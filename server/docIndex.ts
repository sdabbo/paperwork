// Paperwork's search index: everything known about each filed document, plus its text in chunks with
// embeddings (vectors) for semantic search. Google Drive stays the source of truth for the files, their names,
// folders and labels; the index is rebuilt from Drive when it is missing or out of date (sync.ts). Removing an
// entry here never touches Drive.
//
// Firestore (STORAGE=firestore):
//   paperworkDocs/{fileId}           one document's metadata, deadlines and index state (IndexedDoc)
//   paperworkChunks/{fileId}_{n}     n = 0: title, facts and summary; n ≥ 1: the document's text, in pieces;
//                                    each with a 768-number embedding, found with Firestore's vector search
//                                    (needs the vector index that deploy/setup.sh creates)
// Locally, the same lives in data/index/ as JSON, searched in memory.
//
// The server keeps all document entries in memory (one Cloud Run instance at most, and the only writer), so
// listing the library reads nothing from Firestore after the first load. The public edge (roles.ts) keeps a copy it
// never writes, a follower: it reads the entries stored since it last looked every 30 seconds while in use (each
// write stamps storedAt), and all of them every 15 minutes, which also drops entries purged for good.
import fs from 'fs';
import path from 'path';
import { FieldValue, Firestore, WriteBatch } from 'firebase-admin/firestore';
import { DocumentInfo } from '../shared/types.js';
import { config } from './config.js';
import { FilerOnly } from './roles.js';
import { firestore } from './store.js';

export interface IndexedDoc extends DocumentInfo {
  // Whether Drive has its topic and gist (metadata.ts SCHEMA_VERSION 2); older documents are given them by
  // sync.ts fillTopics
  described?: boolean;
  // Whether the items bought were looked for (metadata.ts P.itemsRead); receipts and invoices filed before
  // Paperwork read them get them from pipeline.ts fillItems
  itemsRead?: boolean;
  md5: string | null;
  // The chunks have embeddings (false after a failed or skipped embedding; retried later)
  embedded: boolean;
  indexedAt: string;
  // Failed attempts at reading the text or embedding; after a few, the document is left as it is
  indexTries?: number;
  // When it left Paperwork in Drive; kept for a while so it comes back whole if it returns
  removedAt?: string;
  // When this entry was last written (by the writer's clock), so a follower reads only what changed
  storedAt?: string;
  // Documents the owner said this one is no copy of (Drive's pwNotDup, metadata.ts dupTag)
  notDuplicates?: string[];
  // The check for possible copies (duplicates.ts DUP_CHECK_VERSION) is done for this content; index-only, so a
  // rebuilt index checks again (with the same answers: the owner's are in Drive)
  dupChecked?: number;
}

export interface Chunk {
  fileId: string;
  n: number;
  text: string;
  embedding: number[] | null;
}

export interface ChunkHit {
  fileId: string;
  n: number;
  text: string;
  // Cosine distance: 0 is identical, 2 is opposite
  distance: number;
}

export interface IndexBackend {
  readonly name: string;
  loadAll(): Promise<IndexedDoc[]>;
  // Entries written at or after `since` (their storedAt); entries written before storedAt existed are left out
  loadChangedSince(since: string): Promise<IndexedDoc[]>;
  putDoc(doc: IndexedDoc): Promise<void>;
  removeDoc(fileId: string): Promise<void>;
  // 'all' replaces every chunk of the file; 'merge' writes the given chunks and keeps the others
  putChunks(fileId: string, chunks: Chunk[], mode: 'all' | 'merge'): Promise<void>;
  // Without `withEmbeddings`, a chunk's embedding may be left out (null) to save reading it
  getChunks(fileId: string, withEmbeddings?: boolean): Promise<Chunk[]>;
  nearest(vector: number[], limit: number): Promise<ChunkHit[]>;
}

export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? 1 - dot / Math.sqrt(na * nb) : 2;
}

// ---------- Memory (tests) ----------

export class MemoryIndexBackend implements IndexBackend {
  readonly name: string = 'memory';
  docs = new Map<string, IndexedDoc>();
  chunks = new Map<string, Chunk[]>();

  async loadAll() {
    return [...this.docs.values()].map(d => structuredClone(d));
  }
  async loadChangedSince(since: string) {
    return [...this.docs.values()].filter(d => d.storedAt !== undefined && d.storedAt >= since).map(d => structuredClone(d));
  }
  async putDoc(doc: IndexedDoc) {
    this.docs.set(doc.id, structuredClone(doc));
  }
  async removeDoc(fileId: string) {
    this.docs.delete(fileId);
    this.chunks.delete(fileId);
  }
  async putChunks(fileId: string, chunks: Chunk[], mode: 'all' | 'merge') {
    const replaced = new Set(chunks.map(c => c.n));
    const kept = mode === 'all' ? [] : (this.chunks.get(fileId) ?? []).filter(c => !replaced.has(c.n));
    this.chunks.set(fileId, [...kept, ...chunks.map(c => structuredClone(c))].sort((a, b) => a.n - b.n));
  }
  async getChunks(fileId: string) {
    return (this.chunks.get(fileId) ?? []).map(c => structuredClone(c));
  }
  async nearest(vector: number[], limit: number) {
    const hits: ChunkHit[] = [];
    for (const list of this.chunks.values()) {
      for (const c of list) {
        if (c.embedding && c.embedding.length === vector.length) hits.push({ fileId: c.fileId, n: c.n, text: c.text, distance: cosineDistance(vector, c.embedding) });
      }
    }
    return hits.sort((a, b) => a.distance - b.distance).slice(0, limit);
  }
}

// ---------- Files (local development) ----------

export class FileIndexBackend extends MemoryIndexBackend {
  override readonly name = 'files';
  private loading: Promise<void> | null = null;

  constructor(private dir = path.resolve(process.cwd(), 'data', 'index')) {
    super();
  }

  // Every call waits for the same first read, so nothing runs (or saves) on an index that isn't loaded yet.
  // A file that can't be read is tried again on the next call rather than overwritten.
  private load(): Promise<void> {
    this.loading ??= this.read().catch(err => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async read() {
    try {
      const stored = JSON.parse(await fs.promises.readFile(path.join(this.dir, 'index.json'), 'utf-8'));
      for (const d of stored.docs ?? []) this.docs.set(d.id, d);
      for (const [id, list] of Object.entries(stored.chunks ?? {})) this.chunks.set(id, list as Chunk[]);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  private saving: Promise<void> = Promise.resolve();

  // One save at a time, since they share the temporary file; each writes everything in memory at that moment
  private save(): Promise<void> {
    const next = this.saving.then(() => this.write());
    this.saving = next.catch(() => {});
    return next;
  }

  private async write() {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, 'index.json');
    const body = JSON.stringify({ docs: [...this.docs.values()], chunks: Object.fromEntries(this.chunks) });
    await fs.promises.writeFile(`${file}.tmp`, body, 'utf-8');
    await fs.promises.rename(`${file}.tmp`, file);
  }

  override async loadAll() {
    await this.load();
    return super.loadAll();
  }
  override async loadChangedSince(since: string) {
    await this.load();
    return super.loadChangedSince(since);
  }
  override async putDoc(doc: IndexedDoc) {
    await this.load();
    await super.putDoc(doc);
    await this.save();
  }
  override async removeDoc(fileId: string) {
    await this.load();
    await super.removeDoc(fileId);
    await this.save();
  }
  override async putChunks(fileId: string, chunks: Chunk[], mode: 'all' | 'merge') {
    await this.load();
    await super.putChunks(fileId, chunks, mode);
    await this.save();
  }
  override async getChunks(fileId: string) {
    await this.load();
    return super.getChunks(fileId);
  }
  override async nearest(vector: number[], limit: number) {
    await this.load();
    return super.nearest(vector, limit);
  }
}

// ---------- Firestore ----------

export const DOCS_COLLECTION = 'paperworkDocs';
export const CHUNKS_COLLECTION = 'paperworkChunks';
const MAX_BATCH = 400;

const chunkId = (fileId: string, n: number) => `${fileId}_${n}`;

export class FirestoreIndexBackend implements IndexBackend {
  readonly name = 'firestore';
  private firestore: Firestore = firestore();

  async loadAll(): Promise<IndexedDoc[]> {
    const snap = await this.firestore.collection(DOCS_COLLECTION).get();
    return snap.docs.map(d => d.data() as IndexedDoc);
  }

  // A single-field range: Firestore indexes it on its own
  async loadChangedSince(since: string): Promise<IndexedDoc[]> {
    const snap = await this.firestore.collection(DOCS_COLLECTION).where('storedAt', '>=', since).get();
    return snap.docs.map(d => d.data() as IndexedDoc);
  }

  async putDoc(doc: IndexedDoc) {
    await this.firestore.collection(DOCS_COLLECTION).doc(doc.id).set(JSON.parse(JSON.stringify(doc)));
  }

  async removeDoc(fileId: string) {
    const chunks = await this.firestore.collection(CHUNKS_COLLECTION).where('fileId', '==', fileId).select().get();
    const refs = [this.firestore.collection(DOCS_COLLECTION).doc(fileId), ...chunks.docs.map(d => d.ref)];
    for (let i = 0; i < refs.length; i += MAX_BATCH) {
      const batch = this.firestore.batch();
      for (const ref of refs.slice(i, i + MAX_BATCH)) batch.delete(ref);
      await batch.commit();
    }
  }

  async putChunks(fileId: string, chunks: Chunk[], mode: 'all' | 'merge') {
    const writes: ((b: WriteBatch) => void)[] = [];
    if (mode === 'all') {
      const keep = new Set(chunks.map(c => chunkId(fileId, c.n)));
      const existing = await this.firestore.collection(CHUNKS_COLLECTION).where('fileId', '==', fileId).select().get();
      for (const d of existing.docs) if (!keep.has(d.id)) writes.push(b => b.delete(d.ref));
    }
    for (const c of chunks) {
      const ref = this.firestore.collection(CHUNKS_COLLECTION).doc(chunkId(fileId, c.n));
      writes.push(b => b.set(ref, { fileId, n: c.n, text: c.text, ...(c.embedding ? { embedding: FieldValue.vector(c.embedding) } : {}) }));
    }
    for (let i = 0; i < writes.length; i += MAX_BATCH) {
      const batch = this.firestore.batch();
      writes.slice(i, i + MAX_BATCH).forEach(w => w(batch));
      await batch.commit();
    }
  }

  async getChunks(fileId: string, withEmbeddings = false): Promise<Chunk[]> {
    const query = this.firestore.collection(CHUNKS_COLLECTION).where('fileId', '==', fileId);
    const snap = await (withEmbeddings ? query : query.select('n', 'text')).get();
    return snap.docs
      .map(d => {
        const data = d.data();
        return { fileId, n: data.n as number, text: data.text as string, embedding: data.embedding?.toArray?.() ?? null };
      })
      .sort((a, b) => a.n - b.n);
  }

  async nearest(vector: number[], limit: number): Promise<ChunkHit[]> {
    const snap = await this.firestore
      .collection(CHUNKS_COLLECTION)
      .findNearest({ vectorField: 'embedding', queryVector: vector, limit, distanceMeasure: 'COSINE', distanceResultField: 'distance' })
      .get();
    return snap.docs.map(d => ({ fileId: d.get('fileId'), n: d.get('n'), text: d.get('text'), distance: d.get('distance') }));
  }
}

// ---------- The index, cached in memory ----------

// Removed documents (deleted, trashed or moved out in Drive) stay as tombstones for this long, with their
// deadlines, done flags and text, so a document that comes back (restored from the trash, moved back) is whole
const KEEP_REMOVED_MS = 30 * 24 * 60 * 60 * 1000;

// A follower looks for changed entries this often while in use, and reads all of them this often
export const FOLLOW_CHECK_MS = 30 * 1000;
export const FOLLOW_FULL_MS = 15 * 60 * 1000;
// Entries stored this long before the newest one seen are read again: writes may become visible out of order
const FOLLOW_OVERLAP_MS = 2 * 60 * 1000;

const newest = (docs: IndexedDoc[], than = '') => docs.reduce((max, d) => (d.storedAt && d.storedAt > max ? d.storedAt : max), than);

export class DocIndex {
  private docs: Map<string, IndexedDoc> | null = null;
  private loading: Promise<Map<string, IndexedDoc>> | null = null;
  // The write under way per document; the next one waits for it (see lock)
  private locks = new Map<string, Promise<unknown>>();
  // Follower only: when everything was last read, when changes were last looked for, the newest storedAt seen
  private loadedAt = 0;
  private checkedAt = 0;
  private seen = '';
  private freshening: Promise<void> | null = null;

  constructor(
    readonly backend: IndexBackend,
    // A follower only reads (the public edge): another process writes
    readonly options: { follower?: boolean } = {}
  ) {}

  private async map(): Promise<Map<string, IndexedDoc>> {
    if (this.docs) return this.docs;
    this.loading ??= this.loadAll().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async loadAll(now = Date.now()): Promise<Map<string, IndexedDoc>> {
    const all = await this.backend.loadAll();
    this.docs = new Map(all.map(d => [d.id, d]));
    this.loadedAt = this.checkedAt = now;
    this.seen = newest(all);
    return this.docs;
  }

  private assertWriter(what: string) {
    if (this.options.follower) throw new FilerOnly(`${what} is done by Paperwork's app, not by its public edge.`);
  }

  // A follower's copy brought up to date before it is used: changed entries (tombstones included) at most every
  // 30 seconds, everything every 15 minutes. Requests arriving together share one look. Nothing for the writer.
  ensureFresh(now = Date.now()): Promise<void> {
    if (!this.options.follower) return Promise.resolve();
    this.freshening ??= this.freshen(now).finally(() => {
      this.freshening = null;
    });
    return this.freshening;
  }

  private async freshen(now: number): Promise<void> {
    if (!this.docs || now - this.loadedAt >= FOLLOW_FULL_MS) {
      await this.loadAll(now);
      return;
    }
    if (now - this.checkedAt < FOLLOW_CHECK_MS) return;
    const since = this.seen ? new Date(Date.parse(this.seen) - FOLLOW_OVERLAP_MS).toISOString() : '';
    const changed = await this.backend.loadChangedSince(since);
    for (const d of changed) this.docs.set(d.id, d);
    this.seen = newest(changed, this.seen);
    this.checkedAt = now;
  }

  // Runs `fn` when no other change to the same document is under way. Every read-change-write of an entry goes
  // through here, so a deadline ticked off while the document's text is being read isn't overwritten by the
  // older copy the reading started from.
  lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const before = this.locks.get(id) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const settled = run.catch(() => {});
    this.locks.set(id, settled);
    settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return run;
  }

  // Documents in Paperwork (tombstones left out)
  async all(): Promise<IndexedDoc[]> {
    return [...(await this.map()).values()].filter(d => !d.removedAt);
  }

  async get(id: string): Promise<IndexedDoc | null> {
    const doc = (await this.map()).get(id);
    return doc && !doc.removedAt ? doc : null;
  }

  // Including a tombstone, to bring a document back as it was
  async getAny(id: string): Promise<IndexedDoc | null> {
    return (await this.map()).get(id) ?? null;
  }

  // Every write of an entry goes through here (remove() too), stored with when it was stored (for followers)
  async put(doc: IndexedDoc): Promise<void> {
    this.assertWriter('Writing the index');
    const docs = await this.map();
    await this.backend.putDoc({ ...doc, storedAt: new Date().toISOString() });
    docs.set(doc.id, doc);
  }

  // Leaves a tombstone (see KEEP_REMOVED_MS); purge() removes it for good
  async remove(id: string): Promise<void> {
    this.assertWriter('Removing from the index');
    const doc = await this.get(id);
    if (doc) await this.put({ ...doc, removedAt: new Date().toISOString() });
  }

  async purge(id: string): Promise<void> {
    this.assertWriter('Removing from the index');
    const docs = await this.map();
    await this.backend.removeDoc(id);
    docs.delete(id);
  }

  // Tombstones older than KEEP_REMOVED_MS are removed for good
  async purgeOld(now = Date.now()): Promise<number> {
    this.assertWriter('Removing from the index');
    let purged = 0;
    for (const doc of (await this.map()).values()) {
      if (doc.removedAt && now - Date.parse(doc.removedAt) > KEEP_REMOVED_MS) {
        await this.lock(doc.id, () => this.purge(doc.id));
        purged++;
      }
    }
    return purged;
  }

  async putChunks(fileId: string, chunks: Chunk[], mode: 'all' | 'merge' = 'all'): Promise<void> {
    this.assertWriter('Writing the index');
    return this.backend.putChunks(fileId, chunks, mode);
  }

  // The text of a document's chunks; with `withEmbeddings`, their embeddings too
  chunks(fileId: string, withEmbeddings = false): Promise<Chunk[]> {
    return this.backend.getChunks(fileId, withEmbeddings);
  }

  async nearest(vector: number[], limit: number): Promise<ChunkHit[]> {
    const docs = await this.map();
    // Chunks of documents not (or no longer) in Paperwork don't count
    return (await this.backend.nearest(vector, limit)).filter(h => {
      const doc = docs.get(h.fileId);
      return !!doc && !doc.removedAt;
    });
  }

  // Reads the stored entries again and brings the cache in line with them: entries removed from the store from
  // outside (e.g. to rebuild the index) leave the cache, entries the cache lacks are added. Writes under way
  // are unaffected: each puts its entry back into the cache once it is stored. A follower reads everything anew.
  async refresh(): Promise<void> {
    if (this.options.follower) {
      await this.loadAll();
      return;
    }
    const docs = await this.map();
    const stored = await this.backend.loadAll();
    const ids = new Set(stored.map(d => d.id));
    for (const id of [...docs.keys()]) if (!ids.has(id) && !this.locks.has(id)) docs.delete(id);
    for (const d of stored) if (!docs.has(d.id)) docs.set(d.id, d);
  }

  // Forgets the cache, e.g. in tests
  reset() {
    this.docs = null;
  }
}

let index: DocIndex | null = null;

export function getIndex(): DocIndex {
  index ??= new DocIndex(process.env.STORAGE === 'firestore' ? new FirestoreIndexBackend() : new FileIndexBackend(), { follower: config.role === 'edge' });
  return index;
}

export function setIndexForTests(next: DocIndex) {
  index = next;
}
