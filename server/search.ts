// Searching the documents three ways at once, and ranking the results together:
// - by meaning: the question's embedding against the index's chunks ("car insurance" finds "Kfz-Haftpflicht")
// - by words in the files: Drive's own full-text search (exact numbers, names, IBAN fragments)
// - by words in what Paperwork knows: titles, senders, summaries, items bought (as the app's search box does)
// A document with the words searched for is a match. One that is only close in meaning is a guess: a short query
// lands near many documents (their details all read alike), so only a few, about as close as the best match, are
// kept, and marked as such.
import { SearchHit, SearchResponse } from '../shared/types.js';
import { fold, haystack } from '../shared/filter.js';
import { Drive, quote } from './drive.js';
import { ChunkHit, getIndex } from './docIndex.js';
import { embed } from './gemini.js';
import { ROLE } from './metadata.js';
import { Tree, isFiledDocument } from './vault.js';

const NEAREST = 60;
// Semantic hits much further away than the best one are noise: nearest-neighbour search always returns
// something, relevant or not
const MAX_DISTANCE = 0.6;
const WITHIN_BEST = 0.15;
// Reciprocal rank fusion: score = Σ 1 / (K + rank); K damps the weight of the very first ranks
const RRF_K = 30;
const SNIPPET_CHARS = 220;
const MAX_HITS = 50;
// Documents without the words, kept when this close to the best match by meaning, and at most this many
const RELATED_WITHIN = 0.05;
const MAX_RELATED = 5;

export function snippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 2);
  const lower = flat.toLowerCase();
  const at = terms.map(t => lower.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 60);
  const piece = flat.slice(start, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${piece}${start + SNIPPET_CHARS < flat.length ? '…' : ''}`;
}

// The best chunk per document, in order, without the far-off ones
export function semanticRanking(hits: ChunkHit[]): ChunkHit[] {
  const best = new Map<string, ChunkHit>();
  for (const h of hits) {
    const seen = best.get(h.fileId);
    if (!seen || h.distance < seen.distance) best.set(h.fileId, h);
  }
  const ranked = [...best.values()].sort((a, b) => a.distance - b.distance);
  const cutoff = Math.min(MAX_DISTANCE, (ranked[0]?.distance ?? 0) + WITHIN_BEST);
  return ranked.filter(h => h.distance <= cutoff);
}

export function fuse(rankings: string[][]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return scores;
}

async function byMeaning(query: string): Promise<ChunkHit[]> {
  const [vector] = await embed([query], 'RETRIEVAL_QUERY');
  return semanticRanking(await getIndex().nearest(vector, NEAREST));
}

async function byWords(drive: Drive, tree: Tree, query: string): Promise<string[]> {
  const files = await drive.list(`fullText contains ${quote(query)} and properties has { key='${ROLE}' and value='doc' } and trashed = false`, 'id,parents,properties,trashed');
  return files.filter(f => isFiledDocument(tree, f)).map(f => f.id);
}

export interface Matches {
  // Best chunk per document, nearest first
  semantic: ChunkHit[];
  // Document IDs, in Drive's order
  keyword: string[];
  // Whether the search by meaning worked (it needs Gemini, and the day's budget)
  semanticOk: boolean;
}

// Both searches; either may fail on its own and leave its list empty
export async function findMatches(drive: Drive, tree: Tree, query: string): Promise<Matches> {
  const [meaning, words] = await Promise.allSettled([byMeaning(query), byWords(drive, tree, query)]);
  if (meaning.status === 'rejected') console.warn('Semantic search failed:', (meaning.reason as Error)?.message);
  if (words.status === 'rejected') console.warn('Drive search failed:', (words.reason as Error)?.message);
  return {
    semantic: meaning.status === 'fulfilled' ? meaning.value : [],
    keyword: words.status === 'fulfilled' ? words.value : [],
    semanticOk: meaning.status === 'fulfilled',
  };
}

export async function search(drive: Drive, tree: Tree, query: string): Promise<SearchResponse> {
  const { semantic, keyword, semanticOk } = await findMatches(drive, tree, query);
  const docs = await getIndex().all();
  const indexed = new Set(docs.map(d => d.id));
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const hasWords = (text: string) => {
    const folded = fold(text);
    return terms.length > 0 && terms.every(t => folded.includes(t));
  };
  const known = docs
    .filter(d => hasWords(haystack(d)))
    .sort((a, b) => (b.date ?? b.addedAt).localeCompare(a.date ?? a.addedAt))
    .map(d => d.id);
  const words = new Set([...keyword, ...known, ...semantic.filter(h => hasWords(h.text)).map(h => h.fileId)]);
  const nearest = new Map(semantic.map(h => [h.fileId, h]));
  const best = semantic[0]?.distance ?? Infinity;

  const scores = fuse([semantic.map(h => h.fileId), keyword, known]);
  const hits: SearchHit[] = [];
  const related: SearchHit[] = [];
  for (const [id, score] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
    // Only documents the app knows (the index); others are picked up by the next sync
    if (!indexed.has(id)) continue;
    const near = nearest.get(id);
    const hit: SearchHit = { id, score, snippet: near && near.n > 0 ? snippet(near.text, query) : null };
    if (words.has(id)) hits.push({ ...hit, match: 'words' });
    else if (near && near.distance <= best + RELATED_WITHIN && related.length < MAX_RELATED) related.push({ ...hit, match: 'meaning' });
  }
  return { hits: [...hits.slice(0, MAX_HITS), ...related], semantic: semanticOk };
}
