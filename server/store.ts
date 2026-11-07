// The little the app keeps outside Google Drive: the encrypted Drive connection, saved views, the activity
// log and the daily AI budget. Documents and everything known about them live in Drive (see vault.ts).
// STORAGE=firestore keeps these in Firestore (needed on Cloud Run, whose disk is wiped on every restart);
// otherwise JSON files under data/ are used, which suits local development.
import fs from 'fs';
import path from 'path';
import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';

let db: Firestore | null = null;

// The Firestore database, shared by the store and the search index (docIndex.ts)
export function firestore(): Firestore {
  if (!db) {
    const app = initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT || undefined }, 'paperwork-server');
    db = getFirestore(app, process.env.FIRESTORE_DB || '(default)');
    db.settings({ ignoreUndefinedProperties: true });
  }
  return db;
}

export interface Store {
  readonly name: string;
  get<T>(key: string): Promise<T | null>;
  set<T extends object>(key: string, value: T): Promise<void>;
  // Reads the value, changes it and writes it back as one step, also when another instance (the app and its public
  // edge) changes it at the same time: in Firestore a transaction. `change` gets a copy (null when there is none) and
  // returns what to write (`next`; undefined writes nothing) and what update() returns. It may run more than once
  // (Firestore tries a transaction again when the value changed meanwhile), so it only computes: no I/O, no
  // counters, no random IDs or timestamps of its own; those are made before calling update().
  update<T extends object, R>(key: string, change: (current: T | null) => { next?: T; result: R }): Promise<R>;
}

const KEY_PATTERN = /^[a-z0-9-]+$/;

function checkKey(key: string) {
  if (!KEY_PATTERN.test(key)) throw new Error(`Invalid store key: ${key}`);
}

// What Firestore takes as a document: an object, not a list, and no list right inside a list. The file and memory
// stores refuse the same, so a value Firestore would turn away fails in tests and locally too.
function checkValue(key: string, value: unknown) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Store value for ${key} must be an object, not ${Array.isArray(value) ? 'a list' : String(value === null ? null : typeof value)}`);
  }
  const listInList = (v: unknown, inList: boolean): boolean =>
    Array.isArray(v) ? inList || v.some(x => listInList(x, true)) : !!v && typeof v === 'object' && Object.values(v).some(x => listInList(x, false));
  if (listInList(value, false)) throw new Error(`Store value for ${key} has a list right inside a list, which Firestore can't store`);
}

// ---------- Files ----------

export class FileStore implements Store {
  readonly name = 'files';

  constructor(private dir = path.resolve(process.cwd(), 'data')) {}

  async get<T>(key: string): Promise<T | null> {
    checkKey(key);
    try {
      return JSON.parse(await fs.promises.readFile(path.join(this.dir, `${key}.json`), 'utf-8'));
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async set<T extends object>(key: string, value: T): Promise<void> {
    checkKey(key);
    checkValue(key, value);
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${key}.json`);
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), 'utf-8');
    await fs.promises.rename(`${file}.tmp`, file);
  }

  // The update under way per key; the next one waits for it. One process only: two roles run locally need
  // STORAGE=firestore.
  private updates = new Map<string, Promise<unknown>>();

  async update<T extends object, R>(key: string, change: (current: T | null) => { next?: T; result: R }): Promise<R> {
    checkKey(key);
    const run = (this.updates.get(key) ?? Promise.resolve()).then(async () => {
      const out = change(await this.get<T>(key));
      if (out.next !== undefined) await this.set(key, out.next);
      return out.result;
    });
    const settled = run.catch(() => {});
    this.updates.set(key, settled);
    settled.then(() => {
      if (this.updates.get(key) === settled) this.updates.delete(key);
    });
    return run;
  }
}

// ---------- Firestore ----------

// One collection, one document per key: paperwork/connection, paperwork/settings, paperwork/activity,
// paperwork/usage-YYYY-MM-DD, paperwork/drive-changes, paperwork/mcp-access and more. Only the server reads and writes it; firestore.rules
// shut out browsers. The search index has collections of its own (docIndex.ts).
const COLLECTION = 'paperwork';

export class FirestoreStore implements Store {
  readonly name = 'firestore';
  private firestore = firestore();

  async get<T>(key: string): Promise<T | null> {
    checkKey(key);
    const snap = await this.firestore.collection(COLLECTION).doc(key).get();
    return snap.exists ? (snap.data() as T) : null;
  }

  async set<T extends object>(key: string, value: T): Promise<void> {
    checkKey(key);
    await this.firestore.collection(COLLECTION).doc(key).set(value);
  }

  async update<T extends object, R>(key: string, change: (current: T | null) => { next?: T; result: R }): Promise<R> {
    checkKey(key);
    const ref = this.firestore.collection(COLLECTION).doc(key);
    return this.firestore.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const out = change(snap.exists ? (structuredClone(snap.data()) as T) : null);
      if (out.next !== undefined) tx.set(ref, out.next);
      return out.result;
    });
  }
}

// ---------- Memory (tests) ----------

export class MemoryStore implements Store {
  readonly name = 'memory';
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | null> {
    const value = this.data.get(key);
    return value === undefined ? null : (structuredClone(value) as T);
  }

  async set<T extends object>(key: string, value: T): Promise<void> {
    checkValue(key, value);
    this.data.set(key, structuredClone(value));
  }

  // Read, change and write with nothing in between, so atomic within the process
  async update<T extends object, R>(key: string, change: (current: T | null) => { next?: T; result: R }): Promise<R> {
    checkKey(key);
    const value = this.data.get(key);
    const out = change(value === undefined ? null : (structuredClone(value) as T));
    if (out.next !== undefined) {
      checkValue(key, out.next);
      this.data.set(key, structuredClone(out.next));
    }
    return out.result;
  }
}

let store: Store | null = null;

export function getStore(): Store {
  store ??= process.env.STORAGE === 'firestore' ? new FirestoreStore() : new FileStore();
  return store;
}

export function setStoreForTests(next: Store) {
  store = next;
}
