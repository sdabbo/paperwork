// Gemini's daily budget and the activity log, kept by two services at once (the app and its public edge): each is a
// module instance of its own here, over one store, as two processes share one Firestore database.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from './store.js';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => ({ usageMetadata: { totalTokenCount: 100 } }),
      embedContent: async ({ contents }: { contents: unknown[] }) => ({ embeddings: contents.map(() => ({ values: Array(768).fill(0.1) })) }),
    };
  },
}));

// One service's copy of the modules, using the shared store
async function service(store: MemoryStore) {
  vi.resetModules();
  (await import('./store.js')).setStoreForTests(store);
  return { gemini: await import('./gemini.js'), activity: await import('./activity.js') };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the daily budget', () => {
  it('counts what both services spend at the same moment', async () => {
    const store = new MemoryStore();
    const [app, edge] = [await service(store), await service(store)];
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await Promise.all(
      Array.from({ length: 10 }, () => [app.gemini.generate('question', {}, 'test'), edge.gemini.generate('question', {}, 'test'), edge.gemini.embed(['query'], 'RETRIEVAL_QUERY')]).flat()
    );
    const today = new Date().toISOString().slice(0, 10);
    expect(store.data.get(`usage-${today}`)).toEqual({ date: today, requests: 20, tokens: 2000, embeddings: 10 });
  });

  it('takes in what the other service spent within a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
    const store = new MemoryStore();
    const [app, edge] = [await service(store), await service(store)];

    expect((await app.gemini.budgetUsed()).generate).toBe(0);
    for (let i = 0; i < 5; i++) await edge.gemini.generate('question', {}, 'test');
    vi.setSystemTime(new Date('2026-10-24T12:00:59Z'));
    expect((await app.gemini.budgetUsed()).generate).toBe(0);
    vi.setSystemTime(new Date('2026-10-24T12:01:01Z'));
    expect((await app.gemini.budgetUsed()).generate).toBe(5 / 500);
  });

  it('learns the shared total whenever it spends, and stops when that is over the budget', async () => {
    vi.stubEnv('GEMINI_DAILY_REQUEST_LIMIT', '3');
    try {
      const store = new MemoryStore();
      const [app, edge] = [await service(store), await service(store)];
      expect((await app.gemini.budgetUsed()).generate).toBe(0);
      await edge.gemini.generate('q', {}, 'test');
      await edge.gemini.generate('q', {}, 'test');
      // Within the minute, but its own spending brought the edge's along
      await app.gemini.generate('q', {}, 'test');
      await expect(app.gemini.generate('q', {}, 'test')).rejects.toThrow(app.gemini.LimitError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the activity log', () => {
  it('keeps what both services log at the same moment', async () => {
    const store = new MemoryStore();
    const [app, edge] = [await service(store), await service(store)];
    await Promise.all([
      app.activity.logActivity({ kind: 'filed', name: 'Electricity bill' }),
      edge.activity.logActivity({ kind: 'email', name: 'Forwarded invoice', detail: 'From me@example.com' }),
      edge.activity.logActivity({ kind: 'rejected', name: 'Spam', detail: 'Not allowed' }),
    ]);
    expect((await app.activity.recentActivity()).map(e => e.name).sort()).toEqual(['Electricity bill', 'Forwarded invoice', 'Spam']);
  });
});
