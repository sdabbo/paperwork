// Ticking deadlines off in the lists (the Library's "Coming up", the Deadlines page). The list changes at once
// and goes back if the server says no, so a tap feels instant on a slow phone connection.
import { useCallback, useState } from 'react';
import type { Deadline, DocumentInfo, LibraryResponse } from '../../shared/types';
import { deadlineKey } from '../../shared/filter';
import { api } from './api';

export { lapsed } from '../../shared/filter';

export type PatchDocument = (id: string, change: (doc: DocumentInfo) => DocumentInfo) => void;

// Ticks a deadline off (or back on) everywhere and sends it to the server; fails when the server says no, after
// the lists were put back
export type SaveDeadlineDone = (doc: DocumentInfo, deadline: Deadline, done: boolean) => Promise<void>;

const same = (a: Pick<Deadline, 'date' | 'what'>, b: Pick<Deadline, 'date' | 'what'>) => a.date === b.date && a.what === b.what;

export const withDone = (doc: DocumentInfo, deadline: Pick<Deadline, 'date' | 'what'>, done: boolean): DocumentInfo => ({
  ...doc,
  deadlines: doc.deadlines.map(d => (same(d, deadline) ? { ...d, done } : d)),
});

// A tick the lists show that a library loaded from the server may not show yet
interface Tick {
  docId: string;
  date: string;
  what: string;
  done: boolean;
  // What the server last said about this deadline, to go back to when this tick fails
  confirmed: boolean;
  // performance.now() when the server took this tick; null while it is on its way
  settledAt: number | null;
}

// Sends one tick to the server
type PostDone = (docId: string, deadline: Deadline, done: boolean) => Promise<unknown>;

const postDone: PostDone = (docId, deadline, done) =>
  api<DocumentInfo>(`/api/documents/${docId}/deadlines`, { method: 'POST', body: { date: deadline.date, what: deadline.what, done } });

// Kept by the app for the whole session. A library that left the server before a tick reached it would take the
// tick back when it lands, so each tick is laid over the libraries loaded until one shows it. Ticks on one
// document are sent one after another, so two quick taps arrive in the order they were made.
export function deadlineTicks(patchDocument: PatchDocument, post: PostDone = postDone) {
  const ticks = new Map<string, Tick>();
  const queues = new Map<string, Promise<void>>();

  // `startedAt` is performance.now() when the library was asked for: a library asked for after the server took
  // a tick is the server's word on it, even when it doesn't show it (ticked back on another device)
  const applyTicks = (library: LibraryResponse, startedAt: number): LibraryResponse => {
    const open = new Map<string, Tick[]>();
    for (const [key, tick] of ticks) {
      const current = library.documents.find(d => d.id === tick.docId)?.deadlines.find(d => same(d, tick));
      if (tick.settledAt !== null && (current?.done === tick.done || startedAt > tick.settledAt)) ticks.delete(key);
      else if (current && current.done !== tick.done) open.set(tick.docId, [...(open.get(tick.docId) ?? []), tick]);
    }
    if (!open.size) return library;
    return {
      ...library,
      documents: library.documents.map(doc => (open.get(doc.id) ?? []).reduce((d, tick) => withDone(d, tick, tick.done), doc)),
    };
  };

  const saveDone: SaveDeadlineDone = (doc, deadline, done) => {
    const key = deadlineKey({ doc, deadline });
    const earlier = ticks.get(key);
    const tick: Tick = { docId: doc.id, date: deadline.date, what: deadline.what, done, confirmed: earlier?.confirmed ?? deadline.done, settledAt: null };
    ticks.set(key, tick);
    // Changes only this deadline's flag, so ticking off two deadlines of one document quickly keeps both
    patchDocument(doc.id, d => withDone(d, deadline, done));

    const request = (queues.get(doc.id) ?? Promise.resolve()).then(() => post(doc.id, deadline, done));
    const queued = request.then(
      () => {},
      () => {}
    );
    queues.set(doc.id, queued);
    queued.then(() => {
      if (queues.get(doc.id) === queued) queues.delete(doc.id);
    });

    return request.then(
      () => {
        // A later tap on the same deadline may have replaced this tick; it is told what the server has now
        const latest = ticks.get(key);
        if (latest) latest.confirmed = done;
        if (latest === tick) tick.settledAt = performance.now();
      },
      err => {
        // Put back only when no later tap is on its way for this deadline; that one decides what is shown
        if (ticks.get(key) === tick) {
          ticks.delete(key);
          patchDocument(doc.id, d => withDone(d, deadline, tick.confirmed));
        }
        throw err;
      }
    );
  };

  return { applyTicks, saveDone };
}

// The app's ticks; `patchDocument` must keep its identity (a useCallback without dependencies)
export function useDeadlineTicks(patchDocument: PatchDocument) {
  const [ticks] = useState(() => deadlineTicks(patchDocument));
  return ticks;
}

// The state of the tick buttons in one list: which deadlines are on their way, and what went wrong
export function useDeadlineDone(saveDone: SaveDeadlineDone) {
  const [error, setError] = useState<string | null>(null);
  // Deadlines on their way to the server; their buttons wait, so a double tap doesn't send the tick twice
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());

  const setDone = useCallback(
    async (doc: DocumentInfo, deadline: Deadline, done: boolean): Promise<boolean> => {
      const key = deadlineKey({ doc, deadline });
      setError(null);
      setPending(p => new Set(p).add(key));
      try {
        await saveDone(doc, deadline, done);
        return true;
      } catch (err) {
        setError(`Paperwork couldn't mark “${deadline.what}” as ${done ? 'done' : 'not done'}. ${(err as Error).message}`);
        return false;
      } finally {
        setPending(p => {
          const next = new Set(p);
          next.delete(key);
          return next;
        });
      }
    },
    [saveDone]
  );

  const clearError = useCallback(() => setError(null), []);
  return { setDone, error, clearError, pending };
}
