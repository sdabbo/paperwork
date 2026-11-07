// Keeping the index in step with Drive (the change feed and the daily full check), and reading the text of
// documents the index doesn't have yet, against an in-memory Google Drive (testing/fakeDrive.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDrive, FakeFile } from './testing/fakeDrive.js';
import { MemoryStore, setStoreForTests } from './store.js';
import { DocIndex, MemoryIndexBackend, setIndexForTests } from './docIndex.js';
import type { Readable } from './extract.js';
import type { DocMeta } from './metadata.js';
import { billMeta, docLabels, indexedDoc, prose, scanPdf, textPdf, wordVector } from './testing/fixtures.js';

const h = vi.hoisted(() => ({
  fake: null as unknown as import('./testing/fakeDrive.js').FakeDrive,
  connection: null as any,
  transcribe: null as unknown as (content: Readable) => Promise<string>,
  embed: null as unknown as (texts: string[], task: string) => Promise<number[][]>,
  budgetUsed: { generate: 0, embeddings: 0 },
}));

vi.mock('./google.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./google.js')>();
  const { Drive } = await import('./drive.js');
  return {
    ...actual,
    getDrive: () => new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch, sleep: async () => {} }),
    getConnection: async () => h.connection,
    rememberRootFolder: async (id: string) => {
      h.connection.rootFolderId = id;
    },
  };
});

vi.mock('./classify.js', () => ({
  classify: async () => {
    throw new Error('Keeping the index up to date never classifies.');
  },
  transcribe: (content: Readable) => h.transcribe(content),
}));

vi.mock('./gemini.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./gemini.js')>();
  return { ...actual, embed: (texts: string[], task: string) => h.embed(texts, task), budgetUsed: async () => h.budgetUsed };
});

const { reconcile, fillIndex, folderChange } = await import('./sync.js');
const { setDeadlineDone } = await import('./pipeline.js');
const { loadTree, forgetTree } = await import('./vault.js');
const { Drive } = await import('./drive.js');
const { LimitError } = await import('./gemini.js');
const { recentActivity } = await import('./activity.js');
const { fileName } = await import('./metadata.js');
const { FilerOnly } = await import('./roles.js');

let index: DocIndex;
let store: MemoryStore;

const drive = () => new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch, sleep: async () => {} });

beforeEach(() => {
  h.fake = new FakeDrive();
  h.connection = { ownerEmail: 'me@example.com', refreshToken: 'sealed', scope: '', connectedAt: '' };
  h.transcribe = vi.fn(async () => 'Transcribed text of the scan: Allianz Kfz-Versicherung, Beitrag 412,80 EUR.');
  h.embed = vi.fn(async (texts: string[]) => texts.map(t => wordVector(t)));
  h.budgetUsed = { generate: 0, embeddings: 0 };
  store = new MemoryStore();
  setStoreForTests(store);
  index = new DocIndex(new MemoryIndexBackend());
  setIndexForTests(index);
  forgetTree();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// The Paperwork folder with a 2025 folder under Bills & Receipts
async function setup() {
  await loadTree(drive());
  const root = h.fake.find('Paperwork')!;
  const category = (name: string) => h.fake.childrenOf(root.id).find(f => f.name === name)!;
  const year = h.fake.folder('2025', category('Bills & Receipts').id);
  forgetTree();
  const tree = await loadTree(drive());
  return { tree, root, inbox: h.fake.find('Inbox')!, bills: category('Bills & Receipts'), year, category };
}

// A document filed by Paperwork earlier, labelled in Drive
function addDoc(folderId: string, meta: Partial<DocMeta> = {}, file: Partial<FakeFile> = {}) {
  const m = { ...billMeta, ...meta };
  const name = fileName(m, { name: 'scan.pdf', mimeType: 'application/pdf' });
  return h.fake.add({ name, parents: [folderId], ...docLabels(m, name), content: new TextEncoder().encode(`%PDF-1.7 ${name}`), ...file });
}

const changesState = () => store.data.get('drive-changes') as { token: string; fullAt: string } | undefined;

describe('the first run', () => {
  it('is a full check: adds the documents from their Drive labels and drops entries Drive no longer has', async () => {
    const { tree, year, category } = await setup();
    const bill = addDoc(year.id);
    const policy = addDoc(category('Insurance').id, { title: 'Car insurance policy', correspondent: 'Allianz', type: 'policy' });
    await index.put(indexedDoc('stale', { name: 'Old letter.pdf' }));

    const result = await reconcile(drive(), tree);

    expect(result).toMatchObject({ updated: 2, removed: 1, full: true });
    expect(await index.get('stale')).toBeNull();
    expect(await index.get(bill.id)).toMatchObject({ title: 'Electricity bill March', category: 'Bills & Receipts', folderPath: ['Bills & Receipts', '2025'], textSource: null });
    expect(await index.get(policy.id)).toMatchObject({ title: 'Car insurance policy', correspondent: 'Allianz', category: 'Insurance' });
    const [removed] = await recentActivity();
    expect(removed).toMatchObject({ kind: 'removed', name: 'Old letter.pdf', fileId: 'stale', detail: 'No longer in the Paperwork folder in Drive' });
    expect(h.fake.destructive()).toEqual([]);
  });

  it('remembers where the change feed stands, taken before listing', async () => {
    const { tree, year } = await setup();
    addDoc(year.id);
    const position = String(h.fake.changeLog.length);
    await reconcile(drive(), tree);
    expect(changesState()).toEqual({ token: position, fullAt: expect.any(String), rootId: tree.root.id });
    expect(Date.now() - Date.parse(changesState()!.fullAt)).toBeLessThan(60_000);
  });

  it('leaves out documents in the Inbox, outside the Paperwork folder and in the trash', async () => {
    const { tree, inbox, year } = await setup();
    addDoc(inbox.id);
    addDoc(h.fake.myDriveRoot);
    addDoc(year.id, {}, { trashed: true });
    const filed = addDoc(year.id);
    await reconcile(drive(), tree);
    expect((await index.all()).map(d => d.id)).toEqual([filed.id]);
  });
});

describe('changes made in Drive', () => {
  async function synced() {
    const s = await setup();
    const doc = addDoc(s.year.id);
    await reconcile(drive(), s.tree);
    return { ...s, doc };
  }

  it('follow a rename: the title becomes the new file name', async () => {
    const { tree, doc } = await synced();
    h.fake.touch(doc.id, f => (f.name = 'Strom März.pdf'));
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 1, removed: 0, full: false });
    expect(await index.get(doc.id)).toMatchObject({ name: 'Strom März.pdf', title: 'Strom März' });
  });

  it('follow a star', async () => {
    const { tree, doc } = await synced();
    h.fake.touch(doc.id, f => (f.starred = true));
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 1, full: false });
    expect(await index.get(doc.id)).toMatchObject({ starred: true });
  });

  it('follow a move to another category', async () => {
    const { tree, doc, category } = await synced();
    h.fake.touch(doc.id, f => (f.parents = [category('Insurance').id]));
    await reconcile(drive(), tree);
    expect(await index.get(doc.id)).toMatchObject({ category: 'Insurance', folderPath: ['Insurance'] });
  });

  it('remove a document moved to the trash, and say so', async () => {
    const { tree, doc } = await synced();
    h.fake.touch(doc.id, f => (f.trashed = true));
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 0, removed: 1, full: false });
    expect(await index.get(doc.id)).toBeNull();
    expect((await recentActivity())[0]).toMatchObject({ kind: 'removed', name: doc.name, fileId: doc.id, detail: 'Moved to the trash in Drive' });
  });

  it('remove a document moved out of the Paperwork folder', async () => {
    const { tree, doc } = await synced();
    h.fake.touch(doc.id, f => (f.parents = [h.fake.myDriveRoot]));
    expect(await reconcile(drive(), tree)).toMatchObject({ removed: 1 });
    expect(await index.get(doc.id)).toBeNull();
    expect((await recentActivity())[0]).toMatchObject({ kind: 'removed', detail: 'Moved out of the Paperwork folder' });
  });

  it('remove a document moved back into the Inbox, to be filed again', async () => {
    const { tree, doc, inbox } = await synced();
    h.fake.touch(doc.id, f => (f.parents = [inbox.id]));
    expect(await reconcile(drive(), tree)).toMatchObject({ removed: 1 });
    expect(await index.get(doc.id)).toBeNull();
    expect((await recentActivity())[0]).toMatchObject({ kind: 'removed', fileId: doc.id, detail: 'Moved back into the Inbox, to be filed again' });
  });

  it('remove a document deleted for good', async () => {
    const { tree, doc } = await synced();
    h.fake.deleteForGood(doc.id);
    expect(await reconcile(drive(), tree)).toMatchObject({ removed: 1, full: false });
    expect(await index.get(doc.id)).toBeNull();
    expect((await recentActivity())[0]).toMatchObject({ kind: 'removed', name: doc.name, detail: 'Deleted in Drive' });
  });

  it('add a document that comes back from the trash', async () => {
    const { tree, doc } = await synced();
    h.fake.touch(doc.id, f => (f.trashed = true));
    await reconcile(drive(), tree);
    h.fake.touch(doc.id, f => (f.trashed = false));
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 1, removed: 0 });
    expect(await index.get(doc.id)).toMatchObject({ title: 'Electricity bill March' });
  });

  it('take the last state of a file the feed names several times', async () => {
    const { tree, doc } = await synced();
    h.fake.touch(doc.id, f => (f.starred = true));
    h.fake.touch(doc.id, f => (f.name = 'Renamed.pdf'));
    h.fake.touch(doc.id, f => (f.trashed = true));
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 0, removed: 1, full: false });
    expect((await recentActivity()).filter(e => e.kind === 'removed')).toHaveLength(1);
  });

  it("don't count files that changed in a way the app doesn't show, or that aren't documents", async () => {
    const { tree, doc, inbox } = await synced();
    // Shared, opened or otherwise changed in a way that doesn't show: in the feed, but nothing to update
    h.fake.changeLog.push(doc.id);
    h.fake.add({ name: 'new scan.pdf', parents: [inbox.id] });
    h.fake.add({ name: 'Holiday photos.jpg', mimeType: 'image/jpeg', parents: [h.fake.myDriveRoot] });
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 0, removed: 0, full: false });
    expect(await recentActivity()).toEqual([]);
  });

  it('move the stored position in the feed forward', async () => {
    const { tree, doc } = await synced();
    const { fullAt } = changesState()!;
    h.fake.touch(doc.id, f => (f.starred = true));
    await reconcile(drive(), tree);
    expect(changesState()).toEqual({ token: String(h.fake.changeLog.length), fullAt, rootId: tree.root.id });
    // Nothing new since: nothing to do
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 0, removed: 0, full: false });
  });

  it('are only seen through the feed between full checks', async () => {
    const { tree, doc } = await synced();
    // Changed without a trace in the feed: only a full check notices
    h.fake.files.get(doc.id)!.starred = true;
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 0, full: false });
    expect(await index.get(doc.id)).toMatchObject({ starred: false });
    expect(await reconcile(drive(), tree, { full: true })).toMatchObject({ updated: 1, full: true });
    expect(await index.get(doc.id)).toMatchObject({ starred: true });
  });
});

describe('full checks', () => {
  it('run when a folder of the Paperwork tree was renamed, with the new category names', async () => {
    const { tree, year, bills } = await setup();
    const doc = addDoc(year.id);
    await reconcile(drive(), tree);
    h.fake.touch(bills.id, f => (f.name = 'Rechnungen'));

    const result = await reconcile(drive(), tree);

    expect(result).toMatchObject({ updated: 1, removed: 0, full: true });
    expect(await index.get(doc.id)).toMatchObject({ category: 'Rechnungen', folderPath: ['Rechnungen', '2025'] });
    expect(changesState()!.token).toBe(String(h.fake.changeLog.length));
  });

  it('run when a folder is moved into the Paperwork tree, adding what it holds', async () => {
    const { tree, year, category } = await setup();
    addDoc(year.id);
    await reconcile(drive(), tree);
    const outside = h.fake.folder('Old papers', h.fake.myDriveRoot);
    const doc = addDoc(outside.id, { title: 'Old contract' });
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 0, full: false });
    expect(await index.get(doc.id)).toBeNull();

    h.fake.touch(outside.id, f => (f.parents = [category('Housing').id]));
    expect(await reconcile(drive(), tree)).toMatchObject({ full: true, updated: 1 });
    expect(await index.get(doc.id)).toMatchObject({ title: 'Old contract', folderPath: ['Housing', 'Old papers'], category: 'Housing' });
  });

  it('run once a day', async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id);
    await reconcile(drive(), tree);
    h.fake.files.get(doc.id)!.starred = true;
    store.data.set('drive-changes', { ...changesState()!, fullAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });

    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 1, full: true });
    expect(await index.get(doc.id)).toMatchObject({ starred: true });
    expect(Date.now() - Date.parse(changesState()!.fullAt)).toBeLessThan(60_000);
  });

  it('run when the index is empty, e.g. after Firestore was emptied', async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id);
    await reconcile(drive(), tree);
    await index.remove(doc.id);
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 1, full: true });
    expect(await index.get(doc.id)).not.toBeNull();
  });

  it('keep a document filed while they were under way', async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id);
    await reconcile(drive(), tree);
    h.fake.files.get(doc.id)!.starred = true;
    // The check takes a while: it waits after Drive has listed the documents
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let listed!: () => void;
    const busy = new Promise<void>(resolve => (listed = resolve));
    const slowDrive = new Drive({
      accessToken: async () => 'token',
      sleep: async () => {},
      fetch: async (input, init) => {
        const res = await h.fake.fetch(input, init);
        const url = decodeURIComponent(String(input));
        if (url.includes('/drive/v3/files?') && url.includes("value='doc'")) {
          listed();
          await gate;
        }
        return res;
      },
    });
    const check = reconcile(slowDrive, tree, { full: true });
    await busy;

    // Meanwhile an upload is filed: into Drive and the index, after the check listed the documents
    const upload = addDoc(year.id, { title: 'Filed meanwhile' });
    await index.put(indexedDoc(upload.id, { name: upload.name, textSource: 'ocr', textLength: 500 }));
    release();

    expect(await check).toMatchObject({ full: true, updated: 1, removed: 0 });
    expect(await index.get(upload.id)).toMatchObject({ textSource: 'ocr', textLength: 500 });
    expect(await recentActivity()).toEqual([]);
  });

  it('keep what only the index knows', async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id);
    await reconcile(drive(), tree);
    const deadlines = [
      { date: '2025-04-25', what: 'Pay 87.45 EUR', done: true },
      { date: '2025-12-31', what: 'Contract ends', done: false },
    ];
    await index.put({ ...(await index.get(doc.id))!, deadlines, textSource: 'pdf', textLength: 1200 });
    h.fake.touch(doc.id, f => (f.starred = true));
    await reconcile(drive(), tree, { full: true });
    expect(await index.get(doc.id)).toMatchObject({ starred: true, deadlines, textSource: 'pdf', textLength: 1200 });
  });
});

describe('filling in the text', () => {
  it('reads the text layer of PDFs and has scans and photos transcribed', async () => {
    const { tree, year } = await setup();
    const text = prose(20);
    const typed = addDoc(year.id, { title: 'Typed letter' }, { content: await textPdf([text]) });
    const scan = addDoc(year.id, { title: 'Scanned letter' }, { content: await scanPdf() });
    const photo = addDoc(year.id, { title: 'Photo of a receipt' }, { mimeType: 'image/jpeg', name: 'receipt.jpg', content: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) });
    const sheet = addDoc(year.id, { title: 'Spreadsheet' }, { mimeType: 'application/zip', name: 'archive.zip', content: new Uint8Array([0x50, 0x4b]) });
    await reconcile(drive(), tree);

    expect((await fillIndex(drive())).done).toBe(4);

    expect(await index.get(typed.id)).toMatchObject({ textSource: 'pdf', textLength: text.length, embedded: true });
    expect((await index.chunks(typed.id)).map(c => c.text.replace(/\s+/g, ' '))).toEqual([expect.stringContaining('Title: Typed letter'), text]);
    expect(await index.get(scan.id)).toMatchObject({ textSource: 'ocr', embedded: true });
    expect((await index.chunks(scan.id))[1].text).toContain('Kfz-Versicherung');
    expect(await index.get(photo.id)).toMatchObject({ textSource: 'ocr', embedded: true });
    // A kind of file Paperwork can't read is searchable by its details alone
    expect(await index.get(sheet.id)).toMatchObject({ textSource: 'none', textLength: 0, embedded: true });
    expect(await index.chunks(sheet.id)).toHaveLength(1);
    expect(h.transcribe).toHaveBeenCalledTimes(2);
    expect(h.fake.destructive()).toEqual([]);
  });

  it('records a scan whose transcription is empty as having no text', async () => {
    const { tree, year } = await setup();
    const blank = addDoc(year.id, {}, { content: await scanPdf() });
    await reconcile(drive(), tree);
    h.transcribe = vi.fn(async () => '');
    await fillIndex(drive());
    expect(await index.get(blank.id)).toMatchObject({ textSource: 'none', embedded: true });
  });

  it('reads at most five documents per run, newest first', async () => {
    const { tree, year } = await setup();
    const docs = Array.from({ length: 7 }, (_, i) => addDoc(year.id, { title: `Photo ${i}` }, { mimeType: 'image/jpeg', name: `photo-${i}.jpg`, content: new Uint8Array([i]) }));
    await reconcile(drive(), tree);
    const downloads = () => h.fake.log.filter(r => r.query.alt === 'media').map(r => r.path.split('/').pop());

    expect((await fillIndex(drive())).done).toBe(5);
    expect(downloads()).toEqual(docs.slice(2).reverse().map(d => d.id));
    for (const d of docs.slice(0, 2)) expect((await index.get(d.id))!.textSource).toBeNull();

    expect((await fillIndex(drive())).done).toBe(2);
    expect(downloads().slice(5)).toEqual([docs[1].id, docs[0].id]);
    expect((await fillIndex(drive())).done).toBe(0);
  });

  it("stops when the AI budget is used up, without counting it against the documents", async () => {
    const { tree, year } = await setup();
    const docs = Array.from({ length: 3 }, (_, i) => addDoc(year.id, { title: `Photo ${i}` }, { mimeType: 'image/jpeg', name: `photo-${i}.jpg`, content: new Uint8Array([i]) }));
    await reconcile(drive(), tree);
    h.transcribe = vi
      .fn()
      .mockResolvedValueOnce('The newest photo, read.')
      .mockRejectedValueOnce(new LimitError("Paperwork's AI has used today's budget."))
      .mockResolvedValue('Should not be asked for.');

    expect((await fillIndex(drive())).done).toBe(1);

    expect(h.transcribe).toHaveBeenCalledTimes(2);
    expect(await index.get(docs[2].id)).toMatchObject({ textSource: 'ocr' });
    for (const d of docs.slice(0, 2)) {
      const entry = (await index.get(d.id))!;
      expect(entry.textSource).toBeNull();
      expect(entry.indexTries ?? 0).toBe(0);
    }
  });

  it('counts failed attempts and leaves a document alone after three', async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id, {}, { mimeType: 'image/jpeg', name: 'photo.jpg', content: new Uint8Array([1]) });
    await reconcile(drive(), tree);
    h.transcribe = vi.fn(async () => {
      throw new Error('The model could not read the image.');
    });

    for (let run = 1; run <= 3; run++) {
      expect((await fillIndex(drive())).done).toBe(0);
      expect((await index.get(doc.id))!.indexTries).toBe(run);
    }
    await fillIndex(drive());
    expect(h.transcribe).toHaveBeenCalledTimes(3);
    expect(await index.get(doc.id)).toMatchObject({ textSource: null, indexTries: 3 });
  });

  it('embeds text that was read before but not embedded, without reading the file again', async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id, {}, { content: await textPdf([prose(20)]) });
    await reconcile(drive(), tree);
    h.embed = vi.fn(async () => {
      throw new Error('The embedding model is unavailable.');
    });
    expect((await fillIndex(drive())).done).toBe(1);
    expect(await index.get(doc.id)).toMatchObject({ textSource: 'pdf', embedded: false });
    const downloads = h.fake.log.filter(r => r.query.alt === 'media').length;

    h.embed = vi.fn(async (texts: string[]) => texts.map(t => wordVector(t)));
    expect((await fillIndex(drive())).done).toBe(1);

    expect(await index.get(doc.id)).toMatchObject({ textSource: 'pdf', embedded: true });
    expect((await index.chunks(doc.id)).every(c => c.embedding)).toBe(true);
    expect(h.fake.log.filter(r => r.query.alt === 'media')).toHaveLength(downloads);
  });

  it('counts a failed embedding as a try, and stops when the embedding budget is used up', async () => {
    const { tree, year } = await setup();
    const docs = [addDoc(year.id, { title: 'One' }), addDoc(year.id, { title: 'Two' })];
    await reconcile(drive(), tree);
    // Read before, but never embedded
    for (const d of docs) {
      await index.put({ ...(await index.get(d.id))!, textSource: 'none', embedded: false });
      await index.putChunks(d.id, []);
    }

    h.embed = vi.fn(async () => {
      throw new Error('The embedding model rejected the text.');
    });
    expect((await fillIndex(drive())).done).toBe(0);
    for (const d of docs) expect((await index.get(d.id))!.indexTries).toBe(1);

    h.embed = vi.fn(async () => {
      throw new LimitError("Paperwork's search has used today's budget.");
    });
    expect((await fillIndex(drive())).done).toBe(0);
    expect(h.embed).toHaveBeenCalledTimes(1);
    for (const d of docs) expect((await index.get(d.id))!.indexTries).toBe(1);
  });
});

describe('a full check of a large library', () => {
  it('adds documents new to the index without embedding them one by one; filling the index does that later', async () => {
    const { tree, year } = await setup();
    for (let i = 0; i < 4; i++) addDoc(year.id, { title: `Bill ${i}` });
    await reconcile(drive(), tree);
    expect(h.embed).not.toHaveBeenCalled();
    expect((await index.all()).map(d => [d.textSource, d.embedded])).toEqual([
      [null, false],
      [null, false],
      [null, false],
      [null, false],
    ]);
  });

  it('reads the index again first, so an index emptied by hand is rebuilt from Drive', async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id);
    await reconcile(drive(), tree);
    // Emptied in the Firestore console; the server's cache still has it
    (index.backend as MemoryIndexBackend).docs.clear();
    await reconcile(drive(), tree, { full: true });
    expect((index.backend as MemoryIndexBackend).docs.has(doc.id)).toBe(true);
  });
});

describe('after the second review', () => {
  it("doesn't undo a deadline ticked off while the document's text was being read", async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id, {}, { content: await scanPdf() });
    await reconcile(drive(), tree);
    const entry = (await index.get(doc.id))!;
    expect(entry.deadlines).toEqual([expect.objectContaining({ date: '2025-04-25', done: false })]);
    const deadline = entry.deadlines[0];

    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let reading!: () => void;
    const started = new Promise<void>(resolve => (reading = resolve));
    h.transcribe = vi.fn(async () => {
      reading();
      await gate;
      return 'Transcribed meanwhile.';
    });
    const fill = fillIndex(drive());
    await started;
    await setDeadlineDone(doc.id, deadline, true);
    release();

    expect((await fill).done).toBe(1);
    expect(await index.get(doc.id)).toMatchObject({ textSource: 'ocr', deadlines: [{ ...deadline, done: true }] });
  });

  it('brings a document back whole when it returns from the trash, and forgets it after 30 days', async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id, {}, { content: await textPdf([prose(10)]) });
    await reconcile(drive(), tree);
    await fillIndex(drive());
    const entry = (await index.get(doc.id))!;
    await setDeadlineDone(doc.id, entry.deadlines[0], true);

    h.fake.touch(doc.id, f => (f.trashed = true));
    expect(await reconcile(drive(), tree)).toMatchObject({ removed: 1 });
    expect(await index.get(doc.id)).toBeNull();
    expect((await index.all()).map(d => d.id)).not.toContain(doc.id);

    h.fake.touch(doc.id, f => (f.trashed = false));
    expect(await reconcile(drive(), tree)).toMatchObject({ updated: 1 });
    expect(await index.get(doc.id)).toMatchObject({ textSource: 'pdf', embedded: true, deadlines: [expect.objectContaining({ done: true })] });
    expect((await fillIndex(drive())).done).toBe(0);

    h.fake.touch(doc.id, f => (f.trashed = true));
    await reconcile(drive(), tree);
    const tombstone = (await index.getAny(doc.id))!;
    await index.put({ ...tombstone, removedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString() });
    await reconcile(drive(), tree, { full: true });
    expect(await index.getAny(doc.id)).toBeNull();
    expect(await index.chunks(doc.id)).toEqual([]);
  });

  it('reads a document again when its content changed in Drive', async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id, {}, { content: await textPdf([prose(10, 1)]) });
    await reconcile(drive(), tree);
    await fillIndex(drive());
    expect(await index.get(doc.id)).toMatchObject({ textSource: 'pdf', embedded: true });

    const next = await textPdf([prose(10, 2)]);
    h.fake.touch(doc.id, f => {
      f.content = next;
      f.md5Checksum = 'new-content';
    });
    await reconcile(drive(), tree);
    expect(await index.get(doc.id)).toMatchObject({ textSource: null, textLength: 0, embedded: false, md5: 'new-content' });
    expect((await fillIndex(drive())).done).toBe(1);
    expect((await index.chunks(doc.id))[1].text.replace(/\s+/g, ' ')).toBe(prose(10, 2));
  });

  it("leaves half of the day's Gemini budget for new documents and questions", async () => {
    const { tree, year } = await setup();
    addDoc(year.id, {}, { content: await scanPdf() });
    await reconcile(drive(), tree);
    h.budgetUsed = { generate: 0.5, embeddings: 0 };
    expect(await fillIndex(drive())).toEqual({ done: 0, paused: true });
    h.budgetUsed = { generate: 0, embeddings: 0.6 };
    expect(await fillIndex(drive())).toEqual({ done: 0, paused: true });
    expect(h.transcribe).not.toHaveBeenCalled();
    h.budgetUsed = { generate: 0.2, embeddings: 0.2 };
    expect(await fillIndex(drive())).toEqual({ done: 1, paused: false });
  });

  it('starts no new document once its time is up', async () => {
    const { tree, year } = await setup();
    addDoc(year.id, {}, { content: await scanPdf() });
    await reconcile(drive(), tree);
    expect(await fillIndex(drive(), { until: Date.now() - 1 })).toEqual({ done: 0, paused: false });
    expect(h.transcribe).not.toHaveBeenCalled();
  });

  it("doesn't count passing errors (rate limits, Gemini unavailable) as failed tries", async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id, {}, { content: await scanPdf() });
    await reconcile(drive(), tree);
    h.transcribe = vi.fn(async () => {
      throw Object.assign(new Error('Too many requests'), { status: 429 });
    });
    for (let run = 0; run < 4; run++) await fillIndex(drive());
    expect(h.transcribe).toHaveBeenCalledTimes(4);
    expect((await index.get(doc.id))!.indexTries ?? 0).toBe(0);
  });

  it('embeds the details of renamed documents again in the fill step, not while comparing', async () => {
    const { tree, year } = await setup();
    const doc = addDoc(year.id, {}, { content: await textPdf([prose(10)]) });
    await reconcile(drive(), tree);
    await fillIndex(drive());
    const calls = vi.mocked(h.embed).mock.calls.length;

    h.fake.touch(doc.id, f => (f.name = 'Stadtwerke March.pdf'));
    await reconcile(drive(), tree);
    expect(vi.mocked(h.embed).mock.calls.length).toBe(calls);
    expect(await index.get(doc.id)).toMatchObject({ title: 'Stadtwerke March', embedded: false, textSource: 'pdf' });

    expect((await fillIndex(drive())).done).toBe(1);
    expect(vi.mocked(h.embed).mock.calls.at(-1)![0]).toEqual([expect.stringContaining('Title: Stadtwerke March')]);
    expect(await index.get(doc.id)).toMatchObject({ embedded: true });
  });
});

describe('folders changed in Drive', () => {
  it("don't need a full check when Paperwork made them, or only a description changed", async () => {
    const { tree, year, bills } = await setup();
    addDoc(year.id);
    await reconcile(drive(), tree);
    // Paperwork made a year folder; the tree already has it
    const next = h.fake.folder('2026', bills.id);
    forgetTree();
    const fresh = await loadTree(drive());
    expect(await reconcile(drive(), fresh)).toMatchObject({ full: false });

    h.fake.touch(bills.id, f => (f.description = 'Bills, receipts and invoices'));
    const result = await reconcile(drive(), fresh);
    expect(result).toMatchObject({ full: false });
    expect(result.tree.folders.get(bills.id)!.description).toBe('Bills, receipts and invoices');
    expect(fresh.folders.has(next.id)).toBe(true);
  });

  it('need a full check when one is put into the tree, renamed, moved, trashed or deleted', () => {
    const tree = {
      root: { id: 'root' },
      folders: new Map([
        ['root', { id: 'root', name: 'Paperwork', parentId: null, description: '' }],
        ['bills', { id: 'bills', name: 'Bills', parentId: 'root', description: 'Bills' }],
      ]),
    } as any;
    const folder = (overrides: object) => ({ id: 'bills', name: 'Bills', mimeType: 'application/vnd.google-apps.folder', parents: ['root'], description: 'Bills', ...overrides });
    expect(folderChange(tree, { fileId: 'bills', file: folder({}) } as any)).toBe('none');
    expect(folderChange(tree, { fileId: 'bills', file: folder({ description: 'New' }) } as any)).toBe('tree');
    expect(folderChange(tree, { fileId: 'bills', file: folder({ name: 'Rechnungen' }) } as any)).toBe('full');
    expect(folderChange(tree, { fileId: 'bills', file: folder({ parents: ['elsewhere'] }) } as any)).toBe('full');
    expect(folderChange(tree, { fileId: 'bills', file: folder({ trashed: true }) } as any)).toBe('full');
    expect(folderChange(tree, { fileId: 'bills', removed: true } as any)).toBe('full');
    expect(folderChange(tree, { fileId: 'new', file: folder({ id: 'new', name: 'Taxes' }) } as any)).toBe('full');
    expect(folderChange(tree, { fileId: 'other', file: folder({ id: 'other', parents: ['elsewhere'] }) } as any)).toBe('none');
  });

  it('need a full check when the Paperwork folder is a different one', async () => {
    const { tree, year } = await setup();
    addDoc(year.id);
    await reconcile(drive(), tree);
    store.data.set('drive-changes', { ...changesState()!, rootId: 'another-root' });
    expect(await reconcile(drive(), tree)).toMatchObject({ full: true });
  });
});

describe('on the public edge', () => {
  afterEach(() => {
    delete process.env.PAPERWORK_ROLE;
  });

  it('nothing is compared with Drive or read for the index: the app does that', async () => {
    const { tree, year } = await setup();
    addDoc(year.id);
    await index.put(indexedDoc('pending', { textSource: null }));
    process.env.PAPERWORK_ROLE = 'edge';
    const before = h.fake.log.length;

    await expect(reconcile(drive(), tree)).rejects.toBeInstanceOf(FilerOnly);
    await expect(reconcile(drive(), tree, { full: true })).rejects.toBeInstanceOf(FilerOnly);
    await expect(fillIndex(drive())).rejects.toBeInstanceOf(FilerOnly);

    expect(h.fake.log.length).toBe(before);
    expect(changesState()).toBeUndefined();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect((await index.all()).map(d => d.id)).toEqual(['pending']);
  });
});
