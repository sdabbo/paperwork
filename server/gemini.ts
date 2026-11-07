// Single entry point for Gemini calls, so model fallback and the daily budget apply everywhere.
import { GoogleGenAI, Content, GenerateContentConfig, GenerateContentResponse } from '@google/genai';
import { getStore } from './store.js';

// Tried in order; later models are only used when the earlier ones fail. GEMINI_MODELS overrides the list.
export const models = () =>
  (process.env.GEMINI_MODELS || 'gemini-3.8-flash,gemini-2.5-flash')
    .split(',')
    .map(m => m.trim())
    .filter(Boolean);

let client: GoogleGenAI | null = null;

export function getClient(): GoogleGenAI {
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '' });
  return client;
}

export class LimitError extends Error {}

// ---------- Daily budget ----------

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return process.env[name] && Number.isFinite(value) && value >= 0 ? value : fallback;
};

// Each document costs one request (two when asked about); a few thousand tokens per page. Embeddings (for the
// search index and each search) are counted on their own: they are many, small and cheap.
const limits = () => ({
  requests: num('GEMINI_DAILY_REQUEST_LIMIT', 500),
  tokens: num('GEMINI_DAILY_TOKEN_LIMIT', 5_000_000),
  embeddings: num('GEMINI_DAILY_EMBEDDING_LIMIT', 5_000),
});

interface DailyUsage {
  date: string;
  requests: number;
  tokens: number;
  embeddings?: number;
}

// Today's usage as last read or written here. The app and its public edge spend from one budget, so it is read
// again after a minute: each sees what the other spent with at most a minute's delay.
let daily: DailyUsage | null = null;
let readAt = 0;
const REREAD_MS = 60 * 1000;

const today = () => new Date().toISOString().slice(0, 10);

async function usage(): Promise<DailyUsage> {
  const date = today();
  if (daily?.date !== date || Date.now() - readAt >= REREAD_MS) {
    const stored = await getStore().get<DailyUsage>(`usage-${date}`);
    daily = { date, requests: stored?.requests ?? 0, tokens: stored?.tokens ?? 0, embeddings: stored?.embeddings ?? 0 };
    readAt = Date.now();
  }
  return daily;
}

// Added in a store transaction, so what the other service spent at the same moment counts too
async function spend(requests: number, tokens: number, embeddings = 0) {
  const date = today();
  daily = await getStore().update<DailyUsage, DailyUsage>(`usage-${date}`, stored => {
    const next = { date, requests: (stored?.requests ?? 0) + requests, tokens: (stored?.tokens ?? 0) + tokens, embeddings: (stored?.embeddings ?? 0) + embeddings };
    return { next, result: next };
  });
  readAt = Date.now();
}

export async function assertBudget(): Promise<void> {
  const u = await usage();
  const l = limits();
  if (u.requests >= l.requests || u.tokens >= l.tokens) {
    throw new LimitError("Paperwork's AI has used today's budget. It continues after midnight UTC; new documents wait in the Inbox until then.");
  }
}

// How much of today's budget is used, 0 to 1: generating (the larger of requests and tokens) and embeddings
export async function budgetUsed(): Promise<{ generate: number; embeddings: number }> {
  const u = await usage();
  const l = limits();
  const share = (used: number, limit: number) => (limit > 0 ? used / limit : 1);
  return { generate: Math.max(share(u.requests, l.requests), share(u.tokens, l.tokens)), embeddings: share(u.embeddings ?? 0, l.embeddings) };
}

// Errors that say "try again later" (rate limits, overloaded or unreachable services) rather than "this won't work"
export function isTransient(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded/i.test(String((err as Error)?.message ?? err));
}

async function assertEmbeddingBudget(count: number): Promise<void> {
  const u = await usage();
  if ((u.embeddings ?? 0) + count > limits().embeddings) {
    throw new LimitError("Paperwork's search has used today's budget. Searching by meaning continues after midnight UTC.");
  }
}

// ---------- Calls ----------

export async function generate(contents: Content[] | string, config: GenerateContentConfig, label: string): Promise<GenerateContentResponse> {
  let lastError: unknown;
  for (const model of models()) {
    await assertBudget();
    try {
      const response = await getClient().models.generateContent({ model, contents, config });
      await spend(1, response.usageMetadata?.totalTokenCount ?? 0);
      return response;
    } catch (err: any) {
      console.warn(`${model} ${label} error:`, err?.message);
      lastError = err;
    }
  }
  throw lastError;
}

export async function generateStream(contents: Content[], config: GenerateContentConfig, label: string): Promise<AsyncGenerator<GenerateContentResponse>> {
  let lastError: unknown;
  for (const model of models()) {
    await assertBudget();
    try {
      const stream = await getClient().models.generateContentStream({ model, contents, config });
      return countTokens(stream);
    } catch (err: any) {
      console.warn(`${model} ${label} stream error:`, err?.message);
      lastError = err;
    }
  }
  throw lastError;
}

async function* countTokens(stream: AsyncGenerator<GenerateContentResponse>): AsyncGenerator<GenerateContentResponse> {
  let tokens = 0;
  try {
    for await (const chunk of stream) {
      tokens = chunk.usageMetadata?.totalTokenCount ?? tokens;
      yield chunk;
    }
  } finally {
    void spend(1, tokens);
  }
}

// JSON from a model answer, also when it is wrapped in a code fence or followed by text
export function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const start = raw.indexOf('{');
    let depth = 0;
    let inString = false;
    for (let i = start; start >= 0 && i < raw.length; i++) {
      const c = raw[i];
      if (inString) {
        if (c === '\\') i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return JSON.parse(raw.slice(start, i + 1)) as T;
    }
    throw err;
  }
}

// ---------- Embeddings ----------

// Vectors for semantic search: texts with similar meaning get nearby vectors, in any language
export const EMBEDDING_DIMENSIONS = 768;
export const embeddingModel = () => process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBED_BATCH = 50;

export async function embed(texts: string[], task: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    await assertEmbeddingBudget(batch.length);
    const response = await getClient().models.embedContent({
      model: embeddingModel(),
      // One content per text: given plain strings, newer embedding models would merge them into one
      contents: batch.map(text => ({ parts: [{ text }] })),
      config: { taskType: task, outputDimensionality: EMBEDDING_DIMENSIONS },
    });
    const values = (response.embeddings ?? []).map(e => e.values ?? []);
    if (values.length !== batch.length || values.some(v => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error(`The embedding model returned ${values.length} vectors for ${batch.length} texts.`);
    }
    await spend(0, 0, batch.length);
    vectors.push(...values);
  }
  return vectors;
}
