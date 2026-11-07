// The owner's settings, kept in the store: saved views, and whether new documents wait for a check
import { ReviewMode, Settings } from '../shared/types.js';
import { getStore } from './store.js';

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await getStore().get<Partial<Settings>>(KEY);
  return { views: stored?.views ?? [], review: stored?.review === 'automatic' ? 'automatic' : 'manual' };
}

// Changes what is given, keeps the rest
export async function saveSettings(change: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...change };
  await getStore().set<Settings>(KEY, next);
  return next;
}

export const reviewMode = async (): Promise<ReviewMode> => (await getSettings()).review;
