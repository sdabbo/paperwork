// What Paperwork did lately (filed, found a duplicate, couldn't read a file), shown on the Inbox page.
// Kept in the store, not in Drive: it is a log, not a document.
import { ActivityEntry, SyncSummary } from '../shared/types.js';
import { getStore } from './store.js';

const KEEP = 200;

let pending: Promise<void> = Promise.resolve();

export function logActivity(entry: Omit<ActivityEntry, 'at'>): Promise<void> {
  const at = new Date().toISOString();
  // One write at a time here, in order; and as a store transaction, so entries the app and its public edge log at
  // the same moment are all kept
  pending = pending
    .then(() =>
      getStore().update<{ entries: ActivityEntry[] }, void>('activity', stored => ({
        next: { entries: [{ at, ...entry }, ...(stored?.entries ?? [])].slice(0, KEEP) },
        result: undefined,
      }))
    )
    .catch(err => console.error('Could not log activity:', err));
  return pending;
}

export async function recentActivity(): Promise<ActivityEntry[]> {
  await pending;
  return (await getStore().get<{ entries: ActivityEntry[] }>('activity'))?.entries ?? [];
}

export async function saveSyncSummary(summary: SyncSummary): Promise<void> {
  await getStore().set('last-sync', summary);
}

export async function lastSyncSummary(): Promise<SyncSummary | null> {
  return getStore().get<SyncSummary>('last-sync');
}
