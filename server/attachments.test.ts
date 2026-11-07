// Files kept with a document (attachments.ts), end to end against an in-memory Google Drive
// (testing/fakeDrive.ts). Gemini is a stub, and is never asked about a kept file.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDrive } from './testing/fakeDrive.js';
import { MemoryStore, setStoreForTests } from './store.js';
import { DocIndex, MemoryIndexBackend, setIndexForTests } from './docIndex.js';
import type { Classification, ClassifyInput } from './classify.js';
import { wordVector } from './testing/fixtures.js';

const h = vi.hoisted(() => ({
  fake: null as unknown as import('./testing/fakeDrive.js').FakeDrive,
  connection: null as any,
  classify: null as unknown as (input: ClassifyInput) => Promise<Classification>,
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
  describeTopics: async () => new Map(),
  describeItems: async () => new Map(),
  transcribe: async () => 'transcribed text',
}));

vi.mock('./gemini.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./gemini.js')>();
  return { ...actual, embed: async (texts: string[]) => texts.map(t => wordVector(t)) };
});

const { AttachProblem, attachExisting, attachFile, handOver, listAttachments } = await import('./attachments.js');
const { addFile, detachFile, importFromDrive, refile, retryFile, syncVault, updateDocument } = await import('./pipeline.js');
const { createFolder, forgetTree, listDocuments, listInbox, loadTree } = await import('./vault.js');
const { reconcile } = await import('./sync.js');
const { Drive } = await import('./drive.js');
const { LimitError } = await import('./gemini.js');
const { recentActivity } = await import('./activity.js');
const { getStore } = await import('./store.js');
const { dupTag } = await import('./metadata.js');

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// A contract of the owner's company, titled after the file it came from
const contract = (input: ClassifyInput): Classification => ({
  title: input.fileName.replace(/\.\w+$/, ''),
  type: 'contract',
  category: input.fixedCategory ?? 'Legal & Government',
  correspondent: 'Example UG',
  date: '2026-10-20',
  amount: null,
  currency: null,
  dueDate: null,
  deadlines: [],
  items: [],
  tags: [],
  references: null,
  action: null,
  summary: 'Shareholder loan of 20,000 EUR to Example UG.',
  topic: 'Example UG formation',
  gist: null,
  needsReview: false,
  confidence: 0.9,
  text: 'Darlehensvertrag zwischen dem Gesellschafter und der Example UG.',
});

const bytes = (text: string) => new TextEncoder().encode(text);
const pdf = (text: string) => bytes(`%PDF-1.7 ${text}`);
const drive = () => new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch });
const file = (id: string) => h.fake.files.get(id)!;

let index: DocIndex;

beforeEach(() => {
  h.fake = new FakeDrive();
  h.connection = { ownerEmail: 'me@example.com', refreshToken: 'sealed', scope: '', connectedAt: '' };
  h.classify = vi.fn(async (input: ClassifyInput) => contract(input));
  const store = new MemoryStore();
  store.data.set('settings', { views: [], review: 'automatic' });
  setStoreForTests(store);
  index = new DocIndex(new MemoryIndexBackend());
  setIndexForTests(index);
  forgetTree();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// The Paperwork folder and an uploaded document, filed into Legal & Government/2026 (or waiting in the Inbox
// for its check)
async function filedContract(name = 'Loan agreement.pdf', content = 'signed contract') {
  const tree = await loadTree(drive());
  const result = await addFile({ name, mimeType: 'application/pdf', data: pdf(content), source: 'upload' });
  const category = (folder: string) => tree.categories.find(c => c.name === folder)!;
  return { doc: result.document!, tree, inbox: tree.inbox, category };
}

const keepDraft = (documentId: string, content = 'draft v3') => attachFile(documentId, { name: 'Darlehensvertrag.docx', mimeType: DOCX, data: bytes(content) });

// The contract filed into a folder for a matter: Example UG/Eröffnungsbilanz
async function contractInMatter() {
  const filed = await filedContract();
  const company = await createFolder(drive(), filed.tree, { name: 'Example UG' });
  const folder = await createFolder(drive(), filed.tree, { name: 'Eröffnungsbilanz', parentId: company.id });
  const doc = await updateDocument(filed.doc.id, { folderId: folder.id });
  return { ...filed, doc, folder };
}

// Drive refusing every change to one file, as it does when its rate limit is reached (not retried)
function refuseChanges(id: string) {
  const fetch = h.fake.fetch;
  h.fake.fetch = async (input, init) =>
    init?.method === 'PATCH' && String(input).includes(`/files/${id}`)
      ? new Response(JSON.stringify({ error: { code: 403, message: 'User rate limit exceeded.', errors: [{ reason: 'userRateLimitExceeded' }] } }), { status: 403 })
      : fetch(input, init);
  return () => {
    h.fake.fetch = fetch;
  };
}

describe('keeping a file with a document', () => {
  it('stores a Word draft next to its document, named after it, without reading it', async () => {
    const { doc } = await filedContract();
    // The AI budget is used up: keeping a file doesn't need it
    h.classify = vi.fn(async () => {
      throw new LimitError('The AI budget for today is used up.');
    });

    const result = await keepDraft(doc.id);

    expect(result.status).toBe('kept');
    const kept = file(result.attachment!.id);
    expect(kept).toMatchObject({ name: '2026-10-20 Example UG - Loan agreement - Draft.docx', mimeType: DOCX, parents: [doc.folderId] });
    expect(kept.properties).toMatchObject({ paperwork: 'attachment', pwOf: doc.id, pwLabel: 'Draft', pwMd5: kept.md5Checksum, pwSource: 'upload' });
    expect(kept.description).toMatch(/^Kept with "2026-10-20 Example UG - Loan agreement\.pdf" \(https:\/\/drive\.google\.com\/file\/d\/.+\/view\)\./);
    expect(result.attachment).toMatchObject({ documentId: doc.id, label: 'Draft', folderId: doc.folderId, size: 8, mimeType: DOCX });
    expect((await recentActivity())[0]).toMatchObject({ kind: 'edited', fileId: doc.id, detail: 'Kept Darlehensvertrag.docx with it' });

    // Never a document: not listed, not indexed, not described by a run (which would ask the AI)
    const before = h.fake.log.length;
    expect(await syncVault('test')).toMatchObject({ filed: 0, adopted: 0, failed: 0 });
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.fake.log.slice(before).filter(r => r.path.endsWith(kept.id))).toEqual([]);
    expect(file(kept.id)).toMatchObject({ name: kept.name, parents: [doc.folderId] });
    expect((await listDocuments(drive(), await loadTree(drive()))).map(d => d.id)).toEqual([doc.id]);
    expect(await index.getAny(kept.id)).toBeNull();
    expect(await listAttachments(drive(), await loadTree(drive()), doc.id)).toEqual([result.attachment]);
    expect(h.fake.destructive()).toEqual([]);
  });

  it('takes the label given, and numbers a second file with the same label', async () => {
    const { doc } = await filedContract();
    const signed = await attachFile(doc.id, { name: 'Tilgungsplan.xlsx', mimeType: XLSX, data: bytes('plan'), label: ' Repayment plan ' });
    const first = await keepDraft(doc.id, 'v1');
    const second = await keepDraft(doc.id, 'v2');
    expect([signed, first, second].map(r => file(r.attachment!.id).name)).toEqual([
      '2026-10-20 Example UG - Loan agreement - Repayment plan.xlsx',
      '2026-10-20 Example UG - Loan agreement - Draft.docx',
      '2026-10-20 Example UG - Loan agreement - Draft 2.docx',
    ]);
    expect(signed.attachment!.label).toBe('Repayment plan');
  });

  it('says so when the same file is kept with it already, or is a document of its own', async () => {
    const { doc } = await filedContract();
    const statement = (await addFile({ name: 'Statement.pdf', mimeType: 'application/pdf', data: pdf('transfer'), source: 'upload' })).document!;
    const kept = await keepDraft(doc.id);

    expect(await keepDraft(doc.id)).toEqual({ status: 'already-kept', attachment: kept.attachment });
    const same = await attachFile(doc.id, { name: 'transfer.pdf', mimeType: 'application/pdf', data: pdf('transfer') });
    expect(same).toMatchObject({ status: 'is-document', document: { id: statement.id } });
    await expect(attachFile(doc.id, { name: 'again.pdf', mimeType: 'application/pdf', data: pdf('signed contract') })).rejects.toBeInstanceOf(AttachProblem);
    expect(await listAttachments(drive(), await loadTree(drive()))).toHaveLength(1);
  });

  it('takes a file kept with a document that is gone, instead of keeping a second copy', async () => {
    const { doc, folder } = await contractInMatter();
    const first = (await keepDraft(doc.id)).attachment!;
    // A better scan replaces the contract, whose old scan is put into the trash in Drive
    h.fake.touch(doc.id, f => (f.trashed = true));
    const better = (await addFile({ name: 'Better scan.pdf', mimeType: 'application/pdf', data: pdf('signed contract, scanned again'), source: 'upload', into: folder.id })).document!;

    const result = await keepDraft(better.id);

    expect(result).toMatchObject({ status: 'kept', attachment: { id: first.id, documentId: better.id, folderId: folder.id, label: 'Draft' } });
    expect(file(first.id)).toMatchObject({ name: '2026-10-20 Example UG - Better scan - Draft.docx', parents: [folder.id] });
    expect(file(first.id).description).toMatch(/^Kept with "2026-10-20 Example UG - Better scan\.pdf"/);
    expect(h.fake.childrenOf(folder.id).map(f => f.id).sort()).toEqual([doc.id, better.id, first.id].sort());
    expect(await listAttachments(drive(), await loadTree(drive()))).toEqual([result.attachment]);
  });

  it('keeps files only with a filed document', async () => {
    const { doc, inbox } = await filedContract();
    const kept = await keepDraft(doc.id);
    const waiting = h.fake.add({ name: 'new scan.pdf', parents: [inbox.id], content: pdf('new') });
    for (const id of [kept.attachment!.id, waiting.id, 'nothing']) await expect(keepDraft(id, 'other')).rejects.toMatchObject({ status: 404 });
  });
});

describe('a kept file', () => {
  it('is never edited, read again or filed as a document', async () => {
    const { doc } = await filedContract();
    const { attachment } = await keepDraft(doc.id);
    const id = attachment!.id;
    const before = h.fake.log.length;

    await expect(updateDocument(id, { title: 'Now a document' })).rejects.toMatchObject({ status: 404, message: 'This file is kept with another document.' });
    await expect(refile(id)).rejects.toMatchObject({ status: 404 });
    await expect(retryFile(id)).rejects.toMatchObject({ status: 404 });

    expect(h.fake.log.slice(before).filter(r => r.method !== 'GET')).toEqual([]);
    expect(file(id).properties?.paperwork).toBe('attachment');
  });

  it('waits with its document in the Inbox for its check, is never filed or adopted, and goes along once checked', async () => {
    await getStore().set('settings', { views: [], review: 'manual' });
    const { doc, inbox, category } = await filedContract();
    expect(doc.inInbox).toBe(true);
    const { attachment } = await keepDraft(doc.id);
    expect(file(attachment!.id).parents).toEqual([inbox.id]);

    expect(await syncVault('test')).toMatchObject({ filed: 0, adopted: 0, failed: 0 });
    expect(h.classify).toHaveBeenCalledTimes(1);
    const tree = await loadTree(drive());
    expect(await listInbox(drive(), tree)).toEqual([]);
    expect(file(attachment!.id)).toMatchObject({ parents: [inbox.id], properties: { paperwork: 'attachment' } });

    const checked = await updateDocument(doc.id, { needsReview: false });

    expect(checked.folderPath).toEqual(['Legal & Government', '2026']);
    expect(file(doc.id).parents).toEqual([checked.folderId]);
    expect(file(attachment!.id).parents).toEqual([checked.folderId]);
    expect(checked.categoryId).toBe(category('Legal & Government').id);
  });

  it('goes along when its document moves to another category, a new year or is renamed, into one folder each time', async () => {
    const { doc, category } = await filedContract();
    const draft = (await keepDraft(doc.id)).attachment!;
    const plan = (await attachFile(doc.id, { name: 'Plan.xlsx', mimeType: XLSX, data: bytes('plan') })).attachment!;
    const kept = [draft.id, plan.id];

    const moved = await updateDocument(doc.id, { categoryId: category('Finance & Banking').id });
    expect(moved.folderPath).toEqual(['Finance & Banking', '2026']);
    for (const id of [doc.id, ...kept]) expect(file(id).parents).toEqual([moved.folderId]);

    const redated = await updateDocument(doc.id, { date: '2025-12-30' });
    expect(redated.folderPath).toEqual(['Finance & Banking', '2025']);
    for (const id of [doc.id, ...kept]) expect(file(id).parents).toEqual([redated.folderId]);

    await updateDocument(doc.id, { title: 'Shareholder loan' });
    expect(kept.map(id => file(id).name)).toEqual(['2025-12-30 Example UG - Shareholder loan - Draft.docx', '2025-12-30 Example UG - Shareholder loan - Attachment.xlsx']);
    expect(file(draft.id).description).toMatch(/^Kept with "2025-12-30 Example UG - Shareholder loan\.pdf"/);
    expect(file(draft.id).properties?.pwOf).toBe(doc.id);
    expect(h.fake.destructive()).toEqual([]);
  });

  it('goes along when its document is read again, and keeps a name given in Drive', async () => {
    const { doc, category } = await filedContract();
    const { attachment } = await keepDraft(doc.id);
    h.fake.touch(attachment!.id, f => (f.name = 'My notes.docx'));
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...contract(input), title: 'Shareholder loan', category: 'Finance & Banking' }));

    const again = await refile(doc.id);

    expect(again.document).toMatchObject({ folderPath: ['Finance & Banking', '2026'], title: 'Shareholder loan' });
    expect(file(attachment!.id)).toMatchObject({ name: 'My notes.docx', parents: [again.document!.folderId] });
    expect(again.document!.categoryId).toBe(category('Finance & Banking').id);
  });

  it('goes to the original when its document turns out to be a copy', async () => {
    const { doc: original, category } = await filedContract();
    // The same file, put into a category by hand: described where it is, without a duplicate check
    const copy = h.fake.add({ name: 'Copy of the contract.pdf', parents: [category('Insurance').id], content: pdf('signed contract') });
    expect(await syncVault('test')).toMatchObject({ adopted: 1 });
    const { attachment } = await keepDraft(copy.id);
    expect(file(attachment!.id)).toMatchObject({ name: 'Copy of the contract - Draft.docx', parents: [category('Insurance').id] });

    expect(await refile(copy.id)).toMatchObject({ status: 'duplicate', duplicateOf: { id: original.id } });

    expect(file(attachment!.id)).toMatchObject({ name: '2026-10-20 Example UG - Loan agreement - Draft.docx', parents: [original.folderId] });
    expect(file(attachment!.id).properties).toMatchObject({ paperwork: 'attachment', pwOf: original.id });
    expect(file(copy.id).properties?.paperwork).toBe('duplicate');
  });

  it('found again in My Drive or the Inbox, is recognised by its content: never read or filed as a document', async () => {
    const { doc, inbox } = await filedContract();
    await keepDraft(doc.id);
    const read = vi.mocked(h.classify).mock.calls.length;
    const tree = await loadTree(drive());

    // The same draft picked in Google Drive, for a folder: left where it is
    const mine = h.fake.add({ name: 'Gesellschafterdarlehensvertrag.docx', mimeType: DOCX, content: bytes('draft v3') });
    const picked = await importFromDrive(mine.id, tree.categories[0].id);
    expect(picked).toMatchObject({ status: 'duplicate', duplicateOf: { id: doc.id }, keptWith: { id: doc.id } });
    expect(file(mine.id).parents).toEqual([h.fake.myDriveRoot]);
    expect(file(mine.id).properties).toBeUndefined();

    // Saved into the Inbox in Drive (with full access): to the duplicates, naming its document
    const dropped = h.fake.add({ name: 'Darlehensvertrag (1).docx', mimeType: DOCX, parents: [inbox.id], content: bytes('draft v3') });
    expect(await syncVault('test')).toMatchObject({ filed: 0, duplicates: 1, failed: 0 });
    expect(file(dropped.id).properties).toMatchObject({ paperwork: 'duplicate', pwDupOf: doc.id });
    expect(file(dropped.id).description).toMatch(/^The same file as one kept with "2026-10-20 Example UG - Loan agreement\.pdf"/);
    expect(file(dropped.id).parents).toEqual([(await loadTree(drive())).duplicates!.id]);
    expect(h.classify).toHaveBeenCalledTimes(read);
    expect((await listDocuments(drive(), await loadTree(drive()))).map(d => d.id)).toEqual([doc.id]);
  });

  it('left behind when Drive refused to move it, comes along with the next change to its document', async () => {
    const { doc, category } = await filedContract();
    const { attachment } = await keepDraft(doc.id);
    const allow = refuseChanges(attachment!.id);
    const moved = await updateDocument(doc.id, { categoryId: category('Finance & Banking').id });
    allow();
    expect(file(attachment!.id).parents).toEqual([doc.folderId]);

    await updateDocument(doc.id, { summary: 'Shareholder loan of 20,000 EUR, repaid from 2027.' });

    expect(file(attachment!.id).parents).toEqual([moved.folderId]);
  });

  it('goes to the original with the others when Drive refuses to hand one over', async () => {
    const { doc: original, category } = await filedContract();
    const copy = h.fake.add({ name: 'Copy of the contract.pdf', parents: [category('Insurance').id], content: pdf('signed contract') });
    await syncVault('test');
    const plan = (await attachFile(copy.id, { name: 'Plan.xlsx', mimeType: XLSX, data: bytes('plan') })).attachment!;
    const draft = (await keepDraft(copy.id)).attachment!;
    const allow = refuseChanges(plan.id);

    expect(await refile(copy.id)).toMatchObject({ status: 'duplicate', duplicateOf: { id: original.id } });
    allow();

    expect(file(draft.id)).toMatchObject({ parents: [original.folderId], properties: { pwOf: original.id } });
    expect(file(plan.id).properties?.pwOf).toBe(copy.id);
  });

  it('moved out of Paperwork by hand and picked again, comes back as a document of its own, without its note', async () => {
    const { doc } = await filedContract();
    const { attachment } = await attachFile(doc.id, { name: 'Repayment plan.txt', mimeType: 'text/plain', data: bytes('12 instalments of 1,700 EUR') });
    h.fake.touch(attachment!.id, f => (f.parents = [h.fake.myDriveRoot]));
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...contract(input), title: 'Repayment plan' }));

    const result = await importFromDrive(attachment!.id);

    expect(result).toMatchObject({ status: 'filed', document: { id: attachment!.id, title: 'Repayment plan' } });
    expect(vi.mocked(h.classify).mock.calls[0][0].notes).toBe('');
    expect(file(attachment!.id).properties).toMatchObject({ paperwork: 'doc' });
    expect(file(attachment!.id).properties).not.toHaveProperty('pwOf');
  });

  it('picked in Google Drive, answers with its document, or becomes a document when that is gone', async () => {
    const { doc } = await filedContract();
    const { attachment } = await keepDraft(doc.id);
    expect(await importFromDrive(attachment!.id)).toMatchObject({ status: 'duplicate', duplicateOf: { id: doc.id }, keptWith: { id: doc.id } });
    expect(file(attachment!.id).parents).toEqual([doc.folderId]);

    const orphan = h.fake.add({
      name: 'Old letter - Attachment.txt',
      mimeType: 'text/plain',
      parents: [doc.folderId!],
      properties: { paperwork: 'attachment', pwOf: 'deleted-for-good', pwLabel: 'Attachment' },
      content: bytes('An old letter'),
    });
    const result = await importFromDrive(orphan.id);
    expect(result).toMatchObject({ status: 'filed', document: { id: orphan.id } });
    expect(file(orphan.id).properties).toMatchObject({ paperwork: 'doc' });
    expect(file(orphan.id).properties).not.toHaveProperty('pwOf');
    expect(file(orphan.id).parents).toEqual([result.document!.folderId]);
  });
});

describe('a document made a kept file of another, and back', () => {
  it('is renamed, labelled and moved next to that one, and leaves the library and the index for good', async () => {
    const { doc, tree } = await filedContract();
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...contract(input), category: 'Other', title: 'Loan agreement draft' }));
    const draft = (await addFile({ name: 'draft.txt', mimeType: 'text/plain', data: bytes('Entwurf: Darlehensvertrag'), source: 'upload' })).document!;
    expect(draft.folderPath).toEqual(['Other', '2026']);

    const result = await attachExisting(draft.id, doc.id);

    expect(result).toMatchObject({ status: 'kept', attachment: { id: draft.id, documentId: doc.id, label: 'Attachment', folderId: doc.folderId } });
    const kept = file(draft.id);
    expect(kept).toMatchObject({ name: '2026-10-20 Example UG - Loan agreement - Attachment.txt', parents: [doc.folderId] });
    expect(kept.properties).toMatchObject({ paperwork: 'attachment', pwOf: doc.id, pwLabel: 'Attachment', pwMd5: kept.md5Checksum });
    expect(kept.description).toMatch(/^Kept with "2026-10-20 Example UG - Loan agreement\.pdf" .+\n\nShareholder loan of 20,000 EUR to Example UG\.$/);
    expect((await listDocuments(drive(), tree)).map(d => d.id)).toEqual([doc.id]);
    expect(await index.getAny(draft.id)).toBeNull();

    await syncVault('test');
    await reconcile(drive(), await loadTree(drive()), { full: true });
    expect(await index.getAny(draft.id)).toBeNull();
    expect((await index.all()).map(d => d.id)).toEqual([doc.id]);
    expect(h.fake.destructive()).toEqual([]);
  });

  it('is refused with itself, with a file that is no document, and when files are kept with it', async () => {
    const { doc } = await filedContract();
    const other = (await addFile({ name: 'Statement.pdf', mimeType: 'application/pdf', data: pdf('transfer'), source: 'upload' })).document!;
    const { attachment } = await keepDraft(doc.id);

    await expect(attachExisting(doc.id, doc.id)).rejects.toBeInstanceOf(AttachProblem);
    await expect(attachExisting(other.id, attachment!.id)).rejects.toBeInstanceOf(AttachProblem);
    await expect(attachExisting(other.id, 'nothing')).rejects.toBeInstanceOf(AttachProblem);
    await expect(attachExisting(doc.id, other.id)).rejects.toThrow('Files are kept with this document. Make them documents of their own first.');
    await expect(attachExisting(attachment!.id, other.id)).rejects.toMatchObject({ status: 404 });
    expect(file(doc.id).properties?.paperwork).toBe('doc');
    expect(file(other.id).properties?.paperwork).toBe('doc');
  });

  it('kept with its original as a possible copy: labelled, its own kept files handed over, only while still marked so', async () => {
    const { doc } = await filedContract();
    const scan = (await addFile({ name: 'Loan agreement scan.pdf', mimeType: 'application/pdf', data: pdf('signed contract, scanned'), source: 'upload' })).document!;
    const { attachment: draft } = await keepDraft(scan.id);
    const asCopy = () => attachExisting(scan.id, doc.id, { label: 'Copy', handOver: true, flaggedAs: doc.id });
    await expect(asCopy()).rejects.toThrow('This document isn’t marked as a possible copy of that one any more.');
    h.fake.touch(scan.id, f => (f.properties = { ...f.properties, pwMaybeDup: doc.id, pwNotDup: dupTag('another') }));

    const result = await asCopy();

    expect(result).toMatchObject({ status: 'kept', attachment: { id: scan.id, documentId: doc.id, label: 'Copy', name: '2026-10-20 Example UG - Loan agreement - Copy.pdf' } });
    expect(file(scan.id).properties).toMatchObject({ paperwork: 'attachment', pwOf: doc.id, pwLabel: 'Copy' });
    expect(file(scan.id).properties).not.toHaveProperty('pwMaybeDup');
    expect(file(scan.id).properties).not.toHaveProperty('pwNotDup');
    expect(file(draft!.id).properties).toMatchObject({ pwOf: doc.id });
    expect(file(draft!.id).parents).toEqual([doc.folderId]);
    expect(await index.getAny(scan.id)).toBeNull();
    expect(h.fake.destructive()).toEqual([]);
  });

  it('is refused when the other one was made a file kept with this one meanwhile, so neither leaves the library', async () => {
    const { doc } = await filedContract();
    const scan = (await addFile({ name: 'Loan agreement scan.pdf', mimeType: 'application/pdf', data: pdf('signed contract, scanned'), source: 'upload' })).document!;
    // The first conversion waits while it looks for the files kept with the scan; the opposite one, from another
    // window, runs meanwhile
    let open!: () => void;
    const gate = new Promise<void>(resolve => (open = resolve));
    const fetch = h.fake.fetch;
    let looks = 0;
    h.fake.fetch = async (input, init) => {
      if (decodeURIComponent(String(input)).includes(`value='${scan.id}'`) && looks++ === 0) await gate;
      return fetch(input, init);
    };
    const first = attachExisting(scan.id, doc.id, { label: 'Copy', handOver: true }).catch(err => err);
    await vi.waitFor(() => expect(looks).toBe(1));
    await attachExisting(doc.id, scan.id);
    open();

    expect(await first).toMatchObject({ message: 'That document is kept with this one now.' });
    expect(file(doc.id).properties).toMatchObject({ paperwork: 'attachment', pwOf: scan.id });
    expect(file(scan.id).properties).toMatchObject({ paperwork: 'doc' });
    expect((await listDocuments(drive(), await loadTree(drive()))).map(d => d.id)).toEqual([scan.id]);
    expect((await listAttachments(drive(), await loadTree(drive()), scan.id)).map(a => a.id)).toEqual([doc.id]);
  });

  it('never keeps the original with itself when handing a copy’s kept files over to it', async () => {
    const { doc, tree } = await filedContract();
    const scan = (await addFile({ name: 'Loan agreement scan.pdf', mimeType: 'application/pdf', data: pdf('signed contract, scanned'), source: 'upload' })).document!;
    const original = await drive().get(doc.id);
    // The original kept with the copy meanwhile, as a draft is
    const { attachment: draft } = await keepDraft(scan.id);
    h.fake.touch(doc.id, f => (f.properties = { ...f.properties, paperwork: 'attachment', pwOf: scan.id }));

    await handOver(drive(), tree, scan.id, original);

    expect(file(draft!.id).properties).toMatchObject({ pwOf: doc.id });
    expect(file(doc.id).properties).toMatchObject({ pwOf: scan.id });
  });

  it('becomes a document of its own again: out into the Inbox, and filed from there', async () => {
    const { doc, inbox } = await filedContract();
    const { attachment } = await attachFile(doc.id, { name: 'Repayment plan.txt', mimeType: 'text/plain', data: bytes('12 instalments of 1,700 EUR') });
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...contract(input), title: 'Repayment plan', category: 'Finance & Banking' }));

    const result = await detachFile(attachment!.id);

    expect(result).toMatchObject({ status: 'filed', document: { id: attachment!.id, title: 'Repayment plan', folderPath: ['Finance & Banking', '2026'] } });
    const filed = file(attachment!.id);
    expect(filed.name).toBe('2026-10-20 Example UG - Repayment plan.txt');
    expect(filed.parents).toEqual([result.document!.folderId]);
    // Made a document of its own on purpose: never asked about as a copy of the one it was kept with
    expect(filed.properties).toMatchObject({ paperwork: 'doc', pwNotDup: dupTag(doc.id) });
    expect(filed.properties).not.toHaveProperty('pwOf');
    expect(filed.properties).not.toHaveProperty('pwLabel');
    // Through the Inbox
    expect(h.fake.log.some(r => r.method === 'PATCH' && r.path.endsWith(attachment!.id) && r.query.addParents === inbox.id)).toBe(true);
    expect(await index.get(attachment!.id)).not.toBeNull();
    await expect(detachFile(doc.id)).rejects.toMatchObject({ status: 404 });
  });

  it('kept in a folder for a matter, goes back into it, and its note naming the document is not read as one', async () => {
    const { doc, folder } = await contractInMatter();
    const { attachment } = await attachFile(doc.id, { name: 'Kontoauszug.pdf', mimeType: 'application/pdf', data: pdf('transfer of 20,000 EUR') });
    expect(file(attachment!.id).parents).toEqual([folder.id]);
    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...contract(input), title: 'Bank statement', category: 'Finance & Banking' }));

    const result = await detachFile(attachment!.id);

    expect(result).toMatchObject({ status: 'filed', document: { folderId: folder.id, folderPath: ['Example UG', 'Eröffnungsbilanz'], category: 'Example UG' } });
    expect(file(attachment!.id).parents).toEqual([folder.id]);
    expect(file(attachment!.id).properties).not.toHaveProperty('pwInto');
    const input = vi.mocked(h.classify).mock.calls[0][0];
    expect(input.fixedCategory).toBe('Example UG');
    expect(input.notes).not.toMatch(/Kept with/);
  });

  it('kept in a folder for a matter, waits for the AI budget in the Inbox to go back into it', async () => {
    await getStore().set('settings', { views: [], review: 'manual' });
    const { doc, folder, inbox } = await contractInMatter();
    const { attachment } = await attachFile(doc.id, { name: 'Kontoauszug.pdf', mimeType: 'application/pdf', data: pdf('transfer of 20,000 EUR') });
    h.classify = vi.fn(async () => {
      throw new LimitError('The AI budget for today is used up.');
    });

    expect(await detachFile(attachment!.id)).toMatchObject({ status: 'waiting' });
    expect(file(attachment!.id)).toMatchObject({ parents: [inbox.id], description: '' });
    expect(file(attachment!.id).properties).toMatchObject({ pwInto: folder.id });

    h.classify = vi.fn(async (input: ClassifyInput) => ({ ...contract(input), title: 'Bank statement', category: 'Finance & Banking' }));
    expect(await syncVault('test')).toMatchObject({ filed: 1 });
    expect(file(attachment!.id).parents).toEqual([folder.id]);
    expect(file(attachment!.id).properties).toMatchObject({ paperwork: 'doc', pwReview: '1' });
  });

  it('is refused for a file Paperwork can’t read, which stays kept with its document', async () => {
    const { doc } = await filedContract();
    const plan = (await attachFile(doc.id, { name: 'Tilgungsplan.xlsx', mimeType: XLSX, data: bytes('plan') })).attachment!;
    const draft = (await keepDraft(doc.id)).attachment!;
    expect([plan.readable, draft.readable]).toEqual([false, true]);
    const before = h.fake.log.length;

    await expect(detachFile(plan.id)).rejects.toThrow('Paperwork can’t read this kind of file, so it can’t be a document of its own. It stays where it is.');
    // Nor when it is picked in Google Drive once its document is gone
    h.fake.touch(doc.id, f => (f.trashed = true));
    await expect(importFromDrive(plan.id)).rejects.toBeInstanceOf(AttachProblem);

    expect(h.fake.log.slice(before).filter(r => r.method !== 'GET')).toEqual([]);
    expect(file(plan.id)).toMatchObject({ parents: [doc.folderId], properties: { paperwork: 'attachment', pwOf: doc.id } });
  });

  it('follows the document it is now kept with when an edit moves that one at the same time', async () => {
    const { doc, tree } = await filedContract();
    const company = await createFolder(drive(), tree, { name: 'Example UG' });
    const folder = await createFolder(drive(), tree, { name: 'Eröffnungsbilanz', parentId: company.id });
    const draft = (await addFile({ name: 'draft.txt', mimeType: 'text/plain', data: bytes('Entwurf: Darlehensvertrag'), source: 'upload' })).document!;
    // The edit moving the contract is saved just before the draft is labelled, so it found no kept file to take along
    const fetch = h.fake.fetch;
    let moving = true;
    h.fake.fetch = async (input, init) => {
      if (moving && init?.method === 'PATCH' && String(input).includes(`/files/${draft.id}`)) {
        moving = false;
        await updateDocument(doc.id, { folderId: folder.id });
      }
      return fetch(input, init);
    };

    const result = await attachExisting(draft.id, doc.id);

    expect(file(doc.id).parents).toEqual([folder.id]);
    expect(file(draft.id).parents).toEqual([folder.id]);
    expect(result.attachment).toMatchObject({ folderId: folder.id });
  });
});
