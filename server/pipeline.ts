// Filing. A file in the Inbox is read by Gemini, renamed ("2025-03-14 Stadtwerke - Electricity bill.pdf"),
// described (summary and key facts in its Drive description and properties) and moved into
// Category/Year. A file that is already in Paperwork goes to Duplicates instead, and one Paperwork can't
// read stays in the Inbox, marked, for the owner to deal with. Nothing is ever deleted.
//
// It runs when Cloud Scheduler calls (every few minutes), when the app is opened, and right away for
// uploads and forwarded email. Files put straight into a category folder by hand are described where they
// are ("adopted"), keeping their name and place. Each run also brings the search index up to date with
// Drive (sync.ts); every filed or changed document is written to it with its text (indexing.ts).
//
// Only the app (or Paperwork as one service) files: on the public edge every entry point here refuses
// (assertFiler, roles.ts), and forwarded email is only put into the Inbox (dropIntoInbox) for the app to file.
import crypto from 'crypto';
import {
  Deadline,
  DocumentInfo,
  DocumentSource,
  DocumentType,
  DocumentUpdate,
  DuplicateChoice,
  DuplicateChoiceResult,
  InboxItem,
  RenameRequest,
  RenameResult,
  SyncSummary,
  TextSource,
  TopicMerge,
  UploadResult,
} from '../shared/types.js';
import { logActivity, saveSyncSummary } from './activity.js';
import { attachExisting, detach, documentOf, findKeptWith, followParent, handOver, unkeep } from './attachments.js';
import { Classification, KnownTopic, classify, describeItems, describeTopics } from './classify.js';
import { md5 } from './crypto.js';
import { Drive, DriveError, DriveFile, DriveGuardError, FOLDER, quote } from './drive.js';
import { DUP_CHECK_VERSION, DupFacts, TextSignals, TextState, comparable, compare, compareByText, copyAndOriginal, factsOf, rankCandidates, textSignals } from './duplicates.js';
import { Readable, UnsupportedFile, readBytes, readFile } from './extract.js';
import { LimitError } from './gemini.js';
import { IndexedDoc, getIndex } from './docIndex.js';
import { IndexExtras, carryDone, fromDrive, headerChanged, indexDetails, indexWithText, isPending, toInfo } from './indexing.js';
import { backlogPaused, fillIndex, reconcile } from './sync.js';
import { assertFiler } from './roles.js';
import { reviewMode } from './settings.js';
import { getStore } from './store.js';
import { joinChunks, ownText } from './text.js';
import { NotConnectedError, getDrive } from './google.js';
import {
  DocMeta,
  P,
  ROLE,
  SCHEMA_VERSION,
  addDupTag,
  cleanItems,
  copyLabel,
  deadlineText,
  describe,
  dupTag,
  fileName,
  fit,
  fromProperties,
  isDeadlineKind,
  nameHash,
  oneLine,
  parseDupTags,
  toProperties,
  validDate,
} from './metadata.js';
import {
  Folder,
  Tree,
  documentFolder,
  ensureDuplicates,
  ensureYearFolder,
  folderOf,
  getDocument,
  importTarget,
  isFiledDocument,
  isInside,
  isKept,
  isSubfolder,
  isYearFolder,
  keptError,
  listInbox,
  listUnfiled,
  loadTree,
  moveTarget,
  toDocumentInfo,
} from './vault.js';

const MAX_TRIES = 3;
// Hand-filed files described per run, so a big folder dropped in at once is worked through over a few runs
const ADOPT_PER_RUN = 10;
// A run starts no new work after this long, so it ends well within Cloud Run's request timeout (600 s) and
// before the next scheduled run; what is left waits for that one
const RUN_TIME_MS = 4 * 60 * 1000;

interface Context {
  drive: Drive;
  tree: Tree;
  documents: DocumentInfo[];
}

// Files being worked on right now, so a scheduled run and an upload never file the same one twice
const busy = new Set<string>();

async function loadContext(drive: Drive, tree?: Tree): Promise<Context> {
  const t = tree ?? (await loadTree(drive));
  return { drive, tree: t, documents: (await getIndex().all()).map(toInfo) };
}

// Writes a filed document to the search index. The filing stands even when this fails: the next sync adds
// the document from Drive and reads its text again. The caller holds the document's lock (docIndex.ts).
async function writeIndex(ctx: Context, file: DriveFile, extras: IndexExtras): Promise<DocumentInfo> {
  try {
    const index = getIndex();
    // A tombstone too: a document filed again after it was moved back to the Inbox keeps its done deadlines
    const previous = await index.getAny(file.id);
    const entry = fromDrive(ctx.tree, file, previous, extras);
    const saved = extras.text ? await indexWithText(entry, extras.text.text) : await indexDetails(entry, previous?.removedAt ? null : previous);
    return toInfo(saved);
  } catch (err) {
    console.error(`Adding ${file.name} to the search index failed:`, err);
    return toDocumentInfo(ctx.tree, file);
  }
}

const indexFiled = (ctx: Context, file: DriveFile, extras: IndexExtras) => getIndex().lock(file.id, () => writeIndex(ctx, file, extras));

// What a classification adds to the Drive file for the index: values at full length, deadlines, the text
function extrasFrom(result: Classification, text: { text: string; source: TextSource } | undefined): IndexExtras {
  return {
    title: result.title,
    correspondent: result.correspondent,
    references: result.references,
    action: result.action,
    tags: result.tags,
    topic: result.topic,
    gist: result.gist,
    deadlines: result.deadlines,
    text,
  };
}

// The text the index keeps: the document's own, or Gemini's transcription of a scan. None yet when the scan
// was too long to transcribe while filing it: the next sync reads it on its own (sync.ts fillIndex).
function indexText(own: { text: string; source: TextSource } | null, result: Classification): { text: string; source: TextSource } | undefined {
  if (own) return own;
  if (result.textPending) return undefined;
  return result.text ? { text: result.text, source: 'ocr' } : { text: '', source: 'none' };
}

// Names and tags already in use, most frequent first, so new documents reuse the same spelling
export function knownNames(documents: DocumentInfo[]) {
  const rank = (values: (string | null)[], limit: number) => {
    const counts = new Map<string, number>();
    for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([v]) => v);
  };
  // Topics in use, the most used first, each with who sent its documents
  const senders = new Map<string, string[]>();
  for (const d of documents) if (d.topic && d.correspondent) senders.set(d.topic, [...(senders.get(d.topic) ?? []), d.correspondent]);
  return {
    correspondents: rank(documents.map(d => d.correspondent), 150),
    tags: rank(documents.flatMap(d => d.tags), 60),
    topics: rank(documents.map(d => d.topic), 300).map((topic): KnownTopic => ({ topic, correspondents: rank(senders.get(topic) ?? [], 6) })),
  };
}

async function findDuplicate(ctx: Context, checksum: string | undefined, exceptId?: string): Promise<DriveFile | null> {
  if (!checksum) return null;
  const files = await ctx.drive.list(`properties has { key='${P.md5}' and value=${quote(checksum)} } and trashed = false`);
  const document = files.find(f => f.id !== exceptId && f.properties?.[ROLE] === 'doc' && isInside(ctx.tree, f.parents));
  if (document) return document;
  // Set aside by the owner as the same document as another one ("Move to Duplicates"): that one, while it is in
  // Paperwork
  for (const file of files) {
    const of = file.properties?.[ROLE] === 'duplicate' ? file.properties?.[P.duplicateOf] : undefined;
    if (!of || of === exceptId || file.id === exceptId || !isInside(ctx.tree, file.parents)) continue;
    const original = await getOrNull(ctx.drive, of);
    if (original && isFiledDocument(ctx.tree, original)) return original;
  }
  return null;
}

const getOrNull = (drive: Drive, id: string) =>
  drive.get(id).catch(err => {
    if (err instanceof DriveError && err.status === 404) return null;
    throw err;
  });

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function markInbox(ctx: Context, file: DriveFile, state: 'failed' | 'unsupported', error: string) {
  const tries = Number(file.properties?.[P.tries] ?? 0) + 1;
  await ctx.drive.update(file.id, {
    properties: { [P.state]: state, [P.error]: fit(P.error, error), [P.tries]: String(tries) },
  });
}

// same-file: the same bytes as `original`; kept: the same as a file kept with `original` (a Word draft saved into the
// Inbox again); same-document: the owner said it is the same document as `original` (a possible duplicate). The
// caller of the last holds the document's lock (`locked`), so its purge doesn't wait for itself.
type DuplicateReason = 'same-file' | 'kept' | 'same-document';

async function moveToDuplicates(ctx: Context, file: DriveFile, original: DriveFile, reason: DuplicateReason = 'same-file', options: { locked?: boolean } = {}): Promise<UploadResult> {
  const kept = reason === 'kept';
  const same = reason === 'same-document';
  const folder = await ensureDuplicates(ctx.drive, ctx.tree);
  await ctx.drive.update(
    file.id,
    {
      description: same
        ? `You said this is the same document as "${original.name}" (${original.webViewLink ?? original.id}), which is in Paperwork. Paperwork never deletes files: delete this copy in Google Drive if you don't need it.`
        : `The same file as ${kept ? 'one kept with ' : ''}"${original.name}" (${original.webViewLink ?? original.id}), which is already in Paperwork. Paperwork never deletes files: delete this copy in Google Drive if you don't need it.`,
      // Its checksum stays, so the same file added again is known as that document (findDuplicate)
      properties: {
        [ROLE]: 'duplicate',
        [P.duplicateOf]: original.id,
        [P.state]: null,
        [P.error]: null,
        [P.tries]: null,
        [P.into]: null,
        ...(same ? { [P.maybeDup]: null, [P.review]: null, [P.target]: null } : {}),
      },
    },
    moveTarget(ctx.tree, file, folder.id)
  );
  // Its kept files go to the original
  if (file.properties?.[ROLE] === 'doc') await handOver(ctx.drive, ctx.tree, file.id, original);
  // A filed document that turned out to be a copy (when filed again) leaves the index for good: as a duplicate
  // it never counts again
  const purge = () => getIndex().purge(file.id);
  await (options.locked ? purge() : getIndex().lock(file.id, purge)).catch(() => {});
  const detail = same ? `You said it's the same as ${original.name}` : `Same as ${kept ? 'a file kept with ' : ''}${original.name}`;
  await logActivity({ kind: 'duplicate', name: file.name, fileId: file.id, detail });
  const document = toDocumentInfo(ctx.tree, original);
  return { status: 'duplicate', duplicateOf: document, ...(kept ? { keptWith: document } : {}) };
}

// The category folder for a document
function categoryFolder(ctx: Context, categoryName: string) {
  const category = ctx.tree.categories.find(c => c.name === categoryName) ?? ctx.tree.categories[0];
  if (!category) throw new Error('The Paperwork folder has no category folders. Add at least one folder to it in Google Drive.');
  return category;
}

// The folder for a document: its category's year folder
function targetFolder(ctx: Context, categoryId: string, date: string | null, fallbackDate: string | undefined) {
  const year = (date ?? fallbackDate ?? new Date().toISOString()).slice(0, 4);
  return ensureYearFolder(ctx.drive, ctx.tree, categoryId, year);
}

// Where the owner put a file: the folder inside a category it sits in or, while it waits in the Inbox, the folder
// (or category) it was added to. Its category is fixed, and a folder inside a category keeps it.
function placement(tree: Tree, file: DriveFile): Folder | null {
  const folder = folderOf(tree, file);
  if (isSubfolder(folder)) return folder;
  const into = folder?.role === 'inbox' ? tree.folders.get(file.properties?.[P.into] ?? '') : undefined;
  return into && (into.role === 'category' || isSubfolder(into)) ? into : null;
}

// Files one document that is in the Inbox (or re-files one that is already somewhere in Paperwork)
async function fileOne(ctx: Context, file: DriveFile, readable?: Readable): Promise<UploadResult> {
  assertFiler('Filing');
  if (isKept(file)) throw keptError();
  if (busy.has(file.id)) return { status: 'waiting' };
  busy.add(file.id);
  try {
    const duplicate = await findDuplicate(ctx, file.md5Checksum, file.id);
    if (duplicate) return await moveToDuplicates(ctx, file, duplicate);
    // A new arrival (not labelled with its content yet, as a document or a kept file made one is) may be a file kept
    // with a document: never read, as that one isn't
    const keptWith = !file.properties?.[P.md5] && file.md5Checksum ? await findKeptWith(ctx.drive, ctx.tree, file.md5Checksum) : null;
    if (keptWith) return await moveToDuplicates(ctx, file, keptWith, 'kept');

    let content: Readable;
    try {
      content = readable ?? (await readFile(ctx.drive, file));
    } catch (err) {
      if (!(err instanceof UnsupportedFile)) throw err;
      await markInbox(ctx, file, 'unsupported', err.message);
      await logActivity({ kind: 'unsupported', name: file.name, fileId: file.id, detail: err.message });
      return { status: 'unsupported', error: err.message };
    }

    const known = knownNames(ctx.documents.filter(d => d.id !== file.id));
    const origin = file.properties?.[P.origin] ?? null;
    const own = await ownText(content);
    const placed = placement(ctx.tree, file);
    const fixed = placed?.categoryId ? ctx.tree.folders.get(placed.categoryId) : undefined;
    const result = await classify({
      content,
      fileName: file.name,
      notes: file.description ?? '',
      categories: ctx.tree.categories.map(c => ({ name: c.name, description: c.description })),
      fixedCategory: fixed?.name,
      transcribe: !own,
      ...known,
    });
    const category = fixed ?? categoryFolder(ctx, result.category);
    // Checked by the owner first (review mode manual): described, but waiting in the Inbox until checked. One put
    // into a folder inside a category goes there (or stays there) whatever its date, marked for the check.
    const check = (await reviewMode()) === 'manual';
    const stays = isSubfolder(placed) ? placed : null;
    const waits = check && !stays;
    const meta: Classification = check ? { ...result, needsReview: true } : result;
    const text = indexText(own, result);
    // The same document as one in Paperwork, as another file (a second scan, the emailed PDF of a paper bill): marked
    // for the owner's check, and filed as the review mode says
    const original = await possibleOriginal(file, { ...dupFactsOf(result), id: file.id, addedAt: file.createdTime ?? '' }, text);
    const inInbox = folderOf(ctx.tree, file)?.role === 'inbox';
    const move = stays
      ? moveTarget(ctx.tree, file, stays.id)
      : waits
        ? inInbox
          ? undefined
          : moveTarget(ctx.tree, file, ctx.tree.inbox.id)
        : moveTarget(ctx.tree, file, (await targetFolder(ctx, category.id, result.date, file.createdTime)).id);
    const name = fileName(meta, file);
    const updated = await ctx.drive.update(
      file.id,
      {
        name,
        description: describe(meta, origin),
        properties: { ...toProperties(meta, name), [P.md5]: file.md5Checksum ?? null, [P.target]: waits ? category.id : null, [P.into]: null, [P.maybeDup]: original?.id ?? null },
      },
      move
    );
    // A document read again may have moved or been renamed: its kept files go along
    if (file.properties?.[ROLE] === 'doc' && (name !== file.name || folderOf(ctx.tree, updated)?.id !== folderOf(ctx.tree, file)?.id)) {
      await followParent(ctx.drive, ctx.tree, updated);
    }
    // Unless marked, looked at again by the backlog (fillDuplicateChecks) once its text and embeddings are in the index
    const document = await indexFiled(ctx, updated, { ...extrasFrom(result, text), dupChecked: original ? DUP_CHECK_VERSION : 0 });
    ctx.documents = [...ctx.documents.filter(d => d.id !== document.id), document];
    await logActivity({
      kind: 'filed',
      name,
      fileId: file.id,
      detail: (waits ? `Waiting for your check in the Inbox · ${category.name}` : document.folderPath.join(' / ')) + (original ? ` · may be a copy of ${original.title}` : ''),
    });
    return { status: 'filed', document, ...(original ? { possibleDuplicateOf: toInfo(original) } : {}) };
  } catch (err) {
    // Out of AI budget or Drive disconnected: the file waits, it hasn't failed
    if (err instanceof LimitError || err instanceof NotConnectedError) throw err;
    console.error(`Filing ${file.name} failed:`, err);
    if (err instanceof DriveGuardError) throw err;
    await markInbox(ctx, file, 'failed', errorText(err)).catch(() => {});
    await logActivity({ kind: 'failed', name: file.name, fileId: file.id, detail: errorText(err) });
    return { status: 'failed', error: errorText(err) };
  } finally {
    busy.delete(file.id);
  }
}

// Describes a file someone put into a category folder by hand, leaving its name and place alone
async function adoptOne(ctx: Context, file: DriveFile): Promise<boolean> {
  assertFiler('Filing');
  const folder = folderOf(ctx.tree, file);
  const category = folder?.categoryId ? ctx.tree.folders.get(folder.categoryId) : null;
  if (!category || busy.has(file.id)) return false;
  busy.add(file.id);
  try {
    const content = await readFile(ctx.drive, file);
    const own = await ownText(content);
    const result = await classify({
      content,
      fileName: file.name,
      notes: '',
      categories: ctx.tree.categories.map(c => ({ name: c.name, description: c.description })),
      fixedCategory: category.name,
      transcribe: !own,
      ...knownNames(ctx.documents),
    });
    const check = (await reviewMode()) === 'manual';
    const meta: DocMeta = { ...result, title: file.name.replace(/\.[A-Za-z0-9]{1,5}$/, ''), needsReview: check || result.needsReview };
    const text = indexText(own, result);
    const original = await possibleOriginal(file, { ...dupFactsOf(meta), id: file.id, addedAt: file.createdTime ?? '' }, text);
    const updated = await ctx.drive.update(file.id, {
      description: describe(meta),
      properties: { ...toProperties(meta, file.name), [P.md5]: file.md5Checksum ?? null, [P.source]: 'drive', [P.maybeDup]: original?.id ?? null },
    });
    const document = await indexFiled(ctx, updated, { ...extrasFrom(result, text), title: meta.title, dupChecked: original ? DUP_CHECK_VERSION : 0 });
    ctx.documents = [...ctx.documents.filter(d => d.id !== document.id), document];
    await logActivity({ kind: 'adopted', name: file.name, fileId: file.id, detail: folder!.path.join(' / ') });
    return true;
  } catch (err) {
    if (err instanceof LimitError || err instanceof NotConnectedError || err instanceof DriveGuardError) throw err;
    const state = err instanceof UnsupportedFile ? 'unsupported' : 'failed';
    await markInbox(ctx, file, state, errorText(err)).catch(() => {});
    return false;
  } finally {
    busy.delete(file.id);
  }
}

const shouldRetry = (file: DriveFile) => {
  const state = file.properties?.[P.state];
  if (state === 'unsupported') return false;
  return state !== 'failed' || Number(file.properties?.[P.tries] ?? 0) < MAX_TRIES;
};

// ---------- Runs ----------

// One run at a time in this process, and one at a time across processes: two revisions overlap during a deploy,
// and while Paperwork is switched to two services the old single service and the new app both run. A run holds
// a lease in the store while it files; one whose process died lapses after LEASE_MS.
const LEASE_KEY = 'sync-lease';
const LEASE_MS = 10 * 60 * 1000;
// This process: its Cloud Run revision, and a random part for two instances of one revision
const LEASE_HOLDER = `${process.env.K_REVISION ?? 'local'}:${crypto.randomBytes(6).toString('hex')}`;
const SKIPPED = 'Another filing run is under way';

interface SyncLease {
  holder: string | null;
  until: string | null;
}

// Takes the lease (or extends its own) unless another holder's hasn't run out yet; true when `holder` has it
export function takeSyncLease(holder: string, now = Date.now()): Promise<boolean> {
  const until = new Date(now + LEASE_MS).toISOString();
  return getStore().update<SyncLease, boolean>(LEASE_KEY, lease => {
    if (lease?.holder && lease.holder !== holder && Date.parse(lease.until ?? '') > now) return { result: false };
    return { next: { holder, until }, result: true };
  });
}

// Gives the lease back, if `holder` still has it
export function releaseSyncLease(holder: string): Promise<void> {
  return getStore().update<SyncLease, void>(LEASE_KEY, lease => (lease?.holder === holder ? { next: { holder: null, until: null }, result: undefined } : { result: undefined }));
}

let running: Promise<SyncSummary> | null = null;

export async function syncVault(reason: string): Promise<SyncSummary> {
  assertFiler('Filing');
  running ??= leasedRun(reason).finally(() => {
    running = null;
  });
  return running;
}

const emptySummary = (reason: string): SyncSummary => ({ at: new Date().toISOString(), reason, filed: 0, adopted: 0, duplicates: 0, failed: 0, waiting: 0, updated: 0, indexed: 0 });

async function leasedRun(reason: string): Promise<SyncSummary> {
  // Not saved as the last run: nothing was done
  if (!(await takeSyncLease(LEASE_HOLDER))) {
    console.warn(`${SKIPPED}; this one (${reason}) is skipped.`);
    return { ...emptySummary(reason), skipped: SKIPPED };
  }
  try {
    return await runSync(reason);
  } finally {
    await releaseSyncLease(LEASE_HOLDER).catch(err => console.error('Giving back the filing lease failed:', err));
  }
}

async function runSync(reason: string): Promise<SyncSummary> {
  assertFiler('Filing');
  const until = Date.now() + RUN_TIME_MS;
  const drive = getDrive();
  let tree = await loadTree(drive);
  const summary = emptySummary(reason);

  // Changes made in Drive first, so filing sees the documents (and folders) as they are now
  try {
    const result = await reconcile(drive, tree);
    summary.updated = result.updated + result.removed;
    tree = result.tree;
  } catch (err) {
    console.error('Bringing the search index up to date failed:', err);
  }

  const inbox = (await listInbox(drive, tree)).filter(shouldRetry);
  const unfiled = (await listUnfiled(drive, tree)).filter(shouldRetry).slice(0, ADOPT_PER_RUN);
  if (inbox.length || unfiled.length) {
    const ctx = await loadContext(drive, tree);
    try {
      for (const file of inbox) {
        if (Date.now() > until) {
          summary.waiting++;
          continue;
        }
        const outcome = await fileOne(ctx, file);
        if (outcome.possibleDuplicateOf) summary.possibleDuplicates = (summary.possibleDuplicates ?? 0) + 1;
        if (outcome.status === 'filed') summary.filed++;
        else if (outcome.status === 'duplicate') summary.duplicates++;
        else if (outcome.status === 'waiting') summary.waiting++;
        else summary.failed++;
      }
      for (const file of unfiled) if (Date.now() < until && (await adoptOne(ctx, file))) summary.adopted++;
    } catch (err) {
      if (!(err instanceof LimitError)) throw err;
      summary.waiting = inbox.length - summary.filed - summary.duplicates - summary.failed;
      console.warn(err.message);
    }
  }
  // Then the backlog: text and embeddings for documents the index doesn't have them for yet, possible copies among
  // documents filed before (or before their text was read), topics for documents filed before there were any, and
  // the items of receipts filed before Paperwork read them
  try {
    summary.indexed = (await fillIndex(drive, { until })).done;
  } catch (err) {
    console.error('Filling in the search index failed:', err);
  }
  try {
    const marked = Date.now() < until ? await fillDuplicateChecks(drive, { until }) : 0;
    if (marked) summary.possibleDuplicates = (summary.possibleDuplicates ?? 0) + marked;
  } catch (err) {
    console.error('Looking for possible duplicates failed:', err);
  }
  try {
    if (Date.now() < until) await fillTopics({ until });
  } catch (err) {
    if (err instanceof LimitError) console.warn(err.message);
    else console.error('Giving older documents topics failed:', err);
  }
  try {
    if (Date.now() < until) await fillItems({ until });
  } catch (err) {
    if (err instanceof LimitError) console.warn(err.message);
    else console.error('Reading the items of older receipts failed:', err);
  }
  await saveSyncSummary(summary);
  return summary;
}

// ---------- New files from the app and from email ----------

export interface Incoming {
  name: string;
  mimeType: string;
  data: Uint8Array;
  source: DocumentSource;
  // Context for the AI (and kept on the Inbox file until it is filed), e.g. the email's subject and text
  notes?: string;
  origin?: string;
  // Email: the message, so a message delivered twice isn't added twice
  mailId?: string;
  // The ID of the folder the owner added it to ("Add a document to this folder"): a category or a folder inside one
  into?: string;
}

// Titles named in the note on a file added to a folder
const FOLDER_NOTE_TITLES = 5;

// A file added to a folder by the owner: the folder (pwInto) and, for the AI, a note naming it and the documents
// in it already, before any notes it came with. It is filed into that folder (see placement).
function addedTo(ctx: Context, folder: Folder | null, notes?: string): { description?: string; properties: Record<string, string> } {
  if (!folder) return { description: notes, properties: {} };
  const titles = ctx.documents
    .filter(d => d.folderId === folder.id)
    .sort((a, b) => (b.date ?? b.addedAt).localeCompare(a.date ?? a.addedAt))
    .slice(0, FOLDER_NOTE_TITLES)
    .map(d => d.title);
  const note = `Added by the owner to the folder ${folder.path.join(' / ')}${titles.length ? `, with: ${titles.join('; ')}` : ''}.`;
  return { description: [note, notes].filter(Boolean).join('\n\n'), properties: { [P.into]: folder.id } };
}

// How a file arrived, as labels on it in the Inbox. Filing keeps them (fileOne merges its labels in), so a message
// stays recognised (alreadyReceived) after its files are filed.
const arrival = (incoming: Pick<Incoming, 'source' | 'origin' | 'mailId'>): Record<string, string> => ({
  [P.source]: incoming.source,
  ...(incoming.origin ? { [P.origin]: fit(P.origin, incoming.origin) } : {}),
  ...(incoming.mailId ? { [P.mail]: incoming.mailId } : {}),
});

// Puts a file into the Inbox and files it right away. A file whose exact content is already in Paperwork is
// not added at all (and so never needs deleting).
export async function addFile(incoming: Incoming): Promise<UploadResult> {
  assertFiler('Filing');
  const drive = getDrive();
  const tree = await loadTree(drive);
  const ctx: Context = { drive, tree, documents: [] };
  // Checked before anything is written
  const into = incoming.into !== undefined ? documentFolder(tree, incoming.into) : null;

  const checksum = md5(incoming.data);
  const existing = await findDuplicate(ctx, checksum);
  if (existing) return { status: 'duplicate', duplicateOf: toDocumentInfo(tree, existing) };
  // Kept with a document already (a Word draft sent again): that document
  const keptWith = await findKeptWith(drive, tree, checksum);
  if (keptWith) {
    const document = toDocumentInfo(tree, keptWith);
    return { status: 'duplicate', duplicateOf: document, keptWith: document };
  }

  const full = await loadContext(drive, tree);
  const added = addedTo(full, into, incoming.notes);
  const created = await drive.createFile(
    {
      name: incoming.name,
      parents: [tree.inbox.id],
      description: added.description?.slice(0, 4000),
      properties: { ...arrival(incoming), ...added.properties },
    },
    { data: incoming.data, mimeType: incoming.mimeType }
  );

  let readable: Readable | undefined;
  try {
    readable = await readBytes(incoming.data, incoming.mimeType);
  } catch (err) {
    if (!(err instanceof UnsupportedFile)) throw err;
  }
  try {
    return await fileOne(full, created, readable);
  } catch (err) {
    if (err instanceof LimitError || err instanceof NotConnectedError) return { status: 'waiting', error: err.message };
    throw err;
  }
}

export type IncomingDoc = Omit<Incoming, 'data' | 'mimeType'> & { html: string };

// The Google Doc made by Drive from HTML, in the Inbox
const createConvertedDoc = (drive: Drive, tree: Tree, incoming: IncomingDoc) =>
  drive.createFile(
    {
      name: incoming.name,
      parents: [tree.inbox.id],
      description: incoming.notes?.slice(0, 4000),
      properties: arrival(incoming),
      convertTo: 'application/vnd.google-apps.document',
    },
    { data: Buffer.from(incoming.html, 'utf8'), mimeType: 'text/html' }
  );

// A Google Doc made by Drive from HTML or text, e.g. an email that has no attachment
export async function addConvertedDoc(incoming: IncomingDoc): Promise<UploadResult> {
  assertFiler('Filing');
  const drive = getDrive();
  const tree = await loadTree(drive);
  const created = await createConvertedDoc(drive, tree, incoming);
  const ctx = await loadContext(drive, tree);
  try {
    return await fileOne(ctx, created);
  } catch (err) {
    if (err instanceof LimitError || err instanceof NotConnectedError) return { status: 'waiting', error: err.message };
    throw err;
  }
}

// ---------- Email on the public edge ----------

// A file in the Inbox, as the library lists it (one Paperwork tried before is marked)
const inboxItem = (file: DriveFile): InboxItem => {
  const state = file.properties?.[P.state];
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    addedAt: file.createdTime ?? '',
    state: state === 'failed' || state === 'unsupported' ? state : 'waiting',
    error: file.properties?.[P.error] ?? null,
    webViewLink: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
  };
};

// The public edge (roles.ts) puts forwarded email into the Inbox, labelled and with its notes as addFile does, and
// leaves the filing to the app: its next run reads the notes from the file's description. Nothing here reads or
// writes the index, asks Gemini or creates a folder (a missing Paperwork folder or Inbox is a VaultProblem).
export async function dropIntoInbox(incoming: Incoming): Promise<UploadResult> {
  const drive = getDrive();
  const tree = await loadTree(drive, { create: false });
  const checksum = md5(incoming.data);
  const existing = await findDuplicate({ drive, tree, documents: [] }, checksum);
  if (existing) return { status: 'duplicate', duplicateOf: toDocumentInfo(tree, existing) };
  const keptWith = await findKeptWith(drive, tree, checksum);
  if (keptWith) {
    const document = toDocumentInfo(tree, keptWith);
    return { status: 'duplicate', duplicateOf: document, keptWith: document };
  }
  // Sent again before the app filed it: the one waiting is enough
  const waiting = (await listInbox(drive, tree)).find(f => f.md5Checksum === checksum);
  if (waiting) return { status: 'waiting', inboxItem: inboxItem(waiting) };
  const created = await drive.createFile(
    { name: incoming.name, parents: [tree.inbox.id], description: incoming.notes?.slice(0, 4000), properties: arrival(incoming) },
    { data: incoming.data, mimeType: incoming.mimeType }
  );
  return { status: 'waiting', inboxItem: inboxItem(created) };
}

// An email without attachments, as a Google Doc in the Inbox. Google Docs have no checksum: a message delivered
// twice is caught by its mailId (alreadyReceived).
export async function dropConvertedDoc(incoming: IncomingDoc): Promise<UploadResult> {
  const drive = getDrive();
  const tree = await loadTree(drive, { create: false });
  return { status: 'waiting', inboxItem: inboxItem(await createConvertedDoc(drive, tree, incoming)) };
}

// ---------- Files picked in Google Drive ----------

const MAX_COPY_BYTES = 40 * 1024 * 1024;

// A file the owner picked in Google's file picker (with Drive access limited to Paperwork's own files; e.g. a
// scan made with the Drive app): moved into the Inbox and filed like an upload (into the folder `into` when it was
// picked for one). Picking it is what gives Paperwork access to it. A file that is already in Paperwork, or whose
// content is, stays where it is.
export async function importFromDrive(id: string, into?: string): Promise<UploadResult> {
  assertFiler('Filing');
  const drive = getDrive();
  const tree = await loadTree(drive);
  // Checked before anything is written
  const folder = into !== undefined ? documentFolder(tree, into) : null;
  const file = await drive.get(id);
  if (file.trashed) throw new DriveError('This file is in the trash in Google Drive.', 404);
  if (file.mimeType === FOLDER) throw new DriveGuardError('Pick files, not folders.');
  const ctx = await loadContext(drive, tree);
  // Picked for a folder: labelled for it, with the note for the AI
  const added = addedTo(ctx, folder, file.description);
  // Already filed: picking it gives Paperwork access to it again (e.g. after Drive access was narrowed), so it is
  // back in the index right away
  if (isFiledDocument(tree, file)) return { status: 'duplicate', duplicateOf: await indexFiled(ctx, file, {}) };
  // Kept with a document: picking it finds that document. One whose document is gone becomes a document of its own,
  // if Paperwork can read it (detach).
  if (isKept(file) && isInside(tree, file.parents)) {
    const parent = await documentOf(drive, tree, file);
    if (!parent) return fileNow(ctx, await detach(drive, tree, file));
    const document = toDocumentInfo(tree, parent);
    return { status: 'duplicate', duplicateOf: document, keptWith: document };
  }
  if (isInside(tree, file.parents)) {
    if (folderOf(tree, file)?.role === 'inbox') return fileNow(ctx, folder ? await ctx.drive.update(file.id, added) : file);
    const original = ctx.documents.find(d => d.id === file.properties?.[P.duplicateOf]);
    if (original) return { status: 'duplicate', duplicateOf: original };
    // Put into a category folder by hand: described where it is by the next run
    return { status: 'waiting', error: 'It is in a folder of Paperwork already and is described where it is within a few minutes.' };
  }
  const duplicate = await findDuplicate(ctx, file.md5Checksum);
  if (duplicate) return { status: 'duplicate', duplicateOf: toDocumentInfo(tree, duplicate) };
  // Kept with a document already (a Word draft picked again): that document
  const keptWith = file.md5Checksum ? await findKeptWith(drive, tree, file.md5Checksum) : null;
  if (keptWith) {
    const document = toDocumentInfo(tree, keptWith);
    return { status: 'duplicate', duplicateOf: document, keptWith: document };
  }

  const labels = { [P.source]: 'drive', [P.origin]: fit(P.origin, 'Picked in Google Drive') };
  // A file once kept with a document and moved out of Paperwork by hand comes back as a document of its own, without
  // the note naming that document
  const unkept = isKept(file) ? unkeep(file) : null;
  const notes = unkept ? addedTo(ctx, folder, unkept.description) : added;
  let moved: DriveFile | null = null;
  try {
    moved = await ctx.drive.update(
      file.id,
      { ...(folder || unkept ? { description: notes.description } : {}), properties: { ...labels, ...unkept?.properties, ...notes.properties } },
      importTarget(tree, file)
    );
  } catch (err) {
    // Drive may refuse to take the file out of its folder (a folder Paperwork can't see, or a file someone else
    // owns): a copy is filed instead, and the original stays where it is
    if (!(err instanceof DriveError) || (err.status !== 403 && err.status !== 404)) throw err;
    console.warn(`Moving ${file.name} into the Inbox failed (${err.message}); filing a copy.`);
  }
  if (moved) return fileNow(ctx, moved);
  const native = file.mimeType.startsWith('application/vnd.google-apps.');
  if (!native && Number(file.size ?? 0) > MAX_COPY_BYTES) return { status: 'unsupported', error: 'The file is larger than 40 MB.' };
  const copy = await ctx.drive.createFile(
    { name: native ? `${file.name}.pdf` : file.name, parents: [tree.inbox.id], ...(folder ? { description: notes.description } : {}), properties: { ...labels, ...notes.properties } },
    { data: native ? await ctx.drive.export(file.id, 'application/pdf') : await ctx.drive.download(file.id), mimeType: native ? 'application/pdf' : file.mimeType }
  );
  return { ...(await fileNow(ctx, copy)), copied: true };
}

// Files a file now; out of AI budget or Drive disconnected, it waits in the Inbox
async function fileNow(ctx: Context, file: DriveFile): Promise<UploadResult> {
  try {
    return await fileOne(ctx, file);
  } catch (err) {
    if (err instanceof LimitError || err instanceof NotConnectedError) return { status: 'waiting', error: err.message };
    throw err;
  }
}

// A file kept with a document, made a document of its own: put into the Inbox and filed like a new one
export async function detachFile(id: string): Promise<UploadResult> {
  assertFiler('Filing');
  const drive = getDrive();
  const ctx = await loadContext(drive);
  return fileNow(ctx, await detach(drive, ctx.tree, await drive.get(id)));
}

export async function alreadyReceived(mailId: string): Promise<boolean> {
  const drive = getDrive();
  const files = await drive.list(`properties has { key='${P.mail}' and value=${quote(mailId)} }`, 'id');
  return files.length > 0;
}

// ---------- Changes from the app ----------

export async function retryFile(id: string): Promise<UploadResult> {
  assertFiler('Filing');
  const drive = getDrive();
  const ctx = await loadContext(drive);
  const file = await drive.get(id);
  if (file.trashed || !isInside(ctx.tree, file.parents)) throw new DriveGuardError('This file is outside the Paperwork folder');
  if (isKept(file)) throw keptError();
  await drive.update(file.id, { properties: { [P.state]: null, [P.error]: null, [P.tries]: null } });
  return fileOne(ctx, { ...file, properties: { ...file.properties, [P.state]: '', [P.tries]: '0' } });
}

// Reads a filed document again and files it from scratch (new name, folder and description)
export async function refile(id: string): Promise<UploadResult> {
  assertFiler('Filing');
  const drive = getDrive();
  const ctx = await loadContext(drive);
  const { file } = await getDocument(drive, ctx.tree, id);
  // Set aside meanwhile (moved to Duplicates in another window, say): it would come back as a document there
  if (!isFiledDocument(ctx.tree, file)) throw new DriveError('This document is not in Paperwork.', 404);
  ctx.documents = ctx.documents.filter(d => d.id !== id);
  return fileOne(ctx, file);
}

// Edits from the app. The whole edit holds the document's lock, so two edits (or an edit and a deadline
// ticked off) don't each start from the same state and undo the other.
export async function updateDocument(id: string, update: DocumentUpdate): Promise<DocumentInfo> {
  assertFiler('Changing a document');
  return getIndex().lock(id, () => applyUpdate(id, update));
}

async function applyUpdate(id: string, update: DocumentUpdate): Promise<DocumentInfo> {
  const drive = getDrive();
  const tree = await loadTree(drive);
  const { file, doc } = await getDocument(drive, tree, id);
  // Set aside meanwhile (moved to Duplicates in another window, say): an edit would make it a document again, there
  if (!isFiledDocument(tree, file)) throw new DriveError('This document is not in Paperwork.', 404);
  const ctx: Context = { drive, tree, documents: [] };
  if (Object.keys(update).length === 1 && update.starred !== undefined) {
    return writeIndex(ctx, await drive.update(file.id, { starred: update.starred }), {});
  }
  // Drive labels hold shortened copies of long values; the index has them in full. A name given in Drive wins
  // over the title, as everywhere else.
  const renamedInDrive = file.properties?.[P.nameHash] !== nameHash(file.name);
  const indexed = await getIndex().get(id);
  const labels = fromProperties(file.properties, file.description);
  const current: DocMeta = indexed
    ? {
        ...labels,
        title: renamedInDrive ? doc.title : indexed.title,
        correspondent: indexed.correspondent,
        references: indexed.references,
        topic: indexed.topic,
        gist: indexed.gist,
        action: indexed.action,
        tags: indexed.tags,
        deadlines: indexed.deadlines,
        items: indexed.items ?? labels.items,
      }
    : labels;

  const meta: DocMeta = {
    ...current,
    title: update.title?.trim() || current.title || doc.title,
    type: update.type !== undefined ? update.type : current.type,
    correspondent: update.correspondent !== undefined ? update.correspondent?.trim() || null : current.correspondent,
    date: update.date !== undefined ? validDate(update.date) : current.date,
    amount: update.amount !== undefined ? (update.amount === null || !Number.isFinite(update.amount) ? null : update.amount) : current.amount,
    currency: update.currency !== undefined ? update.currency?.trim().toUpperCase().slice(0, 3) || null : current.currency,
    ...datesAfter(current, update),
    items: update.items !== undefined ? cleanItems(update.items) : current.items,
    tags: update.tags ? [...new Set(update.tags.map(t => t.trim().toLowerCase().replace(/[,#]/g, '')).filter(Boolean))].slice(0, 10) : current.tags,
    references: update.references !== undefined ? update.references?.trim() || null : current.references,
    topic: update.topic !== undefined ? oneLine(update.topic, 100) : current.topic,
    gist: update.gist !== undefined ? oneLine(update.gist, 160) : current.gist,
    action: update.action !== undefined ? update.action?.trim() || null : current.action,
    summary: update.summary !== undefined ? update.summary.trim() : current.summary,
    needsReview: update.needsReview ?? current.needsReview,
  };

  // Paperwork's naming is kept up to date unless the file was renamed in Drive and the title wasn't edited
  const name = renamedInDrive && update.title === undefined ? file.name : fileName(meta, file);

  // A new category moves the document; so does a new year while it sits in a year folder. A document waiting
  // in the Inbox for its check stays there (its category is where it goes) until it is checked. A folder chosen
  // inside a category takes it there, from the Inbox too, and it stays there whatever its date; choosing its
  // category takes it out of that folder again.
  let move: { from: string[]; to: string } | undefined;
  const folder = folderOf(tree, file);
  const chosen = update.folderId !== undefined ? documentFolder(tree, update.folderId) : null;
  const into = isSubfolder(chosen) ? chosen : null;
  const categoryId = chosen ? chosen.categoryId : (update.categoryId ?? doc.categoryId);
  const waiting = folder?.role === 'inbox' && !into;
  const checked = doc.needsReview && !meta.needsReview;
  // A possible copy the owner kept ("Keep both"): no copy of that document, and not asked about again. Only of the
  // document they were shown; a check alone keeps the mark (sent from a view that didn't show it yet, say), and the
  // document stays to check for it.
  const copyOf = file.properties?.[P.maybeDup] || null;
  if (update.notDuplicate === true && copyOf && update.duplicateOf !== undefined && update.duplicateOf !== copyOf) {
    throw new DuplicateProblem('Paperwork now thinks this may be a copy of another document. Compare it with that one first.');
  }
  const notCopy = !!copyOf && update.notDuplicate === true;
  const year = (meta.date ?? file.createdTime ?? '').slice(0, 4);
  const inYearFolder = isYearFolder(folder);
  if (into) {
    if (folder?.id !== into.id) move = moveTarget(tree, file, into.id);
  } else if (waiting) {
    if (categoryId && tree.folders.get(categoryId)?.role !== 'category') throw new DriveGuardError('Not a category folder');
    if (!meta.needsReview) {
      if (!categoryId) throw new DriveGuardError('Choose a folder for this document first');
      move = moveTarget(tree, file, (await ensureYearFolder(drive, tree, categoryId, year || new Date().getFullYear().toString())).id);
    }
  } else if (categoryId && (categoryId !== doc.categoryId || (inYearFolder && folder!.name !== year) || (chosen && isSubfolder(folder)))) {
    const category = tree.folders.get(categoryId);
    if (!category || category.role !== 'category') throw new DriveGuardError('Not a category folder');
    const target = await ensureYearFolder(drive, tree, categoryId, year || new Date().getFullYear().toString());
    move = moveTarget(tree, file, target.id);
  }

  const updated = await drive.update(
    file.id,
    {
      name,
      description: describe(meta, file.properties?.[P.origin]),
      // A document filed before topics existed keeps waiting for its topic, unless this edit gives it one; the same
      // for the items bought
      properties: {
        ...toProperties(
          meta,
          name,
          update.topic !== undefined || update.gist !== undefined ? SCHEMA_VERSION : (file.properties?.[P.version] ?? SCHEMA_VERSION),
          update.items !== undefined || file.properties?.[P.itemsRead] === '1'
        ),
        [P.target]: waiting && meta.needsReview ? categoryId : null,
        [P.into]: null,
        ...(notCopy ? { [P.maybeDup]: null, [P.notDup]: addDupTag(file.properties?.[P.notDup], copyOf!) } : {}),
      },
      ...(update.starred !== undefined ? { starred: update.starred } : {}),
    },
    move
  );
  // Kept files go along with a document Paperwork moved or renamed, and one left behind (a move that failed, or the
  // document moved by hand in Drive) is brought next to it; all in place, it costs a look
  await followParent(drive, tree, updated);
  const result = await writeIndex(ctx, updated, {
    title: meta.title,
    correspondent: meta.correspondent,
    references: meta.references,
    action: meta.action,
    topic: meta.topic,
    gist: meta.gist,
    tags: meta.tags,
    deadlines: meta.deadlines,
    deadlinesAsGiven: update.deadlines !== undefined || update.dueDate !== undefined,
  });
  if (checked) await logActivity({ kind: 'checked', name, fileId: id, detail: result.folderPath.join(' / ') });
  else if (move || name !== file.name) await logActivity({ kind: 'edited', name, fileId: id, detail: result.folderPath.join(' / ') });
  else if (notCopy) await logActivity({ kind: 'edited', name, fileId: id, detail: 'Kept both: not a copy' });
  return result;
}

// ---------- Possible duplicates ----------

// A filing waits this long for the check at most; the backlog (fillDuplicateChecks) looks again
const DUP_FILING_MS = 5000;
// The backlog's share per run: documents looked at, texts read, searches by meaning, documents marked (so a library
// filed before the check existed doesn't flood To check), and marks put right
const DUP_DOCS_PER_RUN = 100;
const DUP_TEXT_READS_PER_RUN = 40;
const DUP_NEAREST_PER_RUN = 10;
const DUP_FLAGS_PER_RUN = 5;
const DUP_REPAIRS_PER_RUN = 10;
// Searched by meaning: documents added in the last NEAREST_DAYS, for text pieces of others up to NEAREST_DISTANCE
// away (embeddings only find candidates; the texts decide)
const NEAREST_DAYS = 90;
const NEAREST_LIMIT = 20;
const NEAREST_DISTANCE = 0.12;
const NEAREST_CANDIDATES = 3;

// What the check compares of a document just read
const dupFactsOf = (meta: Pick<DocMeta, 'title' | 'type' | 'correspondent' | 'date' | 'amount' | 'currency' | 'references' | 'items' | 'topic'>) => ({
  title: meta.title,
  type: meta.type,
  correspondent: meta.correspondent,
  date: meta.date,
  amount: meta.amount,
  currency: meta.currency,
  references: meta.references,
  items: meta.items,
  topic: meta.topic,
});

// Whether an indexed document's text is there to compare: read, still to be read, or not to be had (none, or
// given up on)
function textStateOf(doc: IndexedDoc): TextState {
  if (doc.textSource === 'pdf' || doc.textSource === 'ocr' || doc.textSource === 'text') return 'ready';
  return doc.textSource === null && isPending(doc) ? 'pending' : 'never';
}

// A text as the check compares it; one too short to tell anything counts as none
const textFor = (text: string): TextSignals | TextState => {
  const signals = textSignals(text);
  return signals.usable ? signals : 'never';
};

const chunkText = (chunks: { n: number; text: string }[]) =>
  joinChunks(
    chunks
      .filter(c => c.n > 0)
      .sort((a, b) => a.n - b.n)
      .map(c => c.text)
  );

// The document a filing may be a copy of, from what the index has (no Gemini). Never fails a filing, and gives up
// after a few seconds: the backlog looks again.
async function possibleOriginal(file: DriveFile, facts: Omit<DupFacts, 'notDuplicates' | 'possibleDuplicateOf'>, text: { text: string; source: TextSource } | undefined): Promise<IndexedDoc | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      console.warn(`Looking for a document ${file.name} may be a copy of took too long; the next run looks again.`);
      resolve(null);
    }, DUP_FILING_MS);
  });
  try {
    return await Promise.race([findOriginal(file, facts, text), late]);
  } catch (err) {
    console.warn(`Looking for a document ${file.name} may be a copy of failed:`, (err as Error)?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findOriginal(file: DriveFile, facts: Omit<DupFacts, 'notDuplicates' | 'possibleDuplicateOf'>, text: { text: string; source: TextSource } | undefined): Promise<IndexedDoc | null> {
  const index = getIndex();
  // The owner's answers: in Drive, and in the index for one that landed while this filing read the document
  const notDuplicates = [...new Set([...parseDupTags(file.properties?.[P.notDup]), ...((await index.get(file.id))?.notDuplicates ?? [])])];
  const self: DupFacts = { ...facts, notDuplicates, possibleDuplicateOf: null };
  // No text yet: a long scan, read on its own later (indexText)
  const own = text === undefined ? 'pending' : text.text ? textFor(text.text) : 'never';
  // Only one added before it can be its original: read again, an older document is never the copy of a newer one
  // (the backlog marks the newer one, as it marks the one added later of any pair)
  const docs = (await index.all()).filter(d => d.id !== file.id && copyAndOriginal(self, factsOf(d)).copy.id === self.id);
  const byId = new Map(docs.map(d => [d.id, d]));
  for (const candidate of rankCandidates(self, docs.map(factsOf))) {
    const doc = byId.get(candidate.id)!;
    const state = textStateOf(doc);
    // Its text is read only when there are two to compare
    const theirs = state === 'ready' && typeof own !== 'string' ? textFor(chunkText(await index.chunks(doc.id))) : state;
    if (compare(self, own, candidate, theirs).verdict === 'flag') return doc;
  }
  return null;
}

// Looks for possible copies the filing couldn't decide about, a batch per run: documents filed before the check
// existed (newest first), those whose text wasn't read yet, recent ones by meaning (their nearest text pieces, for a
// copy whose facts were read differently), and marks put right whose original is gone. Asks Gemini nothing, so it
// doesn't wait for the budget. Returns the documents marked.
export async function fillDuplicateChecks(drive: Drive, options: { until?: number } = {}): Promise<number> {
  assertFiler('Looking for possible duplicates');
  const index = getIndex();
  const tree = await loadTree(drive);
  await repairMarks(drive, tree);

  const all = await index.all();
  const byId = new Map(all.map(d => [d.id, d]));
  const facts = new Map(all.map(d => [d.id, factsOf(d)]));
  const pending = all
    .filter(d => !d.possibleDuplicateOf && (d.dupChecked ?? 0) < DUP_CHECK_VERSION && !busy.has(d.id))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .slice(0, DUP_DOCS_PER_RUN);
  // Texts read in this run, once each; undefined once the run has read its share (what is left waits for the next)
  const texts = new Map<string, TextSignals | TextState>();
  let reads = 0;
  let searches = 0;
  let flags = 0;
  const textOf = async (doc: IndexedDoc): Promise<TextSignals | TextState | undefined> => {
    const known = texts.get(doc.id);
    if (known) return known;
    const state = textStateOf(doc);
    if (state !== 'ready') return state;
    if (reads >= DUP_TEXT_READS_PER_RUN) return undefined;
    reads++;
    const text = textFor(chunkText(await index.chunks(doc.id)));
    texts.set(doc.id, text);
    return text;
  };

  for (const doc of pending) {
    if (options.until && Date.now() > options.until) break;
    const self = facts.get(doc.id)!;
    // Marked as a copy earlier in this run, or its text is still to be read
    if (self.possibleDuplicateOf || textStateOf(doc) === 'pending') continue;
    const candidates = rankCandidates(self, [...facts.values()]);
    let near: DupFacts[] = [];
    const recent = Date.now() - Date.parse(doc.addedAt) < NEAREST_DAYS * 86_400_000;
    if (doc.embedded && textStateOf(doc) === 'ready' && recent && searches < DUP_NEAREST_PER_RUN) {
      if (reads >= DUP_TEXT_READS_PER_RUN) break;
      reads++;
      searches++;
      // Its own chunks give its text too; the first holds its facts, which say little more than "the same sender"
      const own = await index.chunks(doc.id, true);
      texts.set(doc.id, textFor(chunkText(own)));
      const first = own.find(c => c.n === 1 && c.embedding);
      if (first) {
        const hits = await index.nearest(first.embedding!, NEAREST_LIMIT);
        const ids = new Set(hits.filter(h => h.n >= 1 && h.fileId !== doc.id && h.distance <= NEAREST_DISTANCE).map(h => h.fileId));
        near = [...ids]
          .map(id => facts.get(id))
          .filter((f): f is DupFacts => !!f && comparable(self, f) && !candidates.some(c => c.id === f.id))
          .slice(0, NEAREST_CANDIDATES);
      }
    }
    if (!candidates.length && !near.length) {
      await markChecked(doc);
      continue;
    }
    const own = await textOf(doc);
    if (own === undefined) break;
    let found: DupFacts | null = null;
    let deferred = false;
    let outOfReads = false;
    for (const [candidate, byText] of [...candidates.map(c => [c, false] as const), ...near.map(c => [c, true] as const)]) {
      const other = byId.get(candidate.id)!;
      // Its text is read only when there are two to compare
      const theirs = typeof own === 'string' ? textStateOf(other) : await textOf(other);
      if (theirs === undefined) {
        outOfReads = true;
        break;
      }
      const { verdict } = (byText ? compareByText : compare)(self, own, candidate, theirs);
      if (verdict === 'flag') {
        found = candidate;
        break;
      }
      if (verdict === 'defer') deferred = true;
    }
    if (outOfReads) break;
    if (found) {
      // Both wait for the next run
      if (flags >= DUP_FLAGS_PER_RUN) continue;
      const { copy, original } = copyAndOriginal(self, found);
      if (await flagInBacklog(drive, tree, copy.id, original.id)) {
        flags++;
        facts.set(copy.id, { ...copy, possibleDuplicateOf: original.id });
        if (copy.id !== doc.id) await markChecked(doc);
      }
    } else if (!deferred) {
      await markChecked(doc);
    }
  }
  return flags;
}

// The check is done for a document, unless it changed meanwhile
async function markChecked(doc: IndexedDoc): Promise<void> {
  const index = getIndex();
  await index.lock(doc.id, async () => {
    const current = await index.get(doc.id);
    if (current && current.md5 === doc.md5 && !current.possibleDuplicateOf) await index.put({ ...current, dupChecked: DUP_CHECK_VERSION });
  });
}

const dismissed = (a: Pick<IndexedDoc, 'id' | 'notDuplicates'>, b: Pick<IndexedDoc, 'id' | 'notDuplicates'>) =>
  !!a.notDuplicates?.includes(dupTag(b.id)) || !!b.notDuplicates?.includes(dupTag(a.id));

// An index entry brought in line with its Drive file after Paperwork changed only labels on it
async function putFromDrive(tree: Tree, file: DriveFile, current: IndexedDoc, extras: IndexExtras): Promise<void> {
  const next = fromDrive(tree, file, current, extras);
  await getIndex().put(headerChanged(current, next) ? { ...next, embedded: false } : next);
}

// Marks a document found by the backlog as a possible copy, where it is: an older one keeps its folder and its
// check (it shows in To check for the mark alone). Refused when anything changed since it was compared.
async function flagInBacklog(drive: Drive, tree: Tree, copyId: string, originalId: string): Promise<boolean> {
  const index = getIndex();
  if (busy.has(copyId)) return false;
  const marked = await index.lock(copyId, async () => {
    const current = await index.get(copyId);
    const original = await index.get(originalId);
    if (!current || !original || current.possibleDuplicateOf || original.possibleDuplicateOf) return null;
    const file = await getOrNull(drive, copyId);
    if (!file || !isFiledDocument(tree, file) || file.properties?.[P.maybeDup] || (current.md5 ?? null) !== (file.md5Checksum ?? null)) return null;
    if (dismissed({ id: copyId, notDuplicates: parseDupTags(file.properties?.[P.notDup]) }, original)) return null;
    const updated = await drive.update(copyId, { properties: { [P.maybeDup]: originalId } });
    await putFromDrive(tree, updated, current, { dupChecked: DUP_CHECK_VERSION });
    return { copy: current, original };
  });
  if (!marked) return false;
  // Its ticks stay its own until the owner says it is the same document (resolvePossibleDuplicate merges them then):
  // two different bills, kept both, would otherwise leave one ticked off unpaid
  await logActivity({ kind: 'edited', name: marked.copy.name, fileId: copyId, detail: `May be a copy of ${marked.original.title}; its deadlines aren’t counted until you check it` });
  return true;
}

// Marks put right: one whose original is gone for good (set aside, kept with another document) is taken off, so the
// copy is looked at again; one naming a document marked itself points to that one's original instead, and of two
// marked as each other's copy the earlier one is a document of its own again. One naming a document removed for
// now (a tombstone: it may come back) stays; the app and the MCP tools ignore it meanwhile.
async function repairMarks(drive: Drive, tree: Tree): Promise<void> {
  const index = getIndex();
  let writes = 0;
  for (const doc of await index.all()) {
    if (writes >= DUP_REPAIRS_PER_RUN) return;
    const of = doc.possibleDuplicateOf;
    if (!of || busy.has(doc.id)) continue;
    const original = await index.get(of);
    if (original && !original.possibleDuplicateOf) continue;
    let next: string | null = null;
    if (!original) {
      if ((await index.getAny(of))?.removedAt) continue;
    } else if (original.possibleDuplicateOf === doc.id) {
      if (copyAndOriginal(factsOf(doc), factsOf(original)).original.id !== doc.id) continue;
    } else {
      const further = await index.get(original.possibleDuplicateOf!);
      if (further && !further.possibleDuplicateOf && further.id !== doc.id && !dismissed(doc, further)) next = further.id;
    }
    if (await remark(drive, tree, doc.id, of, next)) writes++;
  }
}

// Changes a document's mark from `from` to `to` (null: none), while Drive still has the mark the index had; one Drive
// no longer has is taken from Drive into the index
async function remark(drive: Drive, tree: Tree, id: string, from: string, to: string | null): Promise<boolean> {
  const index = getIndex();
  return index.lock(id, async () => {
    const current = await index.get(id);
    if (!current || current.possibleDuplicateOf !== from) return false;
    const file = await getOrNull(drive, id);
    if (!file || !isFiledDocument(tree, file)) return false;
    if (file.properties?.[P.maybeDup] !== from) {
      await putFromDrive(tree, file, current, {});
      return false;
    }
    const updated = await drive.update(id, { properties: { [P.maybeDup]: to } });
    await putFromDrive(tree, updated, current, { dupChecked: to ? DUP_CHECK_VERSION : 0 });
    return true;
  });
}

// Deadlines ticked off on a copy stay ticked off on its original, whose deadlines are the ones counted
async function mergeDone(originalId: string, deadlines: Deadline[]): Promise<void> {
  if (!deadlines.some(d => d.done)) return;
  const index = getIndex();
  await index
    .lock(originalId, async () => {
      const original = await index.get(originalId);
      if (!original) return;
      const next = carryDone(original.deadlines, deadlines);
      if (next.some((d, i) => d.done !== original.deadlines[i].done)) await index.put({ ...original, deadlines: next });
    })
    .catch(err => console.warn(`Ticking off the deadlines of ${originalId} done on its copy failed:`, (err as Error)?.message));
}

// Why the owner's answer about a possible duplicate can't be carried out now
export class DuplicateProblem extends Error {}

// The document a possible copy is marked as a copy of, while both are documents in Paperwork and it is still the one
// the owner was shown (`shown`; a run may have moved the mark to that one's own original meanwhile)
async function flaggedOriginal(drive: Drive, tree: Tree, file: DriveFile, shown: string): Promise<DriveFile> {
  if (!isFiledDocument(tree, file)) throw new DriveError('This document is not in Paperwork.', 404);
  const of = file.properties?.[P.maybeDup];
  if (!of) throw new DuplicateProblem('This document isn’t marked as a possible duplicate any more.');
  if (of !== shown) throw new DuplicateProblem('Paperwork now thinks this may be a copy of another document. Compare it with that one first.');
  const original = of === file.id ? null : await getOrNull(drive, of);
  if (!original || !isFiledDocument(tree, original)) throw new DuplicateProblem('The document it may be a copy of is no longer in Paperwork, so it stays a document of its own.');
  return original;
}

// What the owner says about a possible duplicate of `of` (the original they were shown): two different documents
// (never asked about again), the same one (moved to Duplicates), or the same one kept as a file with the original
// (the paper scan next to the emailed PDF). The original keeps its name, place and labels; it only takes the
// deadlines ticked off on the copy, and its kept files.
export async function resolvePossibleDuplicate(id: string, choice: DuplicateChoice, of: string): Promise<DuplicateChoiceResult> {
  assertFiler('Deciding about a possible duplicate');
  if (busy.has(id)) throw new DuplicateProblem('Paperwork is reading this document right now. Try again in a moment.');
  if (choice === 'keep-both') return { choice, document: await updateDocument(id, { notDuplicate: true, duplicateOf: of }) };
  busy.add(id);
  try {
    const drive = getDrive();
    const tree = await loadTree(drive);
    const index = getIndex();
    if (choice === 'duplicate') {
      const { result, deadlines, originalId } = await index.lock(id, async () => {
        const file = await drive.get(id);
        const original = await flaggedOriginal(drive, tree, file, of);
        const entry = await index.get(id);
        const result = await moveToDuplicates({ drive, tree, documents: [] }, file, original, 'same-document', { locked: true });
        return { result, deadlines: entry?.deadlines ?? [], originalId: original.id };
      });
      await mergeDone(originalId, deadlines);
      return { choice, duplicateOf: result.duplicateOf, duplicatesFolderUrl: tree.duplicates?.webViewLink ?? null };
    }
    // attachExisting takes the document's lock itself; it refuses if the mark changed meanwhile (flaggedAs)
    const original = await flaggedOriginal(drive, tree, await drive.get(id), of);
    const entry = await index.get(id);
    const kept = await attachExisting(id, original.id, { label: copyLabel(), handOver: true, flaggedAs: original.id });
    await mergeDone(original.id, entry?.deadlines ?? []);
    return { choice, attachment: kept.attachment };
  } finally {
    busy.delete(id);
  }
}

const MAX_DEADLINES = 12;

// Deadlines as edited in the app: valid, described, without repeats (compared like normalizeDeadlines does)
export function cleanDeadlines(list: Deadline[]): Deadline[] {
  const seen = new Set<string>();
  const out: Deadline[] = [];
  for (const d of list) {
    const date = validDate(d?.date);
    const what = deadlineText(d?.what);
    const key = `${date}|${what.toLowerCase()}`;
    if (!date || !what || seen.has(key)) continue;
    seen.add(key);
    out.push({ date, what, done: !!d.done, ...(isDeadlineKind(d.kind) ? { kind: d.kind } : {}) });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, MAX_DEADLINES);
}

// ---------- Companies and topics ----------

// Renames a correspondent in all its documents, or a topic in all its documents (from every correspondent), in
// Drive and the index. Renaming to a name already in use merges the two.
export async function renameAll(request: RenameRequest): Promise<RenameResult> {
  assertFiler('Renaming');
  const topic = request.topic || null;
  if (topic) return mergeTopics({ from: [topic], to: request.to });
  const to = oneLine(request.to, 80);
  if (!to || !request.correspondent) throw new DriveGuardError('Say what to rename, and the new name.');
  const docs = (await getIndex().all()).filter(d => d.correspondent === request.correspondent);
  const result = await updateEach(docs, { correspondent: to });
  if (result.updated) await logRename(request.correspondent, to, result.updated);
  return result;
}

// Topics made one: every document of the `from` topics gets the topic `to`
export async function mergeTopics(merge: TopicMerge): Promise<RenameResult> {
  assertFiler('Merging topics');
  const to = oneLine(merge.to, 100);
  const from = new Set(merge.from.filter(t => t && t !== to));
  if (!to || !from.size) throw new DriveGuardError('Say which topics to merge, and the name they get.');
  const docs = (await getIndex().all()).filter(d => d.topic && from.has(d.topic));
  const result = await updateEach(docs, { topic: to });
  if (result.updated) await logRename([...from].join(', '), to, result.updated);
  return result;
}

// Moves every document of a topic into one folder, each as the Folder field does (its kept files go along): e.g.
// the documents of "Example UG formation" into Example UG/Eröffnungsbilanz. Documents already there are left
// alone, so `updated` counts those moved.
export async function moveTopic(topic: string, folderId: string): Promise<RenameResult> {
  assertFiler('Moving a topic');
  const tree = await loadTree(getDrive());
  // Checked before anything is written
  const folder = documentFolder(tree, folderId);
  // Already there: in that folder or, for a category, anywhere in it but a folder inside it
  const inPlace = (d: IndexedDoc) =>
    d.folderId === folder.id || (folder.role === 'category' && d.categoryId === folder.id && !isSubfolder(tree.folders.get(d.folderId ?? '')));
  const docs = (await getIndex().all()).filter(d => d.topic === topic && !inPlace(d));
  const result = await updateEach(docs, { folderId: folder.id });
  if (result.updated) {
    await logActivity({ kind: 'edited', name: topic, detail: `Moved ${result.updated} ${result.updated === 1 ? 'document' : 'documents'} to ${folder.path.join(' / ')}` });
  }
  return result;
}

async function updateEach(docs: IndexedDoc[], update: DocumentUpdate): Promise<RenameResult> {
  const result: RenameResult = { updated: 0, failed: 0 };
  for (const doc of docs) {
    try {
      await updateDocument(doc.id, update);
      result.updated++;
    } catch (err) {
      if (err instanceof LimitError || err instanceof NotConnectedError) throw err;
      console.warn(`Changing ${doc.name} failed:`, (err as Error).message);
      result.failed++;
    }
  }
  return result;
}

const logRename = (name: string, to: string, count: number) =>
  logActivity({ kind: 'edited', name, detail: `Renamed to ${to} in ${count} ${count === 1 ? 'document' : 'documents'}` });

// Documents given a topic and gist per run (one Gemini request for all of them)
const TOPICS_PER_RUN = 25;
// Documents Drive didn't take a topic for, and how often: left out after a few tries, so they aren't sent to
// Gemini again on every run (until the server restarts)
const topicFailures = new Map<string, number>();

// Documents filed before topics existed get one, from what the index knows about them, a batch per run. A
// correspondent's documents are taken together, so they end up under the same topics.
export async function fillTopics(options: { until?: number } = {}): Promise<number> {
  assertFiler('Giving documents topics');
  const all = await getIndex().all();
  const pending = all
    .filter(d => !d.described && (topicFailures.get(d.id) ?? 0) < 3)
    .sort((a, b) => (a.correspondent ?? '\uffff').localeCompare(b.correspondent ?? '\uffff') || (a.date ?? a.addedAt).localeCompare(b.date ?? b.addedAt))
    .slice(0, TOPICS_PER_RUN);
  if (!pending.length || (await backlogPaused())) return 0;
  const described = await describeTopics(pending.map(toInfo), knownNames(all.filter(d => d.described).map(toInfo)).topics);
  let done = 0;
  for (const doc of pending) {
    if (options.until && Date.now() > options.until) break;
    // One the answer left out is given none, so it isn't asked about again and again
    const { topic, gist } = described.get(doc.id) ?? { topic: null, gist: null };
    try {
      await updateDocument(doc.id, { topic, gist });
      done++;
    } catch (err) {
      if (err instanceof LimitError || err instanceof NotConnectedError) throw err;
      console.warn(`Giving ${doc.name} a topic failed:`, (err as Error).message);
      topicFailures.set(doc.id, (topicFailures.get(doc.id) ?? 0) + 1);
    }
  }
  return done;
}

// Receipts and invoices read per run (one Gemini request for all of them)
const ITEMS_PER_RUN = 5;
const PURCHASE_TYPES = new Set<DocumentType>(['receipt', 'invoice']);
// As topicFailures, for the items
const itemFailures = new Map<string, number>();

// Receipts and invoices filed before Paperwork read what was bought get their items, and the dates to return them
// by and until their warranty lasts, from their text in the index, newest first, a few per run. Nothing is moved
// or renamed; one without items is only marked as read.
export async function fillItems(options: { until?: number } = {}): Promise<number> {
  assertFiler('Reading the items of receipts');
  const index = getIndex();
  const pending = (await index.all())
    .filter(d => !d.itemsRead && d.type && PURCHASE_TYPES.has(d.type) && d.textSource && d.textSource !== 'none' && (itemFailures.get(d.id) ?? 0) < 3)
    .sort((a, b) => (b.date ?? b.addedAt).localeCompare(a.date ?? a.addedAt))
    .slice(0, ITEMS_PER_RUN);
  if (!pending.length || (await backlogPaused())) return 0;
  const texts = await Promise.all(
    pending.map(async doc => {
      const chunks = (await index.chunks(doc.id)).filter(c => c.n > 0).sort((a, b) => a.n - b.n);
      return { doc: toInfo(doc), text: joinChunks(chunks.map(c => c.text)) };
    })
  );
  const found = await describeItems(texts.filter(t => t.text.trim()));
  let done = 0;
  for (const doc of pending) {
    if (options.until && Date.now() > options.until) break;
    const { items, deadlines } = found.get(doc.id) ?? { items: [], deadlines: [] };
    try {
      await updateDocument(doc.id, { items, ...(deadlines.length ? { deadlines: withPurchaseDates(doc.deadlines, deadlines) } : {}) });
      done++;
    } catch (err) {
      if (err instanceof LimitError || err instanceof NotConnectedError) throw err;
      console.warn(`Reading the items of ${doc.name} failed:`, (err as Error).message);
      itemFailures.set(doc.id, (itemFailures.get(doc.id) ?? 0) + 1);
    }
  }
  return done;
}

// A document's deadlines with the return and warranty dates read later: one already there on the same day (read
// before, without its kind) becomes that date, the others are added
export function withPurchaseDates(current: Deadline[], found: Deadline[]): Deadline[] {
  const list = current.map(d => ({ ...d }));
  for (const date of found) {
    const same = list.find(d => d.date === date.date && !d.kind);
    if (same) Object.assign(same, { kind: date.kind, what: same.what === 'Due' ? date.what : same.what });
    else if (!list.some(d => d.date === date.date && d.kind === date.kind)) list.push(date);
  }
  return list;
}

// The due date and the deadlines describe the same dates (the due date is the main deadline), so an edit of
// one moves the other along: deadlines edited alone keep the due date on the main deadline (found by its
// description) or the soonest open one; a due date edited alone moves the main deadline, or adds one.
export function datesAfter(current: Pick<DocMeta, 'dueDate' | 'deadlines' | 'action'>, update: Pick<DocumentUpdate, 'dueDate' | 'deadlines'>): Pick<DocMeta, 'dueDate' | 'deadlines'> {
  const main = current.dueDate ? current.deadlines.find(d => d.date === current.dueDate) : undefined;
  if (update.deadlines !== undefined) {
    const deadlines = cleanDeadlines(update.deadlines);
    if (update.dueDate !== undefined) return { dueDate: validDate(update.dueDate), deadlines };
    // A due date that isn't one of the deadlines (older documents) stays as it is
    if (!current.dueDate || !main) return { dueDate: current.dueDate, deadlines };
    const same = deadlines.find(d => d.what.toLowerCase() === main.what.toLowerCase());
    return { dueDate: same?.date ?? deadlines.find(d => !d.done)?.date ?? null, deadlines };
  }
  if (update.dueDate === undefined) return { dueDate: current.dueDate, deadlines: current.deadlines };
  const dueDate = validDate(update.dueDate);
  const others = current.deadlines.filter(d => d !== main);
  if (!dueDate) return { dueDate, deadlines: others };
  const moved: Deadline = {
    date: dueDate,
    what: main?.what ?? (deadlineText(current.action) || 'Due'),
    done: main?.date === dueDate ? main.done : false,
    ...(main?.kind ? { kind: main.kind } : {}),
  };
  return { dueDate, deadlines: cleanDeadlines([...others, moved]) };
}

// Ticks a deadline off (or on again). Only the index knows; Drive keeps the dates in the description.
export async function setDeadlineDone(id: string, deadline: { date: string; what: string }, done: boolean): Promise<DocumentInfo> {
  assertFiler('Ticking off a deadline');
  const index = getIndex();
  return index.lock(id, async () => {
    const doc = await index.get(id);
    if (!doc) throw new DriveError('This document is not in Paperwork.', 404);
    const match = (d: Deadline) => d.date === deadline.date && d.what === deadline.what;
    if (!doc.deadlines.some(match)) throw new DriveError('This document has no such deadline.', 404);
    const next: IndexedDoc = { ...doc, deadlines: doc.deadlines.map(d => (match(d) ? { ...d, done } : d)) };
    await index.put(next);
    return toInfo(next);
  });
}

// The steps of a run that aren't exported, for tests of the edge's guard
export const filingStepsForTests = { runSync, fileOne, adoptOne };
