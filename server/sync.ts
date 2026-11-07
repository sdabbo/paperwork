// Keeping the search index in step with Drive, where the owner may rename, move, star, delete or file
// documents by hand at any time.
//
// - Drive's change feed says what changed since the last run; each changed document is read again (one
//   request for all of them). Documents deleted, trashed or moved out of the Paperwork folder leave the index,
//   as tombstones for a while (docIndex.ts), so one that comes back has its deadlines and text again.
// - Once a day, and whenever the feed can't be trusted (first run, a folder of the tree renamed or moved, a
//   different Paperwork folder), every document is listed and compared instead: the index is rebuilt from Drive
//   if it is ever lost.
// - Documents whose text or embeddings aren't in the index yet (filed before the index existed, added by a full
//   check, changed in Drive) are worked through a few per run, within half of the day's Gemini budget, so
//   filing new documents, questions and searches always have the other half.
// Only the app (or Paperwork as one service) does this; the public edge only reads the index (roles.ts).
import { logActivity } from './activity.js';
import { transcribe } from './classify.js';
import { Drive, DriveChange, DriveFile, FOLDER } from './drive.js';
import { Readable, UnsupportedFile, readFile } from './extract.js';
import { LimitError, budgetUsed, isTransient } from './gemini.js';
import { IndexedDoc, getIndex } from './docIndex.js';
import { changed, embedMissing, fromDrive, headerChanged, indexWithText, isPending } from './indexing.js';
import { assertFiler } from './roles.js';
import { getStore } from './store.js';
import { ownText } from './text.js';
import { Tree, folderOf, forgetTree, isFiledDocument, isInside, listDocumentFiles, loadTree } from './vault.js';

const FULL_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
// Documents read for the index per run, so a large backlog doesn't hold up filing
const TEXT_PER_RUN = 5;
// Documents whose text is indexed but whose embeddings are missing or out of date (one quick request each)
const EMBED_PER_RUN = 50;
// The backlog stops for the day once this share of the Gemini budget is used
const BACKLOG_SHARE = 0.5;

interface ChangesState {
  token: string;
  fullAt: string;
  // The Paperwork folder the token belongs to; another one (recreated, or another Drive) means a full check
  rootId?: string;
}

export interface ReconcileResult {
  updated: number;
  removed: number;
  full: boolean;
  // The tree the index was compared against: read again when folders changed
  tree: Tree;
}

// Writes a document's current state from Drive. Returns whether anything the app shows changed.
async function upsert(tree: Tree, file: DriveFile): Promise<boolean> {
  const index = getIndex();
  return index.lock(file.id, async () => {
    // A tombstone brings back what only the index knew (deadlines ticked off, text)
    const previous = await index.getAny(file.id);
    const live = previous?.removedAt ? null : previous;
    const next = fromDrive(tree, file, previous);
    if (!changed(live, next)) return false;
    // Details that semantic search is built from changed: the first chunk is embedded again by fillIndex, which
    // keeps a full check after a folder rename quick and within the budget
    await index.put(headerChanged(previous, next) ? { ...next, embedded: false } : next);
    return true;
  });
}

async function remove(id: string, name: string, why: string): Promise<void> {
  await getIndex().lock(id, () => getIndex().remove(id));
  await logActivity({ kind: 'removed', name, fileId: id, detail: why });
}

async function fullCheck(drive: Drive): Promise<ReconcileResult> {
  const index = getIndex();
  // Folders as they are now, and entries as they are stored: an index emptied from outside (to rebuild it)
  // is noticed
  forgetTree();
  const tree = await loadTree(drive, { fresh: true });
  await index.refresh();
  // Documents filed while the check is under way (uploads, email) are missing from its listing; only entries
  // the index had before it are compared
  const before = new Set((await index.all()).map(d => d.id));
  // Taken before listing, so changes made while listing are seen next time
  const token = await drive.changesStartToken();
  const files = await listDocumentFiles(drive, tree);
  const seen = new Set<string>();
  let updated = 0;
  let removed = 0;
  for (const file of files) {
    seen.add(file.id);
    if (await upsert(tree, file)) updated++;
  }
  for (const doc of await index.all()) {
    if (seen.has(doc.id) || !before.has(doc.id)) continue;
    await remove(doc.id, doc.name, 'No longer in the Paperwork folder in Drive');
    removed++;
  }
  await index.purgeOld();
  await getStore().set<ChangesState>('drive-changes', { token, fullAt: new Date().toISOString(), rootId: tree.root.id });
  return { updated, removed, full: true, tree };
}

// What a changed folder means: nothing (a folder Paperwork made, a folder elsewhere in Drive), a tree read
// again (a description edited: it guides filing), or a full check (a folder of the tree renamed, moved,
// trashed or deleted, which changes the place of every document in it; a folder put into the tree by hand)
export function folderChange(tree: Tree, change: DriveChange): 'none' | 'tree' | 'full' {
  const known = tree.folders.get(change.fileId);
  const folder = change.file;
  if (known) {
    if (change.removed || !folder || folder.trashed || folder.name !== known.name) return 'full';
    if (known.parentId && !folder.parents?.includes(known.parentId)) return 'full';
    return (folder.description ?? '') !== known.description ? 'tree' : 'none';
  }
  return folder?.mimeType === FOLDER && !folder.trashed && isInside(tree, folder.parents) ? 'full' : 'none';
}

export async function reconcile(drive: Drive, tree: Tree, options: { full?: boolean } = {}): Promise<ReconcileResult> {
  assertFiler('Bringing the search index up to date');
  const state = await getStore().get<ChangesState>('drive-changes');
  const index = getIndex();
  const stale = !state?.token || Date.now() - Date.parse(state.fullAt) > FULL_CHECK_EVERY_MS || (!!state.rootId && state.rootId !== tree.root.id);
  if (options.full || stale || (await index.all()).length === 0) return fullCheck(drive);

  const { changes, nextToken } = await drive.changes(state.token);
  const folders = changes.filter(c => tree.folders.has(c.fileId) || c.file?.mimeType === FOLDER).map(c => folderChange(tree, c));
  if (folders.includes('full')) return fullCheck(drive);
  if (folders.includes('tree')) {
    forgetTree();
    tree = await loadTree(drive, { fresh: true });
  }

  let updated = 0;
  let removed = 0;
  // The feed can name a file several times; its last entry is its current state
  const latest = new Map(changes.filter(c => c.file?.mimeType !== FOLDER).map(c => [c.fileId, c]));
  for (const change of latest.values()) {
    const file = change.file;
    if (file && isFiledDocument(tree, file)) {
      if (await upsert(tree, file)) updated++;
      continue;
    }
    const previous = await index.get(change.fileId);
    if (!previous) continue;
    const why =
      change.removed || !file
        ? 'Deleted in Drive'
        : file.trashed
          ? 'Moved to the trash in Drive'
          : folderOf(tree, file)?.role === 'inbox'
            ? 'Moved back into the Inbox, to be filed again'
            : 'Moved out of the Paperwork folder';
    await remove(previous.id, previous.name, why);
    removed++;
  }
  await getStore().set<ChangesState>('drive-changes', { token: nextToken, fullAt: state.fullAt, rootId: tree.root.id });
  return { updated, removed, full: false, tree };
}

// The text for a document already filed: its own, or a transcription of the scan
async function readText(drive: Drive, doc: IndexedDoc): Promise<{ text: string; source: 'pdf' | 'ocr' | 'text' | 'none' }> {
  let content: Readable;
  try {
    content = await readFile(drive, { id: doc.id, name: doc.name, mimeType: doc.mimeType, size: doc.size ? String(doc.size) : undefined });
  } catch (err) {
    if (err instanceof UnsupportedFile) return { text: '', source: 'none' };
    throw err;
  }
  const own = await ownText(content);
  if (own) return own;
  const text = await transcribe(content);
  return { text, source: text ? 'ocr' : 'none' };
}

// Whether the backlog waits for tomorrow's budget
export async function backlogPaused(): Promise<boolean> {
  const used = await budgetUsed();
  return used.generate >= BACKLOG_SHARE || used.embeddings >= BACKLOG_SHARE;
}

// Counts a failed attempt; after MAX_INDEX_TRIES the document is left without its text. Errors that pass
// (rate limits, Gemini or Drive unavailable) don't count.
async function failed(doc: IndexedDoc, err: unknown): Promise<void> {
  console.warn(`Indexing ${doc.name} failed:`, (err as Error)?.message);
  if (isTransient(err)) return;
  const index = getIndex();
  await index
    .lock(doc.id, async () => {
      const current = await index.get(doc.id);
      if (current) await index.put({ ...current, indexTries: (current.indexTries ?? 0) + 1 });
    })
    .catch(() => {});
}

export interface FillResult {
  done: number;
  paused: boolean;
}

// Reads text and embeds what is missing, a few documents per run, until `until` (a time) if given. The slow
// part (downloading, transcribing) happens outside the document's lock; what is written is merged into the
// entry as it is then, so edits made in the meantime stay.
export async function fillIndex(drive: Drive, options: { until?: number } = {}): Promise<FillResult> {
  assertFiler('Filling in the search index');
  const index = getIndex();
  const pending = (await index.all())
    .filter(isPending)
    // Newest first: those are the ones most likely to be looked for
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  const embedOnly = pending.filter(d => d.textSource !== null).slice(0, EMBED_PER_RUN);
  const withText = pending.filter(d => d.textSource === null).slice(0, TEXT_PER_RUN);
  let done = 0;
  for (const doc of [...embedOnly, ...withText]) {
    if (options.until && Date.now() > options.until) break;
    if (await backlogPaused()) return { done, paused: true };
    try {
      if (doc.textSource === null) {
        const { text, source } = await readText(drive, doc);
        await index.lock(doc.id, async () => {
          const current = await index.get(doc.id);
          // Removed, or its content changed while it was read: the next run starts over
          if (!current || current.textSource !== null || current.md5 !== doc.md5) return;
          await indexWithText({ ...current, textSource: source, textLength: text.length }, text);
          done++;
        });
      } else {
        await index.lock(doc.id, async () => {
          const current = await index.get(doc.id);
          if (!current || current.embedded || current.textSource === null) return;
          await embedMissing(current);
          done++;
        });
      }
    } catch (err) {
      if (err instanceof LimitError) return { done, paused: true };
      await failed(doc, err);
    }
  }
  return { done, paused: false };
}

