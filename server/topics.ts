// Topics that look like the same matter, e.g. "Example UG commercial register" (from the court) and "Example UG
// formation" (from the notary), for the owner to merge with one click. Gemini looks at all topics at once
// (classify.ts suggestTopicMerges); the answer is kept until new topics appear, and groups the owner said
// don't belong together aren't suggested again.
import crypto from 'crypto';
import { DocumentInfo, TopicSuggestion } from '../shared/types.js';
import { TopicOverview, suggestTopicMerges } from './classify.js';
import { getIndex } from './docIndex.js';
import { toInfo } from './indexing.js';
import { getStore } from './store.js';

const SUGGESTIONS_KEY = 'topic-suggestions';
const DISMISSED_KEY = 'topic-suggestions-dismissed';
const MAX_TOPICS = 300;
const MAX_DISMISSED = 500;

interface Stored {
  // The topics Gemini was shown
  topics: string[];
  suggestions: TopicSuggestion[];
}

// Each topic with its number of documents, senders, years and a few documents, the most used first
export function topicOverviews(documents: DocumentInfo[]): TopicOverview[] {
  const by = new Map<string, DocumentInfo[]>();
  for (const d of documents) if (d.topic) by.set(d.topic, [...(by.get(d.topic) ?? []), d]);
  return [...by.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_TOPICS)
    .map(([topic, docs]) => {
      const years = docs.map(d => (d.date ?? d.addedAt).slice(0, 4)).sort();
      const newest = [...docs].sort((a, b) => (b.date ?? b.addedAt).localeCompare(a.date ?? a.addedAt));
      return {
        topic,
        documents: docs.length,
        correspondents: [...new Set(docs.map(d => d.correspondent).filter((c): c is string => !!c))].slice(0, 5),
        years: years[0] === years.at(-1) ? years[0] : `${years[0]}–${years.at(-1)}`,
        examples: newest.slice(0, 2).map(d => `${d.title}${d.gist ? `: ${d.gist}` : ''}`.slice(0, 160)),
      };
    });
}

const groupKey = (topics: string[]) =>
  crypto
    .createHash('sha1')
    .update([...topics].sort().join('\u0000'))
    .digest('hex')
    .slice(0, 16);

let asking: Promise<Stored> | null = null;

export async function topicSuggestions(): Promise<TopicSuggestion[]> {
  const overviews = topicOverviews((await getIndex().all()).map(toInfo));
  const current = new Set(overviews.map(t => t.topic));
  const store = getStore();
  let stored = await store.get<Stored>(SUGGESTIONS_KEY);
  // Merges and renames only take topics away; new topics need a new look
  if (!stored || overviews.some(t => !stored!.topics.includes(t.topic))) {
    asking ??= (async () => {
      const fresh: Stored = { topics: [...current], suggestions: current.size < 2 ? [] : await suggestTopicMerges(overviews) };
      await store.set(SUGGESTIONS_KEY, fresh);
      return fresh;
    })().finally(() => {
      asking = null;
    });
    stored = await asking;
  }
  const dismissed = new Set(dismissedKeys(await store.get<Dismissed | string[]>(DISMISSED_KEY)));
  return stored.suggestions
    .map(s => ({ ...s, topics: s.topics.filter(t => current.has(t)) }))
    .filter(s => s.topics.length >= 2 && !dismissed.has(groupKey(s.topics)));
}

// The groups the owner said are different matters, by groupKey. A store document is an object (Firestore takes no
// plain list); a file store may still hold the plain list written before.
interface Dismissed {
  keys: string[];
}

const dismissedKeys = (stored: Dismissed | string[] | null) => (Array.isArray(stored) ? stored : stored?.keys) ?? [];

// The owner says these topics are different matters
export async function dismissSuggestion(topics: string[]): Promise<void> {
  const key = groupKey(topics);
  await getStore().update<Dismissed | string[], void>(DISMISSED_KEY, stored => {
    const keys = dismissedKeys(stored);
    return keys.includes(key) ? { result: undefined } : { next: { keys: [...keys, key].slice(-MAX_DISMISSED) }, result: undefined };
  });
}
