// Filing end to end, against an in-memory Google Drive (testing/fakeDrive.ts). Gemini is replaced by a stub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDrive } from './testing/fakeDrive.js';
import { MemoryStore, getStore, setStoreForTests } from './store.js';
import { DocIndex, MemoryIndexBackend, setIndexForTests } from './docIndex.js';
import type { Classification, ClassifyInput } from './classify.js';
import type { DocMeta } from './metadata.js';
import { billMeta, chunk, docLabels, invoiceText, ocrOf, payslipText, prose, receiptText, textPdf, wordVector } from './testing/fixtures.js';

const h = vi.hoisted(() => ({
  fake: null as unknown as import('./testing/fakeDrive.js').FakeDrive,
  connection: null as any,
  classify: null as unknown as (input: ClassifyInput) => Promise<Classification>,
  describeTopics: null as unknown as (docs: { id: string }[], topics: unknown[]) => Promise<Map<string, { topic: string | null; gist: string | null }>>,
  describeItems: null as unknown as (docs: { doc: { id: string }; text: string }[]) => Promise<Map<string, { items: unknown[]; deadlines: unknown[] }>>,
  embed: null as unknown as (texts: string[], task: string) => Promise<number[][]>,
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
  classify: (input: ClassifyInput) => h.classify(input),
  describeTopics: (docs: { id: string }[], topics: unknown[]) => h.describeTopics(docs, topics),
  describeItems: (docs: { doc: { id: string }; text: string }[]) => h.describeItems(docs),
  transcribe: async () => 'transcribed text',
}));

// Embeddings: a vector made from each text's words, so filing can index without Gemini
vi.mock('./gemini.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./gemini.js')>();
  return { ...actual, embed: (texts: string[], task: string) => h.embed(texts, task) };
});

const { syncVault, addFile, updateDocument, refile, retryFile, setDeadlineDone, datesAfter, renameAll, moveTopic } = await import('./pipeline.js');
const { addConvertedDoc, alreadyReceived, detachFile, fillItems, fillTopics, filingStepsForTests, importFromDrive, mergeTopics, releaseSyncLease, takeSyncLease } = await import('./pipeline.js');
const { DuplicateProblem, fillDuplicateChecks, resolvePossibleDuplicate } = await import('./pipeline.js');
const { parseRaw, receiveEmail } = await import('./email.js');
const { FilerOnly } = await import('./roles.js');
const { getIndex: getIndexForTest } = await import('./docIndex.js');
const { loadTree, forgetTree, listDocuments, createFolder, categoryInfos, ensureYearFolder, FolderProblem, VaultProblem } = await import('./vault.js');
const { attachExisting, attachFile } = await import('./attachments.js');
const { reconcile } = await import('./sync.js');
const { Drive, DriveGuardError } = await import('./drive.js');
const { recentActivity } = await import('./activity.js');
const { LimitError } = await import('./gemini.js');
const { dupTag, fileName } = await import('./metadata.js');
const { fromDrive } = await import('./indexing.js');
const { headerText } = await import('./text.js');
const { deadlineItems } = await import('../shared/filter.js');

const bill = (input: ClassifyInput): Classification => ({
  title: 'Electricity bill March',
  type: 'invoice',
  category: input.fixedCategory ?? 'Bills & Receipts',
  correspondent: 'Stadtwerke Musterstadt',
  date: '2025-03-14',
  amount: 87.45,
  currency: 'EUR',
  dueDate: '2025-04-25',
  deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: false }],
  items: [],
  tags: ['electricity'],
  references: null,
  action: 'Pay 87.45 EUR by 2025-04-25',
  summary: 'Electricity for March 2025.',
  topic: null,
  gist: null,
  needsReview: false,
  confidence: 0.9,
  text: 'Stadtwerke Musterstadt. Rechnung März 2025. Betrag 87,45 EUR.',
});

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.7 ${text}`);
const drive = () => new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch });

let index: DocIndex;

async function setup() {
  const tree = await loadTree(drive());
  const root = h.fake.find('Paperwork')!;
  const inbox = h.fake.find('Inbox')!;
  return { tree, root, inbox, category: (name: string) => h.fake.childrenOf(root.id).find(f => f.name === name)! };
}

beforeEach(() => {
  h.fake = new FakeDrive();
  h.connection = { ownerEmail: 'me@example.com', refreshToken: 'sealed', scope: '', connectedAt: '' };
  h.classify = vi.fn(async (input: ClassifyInput) => bill(input));
  h.describeTopics = vi.fn(async () => new Map());
  h.describeItems = vi.fn(async () => new Map());
  h.embed = vi.fn(async (texts: string[]) => texts.map(t => wordVector(t)));
  // Filed straight into folders, unless a test turns checking on
  const store = new MemoryStore();
  store.data.set('settings', { views: [], review: 'automatic' });
  setStoreForTests(store);
  index = new DocIndex(new MemoryIndexBackend());
  setIndexForTests(index);
  forgetTree();
});

describe('the Paperwork folder', () => {
  it('is created on first use, with an Inbox and the category folders', async () => {
    const { tree, root } = await setup();
    expect(root.parents).toEqual([h.fake.myDriveRoot]);
    expect(root.properties).toEqual({ paperwork: 'root' });
    expect(tree.inbox.name).toBe('Inbox');
    expect(tree.categories.map(c => c.name)).toContain('Bills & Receipts');
    expect(tree.categories.find(c => c.name === 'Insurance')!.description).toMatch(/policies/i);
    expect(h.connection.rootFolderId).toBe(root.id);
  });

  it('is found again by its label when the stored ID is gone', async () => {
    const root = h.fake.folder('My Papers', h.fake.myDriveRoot, { paperwork: 'root' });
    h.fake.folder('Inbox', root.id, { paperwork: 'inbox' });
    h.fake.folder('Taxes', root.id);
    const tree = await loadTree(drive());
    expect(tree.root.id).toBe(root.id);
    expect(tree.categories.map(c => c.name)).toEqual(['Taxes']);
  });

  it('treats folders made by hand as categories and a hand-made Inbox as the Inbox', async () => {
    const root = h.fake.folder('Paperwork', h.fake.myDriveRoot, { paperwork: 'root' });
    h.fake.folder('Inbox', root.id);
    h.fake.folder('Garden', root.id, undefined, 'Plants and tools');
    h.connection.rootFolderId = root.id;
    const tree = await loadTree(drive());
    expect(tree.inbox.name).toBe('Inbox');
    expect(tree.categories.map(c => [c.name, c.description])).toEqual([['Garden', 'Plants and tools']]);
  });

  it('is made once when several requests arrive together', async () => {
    await Promise.all([loadTree(drive()), loadTree(drive()), loadTree(drive())]);
    expect([...h.fake.files.values()].filter(f => f.properties?.paperwork === 'root')).toHaveLength(1);
  });

  it('gets one year folder when several documents of a new year arrive together', async () => {
    await setup();
    await Promise.all(
      ['one', 'two', 'three'].map(text => addFile({ name: `${text}.pdf`, mimeType: 'application/pdf', data: pdf(text), source: 'upload' }))
    );
    expect([...h.fake.files.values()].filter(f => f.name === '2025')).toHaveLength(1);
  });

  it('reports a trashed folder instead of making a new one', async () => {
    const { root } = await setup();
    root.trashed = true;
    forgetTree();
    await expect(loadTree(drive())).rejects.toBeInstanceOf(VaultProblem);
  });
});

describe('filing from the Inbox', () => {
  it('names, describes and moves a scan into Category/Year', async () => {
    const { inbox, category } = await setup();
    const scan = h.fake.add({ name: 'Scanned_20251016-0830.pdf', parents: [inbox.id], content: pdf('electricity') });

    const summary = await syncVault('test');

    expect(summary).toMatchObject({ filed: 1, failed: 0, duplicates: 0 });
    const filed = h.fake.files.get(scan.id)!;
    const year = h.fake.childrenOf(category('Bills & Receipts').id).find(f => f.name === '2025')!;
    expect(filed.parents).toEqual([year.id]);
    expect(filed.name).toBe('2025-03-14 Stadtwerke Musterstadt - Electricity bill March.pdf');
    expect(filed.description).toContain('Electricity for March 2025.');
    expect(filed.description).toContain('Due: 2025-04-25');
    expect(filed.properties).toMatchObject({ paperwork: 'doc', pwType: 'invoice', pwFrom: 'Stadtwerke Musterstadt', pwAmount: '87.45', pwMd5: scan.md5Checksum });

    const docs = await listDocuments(drive(), await loadTree(drive()));
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ title: 'Electricity bill March', category: 'Bills & Receipts', folderPath: ['Bills & Receipts', '2025'], amount: 87.45 });
    expect(h.fake.destructive()).toEqual([]);
  });

  it('gives the AI the folders, the names already in use and how the file arrived', async () => {
    const { inbox } = await setup();
    h.fake.add({ name: 'a.pdf', parents: [inbox.id], content: pdf('one') });
    await syncVault('test');
    h.fake.add({ name: 'b.pdf', parents: [inbox.id], content: pdf('two'), description: 'Email from me: Fwd: Police' });
    await syncVault('test');
    const second = vi.mocked(h.classify).mock.calls[1][0];
    expect(second.correspondents).toEqual(['Stadtwerke Musterstadt']);
    expect(second.tags).toEqual(['electricity']);
    expect(second.notes).toBe('Email from me: Fwd: Police');
    expect(second.categories.map(c => c.name)).toContain('Insurance');
  });

  it('moves a file that is already in Paperwork to Duplicates instead of filing it twice', async () => {
    const { inbox, root } = await setup();
    h.fake.add({ name: 'first.pdf', parents: [inbox.id], content: pdf('same') });
    await syncVault('test');
    const copy = h.fake.add({ name: 'again.pdf', parents: [inbox.id], content: pdf('same') });

    const summary = await syncVault('test');

    expect(summary.duplicates).toBe(1);
    const duplicates = h.fake.childrenOf(root.id).find(f => f.name === 'Duplicates')!;
    expect(h.fake.files.get(copy.id)!.parents).toEqual([duplicates.id]);
    expect(h.fake.files.get(copy.id)!.properties?.paperwork).toBe('duplicate');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(h.fake.destructive()).toEqual([]);
  });

  it('leaves files it cannot read in the Inbox, marked, and does not try them again', async () => {
    const { inbox } = await setup();
    const zip = h.fake.add({ name: 'photos.zip', mimeType: 'application/zip', parents: [inbox.id], content: new Uint8Array([1, 2]) });
    await syncVault('test');
    expect(h.fake.files.get(zip.id)).toMatchObject({ parents: [inbox.id], properties: { pwState: 'unsupported' } });
    await syncVault('test');
    expect(h.classify).not.toHaveBeenCalled();
  });

  it('gives up on a file after three failed attempts, until asked to retry', async () => {
    const { inbox } = await setup();
    h.classify = vi.fn(async () => {
      throw new Error('model unavailable');
    });
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('x') });
    for (let i = 0; i < 4; i++) await syncVault('test');
    expect(h.classify).toHaveBeenCalledTimes(3);
    expect(h.fake.files.get(scan.id)!.properties).toMatchObject({ pwState: 'failed', pwTries: '3', pwError: 'model unavailable' });

    h.classify = vi.fn(async (input: ClassifyInput) => bill(input));
    const result = await retryFile(scan.id);
    expect(result.status).toBe('filed');
    expect(h.fake.files.get(scan.id)!.properties?.pwState).toBeUndefined();
  });

  it('describes files put into a category by hand without renaming or moving them', async () => {
    const { category } = await setup();
    const insurance = category('Insurance');
    const own = h.fake.add({ name: 'Car policy 2024.pdf', parents: [insurance.id], content: pdf('policy') });

    const summary = await syncVault('test');

    expect(summary.adopted).toBe(1);
    expect(vi.mocked(h.classify).mock.calls[0][0].fixedCategory).toBe('Insurance');
    const file = h.fake.files.get(own.id)!;
    expect(file.name).toBe('Car policy 2024.pdf');
    expect(file.parents).toEqual([insurance.id]);
    expect(file.properties?.paperwork).toBe('doc');
    const [doc] = await listDocuments(drive(), await loadTree(drive()));
    expect(doc.title).toBe('Car policy 2024');
  });
});

describe('adding files', () => {
  it('puts an upload into the Inbox and files it right away', async () => {
    await setup();
    const result = await addFile({ name: 'IMG_2041.jpg', mimeType: 'image/jpeg', data: pdf('photo'), source: 'upload' });
    expect(result.status).toBe('filed');
    expect(result.document).toMatchObject({ source: 'upload', category: 'Bills & Receipts' });
    expect(h.fake.files.get(result.document!.id)!.name).toBe('2025-03-14 Stadtwerke Musterstadt - Electricity bill March.jpg');
  });

  it('does not add a file whose content is already in Paperwork', async () => {
    await setup();
    const first = await addFile({ name: 'a.pdf', mimeType: 'application/pdf', data: pdf('same'), source: 'upload' });
    const before = h.fake.files.size;
    const second = await addFile({ name: 'b.pdf', mimeType: 'application/pdf', data: pdf('same'), source: 'email' });
    expect(second.status).toBe('duplicate');
    expect(second.duplicateOf!.id).toBe(first.document!.id);
    expect(h.fake.files.size).toBe(before);
  });

  it('does not add a file that is kept with a document already, and names that document', async () => {
    await setup();
    const doc = (await addFile({ name: 'contract.pdf', mimeType: 'application/pdf', data: pdf('signed'), source: 'upload' })).document!;
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    await attachFile(doc.id, { name: 'Vertrag.docx', mimeType: docx, data: new TextEncoder().encode('draft') });
    const before = h.fake.files.size;

    const again = await addFile({ name: 'Vertrag (1).docx', mimeType: docx, data: new TextEncoder().encode('draft'), source: 'email' });

    expect(again).toMatchObject({ status: 'duplicate', duplicateOf: { id: doc.id }, keptWith: { id: doc.id } });
    expect(h.fake.files.size).toBe(before);
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

  it('keeps a file it cannot read, in the Inbox', async () => {
    const { inbox } = await setup();
    const result = await addFile({ name: 'data.xlsx', mimeType: 'application/vnd.ms-excel', data: new Uint8Array([1]), source: 'upload' });
    expect(result.status).toBe('unsupported');
    expect(h.fake.childrenOf(inbox.id).map(f => f.name)).toEqual(['data.xlsx']);
  });
});

describe('changes from the app', () => {
  async function filedDoc() {
    const { inbox, category } = await setup();
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });
    await syncVault('test');
    return { id: scan.id, category };
  }

  it('keeps long values whole in Drive when a document is edited (Drive labels hold only shortened copies)', async () => {
    const references = 'Customer: 88123 · Contract: 2025-0042-STROM-OEKO · Meter: 1ESY1160523917 · Account ending 4821 · Branch 7731 · Tariff: Ökostrom Plus 24';
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...bill(input), references }));
    const { id } = await filedDoc();
    expect(h.fake.files.get(id)!.properties!.pwRef.endsWith('…')).toBe(true);

    await updateDocument(id, { tags: ['home'] });

    expect(h.fake.files.get(id)!.description).toContain(`Reference: ${references}`);
    expect((await getIndexForTest().get(id))!.references).toBe(references);
  });

  it('takes edited deadlines without repeats, whatever their case', async () => {
    const { id } = await filedDoc();
    const doc = await updateDocument(id, {
      deadlines: [
        { date: '2026-11-30', what: 'Cancel', done: false },
        { date: '2026-11-30', what: 'cancel', done: true },
        { date: 'soon', what: 'Nothing', done: false },
      ],
    });
    expect(doc.deadlines).toEqual([{ date: '2026-11-30', what: 'Cancel', done: false }]);
  });

  it('renames, re-describes and moves a document to its new category and year', async () => {
    const { id, category } = await filedDoc();
    const insurance = category('Insurance');
    const doc = await updateDocument(id, { categoryId: insurance.id, title: 'Car insurance premium', date: '2024-12-01', correspondent: 'Allianz' });
    expect(doc).toMatchObject({ category: 'Insurance', folderPath: ['Insurance', '2024'], title: 'Car insurance premium', correspondent: 'Allianz' });
    expect(h.fake.files.get(id)!.name).toBe('2024-12-01 Allianz - Car insurance premium.pdf');
    expect(h.fake.destructive()).toEqual([]);
  });

  it('stars without touching anything else', async () => {
    const { id } = await filedDoc();
    const before = h.fake.log.length;
    await updateDocument(id, { starred: true });
    const patches = h.fake.log.slice(before).filter(r => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ starred: true });
  });

  it('keeps a name given in Drive unless the title is edited', async () => {
    const { id } = await filedDoc();
    h.fake.files.get(id)!.name = 'My own name.pdf';
    const doc = await updateDocument(id, { tags: ['home'] });
    expect(doc.title).toBe('My own name');
    expect(h.fake.files.get(id)!.name).toBe('My own name.pdf');
  });

  it('re-reads and re-files a document', async () => {
    const { id } = await filedDoc();
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...bill(input), category: 'Insurance', title: 'Policy', date: '2023-01-02' }));
    const result = await refile(id);
    expect(result.document).toMatchObject({ folderPath: ['Insurance', '2023'], title: 'Policy' });
  });

  it('never touches files outside the Paperwork folder', async () => {
    await setup();
    const outside = h.fake.add({ name: 'Private.pdf', parents: [h.fake.myDriveRoot], properties: { paperwork: 'doc' }, content: pdf('private') });
    expect(await listDocuments(drive(), await loadTree(drive()))).toEqual([]);
    await expect(updateDocument(outside.id, { title: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(refile(outside.id)).rejects.toMatchObject({ status: 404 });
    await expect(retryFile(outside.id)).rejects.toBeInstanceOf(DriveGuardError);
    expect(h.fake.log.filter(r => r.method !== 'GET' && r.path.includes(outside.id))).toEqual([]);
  });

  it('refuses to move a document into a folder outside Paperwork', async () => {
    const { id } = await filedDoc();
    const elsewhere = h.fake.folder('Elsewhere', h.fake.myDriveRoot);
    await expect(updateDocument(id, { categoryId: elsewhere.id })).rejects.toBeInstanceOf(DriveGuardError);
  });

  it('logs what happened', async () => {
    await filedDoc();
    const entries = await recentActivity();
    expect(entries[0]).toMatchObject({ kind: 'filed', name: '2025-03-14 Stadtwerke Musterstadt - Electricity bill March.pdf', detail: 'Bills & Receipts / 2025' });
  });
});

describe('the search index', () => {
  async function filedDoc() {
    const { inbox, category } = await setup();
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });
    await syncVault('test');
    return { id: scan.id, category };
  }

  it('keeps values at full length while the Drive labels hold shortened copies, with the text and its embeddings', async () => {
    const { inbox } = await setup();
    const references = Array.from({ length: 6 }, (_, i) => `Contract ${i + 1}: DE-2025-${String(i + 1).repeat(8)}`).join(' · ');
    const correspondent = 'Stadtwerke Musterstadt Versorgungs GmbH, Kundenservice Energie und Wasser, Emmy-Noether-Straße 2, 12345 Musterstadt, Deutschland';
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...bill(input), references, correspondent }));
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });

    await syncVault('test');

    const labels = h.fake.files.get(scan.id)!.properties!;
    for (const key of ['pwRef', 'pwFrom']) {
      expect(labels[key].endsWith('…')).toBe(true);
      expect(Buffer.byteLength(key + labels[key])).toBeLessThanOrEqual(124);
    }
    const entry = (await index.get(scan.id))!;
    expect(entry).toMatchObject({ references, correspondent, textSource: 'ocr', textLength: bill(vi.mocked(h.classify).mock.calls[0][0]).text!.length, embedded: true, md5: scan.md5Checksum });
    expect(h.classify).toHaveBeenCalledWith(expect.objectContaining({ transcribe: true }));

    const chunks = await index.chunks(scan.id);
    expect(chunks.map(c => c.n)).toEqual([0, 1]);
    expect(chunks[0].text).toContain('Title: Electricity bill March');
    expect(chunks[0].text).toContain(`References: ${references}`);
    expect(chunks[1].text).toBe('Stadtwerke Musterstadt. Rechnung März 2025. Betrag 87,45 EUR.');
    expect(chunks.every(c => c.embedding?.length)).toBe(true);

    // Later runs see the filing in Drive's change feed, and a rename by hand, and keep the full values
    h.fake.touch(scan.id, f => (f.name = 'Strom März.pdf'));
    await syncVault('test');
    expect(await index.get(scan.id)).toMatchObject({ title: 'Strom März', references, correspondent, textSource: 'ocr' });
  });

  it("reads a PDF's own text instead of asking for a transcription", async () => {
    await setup();
    const text = prose(12);
    const result = await addFile({ name: 'letter.pdf', mimeType: 'application/pdf', data: await textPdf([text]), source: 'upload' });

    expect(result.document).toMatchObject({ textSource: 'pdf', textLength: text.length });
    expect(h.classify).toHaveBeenCalledWith(expect.objectContaining({ transcribe: false }));
    const chunks = await index.chunks(result.document!.id);
    expect(chunks[1].text.replace(/\s+/g, ' ')).toBe(text);
  });

  it('files a document even when embedding fails, and embeds it on a later run', async () => {
    const { inbox } = await setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.embed = vi.fn(async () => {
      throw new Error('The embedding model is unavailable.');
    });
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });

    expect(await syncVault('test')).toMatchObject({ filed: 1, failed: 0, indexed: 0 });

    expect(h.fake.files.get(scan.id)!.name).toBe('2025-03-14 Stadtwerke Musterstadt - Electricity bill March.pdf');
    expect(await index.get(scan.id)).toMatchObject({ textSource: 'ocr', embedded: false });
    expect((await index.chunks(scan.id)).map(c => c.embedding)).toEqual([null, null]);

    h.embed = vi.fn(async (texts: string[]) => texts.map(t => wordVector(t)));
    expect(await syncVault('test')).toMatchObject({ indexed: 1 });
    expect(await index.get(scan.id)).toMatchObject({ embedded: true });
    expect((await index.chunks(scan.id)).every(c => c.embedding)).toBe(true);
  });

  it('files a document even when the index cannot be written', async () => {
    const { inbox } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    class Unavailable extends MemoryIndexBackend {
      override async putChunks(): Promise<void> {
        throw new Error('Firestore is unavailable.');
      }
    }
    setIndexForTests(new DocIndex(new Unavailable()));
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });

    const summary = await syncVault('test');

    expect(summary).toMatchObject({ filed: 1, failed: 0 });
    expect(h.fake.files.get(scan.id)!.properties).toMatchObject({ paperwork: 'doc', pwTitle: 'Electricity bill March' });
    expect((await recentActivity())[0]).toMatchObject({ kind: 'filed', fileId: scan.id });
  });

  it('takes deadlines edited in the app as given, done or not', async () => {
    const { id } = await filedDoc();
    const expected = [
      { date: '2025-04-25', what: 'Pay 87.45 EUR', done: true },
      { date: '2025-05-01', what: 'Cancellation deadline', done: false },
    ];

    const doc = await updateDocument(id, {
      deadlines: [
        { date: '2025-05-01', what: 'Cancellation deadline', done: false },
        { date: '2025-04-25', what: 'Pay 87.45 EUR', done: true },
        { date: 'someday', what: 'Not a date', done: false },
        { date: '2025-06-01', what: '   ', done: false },
      ],
    });

    expect(doc.deadlines).toEqual(expected);
    expect((await index.get(id))!.deadlines).toEqual(expected);
    expect(h.fake.files.get(id)!.description).toContain('Dates: 2025-04-25 Pay 87.45 EUR · 2025-05-01 Cancellation deadline');

    // Ticked off by mistake: unticked again in the app
    const again = await updateDocument(id, { deadlines: [{ ...expected[0], done: false }, expected[1]] });
    expect(again.deadlines.map(d => d.done)).toEqual([false, false]);
    expect((await index.get(id))!.deadlines.map(d => d.done)).toEqual([false, false]);
  });

  it('ticks a deadline off in the index alone, without writing to Drive', async () => {
    const { id } = await filedDoc();
    const before = h.fake.log.length;

    const doc = await setDeadlineDone(id, { date: '2025-04-25', what: 'Pay 87.45 EUR' }, true);

    expect(doc.deadlines).toEqual([{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: true }]);
    expect(doc).not.toHaveProperty('md5');
    expect((await index.get(id))!.deadlines[0].done).toBe(true);
    expect(h.fake.log.slice(before)).toEqual([]);
    expect((await setDeadlineDone(id, { date: '2025-04-25', what: 'Pay 87.45 EUR' }, false)).deadlines[0].done).toBe(false);
  });

  it('refuses to tick off a deadline the document does not have', async () => {
    const { id } = await filedDoc();
    await expect(setDeadlineDone(id, { date: '2025-04-26', what: 'Pay 87.45 EUR' }, true)).rejects.toMatchObject({ status: 404 });
    await expect(setDeadlineDone(id, { date: '2025-04-25', what: 'Something else' }, true)).rejects.toMatchObject({ status: 404 });
    await expect(setDeadlineDone('not-a-document', { date: '2025-04-25', what: 'Pay 87.45 EUR' }, true)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps a ticked-off deadline through other edits and through changes made in Drive', async () => {
    const { id } = await filedDoc();
    await setDeadlineDone(id, { date: '2025-04-25', what: 'Pay 87.45 EUR' }, true);

    await updateDocument(id, { tags: ['home'] });
    expect((await index.get(id))!).toMatchObject({ tags: ['home'], deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: true }] });

    h.fake.touch(id, f => (f.name = 'Strom.pdf'));
    await syncVault('test');
    expect((await index.get(id))!).toMatchObject({ title: 'Strom', deadlines: [{ done: true }] });
  });

  it('stars in the index too, without embedding anything again', async () => {
    const { id } = await filedDoc();
    const embedded = vi.mocked(h.embed).mock.calls.length;

    const doc = await updateDocument(id, { starred: true });

    expect(doc).toMatchObject({ starred: true, textSource: 'ocr', deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: false }] });
    expect(await index.get(id)).toMatchObject({ starred: true, embedded: true });
    expect(h.embed).toHaveBeenCalledTimes(embedded);
  });

  it('takes a re-filed document that turns out to be a copy out of the index', async () => {
    const { inbox, category } = await setup();
    const first = h.fake.add({ name: 'first.pdf', parents: [inbox.id], content: pdf('same') });
    await syncVault('test');
    // The same file, put into a category by hand: described where it is, without a duplicate check
    const copy = h.fake.add({ name: 'Bill again.pdf', parents: [category('Insurance').id], content: pdf('same') });
    expect(await syncVault('test')).toMatchObject({ adopted: 1 });
    expect(await index.get(copy.id)).not.toBeNull();

    const result = await refile(copy.id);

    expect(result).toMatchObject({ status: 'duplicate', duplicateOf: { id: first.id } });
    expect(await index.get(copy.id)).toBeNull();
    expect(await index.chunks(copy.id)).toEqual([]);
    expect(await index.get(first.id)).not.toBeNull();
    expect(h.fake.files.get(copy.id)!.properties?.paperwork).toBe('duplicate');
    await syncVault('test');
    expect(await index.get(copy.id)).toBeNull();
    expect(h.fake.destructive()).toEqual([]);
  });

  it("counts in each run's summary the documents changed in Drive and those read for the index", async () => {
    const { category } = await setup();
    // Filed before the index existed: labelled in Drive, unknown to the index
    const meta = { ...bill({} as ClassifyInput), title: 'Car insurance policy', correspondent: 'Allianz' };
    const name = fileName(meta, { name: 'policy.pdf', mimeType: 'application/pdf' });
    const old = h.fake.add({ name, parents: [category('Insurance').id], ...docLabels(meta, name), content: await textPdf([prose(10)]) });

    expect(await syncVault('test')).toMatchObject({ updated: 1, indexed: 1, filed: 0, adopted: 0 });
    expect(await index.get(old.id)).toMatchObject({ title: 'Car insurance policy', textSource: 'pdf', embedded: true });

    // A new title changes what search by meaning is built from: embedded again in the same run
    h.fake.touch(old.id, f => (f.name = 'Car policy.pdf'));
    expect(await syncVault('test')).toMatchObject({ updated: 1, indexed: 1 });
    expect(await index.get(old.id)).toMatchObject({ title: 'Car policy', embedded: true });

    h.fake.touch(old.id, f => (f.trashed = true));
    expect(await syncVault('test')).toMatchObject({ updated: 1, indexed: 0 });
    expect(await index.get(old.id)).toBeNull();
    expect((await recentActivity())[0]).toMatchObject({ kind: 'removed', fileId: old.id });
  });
});

describe('after the second review', () => {
  async function filedDoc() {
    const { inbox } = await setup();
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });
    await syncVault('test');
    return scan.id;
  }

  it('files a scan too long to write out while reading it, and reads its text in the same run', async () => {
    const { inbox } = await setup();
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...bill(input), text: null, textPending: true }));
    const scan = h.fake.add({ name: 'long scan.pdf', parents: [inbox.id], content: pdf('forty pages') });

    expect(await syncVault('test')).toMatchObject({ filed: 1, indexed: 1 });

    expect(await index.get(scan.id)).toMatchObject({ title: 'Electricity bill March', textSource: 'ocr', textLength: 'transcribed text'.length, embedded: true });
    expect((await index.chunks(scan.id))[1].text).toBe('transcribed text');
  });

  it('keeps edits and deadlines ticked off at the same time', async () => {
    const id = await filedDoc();
    await Promise.all([updateDocument(id, { tags: ['home'] }), setDeadlineDone(id, { date: '2025-04-25', what: 'Pay 87.45 EUR' }, true), updateDocument(id, { title: 'Power bill March' })]);
    expect(await index.get(id)).toMatchObject({ tags: ['home'], title: 'Power bill March', deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: true }] });
  });

  it('moves the due date along with its deadline, and the deadline along with the due date', async () => {
    const id = await filedDoc();
    let doc = await updateDocument(id, {
      deadlines: [
        { date: '2025-04-30', what: 'Pay 87.45 EUR', done: false },
        { date: '2025-06-01', what: 'Meter reading', done: false },
      ],
    });
    expect(doc).toMatchObject({ dueDate: '2025-04-30' });
    expect(h.fake.files.get(id)!.properties).toMatchObject({ pwDue: '2025-04-30' });

    doc = await updateDocument(id, { dueDate: '2025-05-05' });
    expect(doc.dueDate).toBe('2025-05-05');
    expect(doc.deadlines).toEqual([
      { date: '2025-05-05', what: 'Pay 87.45 EUR', done: false },
      { date: '2025-06-01', what: 'Meter reading', done: false },
    ]);

    doc = await updateDocument(id, { dueDate: null });
    expect(doc).toMatchObject({ dueDate: null, deadlines: [{ date: '2025-06-01', what: 'Meter reading', done: false }] });
  });

  it('works out the due date from edited deadlines', () => {
    const current = { dueDate: '2025-04-25', action: 'Pay 87.45 EUR', deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: false }] };
    const meter = { date: '2025-06-01', what: 'Meter reading', done: false };
    // The main deadline removed: the soonest open one is due
    expect(datesAfter(current, { deadlines: [{ date: '2025-03-01', what: 'Done already', done: true }, meter] })).toMatchObject({ dueDate: '2025-06-01' });
    // None left
    expect(datesAfter(current, { deadlines: [] })).toEqual({ dueDate: null, deadlines: [] });
    // Both given: as given
    expect(datesAfter(current, { deadlines: [meter], dueDate: '2025-07-01' })).toEqual({ dueDate: '2025-07-01', deadlines: [meter] });
    // A due date that wasn't among the deadlines (older documents) stays
    expect(datesAfter({ ...current, deadlines: [] }, { deadlines: [meter] })).toEqual({ dueDate: '2025-04-25', deadlines: [meter] });
    // A due date set where there was none: a deadline described by the to-do
    expect(datesAfter({ dueDate: null, action: 'Pay · now', deadlines: [meter] }, { dueDate: '2025-05-01' })).toEqual({
      dueDate: '2025-05-01',
      deadlines: [{ date: '2025-05-01', what: 'Pay, now', done: false }, meter],
    });
  });

  it("keeps deadline descriptions from breaking the description's facts line", async () => {
    const id = await filedDoc();
    const doc = await updateDocument(id, { deadlines: [{ date: '2025-05-01', what: 'Cancel\n· or renew', done: false }, { date: '2025-06-01', what: 'Pay', done: false }] });
    expect(doc.deadlines.map(d => d.what)).toEqual(['Cancel, or renew', 'Pay']);
    expect(h.fake.files.get(id)!.description).toContain('Dates: 2025-05-01 Cancel, or renew · 2025-06-01 Pay');
  });
});

describe('companies and topics', () => {
  const policy = (input: ClassifyInput, topic: string, gist: string, title = 'Premium notice'): Classification => ({
    ...bill(input),
    title,
    type: 'policy',
    category: 'Insurance',
    correspondent: 'Allianz',
    topic,
    gist,
  });

  it('files a document with its topic and gist, and gives the next one the topics known so far', async () => {
    const { inbox } = await setup();
    h.classify = vi.fn(async (input: ClassifyInput) => policy(input, 'Car insurance VW Golf', 'Premium for 2027 rises to 642.18 EUR'));
    const first = h.fake.add({ name: 'one.pdf', parents: [inbox.id], content: pdf('one') });
    await syncVault('test');

    expect(await index.get(first.id)).toMatchObject({ topic: 'Car insurance VW Golf', gist: 'Premium for 2027 rises to 642.18 EUR', described: true });
    expect(h.fake.files.get(first.id)!.description).toContain('Topic: Car insurance VW Golf');
    expect(h.fake.files.get(first.id)!.properties).toMatchObject({ pwTopic: 'Car insurance VW Golf', pwV: '2' });

    h.fake.add({ name: 'two.pdf', parents: [inbox.id], content: pdf('two') });
    await syncVault('test');
    expect(vi.mocked(h.classify).mock.calls[1][0].topics).toEqual([{ topic: 'Car insurance VW Golf', correspondents: ['Allianz'] }]);
  });

  it('edits a topic and gist like any other field', async () => {
    const { inbox } = await setup();
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });
    await syncVault('test');
    const doc = await updateDocument(scan.id, { topic: '  Electricity  contract ', gist: 'March: 87.45 EUR' });
    expect(doc).toMatchObject({ topic: 'Electricity contract', gist: 'March: 87.45 EUR' });
    expect((await updateDocument(scan.id, { topic: '' })).topic).toBeNull();
  });

  it('renames a topic in all its documents, merging it into another, and a correspondent everywhere', async () => {
    const { inbox } = await setup();
    const answers = [
      ['Car insurance VW Golf', 'Policy starts 2024-01-01'],
      ['Car insurance Golf', 'Premium for 2025: 598.40 EUR'],
      ['Liability insurance', 'Policy confirmed'],
    ];
    const ids: string[] = [];
    for (const [i, [topic, gist]] of answers.entries()) {
      h.classify = vi.fn(async (input: ClassifyInput) => policy(input, topic, gist, `Letter ${i}`));
      ids.push(h.fake.add({ name: `${i}.pdf`, parents: [inbox.id], content: pdf(String(i)) }).id);
      await syncVault('test');
    }

    expect(await renameAll({ correspondent: 'Allianz', topic: 'Car insurance Golf', to: 'Car insurance VW Golf' })).toEqual({ updated: 1, failed: 0 });
    expect((await index.all()).map(d => d.topic).sort()).toEqual(['Car insurance VW Golf', 'Car insurance VW Golf', 'Liability insurance']);

    expect(await renameAll({ correspondent: 'Allianz', to: 'Allianz Versicherungs-AG' })).toEqual({ updated: 3, failed: 0 });
    for (const id of ids) {
      expect(await index.get(id)).toMatchObject({ correspondent: 'Allianz Versicherungs-AG' });
      expect(h.fake.files.get(id)!.name).toContain('Allianz Versicherungs-AG - ');
    }
    expect(h.fake.destructive()).toEqual([]);
  });

  it('gives documents filed before topics existed a topic and gist, a batch per run', async () => {
    const { category } = await setup();
    // Labelled by an earlier Paperwork: no topic yet
    const older = (title: string, content: string) => {
      const meta = { ...bill({} as ClassifyInput), title, correspondent: 'Allianz' };
      const name = fileName(meta, { name: `${title}.pdf`, mimeType: 'application/pdf' });
      const labels = docLabels(meta, name);
      return h.fake.add({ name, parents: [category('Insurance').id], ...labels, properties: { ...labels.properties, pwV: '1' }, content: pdf(content) });
    };
    const a = older('Policy', 'a');
    const b = older('Premium notice', 'b');
    h.describeTopics = vi.fn(async () => new Map([[a.id, { topic: 'Car insurance VW Golf', gist: 'Policy starts 2024-01-01' }]]));

    await syncVault('test');

    expect(h.describeTopics).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.describeTopics).mock.calls[0][0].map(d => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(await index.get(a.id)).toMatchObject({ topic: 'Car insurance VW Golf', gist: 'Policy starts 2024-01-01', described: true });
    expect(h.fake.files.get(a.id)!.properties).toMatchObject({ pwV: '2', pwTopic: 'Car insurance VW Golf' });
    // Left out of the answer: given none, and not asked about again
    expect(await index.get(b.id)).toMatchObject({ topic: null, described: true });
    await syncVault('test');
    expect(h.describeTopics).toHaveBeenCalledTimes(1);
  });

  it('keeps an older document waiting for its topic when an edit gives it none', async () => {
    const { category } = await setup();
    const meta = { ...bill({} as ClassifyInput), title: 'Old letter' };
    const name = fileName(meta, { name: 'old.pdf', mimeType: 'application/pdf' });
    const labels = docLabels(meta, name);
    const file = h.fake.add({ name, parents: [category('Housing').id], ...labels, properties: { ...labels.properties, pwV: '1' }, content: pdf('old') });
    h.describeTopics = vi.fn(async () => {
      throw new Error('Not now');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await syncVault('test');

    await updateDocument(file.id, { tags: ['flat'] });

    expect(h.fake.files.get(file.id)!.properties?.pwV).toBe('1');
    expect(await index.get(file.id)).toMatchObject({ described: false, tags: ['flat'] });
  });
});

describe('checking new documents first (review mode manual)', () => {
  const checkFirst = async () => {
    const { getStore } = await import('./store.js');
    await getStore().set('settings', { views: [], review: 'manual' });
  };

  it('describes a new document but leaves it in the Inbox, in its category, until it is checked', async () => {
    const { inbox, category } = await setup();
    await checkFirst();
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });

    const summary = await syncVault('test');

    expect(summary).toMatchObject({ filed: 1 });
    const file = h.fake.files.get(scan.id)!;
    expect(file.parents).toEqual([inbox.id]);
    expect(file.name).toBe('2025-03-14 Stadtwerke Musterstadt - Electricity bill March.pdf');
    expect(file.properties).toMatchObject({ paperwork: 'doc', pwReview: '1', pwCat: category('Bills & Receipts').id });
    expect(h.fake.childrenOf(category('Bills & Receipts').id).find(f => f.name === '2025')).toBeUndefined();
    expect(await index.get(scan.id)).toMatchObject({ needsReview: true, inInbox: true, category: 'Bills & Receipts', folderPath: ['Inbox'] });
    expect((await recentActivity())[0]).toMatchObject({ kind: 'filed', detail: 'Waiting for your check in the Inbox · Bills & Receipts' });

    // Not filed again by the next runs, and still a document after a full check
    await syncVault('test');
    expect(h.classify).toHaveBeenCalledTimes(1);
    expect(await index.get(scan.id)).toMatchObject({ inInbox: true });
  });

  it('keeps an edit before the check in the Inbox, and moves the document into its folder once checked', async () => {
    const { inbox, category } = await setup();
    await checkFirst();
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });
    await syncVault('test');

    const edited = await updateDocument(scan.id, { categoryId: category('Insurance').id, title: 'Premium notice' });
    expect(edited).toMatchObject({ inInbox: true, category: 'Insurance', needsReview: true });
    expect(h.fake.files.get(scan.id)!.parents).toEqual([inbox.id]);
    expect(h.fake.files.get(scan.id)!.properties).toMatchObject({ pwCat: category('Insurance').id });

    const checked = await updateDocument(scan.id, { needsReview: false });

    expect(checked).toMatchObject({ inInbox: false, needsReview: false, category: 'Insurance', folderPath: ['Insurance', '2025'] });
    expect(h.fake.files.get(scan.id)!.properties?.pwCat).toBeUndefined();
    expect(h.fake.files.get(scan.id)!.properties?.pwReview).toBeUndefined();
    expect((await recentActivity())[0]).toMatchObject({ kind: 'checked', fileId: scan.id, detail: 'Insurance / 2025' });
    expect(h.fake.destructive()).toEqual([]);
  });

  it('puts a document read again back into the Inbox to be checked', async () => {
    const { inbox } = await setup();
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });
    await syncVault('test');
    expect(await index.get(scan.id)).toMatchObject({ inInbox: false, needsReview: false });
    await checkFirst();

    const again = await refile(scan.id);

    expect(again).toMatchObject({ status: 'filed', document: { inInbox: true, needsReview: true } });
    expect(h.fake.files.get(scan.id)!.parents).toEqual([inbox.id]);
  });

  it('marks a file put into a folder by hand for a check, and leaves it where it is', async () => {
    const { category } = await setup();
    await checkFirst();
    const file = h.fake.add({ name: 'Policy.pdf', parents: [category('Insurance').id], content: pdf('policy') });
    await syncVault('test');
    expect(await index.get(file.id)).toMatchObject({ needsReview: true, inInbox: false, category: 'Insurance' });
    expect(await updateDocument(file.id, { needsReview: false })).toMatchObject({ needsReview: false, folderPath: ['Insurance'] });
  });

  it('files straight into folders when set to automatic, marking only what the AI is unsure about', async () => {
    const { inbox } = await setup();
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...bill(input), needsReview: true, confidence: 0.4 }));
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('bill') });
    await syncVault('test');
    expect(await index.get(scan.id)).toMatchObject({ needsReview: true, inInbox: false, folderPath: ['Bills & Receipts', '2025'] });
    expect(await updateDocument(scan.id, { needsReview: false })).toMatchObject({ needsReview: false, folderPath: ['Bills & Receipts', '2025'] });
    expect((await recentActivity())[0]).toMatchObject({ kind: 'checked' });
  });
});

describe('receipts and what was bought', () => {
  const PANTS = { name: 'Norrøna Falketind Flex1 Pants', details: 'Size M, Caviar Black', quantity: 1, price: 239, code: '1810-20 7718 M' };
  const receipt = (input: ClassifyInput): Classification => ({
    ...bill(input),
    title: 'Falketind hiking pants',
    type: 'receipt',
    category: input.fixedCategory ?? 'Bills & Receipts',
    correspondent: 'Norrøna',
    date: '2026-05-29',
    amount: 239,
    dueDate: '2026-06-28',
    deadlines: [
      { date: '2026-06-28', what: 'Last day to return', done: false, kind: 'return' },
      { date: '2028-05-29', what: 'Legal warranty ends', done: false, kind: 'warranty' },
    ],
    items: [PANTS],
    action: null,
    summary: 'Bought at Norrøna Musterstadt, paid by card.',
  });

  it('files a receipt with what was bought and the dates to return it by, and gets them back from Drive alone', async () => {
    const { inbox } = await setup();
    h.classify = vi.fn(async (input: ClassifyInput) => receipt(input));
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('receipt') });

    await syncVault('test');

    const file = h.fake.files.get(scan.id)!;
    expect(file.description).toContain('Item: 1 × Norrøna Falketind Flex1 Pants | Size M, Caviar Black | 239.00 EUR | 1810-20 7718 M');
    expect(file.description).toContain('Dates: 2026-06-28 Last day to return [return] · 2028-05-29 Legal warranty ends [warranty]');
    expect(file.properties!.pwItems).toBe('1');
    expect(await index.get(scan.id)).toMatchObject({ items: [PANTS], itemsRead: true, deadlines: [{ kind: 'return' }, { kind: 'warranty' }] });
    expect((await index.chunks(scan.id))[0].text).toContain('Bought: Norrøna Falketind Flex1 Pants (Size M, Caviar Black) 239.00');

    // The index lost: rebuilt from Drive, with the items and which dates are which
    index = new DocIndex(new MemoryIndexBackend());
    setIndexForTests(index);
    await syncVault('test');
    expect(await index.get(scan.id)).toMatchObject({
      items: [PANTS],
      deadlines: [
        { date: '2026-06-28', what: 'Last day to return', kind: 'return' },
        { date: '2028-05-29', what: 'Legal warranty ends', kind: 'warranty' },
      ],
    });
  });

  it('takes what was bought as edited in the app, and keeps which dates are which when they are edited', async () => {
    const { inbox } = await setup();
    h.classify = vi.fn(async (input: ClassifyInput) => receipt(input));
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('receipt') });
    await syncVault('test');

    const edited = await updateDocument(scan.id, {
      items: [PANTS, { name: ' Wash | Eco ', details: null, quantity: 0, price: '8,46' as unknown as number, code: null }, { name: '  ', details: null, quantity: 1, price: null, code: null }],
    });
    expect(edited.items).toEqual([PANTS, { name: 'Wash / Eco', details: null, quantity: 1, price: 8.46, code: null }]);
    expect(h.fake.files.get(scan.id)!.description).toContain('Item: 1 × Wash / Eco |  | 8.46 EUR | ');

    const moved = await updateDocument(scan.id, { deadlines: edited.deadlines.map(d => (d.kind === 'return' ? { ...d, date: '2026-07-15' } : d)) });
    expect(moved.deadlines).toEqual([
      { date: '2026-07-15', what: 'Last day to return', done: false, kind: 'return' },
      { date: '2028-05-29', what: 'Legal warranty ends', done: false, kind: 'warranty' },
    ]);
  });

  it('reads the items of receipts filed before, once, without moving or renaming them', async () => {
    const { category } = await setup();
    const bills = category('Bills & Receipts');
    const old = async (meta: Classification, text: string) => {
      const name = fileName(meta, { name: 'scan.pdf', mimeType: 'application/pdf' });
      const { properties, description } = docLabels({ ...meta, items: [], deadlines: [] }, name);
      delete properties.pwItems;
      return h.fake.add({ name, parents: [bills.id], properties, description, content: await textPdf([text]) });
    };
    const shop = await old(receipt({ fileName: 'scan.pdf' } as ClassifyInput), `NORRØNA Musterstadt. falketind flex1 Pants M's Caviar Black Size M 239,00 EUR. ${prose(8)}`);
    const power = await old({ ...bill({ fileName: 'scan.pdf' } as ClassifyInput), type: 'invoice' }, `Stadtwerke Musterstadt Stromrechnung. ${prose(8)}`);
    h.describeItems = vi.fn(async (docs: { doc: { id: string }; text: string }[]) => {
      const found = { items: [PANTS], deadlines: [{ date: '2026-06-28', what: 'Last day to return', done: false, kind: 'return' }] };
      return new Map(docs.filter(d => d.doc.id === shop.id).map(d => [d.doc.id, found] as const));
    });

    await syncVault('test');

    expect(vi.mocked(h.describeItems).mock.calls[0][0].map(d => d.doc.id).sort()).toEqual([shop.id, power.id].sort());
    expect(vi.mocked(h.describeItems).mock.calls[0][0].find(d => d.doc.id === shop.id)!.text).toContain('falketind flex1 Pants');
    // Its due date, read before as a plain one, is the last day to return it
    expect(await index.get(shop.id)).toMatchObject({ items: [PANTS], itemsRead: true });
    expect((await index.get(shop.id))!.deadlines).toEqual([{ date: '2026-06-28', what: 'Last day to return', done: false, kind: 'return' }]);
    expect(h.fake.files.get(shop.id)!).toMatchObject({ name: shop.name, parents: [bills.id] });
    expect(await index.get(power.id)).toMatchObject({ items: [], itemsRead: true });

    await syncVault('test');
    expect(h.describeItems).toHaveBeenCalledTimes(1);
  });
});

describe('folders made in the app', () => {
  const company = 'Documents of my company Example UG: shareholder resolutions and loans, statements of its business account.';

  it('adds a category right under the Paperwork folder, which the next run takes without a full check', async () => {
    const { root, inbox } = await setup();
    h.fake.add({ name: 'a.pdf', parents: [inbox.id], content: pdf('one') });
    // The first run checks everything, reading the folders again
    await syncVault('test');
    const tree = await loadTree(drive());

    const folder = await createFolder(drive(), tree, { name: '  Example: UG ', description: `  ${company} ` });

    expect(h.fake.files.get(folder.id)).toMatchObject({ name: 'Example UG', parents: [root.id], description: company, properties: { paperwork: 'category' } });
    expect(folder).toMatchObject({ name: 'Example UG', role: 'category', categoryId: folder.id, path: ['Example UG'], parentId: root.id });
    const names = tree.categories.map(c => c.name);
    expect(names).toContain('Example UG');
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(await loadTree(drive())).toBe(tree);
    // Drive's change feed shows the new folder: known as written, so no full check
    expect(await reconcile(drive(), tree)).toMatchObject({ full: false });

    // New documents are read with its description
    h.fake.add({ name: 'b.pdf', parents: [inbox.id], content: pdf('two') });
    await syncVault('test');
    expect(vi.mocked(h.classify).mock.calls[1][0].categories).toContainEqual({ name: 'Example UG', description: company });
    expect(h.fake.destructive()).toEqual([]);
  });

  it('makes one folder for the same name asked for twice at once', async () => {
    const { tree, root } = await setup();
    const [a, b] = await Promise.all([createFolder(drive(), tree, { name: 'Example UG' }), createFolder(drive(), tree, { name: 'example ug' })]);
    expect(a.id).toBe(b.id);
    expect(h.fake.childrenOf(root.id).filter(f => f.name.toLowerCase() === 'example ug')).toHaveLength(1);
    await expect(createFolder(drive(), tree, { name: 'EXAMPLE UG' })).rejects.toThrow('There is a folder named EXAMPLE UG already.');
  });

  it("refuses a name in use, the Inbox's and Duplicates' names, no name, and a place that holds no folders", async () => {
    const { tree } = await setup();
    const before = h.fake.log.length;
    for (const name of ['bills & receipts', 'INBOX', 'Duplicates', '   ', '/:*']) {
      await expect(createFolder(drive(), tree, { name })).rejects.toBeInstanceOf(FolderProblem);
    }
    for (const parentId of [tree.inbox.id, 'somewhere']) await expect(createFolder(drive(), tree, { name: 'Loans', parentId })).rejects.toBeInstanceOf(FolderProblem);
    process.env.APP_LANGUAGE = 'de';
    try {
      await expect(createFolder(drive(), tree, { name: 'Duplikate' })).rejects.toThrow('Duplikate is the name of a folder Paperwork keeps for itself.');
    } finally {
      delete process.env.APP_LANGUAGE;
    }
    expect(h.fake.log.slice(before)).toEqual([]);
  });
});

describe('folders for a matter', () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  // Titled after the file, so the note on a file added to a folder can name the documents in it
  const titled = (input: ClassifyInput): Classification => ({ ...bill(input), title: input.fileName.replace(/\.\w+$/, '') });
  const checkFirst = () => getStore().set('settings', { views: [], review: 'manual' });
  const upload = (name: string, into?: string) => addFile({ name, mimeType: 'application/pdf', data: pdf(name), source: 'upload', into });
  const parents = (id: string) => h.fake.files.get(id)!.parents;

  beforeEach(() => {
    h.classify = vi.fn(async (input: ClassifyInput) => titled(input));
  });

  // The company's category, with a folder for its opening balance sheet in it
  async function matter() {
    const { tree, inbox } = await setup();
    const company = await createFolder(drive(), tree, { name: 'Example UG', description: 'My company' });
    const folder = await createFolder(drive(), tree, { name: 'Eröffnungsbilanz', parentId: company.id });
    return { tree, inbox, company, folder };
  }

  it('makes a folder inside a category, which the next run takes without a full check, listed with its category', async () => {
    const { inbox } = await setup();
    h.fake.add({ name: 'a.pdf', parents: [inbox.id], content: pdf('one') });
    // The first run checks everything, reading the folders again
    await syncVault('test');
    const tree = await loadTree(drive());
    const company = await createFolder(drive(), tree, { name: 'Example UG' });

    const folder = await createFolder(drive(), tree, { name: 'Eröffnungsbilanz', description: ' For the tax advisor ', parentId: company.id });

    expect(h.fake.files.get(folder.id)).toMatchObject({ name: 'Eröffnungsbilanz', parents: [company.id], description: 'For the tax advisor' });
    expect(h.fake.files.get(folder.id)!.properties).toBeUndefined();
    expect(folder).toMatchObject({ role: 'folder', parentId: company.id, categoryId: company.id, path: ['Example UG', 'Eröffnungsbilanz'] });
    expect(tree.folders.get(folder.id)).toBe(folder);
    expect(await reconcile(drive(), tree)).toMatchObject({ full: false });

    // One level more, not two
    const bank = await createFolder(drive(), tree, { name: 'Bank', parentId: folder.id });
    expect(bank.path).toEqual(['Example UG', 'Eröffnungsbilanz', 'Bank']);
    await expect(createFolder(drive(), tree, { name: 'Deeper', parentId: bank.id })).rejects.toThrow('Folders go at most 3 levels deep.');

    // Listed with its category, the year folders not
    await ensureYearFolder(drive(), tree, company.id, '2026');
    const folders = categoryInfos(tree, []).find(c => c.id === company.id)!.folders;
    expect(folders).toEqual([
      { id: folder.id, name: 'Eröffnungsbilanz', path: ['Eröffnungsbilanz'], webViewLink: `https://drive.google.com/drive/folders/${folder.id}` },
      { id: bank.id, name: 'Bank', path: ['Eröffnungsbilanz', 'Bank'], webViewLink: `https://drive.google.com/drive/folders/${bank.id}` },
    ]);
    expect(categoryInfos(tree, []).find(c => c.name === 'Insurance')!.folders).toEqual([]);
    // The same when the folders are read from Drive again
    forgetTree();
    expect(categoryInfos(await loadTree(drive()), []).find(c => c.id === company.id)!.folders).toEqual(folders);
    expect(h.fake.destructive()).toEqual([]);
  });

  it("refuses a year as its name, a name taken next to it, the Inbox's name, and a year folder or the Inbox to put it in", async () => {
    const { tree, company, folder } = await matter();
    const year = await ensureYearFolder(drive(), tree, company.id, '2026');
    const before = h.fake.log.length;
    const refused: [{ name: string; parentId: string }, string][] = [
      [{ name: '2026', parentId: company.id }, 'Names like 2026 are kept for year folders. Give the folder another name.'],
      [{ name: '1999', parentId: folder.id }, 'Names like 2026 are kept for year folders. Give the folder another name.'],
      [{ name: 'eröffnungsBILANZ', parentId: company.id }, 'There is a folder named eröffnungsBILANZ already.'],
      [{ name: 'Inbox', parentId: company.id }, 'Inbox is the name of a folder Paperwork keeps for itself.'],
      [{ name: 'Loan', parentId: year.id }, 'New folders go next to the year folders, not into them.'],
      [{ name: 'Loan', parentId: tree.inbox.id }, 'New folders go into the Paperwork folder or one of its folders.'],
    ];
    for (const [request, error] of refused) await expect(createFolder(drive(), tree, request)).rejects.toThrow(error);
    expect(h.fake.log.slice(before)).toEqual([]);

    // The same name in another category is fine, made once when asked for twice at once
    const taxes = tree.categories.find(c => c.name === 'Taxes')!;
    const [a, b] = await Promise.all([
      createFolder(drive(), tree, { name: 'Eröffnungsbilanz', parentId: taxes.id }),
      createFolder(drive(), tree, { name: 'eröffnungsbilanz', parentId: taxes.id }),
    ]);
    expect(a.id).toBe(b.id);
    expect(h.fake.childrenOf(taxes.id)).toHaveLength(1);
  });

  it('moves a document into a folder with its kept files, its category following, and keeps it there whatever its date', async () => {
    const { company, folder } = await matter();
    const doc = (await upload('Loan agreement.pdf')).document!;
    const draft = (await attachFile(doc.id, { name: 'Vertrag.docx', mimeType: DOCX, data: new TextEncoder().encode('draft') })).attachment!;
    expect(doc.folderPath).toEqual(['Bills & Receipts', '2025']);

    const moved = await updateDocument(doc.id, { folderId: folder.id });

    expect(moved).toMatchObject({ folderId: folder.id, folderPath: ['Example UG', 'Eröffnungsbilanz'], categoryId: company.id, category: 'Example UG' });
    for (const id of [doc.id, draft.id]) expect(parents(id)).toEqual([folder.id]);
    expect(await index.get(doc.id)).toMatchObject({ folderId: folder.id, categoryId: company.id });
    expect((await recentActivity())[0]).toMatchObject({ kind: 'edited', fileId: doc.id, detail: 'Example UG / Eröffnungsbilanz' });

    // A new date, its category sent again, a check: it stays
    await updateDocument(doc.id, { date: '2023-05-02', needsReview: true });
    expect(await updateDocument(doc.id, { categoryId: company.id, needsReview: false })).toMatchObject({ folderId: folder.id, needsReview: false });
    expect(parents(doc.id)).toEqual([folder.id]);

    // Its category chosen as the folder: out into the year folder, with its kept files
    const out = await updateDocument(doc.id, { folderId: company.id });
    expect(out).toMatchObject({ folderPath: ['Example UG', '2023'], categoryId: company.id });
    for (const id of [doc.id, draft.id]) expect(parents(id)).toEqual([out.folderId]);
    expect(h.fake.destructive()).toEqual([]);
  });

  it('refuses to move a document into the Inbox, a year folder, the Paperwork folder or a folder outside it', async () => {
    const { tree } = await matter();
    const doc = (await upload('Loan agreement.pdf')).document!;
    const elsewhere = h.fake.folder('Elsewhere', h.fake.myDriveRoot);
    const before = h.fake.log.length;
    for (const folderId of [tree.inbox.id, doc.folderId!, tree.root.id, elsewhere.id, 'nowhere']) {
      await expect(updateDocument(doc.id, { folderId })).rejects.toThrow('That is not a folder for documents in Paperwork.');
    }
    expect(h.fake.log.slice(before).filter(r => r.method !== 'GET')).toEqual([]);
  });

  it('moves a document waiting in the Inbox for its check straight into a folder, still to be checked', async () => {
    const { inbox, folder } = await matter();
    await checkFirst();
    const doc = (await upload('Loan agreement.pdf')).document!;
    const draft = (await attachFile(doc.id, { name: 'Vertrag.docx', mimeType: DOCX, data: new TextEncoder().encode('draft') })).attachment!;
    expect(parents(draft.id)).toEqual([inbox.id]);

    const moved = await updateDocument(doc.id, { folderId: folder.id });

    expect(moved).toMatchObject({ folderId: folder.id, category: 'Example UG', needsReview: true, inInbox: false });
    for (const id of [doc.id, draft.id]) expect(parents(id)).toEqual([folder.id]);
    expect(h.fake.files.get(doc.id)!.properties).not.toHaveProperty('pwCat');
    // Not filed again, nor taken back into the Inbox
    expect(await syncVault('test')).toMatchObject({ filed: 0, adopted: 0, failed: 0 });
    expect(parents(doc.id)).toEqual([folder.id]);
  });

  it('keeps a document in its folder when it is read again, also to be checked, while one in a year folder moves as before', async () => {
    const { company, folder } = await matter();
    const doc = (await upload('Loan agreement.pdf')).document!;
    const other = (await upload('Bill.pdf')).document!;
    await updateDocument(doc.id, { folderId: folder.id });
    // The AI would put both elsewhere, in another year
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...titled(input), category: 'Insurance', date: '2023-01-02' }));

    const again = await refile(doc.id);
    const moved = await refile(other.id);

    expect(vi.mocked(h.classify).mock.calls.map(c => c[0].fixedCategory)).toEqual(['Example UG', undefined]);
    expect(again.document).toMatchObject({ folderId: folder.id, categoryId: company.id, date: '2023-01-02', needsReview: false });
    expect(parents(doc.id)).toEqual([folder.id]);
    expect(moved.document!.folderPath).toEqual(['Insurance', '2023']);

    // To be checked: marked, and left in its folder rather than put into the Inbox
    await checkFirst();
    const marked = await refile(doc.id);
    expect(marked.document).toMatchObject({ folderId: folder.id, needsReview: true, inInbox: false });
    expect(parents(doc.id)).toEqual([folder.id]);
    expect(h.fake.files.get(doc.id)!.properties).not.toHaveProperty('pwCat');
    expect((await recentActivity())[0]).toMatchObject({ kind: 'filed', fileId: doc.id, detail: 'Example UG / Eröffnungsbilanz' });
    expect(await updateDocument(doc.id, { needsReview: false })).toMatchObject({ folderId: folder.id, needsReview: false });
    expect(parents(doc.id)).toEqual([folder.id]);
  });

  it('files a document added to a folder there, read for its category with a note naming the folder and what is in it', async () => {
    const { company, folder } = await matter();
    const contract = (await upload('Loan agreement.pdf')).document!;
    await updateDocument(contract.id, { folderId: folder.id });

    const result = await upload('Kontoauszug.pdf', folder.id);

    expect(vi.mocked(h.classify).mock.calls.at(-1)![0]).toMatchObject({
      fixedCategory: 'Example UG',
      notes: 'Added by the owner to the folder Example UG / Eröffnungsbilanz, with: Loan agreement.',
    });
    expect(result).toMatchObject({ status: 'filed', document: { folderId: folder.id, categoryId: company.id, title: 'Kontoauszug' } });
    const filed = h.fake.files.get(result.document!.id)!;
    expect(filed.parents).toEqual([folder.id]);
    expect(filed.properties).not.toHaveProperty('pwInto');
    expect(filed.description).not.toContain('Added by the owner');

    // To be checked: marked, but filed into the folder rather than held in the Inbox
    await checkFirst();
    const marked = await upload('Überweisung.pdf', folder.id);
    expect(marked.document).toMatchObject({ folderId: folder.id, needsReview: true, inInbox: false });
    expect(parents(marked.document!.id)).toEqual([folder.id]);
    expect(h.fake.files.get(marked.document!.id)!.properties).not.toHaveProperty('pwCat');
  });

  it('keeps the folder on a file that has to wait for the AI, and files it there on the next run', async () => {
    const { inbox, folder } = await matter();
    h.classify = vi.fn(async () => {
      throw new LimitError('The AI budget for today is used up.');
    });

    expect(await upload('Kontoauszug.pdf', folder.id)).toMatchObject({ status: 'waiting' });
    const [waiting] = h.fake.childrenOf(inbox.id);
    expect(waiting).toMatchObject({ properties: { pwInto: folder.id }, description: 'Added by the owner to the folder Example UG / Eröffnungsbilanz.' });

    h.classify = vi.fn(async (input: ClassifyInput) => titled(input));
    expect(await syncVault('test')).toMatchObject({ filed: 1 });

    expect(vi.mocked(h.classify).mock.calls[0][0]).toMatchObject({ fixedCategory: 'Example UG', notes: 'Added by the owner to the folder Example UG / Eröffnungsbilanz.' });
    expect(parents(waiting.id)).toEqual([folder.id]);
    expect(h.fake.files.get(waiting.id)!.properties).not.toHaveProperty('pwInto');
  });

  it('refuses to add a file to the Inbox, a year folder or a folder outside Paperwork, and adds one to a category for that category', async () => {
    const { tree, company } = await matter();
    const year = await ensureYearFolder(drive(), tree, company.id, '2026');
    const elsewhere = h.fake.folder('Elsewhere', h.fake.myDriveRoot);
    const before = h.fake.files.size;
    for (const into of [tree.inbox.id, year.id, elsewhere.id, 'nowhere', '']) {
      await expect(upload('Kontoauszug.pdf', into)).rejects.toBeInstanceOf(FolderProblem);
    }
    expect(h.fake.files.size).toBe(before);
    expect(h.classify).not.toHaveBeenCalled();

    const result = await upload('Kontoauszug.pdf', company.id);

    expect(vi.mocked(h.classify).mock.calls[0][0]).toMatchObject({ fixedCategory: 'Example UG', notes: 'Added by the owner to the folder Example UG.' });
    expect(result.document!.folderPath).toEqual(['Example UG', '2025']);
    expect(h.fake.files.get(result.document!.id)!.properties).not.toHaveProperty('pwInto');
  });

  it('moves every document of a topic into a folder with their kept files, leaves the rest, and counts those it could not move', async () => {
    const { tree, company, folder } = await matter();
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...titled(input), topic: input.fileName === 'Bill.pdf' ? 'Electricity' : 'Example UG formation' }));
    const articles = (await upload('Articles.pdf')).document!;
    const register = (await upload('Register entry.pdf')).document!;
    const invoice = (await upload('Notary invoice.pdf')).document!;
    const bill = (await upload('Bill.pdf')).document!;
    const draft = (await attachFile(articles.id, { name: 'Articles.docx', mimeType: DOCX, data: new TextEncoder().encode('draft') })).attachment!;
    // Taken out of Paperwork in Drive since: it can't be moved, the others are
    h.fake.files.get(invoice.id)!.parents = [h.fake.myDriveRoot];
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await moveTopic('Example UG formation', folder.id)).toEqual({ updated: 2, failed: 1 });

    for (const id of [articles.id, draft.id, register.id]) expect(parents(id)).toEqual([folder.id]);
    expect(await index.get(articles.id)).toMatchObject({ folderId: folder.id, categoryId: company.id, category: 'Example UG' });
    expect(parents(bill.id)).toEqual([bill.folderId]);
    expect(parents(invoice.id)).toEqual([h.fake.myDriveRoot]);
    expect((await recentActivity())[0]).toMatchObject({ kind: 'edited', name: 'Example UG formation', detail: 'Moved 2 documents to Example UG / Eröffnungsbilanz' });

    // Those already there are left alone
    const writes = h.fake.log.length;
    expect(await moveTopic('Example UG formation', folder.id)).toEqual({ updated: 0, failed: 1 });
    expect(h.fake.log.slice(writes).filter(r => r.method !== 'GET')).toEqual([]);

    // Into the category: out of the folder into its year folder, kept file and all; then nothing left to move
    expect(await moveTopic('Example UG formation', company.id)).toEqual({ updated: 2, failed: 1 });
    const year = (await index.get(articles.id))!;
    expect(year.folderPath).toEqual(['Example UG', '2025']);
    for (const id of [articles.id, draft.id, register.id]) expect(parents(id)).toEqual([year.folderId]);
    expect(await moveTopic('Example UG formation', company.id)).toEqual({ updated: 0, failed: 1 });

    // Not a folder for documents: refused before anything is written
    const before = h.fake.log.length;
    for (const folderId of [tree.inbox.id, tree.root.id, year.folderId!, 'nowhere']) {
      await expect(moveTopic('Example UG formation', folderId)).rejects.toThrow('That is not a folder for documents in Paperwork.');
    }
    expect(h.fake.log.slice(before).filter(r => r.method !== 'GET')).toEqual([]);
    expect(h.fake.destructive()).toEqual([]);
  });
});

describe('email on the public edge', () => {
  const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64').replace(/.{76}/g, '$&\r\n');
  // A forwarded email with PDF attachments, or none
  const mail = (id: string, attachments: { name: string; data: Uint8Array }[]) =>
    [
      'From: Me <me@example.com>',
      'To: paperwork@example.com',
      'Subject: Rechnungen',
      `Message-ID: <${id}@mail.example.com>`,
      'Date: Thu, 16 Oct 2026 08:00:00 +0200',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      [
        `--b1\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nDie Rechnungen für März von den Stadtwerken Musterstadt.\r\n`,
        ...attachments.map(
          a => `--b1\r\nContent-Type: application/pdf; name="${a.name}"\r\nContent-Disposition: attachment; filename="${a.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(a.data)}\r\n`
        ),
      ].join('') + '--b1--',
    ].join('\r\n');
  const two = [
    { name: 'Rechnung-1.pdf', data: pdf('electricity march') },
    { name: 'Rechnung-2.pdf', data: pdf('gas march') },
  ];

  let backend: MemoryIndexBackend;
  // The edge reads the index the app writes, and never writes it (docIndex.ts)
  const asEdge = () => {
    process.env.PAPERWORK_ROLE = 'edge';
    setIndexForTests(new DocIndex(backend, { follower: true }));
  };
  const asApp = () => {
    process.env.PAPERWORK_ROLE = 'app';
    setIndexForTests(new DocIndex(backend));
  };

  beforeEach(() => {
    process.env.ALLOWED_EMAILS = 'me@example.com';
    backend = new MemoryIndexBackend();
    setIndexForTests(new DocIndex(backend));
    // Nothing on the edge reads a document or asks Gemini
    h.classify = vi.fn(async () => {
      throw new Error('The edge never classifies.');
    });
    h.embed = vi.fn(async () => {
      throw new Error('The edge never embeds.');
    });
  });

  afterEach(() => {
    delete process.env.PAPERWORK_ROLE;
    delete process.env.ALLOWED_EMAILS;
  });

  it('puts each attachment into the Inbox with the email’s notes and labels, and files nothing', async () => {
    const { inbox } = await setup();
    asEdge();

    const result = await receiveEmail(await parseRaw(mail('one', two)));

    expect(result.status).toBe('added');
    expect(result.results.map(r => [r.status, r.inboxItem?.name])).toEqual([
      ['waiting', 'Rechnung-1.pdf'],
      ['waiting', 'Rechnung-2.pdf'],
    ]);
    const files = h.fake.childrenOf(inbox.id);
    expect(files.map(f => f.name)).toEqual(['Rechnung-1.pdf', 'Rechnung-2.pdf']);
    for (const file of files) {
      expect(file.description).toContain('Email from Me <me@example.com> on 2026-10-16');
      expect(file.description).toContain('Subject: Rechnungen');
      expect(file.description).toContain('Die Rechnungen für März');
      expect(file.properties).toEqual({ pwSource: 'email', pwOrigin: 'Email from me@example.com: "Rechnungen"', pwMail: expect.stringMatching(/^[0-9a-f]{24}$/) });
    }
    expect(result.results[0].inboxItem).toMatchObject({ id: files[0].id, state: 'waiting', mimeType: 'application/pdf' });
    expect(await backend.loadAll()).toEqual([]);
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.fake.destructive()).toEqual([]);
  });

  it('adds nothing for an attachment already waiting in the Inbox, and names the one already filed', async () => {
    const { inbox } = await setup();
    const classify = h.classify;
    h.classify = vi.fn(async (input: ClassifyInput) => bill(input));
    const filed = await addFile({ name: 'Rechnung-1.pdf', mimeType: 'application/pdf', data: two[0].data, source: 'upload' });
    h.classify = classify;
    asEdge();
    await receiveEmail(await parseRaw(mail('one', [two[1]])));
    const before = h.fake.files.size;

    // Mailed again (another message) before the app filed the first
    const again = await receiveEmail(await parseRaw(mail('two', [two[1]])));
    expect(again.results).toEqual([{ status: 'waiting', inboxItem: expect.objectContaining({ name: 'Rechnung-2.pdf' }) }]);
    // Already a document
    const duplicate = await receiveEmail(await parseRaw(mail('three', [two[0]])));
    expect(duplicate.results).toEqual([{ status: 'duplicate', duplicateOf: expect.objectContaining({ id: filed.document!.id, title: 'Electricity bill March' }) }]);

    expect(h.fake.files.size).toBe(before);
    expect(h.fake.childrenOf(inbox.id).map(f => f.name)).toEqual(['Rechnung-2.pdf']);
  });

  it('puts an email without attachments into the Inbox as a Google Doc', async () => {
    const { inbox } = await setup();
    asEdge();
    const result = await receiveEmail(await parseRaw(mail('body', [])));
    expect(result.results).toEqual([{ status: 'waiting', inboxItem: expect.objectContaining({ name: 'Rechnungen' }) }]);
    const [doc] = h.fake.childrenOf(inbox.id);
    expect(doc).toMatchObject({ name: 'Rechnungen', mimeType: 'application/vnd.google-apps.document' });
    expect(doc.description).toContain('Subject: Rechnungen');
    expect(doc.properties).toMatchObject({ pwSource: 'email', pwMail: expect.any(String) });
    expect(h.classify).not.toHaveBeenCalled();
  });

  it('creates nothing when the Paperwork folder or its Inbox is missing', async () => {
    const root = h.fake.folder('Paperwork', h.fake.myDriveRoot, { paperwork: 'root' });
    h.fake.folder('Bills & Receipts', root.id);
    forgetTree();
    asEdge();
    const before = h.fake.files.size;
    await expect(receiveEmail(await parseRaw(mail('one', two)))).rejects.toBeInstanceOf(VaultProblem);
    await expect(receiveEmail(await parseRaw(mail('body', [])))).rejects.toBeInstanceOf(VaultProblem);
    expect(h.fake.files.size).toBe(before);
    expect(h.connection.rootFolderId).toBeUndefined();
  });

  it('leaves the filing to the app, which reads the notes and keeps the message recognised', async () => {
    const { inbox } = await setup();
    asEdge();
    await receiveEmail(await parseRaw(mail('one', two)));
    const mailId = h.fake.childrenOf(inbox.id)[0].properties!.pwMail;

    asApp();
    h.classify = vi.fn(async (input: ClassifyInput) => bill(input));
    h.embed = vi.fn(async (texts: string[]) => texts.map(t => wordVector(t)));
    const summary = await syncVault('schedule');

    expect(summary).toMatchObject({ filed: 2, failed: 0 });
    expect(h.fake.childrenOf(inbox.id)).toEqual([]);
    const input = vi.mocked(h.classify).mock.calls[0][0];
    expect(input.notes).toContain('Subject: Rechnungen');
    expect(input.notes).toContain('Die Rechnungen für März');
    const filed = [...h.fake.files.values()].filter(f => f.properties?.paperwork === 'doc');
    expect(filed).toHaveLength(2);
    for (const file of filed) expect(file.properties).toMatchObject({ pwMail: mailId, pwSource: 'email', pwOrigin: 'Email from me@example.com: "Rechnungen"' });
    expect(await alreadyReceived(mailId)).toBe(true);
    expect(await backend.loadAll()).toHaveLength(2);

    // The same message delivered again adds nothing on the edge either: each attachment is found filed
    asEdge();
    const before = h.fake.files.size;
    const again = await receiveEmail(await parseRaw(mail('one', two)));
    expect(again.results.map(r => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(h.fake.files.size).toBe(before);
    expect(h.fake.childrenOf(inbox.id)).toEqual([]);
    // A message without attachments, by its mailId
    await receiveEmail(await parseRaw(mail('body', [])));
    expect((await receiveEmail(await parseRaw(mail('body', [])))).status).toBe('already-received');
  });

  it('adds what is missing when a message that failed part-way is delivered again', async () => {
    const { inbox } = await setup();
    asEdge();
    const three = [...two, { name: 'Rechnung-3.pdf', data: pdf('water march') }];
    // Drive refuses the second upload once (a rate limit drive.ts doesn't wait out)
    const drive = h.fake.fetch;
    let uploads = 0;
    h.fake.fetch = async (input, init) => {
      if (init?.method === 'POST' && new URL(String(input)).pathname.startsWith('/upload/') && ++uploads === 2) {
        const error = { error: { code: 403, message: 'User rate limit exceeded.', errors: [{ reason: 'userRateLimitExceeded' }] } };
        return new Response(JSON.stringify(error), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      return drive(input, init);
    };
    await expect(receiveEmail(await parseRaw(mail('three', three)))).rejects.toThrow();
    expect(h.fake.childrenOf(inbox.id).map(f => f.name)).toEqual(['Rechnung-1.pdf']);

    // Delivered again, as Postmark does after a failure
    const again = await receiveEmail(await parseRaw(mail('three', three)));
    expect(again.status).toBe('added');
    expect(again.results.map(r => [r.status, r.inboxItem?.name])).toEqual([
      ['waiting', 'Rechnung-1.pdf'],
      ['waiting', 'Rechnung-2.pdf'],
      ['waiting', 'Rechnung-3.pdf'],
    ]);
    expect(h.fake.childrenOf(inbox.id).map(f => f.name)).toEqual(['Rechnung-1.pdf', 'Rechnung-2.pdf', 'Rechnung-3.pdf']);
    const before = h.fake.files.size;
    await receiveEmail(await parseRaw(mail('three', three)));
    expect(h.fake.files.size).toBe(before);
  });
});

describe('possible duplicates', () => {
  const checkFirst = () => getStore().set('settings', { views: [], review: 'manual' });
  const march = { number: '2025-0412', date: '2025-03-14', period: '2025-03', amount: 87.45, customer: '88123' };
  // Gemini's reading of the March invoice, with the text it writes out of a scan (a PDF has its own)
  const invoice = (over: Partial<Classification> = {}) => (input: ClassifyInput): Classification => ({
    ...bill(input),
    title: 'Electricity bill March 2025',
    references: 'Customer: 88123 · Invoice no: 2025-0412',
    text: input.transcribe ? ocrOf(invoiceText(march)) : null,
    ...over,
  });
  const PHOTO = pdf('phone photo of the March bill');
  const DUE = { date: '2025-04-25', what: 'Pay 87.45 EUR' };
  const props = (id: string) => h.fake.files.get(id)!.properties ?? {};

  // The bill emailed as a PDF, then a photo of the paper bill uploaded
  async function emailedThenPhotographed() {
    const tree = await setup();
    h.classify = vi.fn(async (input: ClassifyInput) => invoice()(input));
    const emailed = await addFile({ name: 'Rechnung_2025-0412.pdf', mimeType: 'application/pdf', data: await textPdf([invoiceText(march)]), source: 'email' });
    const photo = await addFile({ name: 'IMG_2041.jpg', mimeType: 'image/jpeg', data: PHOTO, source: 'upload' });
    return { ...tree, original: emailed.document!, copy: photo.document!, photo };
  }

  it('marks a photo of a bill that came as a PDF, and counts its deadline once', async () => {
    const { original, copy, photo, category } = await emailedThenPhotographed();

    expect(original.textSource).toBe('pdf');
    expect(photo).toMatchObject({ status: 'filed', document: { id: copy.id, possibleDuplicateOf: original.id, textSource: 'ocr' }, possibleDuplicateOf: { id: original.id } });
    // Filed into its folder as the review mode says, the AI's check left as it was
    const year = h.fake.childrenOf(category('Bills & Receipts').id).find(f => f.name === '2025')!;
    expect(h.fake.files.get(copy.id)!.parents).toEqual([year.id]);
    expect(props(copy.id)).toMatchObject({ pwMaybeDup: original.id });
    expect(props(copy.id).pwNotDup).toBeUndefined();
    expect(props(original.id).pwMaybeDup).toBeUndefined();
    expect(await index.get(copy.id)).toMatchObject({ possibleDuplicateOf: original.id, dupChecked: 1, needsReview: false });
    expect(await index.get(original.id)).toMatchObject({ dupChecked: 0 });
    expect((await recentActivity())[0]).toMatchObject({ kind: 'filed', fileId: copy.id, detail: 'Bills & Receipts / 2025 · may be a copy of Electricity bill March 2025' });

    const docs = await listDocuments(drive(), await loadTree(drive()));
    expect(docs.find(d => d.id === copy.id)).toMatchObject({ possibleDuplicateOf: original.id });
    expect(deadlineItems(docs).map(i => [i.doc.id, i.deadline.date])).toEqual([[original.id, '2025-04-25']]);
    // The next run finds nothing more, and keeps the mark
    expect(await syncVault('test')).not.toHaveProperty('possibleDuplicates');
    expect(await index.get(copy.id)).toMatchObject({ possibleDuplicateOf: original.id });
    expect(await index.get(original.id)).toMatchObject({ dupChecked: 1 });
    expect(h.fake.destructive()).toEqual([]);
  });

  it('never marks the older of two as the copy when it is read again', async () => {
    const { original, copy } = await emailedThenPhotographed();
    // As if the photo's check couldn't decide at its filing (too slow, or the PDF's text not read yet)
    delete h.fake.files.get(copy.id)!.properties!.pwMaybeDup;
    await index.put({ ...(await index.get(copy.id))!, possibleDuplicateOf: undefined });

    expect(await refile(original.id)).not.toHaveProperty('possibleDuplicateOf');
    expect(props(original.id).pwMaybeDup).toBeUndefined();
    expect((await index.get(original.id))?.possibleDuplicateOf).toBeFalsy();
  });

  it('keeps a marked document waiting in the Inbox when new documents are checked first, and counts it in the run', async () => {
    const { inbox } = await setup();
    await checkFirst();
    h.classify = vi.fn(async (input: ClassifyInput) => invoice()(input));
    const emailed = await addFile({ name: 'Rechnung_2025-0412.pdf', mimeType: 'application/pdf', data: await textPdf([invoiceText(march)]), source: 'email' });
    const scan = h.fake.add({ name: 'Scan_0001.pdf', parents: [inbox.id], content: PHOTO });

    expect(await syncVault('test')).toMatchObject({ filed: 1, possibleDuplicates: 1 });

    expect(h.fake.files.get(scan.id)!.parents).toEqual([inbox.id]);
    expect(await index.get(scan.id)).toMatchObject({ possibleDuplicateOf: emailed.document!.id, needsReview: true, inInbox: true });
  });

  it('marks no bills of two months, no two coffees and no two payslips', async () => {
    await setup();
    const april = { number: '2025-0512', date: '2025-04-14', period: '2025-04', amount: 87.45, customer: '88123' };
    const coffee = [
      { name: 'Cappuccino', price: 3.4 },
      { name: 'Butter croissant', price: 1.9 },
    ];
    const readings: [string, Classification][] = [
      ['march.pdf', { ...invoice()({ fixedCategory: undefined } as ClassifyInput), text: invoiceText(march) }],
      ['april.pdf', { ...invoice()({} as ClassifyInput), title: 'Electricity bill April 2025', date: '2025-04-14', references: 'Customer: 88123 · Invoice no: 2025-0512', text: invoiceText(april) }],
      ...[
        ['08:12', '1234'],
        ['15:47', '1301'],
      ].map(([time, bon]): [string, Classification] => [
        `coffee-${bon}.jpg`,
        {
          ...bill({} as ClassifyInput),
          title: 'Receipt REWE',
          type: 'receipt',
          correspondent: 'REWE Markt GmbH',
          amount: 5.3,
          references: null,
          deadlines: [],
          dueDate: null,
          items: coffee.map(c => ({ ...c, details: null, quantity: 1, code: null })),
          text: receiptText({ time, bon, items: coffee }),
        },
      ]),
      ...['10', '11'].map((month): [string, Classification] => [
        `payslip-${month}.pdf`,
        {
          ...bill({} as ClassifyInput),
          title: `Payslip ${month === '10' ? 'October' : 'November'} 2025`,
          type: 'payslip',
          correspondent: 'Muster GmbH',
          date: month === '10' ? '2025-10-31' : '2025-11-30',
          amount: 3120.44,
          references: 'Personnel no: 004711',
          deadlines: [],
          dueDate: null,
          text: payslipText({ month: `2025-${month}`, gross: 5200, net: 3120.44 }),
        },
      ]),
    ];
    const ids: string[] = [];
    for (const [name, reading] of readings) {
      h.classify = vi.fn(async (input: ClassifyInput) => ({ ...reading, category: input.fixedCategory ?? 'Bills & Receipts' }));
      const result = await addFile({ name, mimeType: 'image/jpeg', data: pdf(name), source: 'upload' });
      expect(result, name).toMatchObject({ status: 'filed' });
      expect(result.possibleDuplicateOf, name).toBeUndefined();
      ids.push(result.document!.id);
    }
    expect((await index.all()).map(d => d.dupChecked)).toEqual(ids.map(() => 0));

    // Looked at again in the backlog, with the same answer
    await syncVault('test');
    for (const id of ids) expect(await index.get(id)).toMatchObject({ dupChecked: 1 });
    expect((await index.all()).filter(d => d.possibleDuplicateOf)).toEqual([]);
    expect([...h.fake.files.values()].filter(f => f.properties?.pwMaybeDup)).toEqual([]);
  });

  it('files a document when looking for its original fails, and leaves it for the backlog', async () => {
    await setup();
    h.classify = vi.fn(async (input: ClassifyInput) => invoice()(input));
    const emailed = await addFile({ name: 'Rechnung_2025-0412.pdf', mimeType: 'application/pdf', data: await textPdf([invoiceText(march)]), source: 'email' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = vi.spyOn(index, 'chunks').mockRejectedValue(new Error('Firestore is unavailable.'));

    const photo = await addFile({ name: 'IMG_2041.jpg', mimeType: 'image/jpeg', data: PHOTO, source: 'upload' });

    expect(photo).toMatchObject({ status: 'filed', document: { textSource: 'ocr' } });
    expect(photo.possibleDuplicateOf).toBeUndefined();
    expect(props(photo.document!.id).pwMaybeDup).toBeUndefined();
    expect(await index.get(photo.document!.id)).toMatchObject({ dupChecked: 0 });

    chunks.mockRestore();
    expect(await syncVault('test')).toMatchObject({ possibleDuplicates: 1 });
    expect(props(photo.document!.id)).toMatchObject({ pwMaybeDup: emailed.document!.id });
  });

  it('keeps both when the owner says so, and doesn’t ask about the pair again, filed again either way round', async () => {
    const { original, copy } = await emailedThenPhotographed();

    // An edit keeps the mark
    expect(await updateDocument(copy.id, { title: 'Electricity bill March 2025 (photo)' })).toMatchObject({ possibleDuplicateOf: original.id });
    expect(props(copy.id)).toMatchObject({ pwMaybeDup: original.id });

    const result = await resolvePossibleDuplicate(copy.id, 'keep-both', original.id);

    expect(result).toMatchObject({ choice: 'keep-both', document: { id: copy.id } });
    expect(result.document!.possibleDuplicateOf).toBeUndefined();
    expect(props(copy.id).pwMaybeDup).toBeUndefined();
    expect(props(copy.id).pwNotDup).toBe(dupTag(original.id));
    expect(await index.get(copy.id)).toMatchObject({ notDuplicates: [dupTag(original.id)] });
    expect((await recentActivity())[0]).toMatchObject({ kind: 'edited', fileId: copy.id, detail: 'Kept both: not a copy' });

    expect(await refile(copy.id)).not.toHaveProperty('possibleDuplicateOf');
    expect(await refile(original.id)).not.toHaveProperty('possibleDuplicateOf');
    await syncVault('test');
    expect((await index.all()).filter(d => d.possibleDuplicateOf)).toEqual([]);
    expect(props(copy.id).pwNotDup).toBe(dupTag(original.id));
    // Saying it again changes nothing
    await resolvePossibleDuplicate(copy.id, 'keep-both', original.id);
    expect(props(copy.id).pwNotDup).toBe(dupTag(original.id));
  });

  it('keeps the mark when a marked document is checked from a view that didn’t show it', async () => {
    const { inbox, category } = await setup();
    await checkFirst();
    h.classify = vi.fn(async (input: ClassifyInput) => invoice()(input));
    const emailed = (await addFile({ name: 'Rechnung.pdf', mimeType: 'application/pdf', data: await textPdf([invoiceText(march)]), source: 'email' })).document!;
    // Not marked at filing (the look took too long, say): the app shows it to check without the mark
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = vi.spyOn(index, 'chunks').mockRejectedValue(new Error('Firestore is unavailable.'));
    const copy = (await addFile({ name: 'IMG_2041.jpg', mimeType: 'image/jpeg', data: PHOTO, source: 'upload' })).document!;
    chunks.mockRestore();
    expect(h.fake.files.get(copy.id)!.parents).toEqual([inbox.id]);
    // A scheduled run marks it meanwhile
    await syncVault('scheduled');
    expect(props(copy.id)).toMatchObject({ pwMaybeDup: emailed.id });

    // Correct, from the view loaded before
    const checked = await updateDocument(copy.id, { needsReview: false });

    expect(checked).toMatchObject({ needsReview: false, inInbox: false, folderPath: ['Bills & Receipts', '2025'], possibleDuplicateOf: emailed.id });
    expect(props(copy.id)).toMatchObject({ pwMaybeDup: emailed.id });
    expect(props(copy.id).pwNotDup).toBeUndefined();
    expect(h.fake.files.get(copy.id)!.parents).toEqual([h.fake.childrenOf(category('Bills & Receipts').id).find(f => f.name === '2025')!.id]);
    expect((await recentActivity())[0]).toMatchObject({ kind: 'checked', fileId: copy.id });
    // Still asked about, and its deadline not counted twice meanwhile
    const docs = await listDocuments(drive(), await loadTree(drive()));
    expect(deadlineItems(docs).map(i => i.doc.id)).toEqual([emailed.id]);
  });

  it('moves the copy to Duplicates when the owner says it is the same, handing over its kept files and its deadlines done', async () => {
    const { original, copy } = await emailedThenPhotographed();
    const kept = await attachFile(copy.id, { name: 'Notiz.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: new TextEncoder().encode('paid by transfer') });
    await setDeadlineDone(copy.id, DUE, true);
    expect((await index.get(original.id))!.deadlines[0].done).toBe(false);

    const result = await resolvePossibleDuplicate(copy.id, 'duplicate', original.id);

    const duplicates = h.fake.find('Duplicates')!;
    expect(result).toEqual({ choice: 'duplicate', duplicateOf: expect.objectContaining({ id: original.id }), duplicatesFolderUrl: `https://drive.google.com/drive/folders/${duplicates.id}` });
    const moved = h.fake.files.get(copy.id)!;
    expect(moved.parents).toEqual([duplicates.id]);
    expect(moved.properties).toMatchObject({ paperwork: 'duplicate', pwDupOf: original.id, pwMd5: moved.md5Checksum });
    for (const key of ['pwMaybeDup', 'pwReview', 'pwCat']) expect(moved.properties![key]).toBeUndefined();
    expect(moved.description).toMatch(/^You said this is the same document as "2025-03-14 Stadtwerke Musterstadt - Electricity bill March 2025.pdf"/);
    expect(await index.get(copy.id)).toBeNull();
    expect(await index.getAny(copy.id)).toBeNull();
    expect(props(kept.attachment!.id)).toMatchObject({ pwOf: original.id });
    expect((await index.get(original.id))!.deadlines[0]).toMatchObject({ ...DUE, done: true });
    expect((await recentActivity()).find(a => a.kind === 'duplicate')).toMatchObject({ fileId: copy.id, detail: `You said it's the same as ${h.fake.files.get(original.id)!.name}` });
    expect(h.fake.destructive()).toEqual([]);

    // Done already; the same photo added again is known as the original
    await expect(resolvePossibleDuplicate(copy.id, 'duplicate', original.id)).rejects.toMatchObject({ status: 404 });
    expect(await addFile({ name: 'IMG_2041 (1).jpg', mimeType: 'image/jpeg', data: PHOTO, source: 'upload' })).toMatchObject({ status: 'duplicate', duplicateOf: { id: original.id } });
    await syncVault('test');
    expect(await index.get(copy.id)).toBeNull();
  });

  it('never brings back a copy moved to Duplicates when another window still shows it', async () => {
    const { original, copy } = await emailedThenPhotographed();
    await resolvePossibleDuplicate(copy.id, 'duplicate', original.id);
    const duplicates = h.fake.find('Duplicates')!;
    const setAside = { ...props(copy.id) };

    // Keep both, an edit, Keep both with the edits, and reading it again, each from a view loaded before
    await expect(resolvePossibleDuplicate(copy.id, 'keep-both', original.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateDocument(copy.id, { title: 'Photo of the March bill' })).rejects.toMatchObject({ status: 404 });
    await expect(updateDocument(copy.id, { title: 'Photo of the March bill', notDuplicate: true, duplicateOf: original.id })).rejects.toMatchObject({ status: 404 });
    await expect(refile(copy.id)).rejects.toMatchObject({ status: 404 });

    expect(h.fake.files.get(copy.id)!.parents).toEqual([duplicates.id]);
    expect(props(copy.id)).toEqual(setAside);
    await syncVault('test');
    expect(await index.get(copy.id)).toBeNull();
    const docs = await listDocuments(drive(), await loadTree(drive()));
    expect(docs.map(d => d.id)).toEqual([original.id]);
    expect(deadlineItems(docs)).toHaveLength(1);
  });

  it('decides only about the original the owner was shown, not one the mark moved to meanwhile', async () => {
    const { original, copy } = await emailedThenPhotographed();
    // Another document, and the original marked as a copy of it: the next run moves the copy's mark there
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...bill(input), title: 'Water bill', correspondent: 'Wasserwerk', amount: 12, date: '2025-01-02', deadlines: [], dueDate: null, text: null }));
    const other = (await addFile({ name: 'water.pdf', mimeType: 'application/pdf', data: await textPdf(['Wasserwerk water bill January']), source: 'upload' })).document!;
    h.fake.touch(original.id, f => (f.properties = { ...f.properties, pwMaybeDup: other.id }));
    await index.put({ ...(await index.get(original.id))!, possibleDuplicateOf: other.id });
    await fillDuplicateChecks(drive());
    expect(props(copy.id)).toMatchObject({ pwMaybeDup: other.id });

    // Shown as a possible copy of the original
    for (const choice of ['keep-both', 'duplicate', 'keep-with'] as const) {
      await expect(resolvePossibleDuplicate(copy.id, choice, original.id), choice).rejects.toThrow('Paperwork now thinks this may be a copy of another document. Compare it with that one first.');
    }
    await expect(updateDocument(copy.id, { title: 'Photo', notDuplicate: true, duplicateOf: original.id })).rejects.toBeInstanceOf(DuplicateProblem);
    expect(h.fake.files.get(copy.id)!.properties).toMatchObject({ paperwork: 'doc', pwMaybeDup: other.id });
    expect(props(copy.id).pwNotDup).toBeUndefined();
    expect((await index.get(copy.id))!.title).toBe('Electricity bill March 2025');

    // Shown as it is now
    await resolvePossibleDuplicate(copy.id, 'keep-both', other.id);
    expect(props(copy.id)).toMatchObject({ pwNotDup: dupTag(other.id) });
    expect(props(copy.id).pwMaybeDup).toBeUndefined();
  });

  it('keeps the copy as a file with the original when the owner says so, with its own kept files', async () => {
    const { original, copy } = await emailedThenPhotographed();
    const note = await attachFile(copy.id, { name: 'Notiz.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: new TextEncoder().encode('paid by transfer') });
    await setDeadlineDone(copy.id, DUE, true);

    const result = await resolvePossibleDuplicate(copy.id, 'keep-with', original.id);

    expect(result).toMatchObject({ choice: 'keep-with', attachment: { id: copy.id, documentId: original.id, label: 'Copy', name: '2025-03-14 Stadtwerke Musterstadt - Electricity bill March 2025 - Copy.jpg' } });
    const kept = h.fake.files.get(copy.id)!;
    expect(kept.parents).toEqual(h.fake.files.get(original.id)!.parents);
    expect(kept.properties).toMatchObject({ paperwork: 'attachment', pwOf: original.id, pwMd5: kept.md5Checksum });
    expect(kept.properties!.pwMaybeDup).toBeUndefined();
    expect(kept.properties!.pwNotDup).toBeUndefined();
    expect(await index.get(copy.id)).toBeNull();
    expect(props(note.attachment!.id)).toMatchObject({ pwOf: original.id });
    expect((await index.get(original.id))!.deadlines[0].done).toBe(true);
    expect(await addFile({ name: 'again.jpg', mimeType: 'image/jpeg', data: PHOTO, source: 'upload' })).toMatchObject({ status: 'duplicate', keptWith: { id: original.id } });
    await expect(resolvePossibleDuplicate(copy.id, 'keep-with', original.id)).rejects.toMatchObject({ status: 404 });
    expect(h.fake.destructive()).toEqual([]);
  });

  it('names the copy in the app’s language, and takes it along when both waited in the Inbox', async () => {
    const { inbox, category } = await setup();
    await checkFirst();
    h.classify = vi.fn(async (input: ClassifyInput) => invoice()(input));
    const emailed = (await addFile({ name: 'Rechnung.pdf', mimeType: 'application/pdf', data: await textPdf([invoiceText(march)]), source: 'email' })).document!;
    const copy = (await addFile({ name: 'IMG_2041.jpg', mimeType: 'image/jpeg', data: PHOTO, source: 'upload' })).document!;
    process.env.APP_LANGUAGE = 'de';
    try {
      expect(await resolvePossibleDuplicate(copy.id, 'keep-with', emailed.id)).toMatchObject({ attachment: { label: 'Kopie' } });
    } finally {
      delete process.env.APP_LANGUAGE;
    }
    expect(h.fake.files.get(copy.id)!.parents).toEqual([inbox.id]);

    await updateDocument(emailed.id, { needsReview: false });

    const year = h.fake.childrenOf(category('Bills & Receipts').id).find(f => f.name === '2025')!;
    expect(h.fake.files.get(emailed.id)!.parents).toEqual([year.id]);
    expect(h.fake.files.get(copy.id)!.parents).toEqual([year.id]);
  });

  it('refuses while the document is read, and when it isn’t marked or its original is gone', async () => {
    const { original, copy } = await emailedThenPhotographed();
    let release!: () => void;
    const reading = new Promise<void>(resolve => (release = resolve));
    h.classify = vi.fn(async (input: ClassifyInput) => {
      await reading;
      return invoice()(input);
    });
    const refiling = refile(copy.id);
    await vi.waitFor(() => expect(h.classify).toHaveBeenCalled());
    for (const choice of ['keep-both', 'duplicate', 'keep-with'] as const) await expect(resolvePossibleDuplicate(copy.id, choice, original.id), choice).rejects.toBeInstanceOf(DuplicateProblem);
    release();
    expect(await refiling).toMatchObject({ status: 'filed', possibleDuplicateOf: { id: original.id } });

    await expect(resolvePossibleDuplicate(original.id, 'duplicate', copy.id)).rejects.toThrow('This document isn’t marked as a possible duplicate any more.');
    h.fake.touch(original.id, f => (f.trashed = true));
    await expect(resolvePossibleDuplicate(copy.id, 'keep-with', original.id)).rejects.toThrow('The document it may be a copy of is no longer in Paperwork, so it stays a document of its own.');
    expect(h.fake.files.get(copy.id)!.properties).toMatchObject({ paperwork: 'doc', pwMaybeDup: original.id });
  });

  it('never waits for itself when the owner decides while the same documents change', async () => {
    const { original, copy } = await emailedThenPhotographed();
    const both = await Promise.allSettled([resolvePossibleDuplicate(copy.id, 'duplicate', original.id), setDeadlineDone(copy.id, DUE, true)]);
    expect(both[0].status).toBe('fulfilled');

    const again = await emailedThenPhotographedAgain(original.id);
    const decided = await Promise.allSettled([resolvePossibleDuplicate(again, 'keep-with', original.id), updateDocument(original.id, { title: 'Electricity bill March 2025 (paid)' })]);
    expect(decided.map(d => d.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(h.fake.files.get(again)!.properties).toMatchObject({ paperwork: 'attachment', pwOf: original.id });
  });

  // Another photo of the same bill, marked as a copy of `originalId`
  async function emailedThenPhotographedAgain(originalId: string) {
    const photo = await addFile({ name: 'IMG_2050.jpg', mimeType: 'image/jpeg', data: pdf('another photo of the March bill'), source: 'upload' });
    expect(photo.possibleDuplicateOf?.id).toBe(originalId);
    return photo.document!.id;
  }

  it('marks a file put into a category folder by hand', async () => {
    const { original, category } = await emailedThenPhotographed();
    const byHand = h.fake.add({ name: 'Stromrechnung März.pdf', parents: [category('Insurance').id], content: pdf('scanned at the office') });

    expect(await syncVault('test')).toMatchObject({ adopted: 1 });

    expect(props(byHand.id)).toMatchObject({ pwMaybeDup: original.id });
    expect(await index.get(byHand.id)).toMatchObject({ possibleDuplicateOf: original.id, dupChecked: 1, folderPath: ['Insurance'] });
  });

  it('never marks a file made a document of its own again as a copy of the one it was kept with', async () => {
    await setup();
    const first = (await addFile({ name: 'bill.pdf', mimeType: 'application/pdf', data: pdf('bill'), source: 'upload' })).document!;
    // The same facts, no text to tell them apart: marked on its facts alone
    const second = await addFile({ name: 'bill copy.pdf', mimeType: 'application/pdf', data: pdf('bill, printed again'), source: 'upload' });
    expect(second.possibleDuplicateOf?.id).toBe(first.id);
    await attachExisting(second.document!.id, first.id);
    expect(props(second.document!.id).pwMaybeDup).toBeUndefined();

    const detached = await detachFile(second.document!.id);

    expect(detached.status).toBe('filed');
    expect(detached.possibleDuplicateOf).toBeUndefined();
    expect(props(second.document!.id)).toMatchObject({ paperwork: 'doc', pwNotDup: dupTag(first.id) });
  });

  // ---------- Documents filed before the check existed ----------

  // A document filed before: labelled in Drive, in the index with its text (`text` null: not read yet), never
  // checked for copies
  async function filedBefore(meta: DocMeta, text: string | null, properties: Record<string, string> = {}) {
    const tree = await loadTree(drive());
    const year = await ensureYearFolder(drive(), tree, tree.categories[0].id, (meta.date ?? '2025').slice(0, 4));
    const name = fileName(meta, { name: 'scan.pdf', mimeType: 'application/pdf' });
    const labels = docLabels(meta, name);
    const file = h.fake.add({ name, parents: [year.id], ...labels, properties: { ...labels.properties, ...properties }, content: pdf(`${name} ${text}`) });
    const entry = fromDrive(tree, await drive().get(file.id), null, {});
    await index.put(text === null ? entry : { ...entry, textSource: 'ocr', textLength: text.length, embedded: true });
    if (text !== null) await index.putChunks(file.id, [chunk(file.id, 0, headerText(entry), wordVector(headerText(entry))), chunk(file.id, 1, text, wordVector(text))]);
    return file;
  }

  const monthBill = (month: number, over: Partial<DocMeta> = {}): DocMeta => ({
    ...billMeta,
    title: `Electricity bill ${['January', 'February', 'March', 'April', 'May', 'June', 'July'][month - 1]} 2025`,
    date: `2025-0${month}-14`,
    amount: 80 + month,
    deadlines: [],
    dueDate: null,
    action: null,
    references: `Customer: 88123 · Invoice no: 2025-0${month}12`,
    ...over,
  });
  const monthText = (month: number) => invoiceText({ number: `2025-0${month}12`, date: `2025-0${month}-14`, period: `2025-0${month}`, amount: 80 + month, customer: '88123' });

  it('leaves the original’s deadlines as they are when it marks a copy, so keeping both leaves both open', async () => {
    await setup();
    h.classify = vi.fn(async (input: ClassifyInput) => invoice()(input));
    const emailed = (await addFile({ name: 'Rechnung.pdf', mimeType: 'application/pdf', data: await textPdf([invoiceText(march)]), source: 'email' })).document!;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const chunks = vi.spyOn(index, 'chunks').mockRejectedValue(new Error('Firestore is unavailable.'));
    const photo = (await addFile({ name: 'IMG_2041.jpg', mimeType: 'image/jpeg', data: PHOTO, source: 'upload' })).document!;
    chunks.mockRestore();
    // Paid and ticked off before it was marked
    await setDeadlineDone(photo.id, DUE, true);

    await syncVault('scheduled');

    expect(props(photo.id)).toMatchObject({ pwMaybeDup: emailed.id });
    expect((await index.get(emailed.id))!.deadlines[0].done).toBe(false);
    await resolvePossibleDuplicate(photo.id, 'keep-both', emailed.id);
    expect((await index.get(emailed.id))!.deadlines[0].done).toBe(false);
    expect((await index.get(photo.id))!.deadlines[0].done).toBe(true);
  });

  it('looks for copies among documents filed before, marking the later one where it is', async () => {
    const { category } = await setup();
    const older = await filedBefore(monthBill(3), monthText(3));
    const newer = await filedBefore({ ...monthBill(3), needsReview: false }, ocrOf(monthText(3)));
    const other = await filedBefore(monthBill(4), monthText(4));

    expect(await fillDuplicateChecks(drive())).toBe(1);

    const year = h.fake.childrenOf(category('Bills & Receipts').id).find(f => f.name === '2025')!;
    expect(h.fake.files.get(newer.id)!.parents).toEqual([year.id]);
    expect(props(newer.id)).toMatchObject({ pwMaybeDup: older.id });
    expect(await index.get(newer.id)).toMatchObject({ possibleDuplicateOf: older.id, needsReview: false, dupChecked: 1, embedded: true });
    for (const id of [older.id, other.id]) expect(await index.get(id)).toMatchObject({ dupChecked: 1 });
    expect((await recentActivity())[0]).toMatchObject({ kind: 'edited', fileId: newer.id, detail: 'May be a copy of Electricity bill March 2025; its deadlines aren’t counted until you check it' });

    // Nothing more to do
    const before = h.fake.log.length;
    expect(await fillDuplicateChecks(drive())).toBe(0);
    expect(h.fake.log.slice(before).filter(r => r.method === 'PATCH')).toEqual([]);
  });

  it('marks at most five documents per run', async () => {
    await setup();
    for (let month = 1; month <= 6; month++) {
      await filedBefore(monthBill(month), monthText(month));
      await filedBefore(monthBill(month), ocrOf(monthText(month)));
    }
    expect(await fillDuplicateChecks(drive())).toBe(5);
    expect(await fillDuplicateChecks(drive())).toBe(1);
    expect((await index.all()).filter(d => d.possibleDuplicateOf)).toHaveLength(6);
    expect(await fillDuplicateChecks(drive())).toBe(0);
  });

  it('waits for a text still to be read', async () => {
    await setup();
    const older = await filedBefore(monthBill(3), monthText(3));
    const newer = await filedBefore(monthBill(3), null);

    expect(await fillDuplicateChecks(drive())).toBe(0);
    expect(await index.get(newer.id)).not.toHaveProperty('dupChecked');
    expect(await index.get(older.id)).not.toHaveProperty('dupChecked');

    const text = ocrOf(monthText(3));
    await index.put({ ...(await index.get(newer.id))!, textSource: 'ocr', textLength: text.length });
    await index.putChunks(newer.id, [chunk(newer.id, 1, text)]);
    expect(await fillDuplicateChecks(drive())).toBe(1);
    expect(props(newer.id)).toMatchObject({ pwMaybeDup: older.id });
  });

  it('finds a copy whose amount was misread by its text, among recent documents', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-20T08:00:00Z'), toFake: ['Date'] });
    try {
      await setup();
      const older = await filedBefore(monthBill(3), monthText(3));
      const newer = await filedBefore(monthBill(3, { amount: 38.45 }), ocrOf(monthText(3)));

      expect(await fillDuplicateChecks(drive())).toBe(1);
      expect(props(newer.id)).toMatchObject({ pwMaybeDup: older.id });
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts marks right whose original is gone for good, marked itself, or marked as their copy', async () => {
    await setup();
    // Its original gone for good (set aside or kept with another document), or only for now (moved out, may return)
    const gone = await filedBefore(monthBill(1), monthText(1), { pwMaybeDup: 'purged-original' });
    const away = await filedBefore(monthBill(1), monthText(1));
    const waiting = await filedBefore(monthBill(1), ocrOf(monthText(1)), { pwMaybeDup: away.id });
    await index.remove(away.id);
    // A chain: the third marked as a copy of the second, itself marked as a copy of the first
    const first = await filedBefore(monthBill(2), monthText(2));
    const second = await filedBefore(monthBill(2), ocrOf(monthText(2)), { pwMaybeDup: first.id });
    const third = await filedBefore(monthBill(2), ocrOf(monthText(2), 1), { pwMaybeDup: second.id });
    // Each marked as the other's copy
    const one = await filedBefore(monthBill(4), monthText(4));
    const two = await filedBefore(monthBill(4), ocrOf(monthText(4)), { pwMaybeDup: one.id });
    h.fake.touch(one.id, f => (f.properties = { ...f.properties, pwMaybeDup: two.id }));
    await index.put({ ...(await index.get(one.id))!, possibleDuplicateOf: two.id });

    await fillDuplicateChecks(drive());

    expect(props(gone.id).pwMaybeDup).toBeUndefined();
    expect(await index.get(gone.id)).not.toHaveProperty('possibleDuplicateOf');
    expect(props(waiting.id)).toMatchObject({ pwMaybeDup: away.id });
    expect(props(second.id)).toMatchObject({ pwMaybeDup: first.id });
    expect(props(third.id)).toMatchObject({ pwMaybeDup: first.id });
    expect(await index.get(third.id)).toMatchObject({ possibleDuplicateOf: first.id });
    expect(props(one.id).pwMaybeDup).toBeUndefined();
    expect(props(two.id)).toMatchObject({ pwMaybeDup: one.id });
    expect(h.fake.destructive()).toEqual([]);
  });
});

describe('the public edge never files', () => {
  afterEach(() => {
    delete process.env.PAPERWORK_ROLE;
  });

  it('refuses every way into filing and changing documents, before asking Drive anything', async () => {
    const { inbox } = await setup();
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('electricity') });
    process.env.PAPERWORK_ROLE = 'edge';
    const before = h.fake.log.length;
    const file = h.fake.files.get(scan.id) as any;
    const { runSync, fileOne, adoptOne } = filingStepsForTests;

    const entries: [string, () => Promise<unknown>][] = [
      ['syncVault', () => syncVault('schedule')],
      ['runSync', () => runSync('schedule')],
      ['fileOne', () => fileOne({} as any, file)],
      ['adoptOne', () => adoptOne({} as any, file)],
      ['addFile', () => addFile({ name: 'a.pdf', mimeType: 'application/pdf', data: pdf('a'), source: 'upload' })],
      ['addConvertedDoc', () => addConvertedDoc({ name: 'a', html: '<p>a</p>', source: 'email' })],
      ['importFromDrive', () => importFromDrive(scan.id)],
      ['detachFile', () => detachFile(scan.id)],
      ['retryFile', () => retryFile(scan.id)],
      ['refile', () => refile(scan.id)],
      ['updateDocument', () => updateDocument(scan.id, { title: 'x' })],
      ['renameAll', () => renameAll({ correspondent: 'a', to: 'b' })],
      ['mergeTopics', () => mergeTopics({ from: ['a'], to: 'b' })],
      ['moveTopic', () => moveTopic('a', inbox.id)],
      ['fillTopics', () => fillTopics()],
      ['fillItems', () => fillItems()],
      ['fillDuplicateChecks', () => fillDuplicateChecks(drive())],
      ['resolvePossibleDuplicate', () => resolvePossibleDuplicate(scan.id, 'duplicate', 'original')],
      ['setDeadlineDone', () => setDeadlineDone(scan.id, { date: '2025-04-25', what: 'Pay' }, true)],
    ];
    for (const [name, entry] of entries) {
      await expect((async () => entry())(), name).rejects.toBeInstanceOf(FilerOnly);
    }
    expect(h.fake.log.length).toBe(before);
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.fake.files.get(scan.id)!.parents).toEqual([inbox.id]);
  });
});

describe('one filing run at a time, across instances', () => {
  const lease = () => getStore().get<{ holder: string | null; until: string | null }>('sync-lease');

  it('skips a run while another instance files, without filing or saving anything', async () => {
    const { inbox } = await setup();
    const scan = h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('electricity') });
    expect(await takeSyncLease('paperwork-00042-abc:1')).toBe(true);

    const summary = await syncVault('schedule');

    expect(summary).toMatchObject({ reason: 'schedule', skipped: 'Another filing run is under way', filed: 0, adopted: 0, duplicates: 0, failed: 0, waiting: 0, updated: 0, indexed: 0 });
    expect(h.fake.files.get(scan.id)!.parents).toEqual([inbox.id]);
    expect(h.classify).not.toHaveBeenCalled();
    expect(await getStore().get('last-sync')).toBeNull();
    expect((await lease())!.holder).toBe('paperwork-00042-abc:1');
  });

  it('takes over a lease that ran out (its instance died), and gives it back after the run', async () => {
    const { inbox } = await setup();
    h.fake.add({ name: 'scan.pdf', parents: [inbox.id], content: pdf('electricity') });
    expect(await takeSyncLease('paperwork-00041-old:1', Date.now() - 11 * 60_000)).toBe(true);

    expect(await syncVault('schedule')).toMatchObject({ filed: 1 });
    expect(await lease()).toEqual({ holder: null, until: null });
  });

  it('is given back only by its holder, and also when the run fails', async () => {
    expect(await takeSyncLease('a:1')).toBe(true);
    expect(await takeSyncLease('a:1')).toBe(true);
    expect(await takeSyncLease('b:2')).toBe(false);
    await releaseSyncLease('b:2');
    expect((await lease())!.holder).toBe('a:1');
    expect(await takeSyncLease('b:2')).toBe(false);
    await releaseSyncLease('a:1');
    expect(await takeSyncLease('b:2')).toBe(true);
    await releaseSyncLease('b:2');

    const { root } = await setup();
    root.trashed = true;
    forgetTree();
    await expect(syncVault('schedule')).rejects.toBeInstanceOf(VaultProblem);
    expect(await lease()).toEqual({ holder: null, until: null });
  });
});
