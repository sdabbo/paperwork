// The search index's storage: the in-memory and file backends, and the cached DocIndex in front of them.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocIndex, FOLLOW_CHECK_MS, FOLLOW_FULL_MS, FileIndexBackend, MemoryIndexBackend, cosineDistance } from './docIndex.js';
import { toInfo } from './indexing.js';
import { FilerOnly } from './roles.js';
import { chunk, indexedDoc } from './testing/fixtures.js';

describe('cosine distance', () => {
  it('is 0 for the same direction, 1 at a right angle and 2 for opposites', () => {
    expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
    expect(cosineDistance([1, 2], [-1, -2])).toBeCloseTo(2);
  });

  it('ignores length, only direction counts', () => {
    expect(cosineDistance([1, 1], [10, 10])).toBeCloseTo(0);
    expect(cosineDistance([3, 4], [6, 8])).toBeCloseTo(cosineDistance([3, 4], [0.3, 0.4]));
  });

  it('puts an empty (all-zero) vector as far away as possible', () => {
    expect(cosineDistance([0, 0], [1, 1])).toBe(2);
    expect(cosineDistance([1, 1], [0, 0])).toBe(2);
  });
});

describe('the in-memory backend', () => {
  it("replaces every chunk of a file with 'all'", async () => {
    const backend = new MemoryIndexBackend();
    await backend.putChunks('a', [chunk('a', 0, 'header'), chunk('a', 1, 'one'), chunk('a', 2, 'two')], 'all');
    await backend.putChunks('a', [chunk('a', 0, 'new header'), chunk('a', 1, 'new one')], 'all');
    expect((await backend.getChunks('a')).map(c => [c.n, c.text])).toEqual([
      [0, 'new header'],
      [1, 'new one'],
    ]);
  });

  it("writes the given chunks and keeps the others with 'merge'", async () => {
    const backend = new MemoryIndexBackend();
    await backend.putChunks('a', [chunk('a', 0, 'header', [1, 0]), chunk('a', 1, 'one', [0, 1]), chunk('a', 2, 'two', [1, 1])], 'all');
    await backend.putChunks('a', [chunk('a', 0, 'new header', [0.5, 0.5])], 'merge');
    expect(await backend.getChunks('a')).toEqual([chunk('a', 0, 'new header', [0.5, 0.5]), chunk('a', 1, 'one', [0, 1]), chunk('a', 2, 'two', [1, 1])]);
  });

  it('gives chunks back in order, whatever order they were written in', async () => {
    const backend = new MemoryIndexBackend();
    await backend.putChunks('a', [chunk('a', 2, 'two'), chunk('a', 0, 'header')], 'all');
    await backend.putChunks('a', [chunk('a', 1, 'one'), chunk('a', 3, 'three')], 'merge');
    expect((await backend.getChunks('a')).map(c => c.n)).toEqual([0, 1, 2, 3]);
    expect(await backend.getChunks('nothing')).toEqual([]);
  });

  it('keeps the chunks of different files apart', async () => {
    const backend = new MemoryIndexBackend();
    await backend.putChunks('a', [chunk('a', 0, 'a header')], 'all');
    await backend.putChunks('b', [chunk('b', 0, 'b header')], 'all');
    await backend.putChunks('a', [], 'all');
    expect(await backend.getChunks('a')).toEqual([]);
    expect(await backend.getChunks('b')).toEqual([chunk('b', 0, 'b header')]);
  });

  it('removes a document together with its chunks', async () => {
    const backend = new MemoryIndexBackend();
    await backend.putDoc(indexedDoc('a'));
    await backend.putDoc(indexedDoc('b'));
    await backend.putChunks('a', [chunk('a', 0, 'header', [1, 0])], 'all');
    await backend.putChunks('b', [chunk('b', 0, 'header', [1, 0])], 'all');
    await backend.removeDoc('a');
    expect((await backend.loadAll()).map(d => d.id)).toEqual(['b']);
    expect(await backend.getChunks('a')).toEqual([]);
    expect((await backend.nearest([1, 0], 10)).map(h => h.fileId)).toEqual(['b']);
  });

  it('finds the nearest chunks by cosine distance, best first, up to the limit', async () => {
    const backend = new MemoryIndexBackend();
    await backend.putChunks('a', [chunk('a', 0, 'far', [0, 1]), chunk('a', 1, 'near', [1, 0.1])], 'all');
    await backend.putChunks('b', [chunk('b', 0, 'nearest', [1, 0]), chunk('b', 1, 'middle', [1, 1])], 'all');
    const hits = await backend.nearest([1, 0], 3);
    expect(hits.map(h => [h.fileId, h.n, h.text])).toEqual([
      ['b', 0, 'nearest'],
      ['a', 1, 'near'],
      ['b', 1, 'middle'],
    ]);
    expect(hits[0].distance).toBeCloseTo(0);
    expect(hits[2].distance).toBeCloseTo(1 - Math.SQRT1_2);
  });

  it('skips chunks without an embedding and embeddings of another size', async () => {
    const backend = new MemoryIndexBackend();
    await backend.putChunks('a', [chunk('a', 0, 'not embedded'), chunk('a', 1, 'other model', [1, 0, 0]), chunk('a', 2, 'fits', [1, 0])], 'all');
    expect((await backend.nearest([1, 0], 10)).map(h => h.text)).toEqual(['fits']);
  });

  it('hands out copies, so changing them changes nothing stored', async () => {
    const backend = new MemoryIndexBackend();
    const doc = indexedDoc('a', { tags: ['home'] });
    await backend.putDoc(doc);
    doc.tags.push('changed after writing');
    const [loaded] = await backend.loadAll();
    loaded.tags.push('changed after reading');
    await backend.putChunks('a', [chunk('a', 0, 'header', [1, 0])], 'all');
    (await backend.getChunks('a'))[0].embedding![0] = 99;
    expect((await backend.loadAll())[0].tags).toEqual(['home']);
    expect((await backend.getChunks('a'))[0].embedding).toEqual([1, 0]);
  });
});

describe('the cached index', () => {
  it('loads the documents once and then answers from memory', async () => {
    const backend = new MemoryIndexBackend();
    await backend.putDoc(indexedDoc('a'));
    const loadAll = vi.spyOn(backend, 'loadAll');
    const index = new DocIndex(backend);
    expect((await index.all()).map(d => d.id)).toEqual(['a']);
    expect(await index.get('a')).toMatchObject({ id: 'a' });
    expect(await index.get('missing')).toBeNull();
    expect(loadAll).toHaveBeenCalledTimes(1);
  });

  it('shares one load between requests that arrive together', async () => {
    const backend = new MemoryIndexBackend();
    await backend.putDoc(indexedDoc('a'));
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const original = backend.loadAll.bind(backend);
    const loadAll = vi.spyOn(backend, 'loadAll').mockImplementation(async () => {
      await gate;
      return original();
    });
    const index = new DocIndex(backend);
    const pending = Promise.all([index.all(), index.get('a'), index.nearest([1, 0], 5), index.all()]);
    release();
    const [all, one, , again] = await pending;
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(all.map(d => d.id)).toEqual(['a']);
    expect(one?.id).toBe('a');
    expect(again).toHaveLength(1);
  });

  it('tries loading again after a failed load', async () => {
    const backend = new MemoryIndexBackend();
    await backend.putDoc(indexedDoc('a'));
    vi.spyOn(backend, 'loadAll').mockRejectedValueOnce(new Error('Firestore unavailable'));
    const index = new DocIndex(backend);
    await expect(index.all()).rejects.toThrow('Firestore unavailable');
    expect((await index.all()).map(d => d.id)).toEqual(['a']);
  });

  it('writes through to the backend and keeps its memory in step', async () => {
    const backend = new MemoryIndexBackend();
    const index = new DocIndex(backend);
    const loadAll = vi.spyOn(backend, 'loadAll');
    await index.put(indexedDoc('a', { title: 'First' }));
    await index.put(indexedDoc('a', { title: 'Second' }));
    await index.put(indexedDoc('b'));
    expect((await index.get('a'))?.title).toBe('Second');
    expect(backend.docs.get('a')?.title).toBe('Second');
    await index.remove('b');
    expect(await index.get('b')).toBeNull();
    // A tombstone until purged
    expect(backend.docs.get('b')?.removedAt).toEqual(expect.any(String));
    await index.purge('b');
    expect(backend.docs.has('b')).toBe(false);
    expect(loadAll).toHaveBeenCalledTimes(1);
    // A fresh start (another instance, or after a restart) sees the same
    expect((await new DocIndex(backend).all()).map(d => [d.id, d.title])).toEqual([['a', 'Second']]);
  });

  it("replaces a file's chunks unless asked to merge", async () => {
    const backend = new MemoryIndexBackend();
    const index = new DocIndex(backend);
    await index.putChunks('a', [chunk('a', 0, 'header'), chunk('a', 1, 'one')]);
    await index.putChunks('a', [chunk('a', 0, 'new header')]);
    expect((await index.chunks('a')).map(c => c.text)).toEqual(['new header']);
    await index.putChunks('a', [chunk('a', 1, 'one again')], 'merge');
    expect((await index.chunks('a')).map(c => c.text)).toEqual(['new header', 'one again']);
  });

  it('drops search hits of documents that are no longer in the index', async () => {
    const backend = new MemoryIndexBackend();
    const index = new DocIndex(backend);
    await index.put(indexedDoc('kept'));
    await index.putChunks('kept', [chunk('kept', 0, 'kept', [1, 0.2])]);
    // Chunks written for a document that was removed (or never got its entry) meanwhile
    await index.putChunks('orphan', [chunk('orphan', 0, 'orphan', [1, 0])]);
    await index.put(indexedDoc('removed'));
    await index.putChunks('removed', [chunk('removed', 0, 'removed', [1, 0.1])]);
    await index.remove('removed');
    await backend.putChunks('removed', [chunk('removed', 0, 'written late', [1, 0.1])], 'all');
    expect((await index.nearest([1, 0], 10)).map(h => h.fileId)).toEqual(['kept']);
  });

  it('reads the backend again after a reset', async () => {
    const backend = new MemoryIndexBackend();
    const index = new DocIndex(backend);
    expect(await index.all()).toEqual([]);
    await backend.putDoc(indexedDoc('written elsewhere'));
    expect(await index.all()).toEqual([]);
    index.reset();
    expect((await index.all()).map(d => d.id)).toEqual(['written elsewhere']);
  });
});

describe('a copy that only reads (the public edge)', () => {
  // The app writes; the edge's copy follows from the same store
  async function writerAndFollower() {
    const backend = new MemoryIndexBackend();
    const writer = new DocIndex(backend);
    await writer.put(indexedDoc('a', { title: 'First' }));
    await writer.put(indexedDoc('b'));
    const follower = new DocIndex(backend, { follower: true });
    const start = Date.now();
    await follower.ensureFresh(start);
    return { backend, writer, follower, start };
  }

  it('stamps every entry it stores with when, and leaves the stamp out of what the app is given', async () => {
    const backend = new MemoryIndexBackend();
    const index = new DocIndex(backend);
    const before = new Date().toISOString();
    await index.put(indexedDoc('a'));
    await index.remove('a');
    const stored = backend.docs.get('a')!;
    expect(stored.storedAt! >= before).toBe(true);
    expect(stored.removedAt).toEqual(expect.any(String));
    expect(toInfo(stored)).not.toHaveProperty('storedAt');
    expect(await backend.loadChangedSince(stored.storedAt!)).toHaveLength(1);
    expect(await backend.loadChangedSince('2999-01-01')).toEqual([]);
  });

  it('takes in an edited title and a removed document after half a minute, not before', async () => {
    const { writer, follower, start } = await writerAndFollower();
    expect((await follower.get('a'))?.title).toBe('First');

    await writer.put({ ...(await writer.get('a'))!, title: 'Edited' });
    await writer.remove('b');
    await follower.ensureFresh(start + FOLLOW_CHECK_MS - 1);
    expect((await follower.get('a'))?.title).toBe('First');
    expect(await follower.get('b')).not.toBeNull();

    await follower.ensureFresh(start + FOLLOW_CHECK_MS);
    expect((await follower.get('a'))?.title).toBe('Edited');
    expect(await follower.get('b')).toBeNull();
    expect((await follower.all()).map(d => d.id)).toEqual(['a']);
  });

  it('reads only what changed when looking again, and everything every quarter of an hour', async () => {
    const { backend, writer, follower, start } = await writerAndFollower();
    const loadAll = vi.spyOn(backend, 'loadAll');
    const changedSince = vi.spyOn(backend, 'loadChangedSince');
    await writer.put(indexedDoc('c'));
    await follower.ensureFresh(start + FOLLOW_CHECK_MS);
    expect(changedSince).toHaveBeenCalledTimes(1);
    expect(loadAll).not.toHaveBeenCalled();
    expect((await follower.all()).map(d => d.id).sort()).toEqual(['a', 'b', 'c']);

    // Purged for good: no entry says so, only reading everything shows it
    await writer.purge('a');
    await follower.ensureFresh(start + 2 * FOLLOW_CHECK_MS);
    expect(await follower.get('a')).not.toBeNull();
    await follower.ensureFresh(start + FOLLOW_FULL_MS);
    expect(loadAll).toHaveBeenCalledTimes(1);
    expect(await follower.get('a')).toBeNull();
  });

  it('shares one look between requests arriving together', async () => {
    const { backend, follower, start } = await writerAndFollower();
    const changedSince = vi.spyOn(backend, 'loadChangedSince');
    await Promise.all([follower.ensureFresh(start + FOLLOW_CHECK_MS), follower.ensureFresh(start + FOLLOW_CHECK_MS), follower.ensureFresh(start + FOLLOW_CHECK_MS)]);
    expect(changedSince).toHaveBeenCalledTimes(1);
  });

  it('never writes', async () => {
    const { backend, follower } = await writerAndFollower();
    await expect(follower.put(indexedDoc('x'))).rejects.toThrow(FilerOnly);
    await expect(follower.remove('a')).rejects.toThrow(FilerOnly);
    await expect(follower.purge('a')).rejects.toThrow(FilerOnly);
    await expect(follower.purgeOld()).rejects.toThrow(FilerOnly);
    await expect(follower.putChunks('a', [chunk('a', 0, 'header')])).rejects.toThrow(FilerOnly);
    expect([...backend.docs.keys()].sort()).toEqual(['a', 'b']);
    expect(backend.chunks.size).toBe(0);
  });

  it('does nothing extra for the writer', async () => {
    const backend = new MemoryIndexBackend();
    const writer = new DocIndex(backend);
    const loadAll = vi.spyOn(backend, 'loadAll');
    await writer.ensureFresh();
    expect(loadAll).not.toHaveBeenCalled();
  });
});

describe('the file backend (local development)', () => {
  const dirs: string[] = [];
  const tempDir = async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paperwork-index-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('starts empty when there is no index file yet', async () => {
    const backend = new FileIndexBackend(path.join(await tempDir(), 'not', 'there', 'yet'));
    expect(await backend.loadAll()).toEqual([]);
    expect(await backend.getChunks('a')).toEqual([]);
    expect(await backend.nearest([1, 0], 5)).toEqual([]);
  });

  it('keeps documents and chunks across restarts', async () => {
    const dir = path.join(await tempDir(), 'index');
    const first = new FileIndexBackend(dir);
    const doc = indexedDoc('a', { title: 'Strom März', tags: ['strom'], deadlines: [{ date: '2025-04-25', what: 'Zahlung', done: true }], embedded: true });
    await first.putDoc(doc);
    await first.putDoc(indexedDoc('b'));
    await first.putChunks('a', [chunk('a', 0, 'header', [1, 0]), chunk('a', 1, 'Text über Musterstadt', [0, 1]), chunk('a', 2, 'more', null)], 'all');
    await first.putChunks('b', [chunk('b', 0, 'b header', [1, 1])], 'all');
    await first.putChunks('a', [chunk('a', 2, 'more, embedded', [0.5, 0.5])], 'merge');
    await first.removeDoc('b');

    expect(await fs.promises.readdir(dir)).toEqual(['index.json']);

    const second = new FileIndexBackend(dir);
    expect(await second.loadAll()).toEqual([doc]);
    expect(await second.getChunks('a')).toEqual([
      chunk('a', 0, 'header', [1, 0]),
      chunk('a', 1, 'Text über Musterstadt', [0, 1]),
      chunk('a', 2, 'more, embedded', [0.5, 0.5]),
    ]);
    expect(await second.getChunks('b')).toEqual([]);
    expect((await second.nearest([0, 1], 1)).map(h => h.text)).toEqual(['Text über Musterstadt']);
  });

  it('waits for the stored index before a write that arrives during the first load', async () => {
    const dir = await tempDir();
    const first = new FileIndexBackend(dir);
    await first.putDoc(indexedDoc('a'));
    await first.putChunks('a', [chunk('a', 0, 'header', [1, 0])], 'all');

    const second = new FileIndexBackend(dir);
    const [docs, chunks] = await Promise.all([second.loadAll(), second.getChunks('a'), second.putChunks('b', [chunk('b', 0, 'b header', [0, 1])], 'all')]);
    expect(docs.map(d => d.id)).toEqual(['a']);
    expect(chunks).toHaveLength(1);

    // Nothing that was stored before was lost by the write
    const third = new FileIndexBackend(dir);
    expect((await third.loadAll()).map(d => d.id)).toEqual(['a']);
    expect(await third.getChunks('a')).toHaveLength(1);
    expect(await third.getChunks('b')).toHaveLength(1);
  });

  it('saves writes that arrive together, one after the other', async () => {
    const dir = await tempDir();
    const backend = new FileIndexBackend(dir);
    const docs = Array.from({ length: 12 }, (_, i) => indexedDoc(`d${i}`, { summary: 'x'.repeat((12 - i) * 400) }));
    await Promise.all([...docs.map(d => backend.putDoc(d)), backend.putChunks('d0', [chunk('d0', 0, 'header', [1, 0])], 'all')]);
    const reloaded = new FileIndexBackend(dir);
    expect((await reloaded.loadAll()).map(d => d.id).sort()).toEqual(docs.map(d => d.id).sort());
    expect(await reloaded.getChunks('d0')).toHaveLength(1);
    expect(await fs.promises.readdir(dir)).toEqual(['index.json']);
  });

  it('refuses to work over an index file it cannot read, rather than overwrite it', async () => {
    const dir = await tempDir();
    await fs.promises.writeFile(path.join(dir, 'index.json'), '{"docs": [', 'utf-8');
    const backend = new FileIndexBackend(dir);
    await expect(backend.loadAll()).rejects.toThrow();
    await expect(backend.putDoc(indexedDoc('a'))).rejects.toThrow();
    expect(await fs.promises.readFile(path.join(dir, 'index.json'), 'utf-8')).toBe('{"docs": [');
  });
});
