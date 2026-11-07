// Writing documents into the search index (docIndex.ts): their full details, deadlines, text and embeddings.
//
// Drive is the source of truth for names, folders and labels; what Drive can't hold (deadlines and whether
// they're done, the text, values longer than a Drive label) the index adds. `fromDrive` merges the two, so a
// document renamed, moved or starred in Drive shows up that way without losing what only the index knows.
// Failures here never undo a filing: a document that couldn't be indexed is picked up again later (sync.ts).
import { Deadline, DocumentInfo, IndexStatus, TextSource } from '../shared/types.js';
import { DriveFile } from './drive.js';
import { embed } from './gemini.js';
import { Chunk, IndexedDoc, getIndex } from './docIndex.js';
import { MAX_TEXT_CHARS, headerText, splitText } from './text.js';
import { Tree, toDocumentInfo } from './vault.js';
import { P, TOPICS_VERSION, parseDupTags } from './metadata.js';

// Text chunks per document (about 150,000 characters); longer documents are indexed from the start
const MAX_TEXT_CHUNKS = 45;

// What filing or editing knows beyond the Drive file
export interface IndexExtras {
  // Values at full length (Drive labels shorten long ones)
  title?: string;
  correspondent?: string | null;
  references?: string | null;
  action?: string | null;
  tags?: string[];
  topic?: string | null;
  gist?: string | null;
  deadlines?: Deadline[];
  // The deadlines come from an edit in the app, done flags included, rather than from reading the document
  deadlinesAsGiven?: boolean;
  // The document's text, when it was just read; undefined keeps the indexed text
  text?: { text: string; source: TextSource };
  // The check for possible copies is done (duplicates.ts DUP_CHECK_VERSION), or to be done again (0); undefined
  // keeps the mark, unless the content changed
  dupChecked?: number;
}

// Keeps a value the index has in full when Drive holds a shortened copy of it ("Customer: 8812…")
function untruncate(fromDrive: string | null, indexed: string | null | undefined): string | null {
  if (!fromDrive || !indexed || !fromDrive.endsWith('…')) return fromDrive;
  return indexed.startsWith(fromDrive.slice(0, -1)) ? indexed : fromDrive;
}

const deadlineKey = (d: Pick<Deadline, 'date' | 'what'>) => `${d.date}|${d.what.trim().toLowerCase()}`;

// New deadlines keep the "done" of the same deadline before (same date and description)
export function carryDone(next: Deadline[], previous: Deadline[] | undefined): Deadline[] {
  const done = new Set((previous ?? []).filter(d => d.done).map(deadlineKey));
  return next.map(d => ({ ...d, done: d.done || done.has(deadlineKey(d)) }));
}

// The index entry for a Drive file, keeping what only the index knows
export function fromDrive(tree: Tree, file: DriveFile, previous: IndexedDoc | null, extras: IndexExtras = {}): IndexedDoc {
  const base: DocumentInfo = toDocumentInfo(tree, file);
  const tagsFromDrive = base.tags;
  const previousTagsFit = previous && tagsFromDrive.length && previous.tags.join(',').startsWith(tagsFromDrive.join(',').replace(/…$/, ''));
  const deadlines = extras.deadlines ?? previous?.deadlines ?? base.deadlines;
  // A file whose content changed in Drive (a new version uploaded by hand) is read again: its indexed text and
  // embeddings are of the old content
  const contentChanged = !!previous?.md5 && !!file.md5Checksum && previous.md5 !== file.md5Checksum && !extras.text;
  const kept = previous && !contentChanged ? previous : null;
  // The owner's "Keep both" answers live in Drive
  const notDuplicates = parseDupTags(file.properties?.[P.notDup]);
  return {
    ...base,
    title: extras.title ?? untruncate(base.title, previous?.title) ?? base.title,
    correspondent: extras.correspondent !== undefined ? extras.correspondent : untruncate(base.correspondent, previous?.correspondent),
    references: extras.references !== undefined ? extras.references : untruncate(base.references, previous?.references),
    action: extras.action !== undefined ? extras.action : untruncate(base.action, previous?.action),
    topic: extras.topic !== undefined ? extras.topic : untruncate(base.topic, previous?.topic),
    gist: extras.gist !== undefined ? extras.gist : base.gist,
    tags: extras.tags ?? (previousTagsFit && tagsFromDrive.at(-1)?.endsWith('…') ? previous!.tags : tagsFromDrive),
    deadlines: extras.deadlinesAsGiven ? deadlines : carryDone(deadlines, previous?.deadlines),
    textSource: extras.text ? extras.text.source : (kept?.textSource ?? null),
    textLength: extras.text ? extras.text.text.length : (kept?.textLength ?? 0),
    md5: file.md5Checksum ?? previous?.md5 ?? null,
    embedded: kept?.embedded ?? false,
    indexedAt: previous?.indexedAt ?? new Date().toISOString(),
    described: Number(file.properties?.[P.version] ?? 0) >= TOPICS_VERSION,
    itemsRead: file.properties?.[P.itemsRead] === '1',
    ...(kept?.indexTries ? { indexTries: kept.indexTries } : {}),
    ...(notDuplicates.length ? { notDuplicates } : {}),
    ...(extras.dupChecked !== undefined ? { dupChecked: extras.dupChecked } : kept?.dupChecked ? { dupChecked: kept.dupChecked } : {}),
  };
}

// The fields the index's first chunk (and so semantic search) is built from
const HEADER_FIELDS = ['title', 'type', 'correspondent', 'date', 'amount', 'currency', 'category', 'tags', 'references', 'deadlines', 'items', 'action', 'summary', 'topic', 'gist'] as const;

// Ticking a deadline off doesn't change the header text (it has no done marks), so it isn't compared. Entries
// indexed before items were read have none, as documents without items do.
const headerValue = (doc: IndexedDoc, k: (typeof HEADER_FIELDS)[number]) =>
  JSON.stringify(k === 'deadlines' ? doc.deadlines.map(d => [d.date, d.what]) : k === 'items' ? (doc.items ?? []) : doc[k]);

export function headerChanged(a: IndexedDoc | null, b: IndexedDoc): boolean {
  return !a || HEADER_FIELDS.some(k => headerValue(a, k) !== headerValue(b, k));
}

// Fields that change what the app shows; an update without any of these isn't written
const SHOWN_FIELDS = [
  ...HEADER_FIELDS,
  'name',
  'mimeType',
  'categoryId',
  'inInbox',
  'folderPath',
  'folderId',
  'dueDate',
  'needsReview',
  'starred',
  'source',
  'modifiedAt',
  'size',
  'hasThumbnail',
  'textSource',
  'textLength',
  'md5',
  'possibleDuplicateOf',
  // Not shown, but whether the document still needs a topic, or its items read, must be kept; so must the
  // documents the owner said it is no copy of
  'described',
  'itemsRead',
  'notDuplicates',
] as const;

export function changed(a: IndexedDoc | null, b: IndexedDoc): boolean {
  return !a || SHOWN_FIELDS.some(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

async function embedOrNull(texts: string[]): Promise<(number[] | null)[]> {
  try {
    return await embed(texts, 'RETRIEVAL_DOCUMENT');
  } catch (err) {
    console.warn('Embedding failed; the document is searchable by words until it is retried:', (err as Error).message);
    return texts.map(() => null);
  }
}

// Writes a document with its text: chunk 0 for its details, the rest for its text
export async function indexWithText(doc: IndexedDoc, text: string): Promise<IndexedDoc> {
  const pieces = splitText(text.slice(0, MAX_TEXT_CHARS));
  if (pieces.length > MAX_TEXT_CHUNKS) console.warn(`${doc.name}: only the first ${MAX_TEXT_CHUNKS} of ${pieces.length} text pieces are indexed.`);
  const texts = [headerText(doc), ...pieces.slice(0, MAX_TEXT_CHUNKS)];
  const vectors = await embedOrNull(texts);
  const chunks: Chunk[] = texts.map((t, n) => ({ fileId: doc.id, n, text: t, embedding: vectors[n] }));
  const next: IndexedDoc = { ...doc, embedded: vectors.every(Boolean), indexedAt: new Date().toISOString(), indexTries: 0 };
  const index = getIndex();
  await index.putChunks(doc.id, chunks, 'all');
  await index.put(next);
  return next;
}

// Writes a document whose text is unchanged; its first chunk is embedded again when its details changed
export async function indexDetails(doc: IndexedDoc, previous: IndexedDoc | null): Promise<IndexedDoc> {
  const index = getIndex();
  if (!headerChanged(previous, doc) && previous?.embedded) {
    await index.put(doc);
    return doc;
  }
  const [vector] = await embedOrNull([headerText(doc)]);
  await index.putChunks(doc.id, [{ fileId: doc.id, n: 0, text: headerText(doc), embedding: vector }], 'merge');
  // Text chunks that were never embedded (or are of content since changed) are left for the next sync
  const next: IndexedDoc = { ...doc, embedded: !!vector && (doc.embedded || doc.textSource === 'none') };
  await index.put(next);
  return next;
}

// Embeds the chunks that have no embedding yet (after a failed or budget-limited attempt)
export async function embedMissing(doc: IndexedDoc): Promise<IndexedDoc> {
  const index = getIndex();
  const chunks = await index.chunks(doc.id, true);
  const header: Chunk = { fileId: doc.id, n: 0, text: headerText(doc), embedding: null };
  const all = chunks.some(c => c.n === 0) ? chunks.map(c => (c.n === 0 ? { ...header, embedding: c.text === header.text ? c.embedding : null } : c)) : [header, ...chunks];
  const missing = all.filter(c => !c.embedding);
  if (missing.length) {
    const vectors = await embed(missing.map(c => c.text), 'RETRIEVAL_DOCUMENT');
    missing.forEach((c, i) => (c.embedding = vectors[i]));
    await index.putChunks(doc.id, missing, 'merge');
  }
  const next = { ...doc, embedded: true };
  await index.put(next);
  return next;
}

// Failed attempts at reading a document for the index, after which it is left as it is (still listed, found by
// its details, but without its text)
export const MAX_INDEX_TRIES = 3;

export const isIndexed = (d: IndexedDoc) => d.textSource !== null && d.embedded;
export const isPending = (d: IndexedDoc) => !isIndexed(d) && (d.indexTries ?? 0) < MAX_INDEX_TRIES;

// `paused`: indexing waits for tomorrow's Gemini budget (sync.ts)
export function indexStatus(docs: IndexedDoc[], paused = false): IndexStatus {
  return {
    documents: docs.length,
    searchable: docs.filter(isIndexed).length,
    pending: docs.filter(isPending).length,
    paused,
    topicsPending: docs.filter(d => !d.described).length,
  };
}

// What the app gets: the index entry without index bookkeeping
export function toInfo(doc: IndexedDoc): DocumentInfo {
  const { md5: _md5, embedded: _embedded, indexedAt: _indexedAt, indexTries: _indexTries, removedAt: _removedAt, described: _described, itemsRead: _itemsRead, storedAt: _storedAt, notDuplicates: _notDuplicates, dupChecked: _dupChecked, ...info } = doc;
  return info;
}
