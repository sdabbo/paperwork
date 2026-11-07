// The store's read-change-write (update): what the app and its public edge share without losing each other's changes.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore, MemoryStore, Store, setStoreForTests } from './store.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
});

function fileStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperwork-store-'));
  dirs.push(dir);
  return { store: new FileStore(dir), dir };
}

const stores: [string, () => Store][] = [
  ['in memory', () => new MemoryStore()],
  ['in files', () => fileStore().store],
];

describe.each(stores)('update, %s', (_name, make) => {
  it('keeps every one of many changes made at the same time', async () => {
    const store = make();
    const add = () => store.update<{ count: number }, number>('counter', current => {
      const count = (current?.count ?? 0) + 1;
      return { next: { count }, result: count };
    });
    const results = await Promise.all(Array.from({ length: 50 }, add));
    expect(await store.get('counter')).toEqual({ count: 50 });
    expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('writes nothing when there is nothing to write, and returns the result either way', async () => {
    const store = make();
    expect(await store.update('untouched', current => ({ result: current === null ? 'none yet' : 'some' }))).toBe('none yet');
    expect(await store.get('untouched')).toBeNull();

    await store.set('kept', { value: 1 });
    expect(await store.update<{ value: number }, number>('kept', current => ({ result: current!.value + 1 }))).toBe(2);
    expect(await store.get('kept')).toEqual({ value: 1 });
  });

  it('hands the change a copy, so a failed change leaves the stored value as it was', async () => {
    const store = make();
    await store.set('list', { items: ['a'] });
    await expect(
      store.update<{ items: string[] }, void>('list', current => {
        current!.items.push('b');
        throw new Error('changed my mind');
      })
    ).rejects.toThrow('changed my mind');
    expect(await store.get('list')).toEqual({ items: ['a'] });
    // And the next update still runs
    await store.update<{ items: string[] }, void>('list', current => ({ next: { items: [...current!.items, 'c'] }, result: undefined }));
    expect(await store.get('list')).toEqual({ items: ['a', 'c'] });
  });

  it('refuses keys that are not plain names', async () => {
    const store = make();
    await expect(store.update('../escape', () => ({ result: null }))).rejects.toThrow('Invalid store key');
  });
});

describe('update in files', () => {
  it('creates no file for an update that writes nothing', async () => {
    const { store, dir } = fileStore();
    await store.update('nothing', () => ({ result: null }));
    expect(fs.existsSync(path.join(dir, 'nothing.json'))).toBe(false);
  });
});

// As Firestore does: a document is an object, with no list right inside a list
describe('what the file and memory stores take', () => {
  it('refuse what Firestore would turn away, so it fails in tests too', async () => {
    for (const store of [new MemoryStore(), fileStore().store]) {
      await expect(store.set('plain-list', ['a', 'b'] as unknown as object)).rejects.toThrow('must be an object, not a list');
      await expect(store.set('nested', { rows: [['a'], ['b']] })).rejects.toThrow('list right inside a list');
      await expect(store.update('plain-list', () => ({ next: ['a'] as unknown as object, result: undefined }))).rejects.toThrow('must be an object');
      await store.set('fine', { keys: ['a', 'b'], rows: [{ cells: ['x'] }] });
      expect(await store.get('fine')).toEqual({ keys: ['a', 'b'], rows: [{ cells: ['x'] }] });
    }
  });
});

describe('topics the owner said are different matters', () => {
  it('are kept as an object, and read from the plain list an older file store may hold', async () => {
    const store = new MemoryStore();
    setStoreForTests(store);
    const { dismissSuggestion } = await import('./topics.js');
    // Written before as a plain list
    store.data.set('topic-suggestions-dismissed', ['older']);
    await dismissSuggestion(['Church tax 2025', 'Income tax 2025']);
    await dismissSuggestion(['Income tax 2025', 'Church tax 2025']);
    const stored = store.data.get('topic-suggestions-dismissed') as { keys: string[] };
    expect(stored.keys).toHaveLength(2);
    expect(stored.keys[0]).toBe('older');
  });
});
