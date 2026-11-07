// The app's API for the index: the library from the index, a document's text, deadlines, search and sync,
// served over HTTP against an in-memory Google Drive (testing/fakeDrive.ts).
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AttachResult,
  CategoryInfo,
  ContractsResponse,
  DocumentInfo,
  DocumentText,
  DuplicateChoiceResult,
  EmailSetup,
  LibraryResponse,
  TaxResponse,
  PickerConfig,
  SearchResponse,
  SessionInfo,
  Settings,
  SubfolderInfo,
  SyncSummary,
  UploadResult,
} from '../shared/types.js';
import { FakeDrive } from './testing/fakeDrive.js';
import { MemoryStore, setStoreForTests } from './store.js';
import { DocIndex, MemoryIndexBackend, setIndexForTests } from './docIndex.js';
import type { Classification, ClassifyInput } from './classify.js';
import { billMeta, docLabels, prose, textPdf, wordVector } from './testing/fixtures.js';

const h = vi.hoisted(() => ({
  fake: null as unknown as import('./testing/fakeDrive.js').FakeDrive,
  connection: null as any,
  suggest: null as unknown as (topics: { topic: string }[]) => Promise<{ topics: string[]; to: string; why: string }[]>,
}));

vi.mock('./google.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./google.js')>();
  const { Drive } = await import('./drive.js');
  return {
    ...actual,
    getDrive: () => new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch, sleep: async () => {} }),
    getConnection: async () => h.connection,
    accessToken: async () => 'picker-token',
    rememberRootFolder: async (id: string) => {
      h.connection.rootFolderId = id;
    },
  };
});

vi.mock('./classify.js', () => ({
  classify: async (input: ClassifyInput): Promise<Classification> => ({ ...billMeta, category: input.fixedCategory ?? 'Bills & Receipts', text: null }),
  transcribe: async () => 'Transcribed text.',
  suggestTopicMerges: (topics: { topic: string }[]) => h.suggest(topics),
}));

vi.mock('./gemini.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./gemini.js')>();
  return { ...actual, embed: async (texts: string[]) => texts.map(t => wordVector(t)) };
});

const { apiRouter } = await import('./routes.js');
const { startSession } = await import('./auth.js');
const { forgetTree, loadTree } = await import('./vault.js');
const { Drive } = await import('./drive.js');
const { fileName } = await import('./metadata.js');

let server: Server;
let base: string;
let cookie: string;
let index: DocIndex;

beforeAll(async () => {
  const app = express();
  app.use('/api', apiRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const headers: string[] = [];
  await startSession({ append: (_name: string, value: string) => headers.push(value) } as any, { email: 'me@example.com', name: 'Me', picture: null });
  cookie = headers[0].split(';')[0];
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  h.fake = new FakeDrive();
  h.connection = { ownerEmail: 'me@example.com', refreshToken: 'sealed', scope: '', connectedAt: '' };
  // Filed straight into folders, unless a test turns checking on
  const store = new MemoryStore();
  store.data.set('settings', { views: [], review: 'automatic' });
  setStoreForTests(store);
  index = new DocIndex(new MemoryIndexBackend());
  setIndexForTests(index);
  forgetTree();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, {
    method,
    headers: { cookie, 'x-paperwork': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

// A document filed before, with a PDF text layer, in Bills & Receipts
async function filedDocument() {
  await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
  const root = h.fake.find('Paperwork')!;
  const bills = h.fake.childrenOf(root.id).find(f => f.name === 'Bills & Receipts')!;
  const name = fileName(billMeta, { name: 'scan.pdf', mimeType: 'application/pdf' });
  const text = prose(15);
  const file = h.fake.add({ name, parents: [bills.id], ...docLabels(billMeta, name), content: await textPdf([text]) });
  return { file, text };
}

describe('the API for the index', () => {
  it('fills an empty index from Drive before showing the library, without bookkeeping fields', async () => {
    const { file } = await filedDocument();

    const { status, body } = await api<LibraryResponse>('GET', '/library');

    expect(status).toBe(200);
    expect(body.documents.map(d => [d.id, d.title, d.textSource])).toEqual([[file.id, 'Electricity bill March', null]]);
    expect(body.index).toEqual({ documents: 1, searchable: 0, pending: 1, paused: false, topicsPending: 0 });
    for (const key of ['md5', 'embedded', 'indexedAt', 'indexTries', 'removedAt', 'described']) expect(body.documents[0]).not.toHaveProperty(key);
    expect(body.categories.find(c => c.name === 'Bills & Receipts')!.count).toBe(1);
  });

  it('runs a sync that reads the text, then serves it', async () => {
    const { file, text } = await filedDocument();

    const sync = await api<SyncSummary>('POST', '/sync');
    expect(sync.body).toMatchObject({ reason: 'app', updated: 1, indexed: 1 });

    const library = await api<LibraryResponse>('GET', '/library');
    expect(library.body.index).toEqual({ documents: 1, searchable: 1, pending: 0, paused: false, topicsPending: 0 });
    const { status, body } = await api<DocumentText>('GET', `/documents/${file.id}/text`);
    expect(status).toBe(200);
    expect(body.source).toBe('pdf');
    expect(body.text.replace(/\s+/g, ' ')).toBe(text);
  });

  it("answers 404 for the text of a document that isn't in Paperwork", async () => {
    await filedDocument();
    const { status, body } = await api<{ error: string }>('GET', '/documents/nothing/text');
    expect(status).toBe(404);
    expect(body.error).toBe('This document is not in Paperwork.');
  });

  it('ticks a deadline off and on, and explains a request it cannot take', async () => {
    const { file } = await filedDocument();
    await api('GET', '/library');

    const done = await api<DocumentInfo>('POST', `/documents/${file.id}/deadlines`, { date: '2025-04-25', what: 'Pay 87.45 EUR', done: true });
    expect(done.status).toBe(200);
    expect(done.body.deadlines).toEqual([{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: true }]);
    expect((await index.get(file.id))!.deadlines[0].done).toBe(true);

    const missing = await api<{ error: string }>('POST', `/documents/${file.id}/deadlines`, { date: '2025-04-25', what: 'Pay' });
    expect(missing).toEqual({ status: 400, body: { error: 'Say which deadline (date and what) and whether it is done.' } });
    const unknown = await api<{ error: string; code: string }>('POST', `/documents/${file.id}/deadlines`, { date: '2030-01-01', what: 'Nothing', done: true });
    expect(unknown).toEqual({ status: 404, body: { error: 'This document has no such deadline.', code: 'drive' } });
  });

  it('turns away an edit whose deadlines are not a list of dates and descriptions', async () => {
    const { file } = await filedDocument();
    await api('GET', '/library');
    for (const deadlines of ['soon', [null], [{ date: 5, what: 'x' }], [{ date: '2026-01-01' }]]) {
      const res = await api<{ error: string }>('PATCH', `/documents/${file.id}`, { deadlines });
      expect(res).toEqual({ status: 400, body: { error: 'Deadlines need a date and a description each.' } });
    }
  });

  it('takes the deadlines of an edit as given, done flags included', async () => {
    const { file } = await filedDocument();
    await api('GET', '/library');
    const deadlines = [
      { date: '2025-04-25', what: 'Pay 87.45 EUR', done: true },
      { date: '2025-12-31', what: 'Contract ends', done: false },
    ];
    const { status, body } = await api<DocumentInfo>('PATCH', `/documents/${file.id}`, { deadlines });
    expect(status).toBe(200);
    expect(body.deadlines).toEqual(deadlines);
    expect((await index.get(file.id))!.deadlines).toEqual(deadlines);
  });

  it('shows a document fresh from Drive and brings the index up to date with it', async () => {
    const { file } = await filedDocument();
    await api('GET', '/library');
    h.fake.files.get(file.id)!.starred = true;
    const { body } = await api<DocumentInfo>('GET', `/documents/${file.id}`);
    expect(body.starred).toBe(true);
    expect((await index.get(file.id))!.starred).toBe(true);
  });

  it('searches by meaning and by words', async () => {
    const { file } = await filedDocument();
    await api('POST', '/sync');

    const { body } = await api<SearchResponse>('GET', `/search?q=${encodeURIComponent('Electricity bill')}`);
    expect(body.semantic).toBe(true);
    expect(body.hits.map(h => h.id)).toEqual([file.id]);
    expect(await api('GET', '/search?q=%20')).toEqual({ status: 200, body: { hits: [], semantic: true } });
  });
});

describe('after the second review', () => {
  it("shows a file in the Inbox without putting it into the index", async () => {
    await filedDocument();
    await api('GET', '/library');
    const inbox = h.fake.find('Inbox')!;
    const waiting = h.fake.add({ name: 'new scan.pdf', parents: [inbox.id], content: new Uint8Array([1]) });
    const { status, body } = await api<DocumentInfo>('GET', `/documents/${waiting.id}`);
    expect(status).toBe(200);
    expect(body.id).toBe(waiting.id);
    expect(await index.getAny(waiting.id)).toBeNull();
  });

  it('lists the documents from Drive when the index cannot be read', async () => {
    const { file } = await filedDocument();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(index, 'all').mockRejectedValue(new Error('Firestore is unavailable.'));
    const { status, body } = await api<LibraryResponse>('GET', '/library');
    expect(status).toBe(200);
    expect(body.documents.map(d => d.id)).toEqual([file.id]);
    expect(body.index).toEqual({ documents: 1, searchable: 0, pending: 0, paused: false, topicsPending: 0 });
  });
});

describe('picking files in Google Drive', () => {
  const NARROW = 'openid email profile https://www.googleapis.com/auth/drive.file';
  const env = { PICKER_API_KEY: 'picker-key', GOOGLE_CLIENT_ID: '123456789012-abc.apps.googleusercontent.com', DRIVE_ACCESS: undefined as string | undefined };

  beforeEach(() => {
    h.connection.scope = NARROW;
    Object.assign(process.env, { PICKER_API_KEY: env.PICKER_API_KEY, GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID });
    delete process.env.DRIVE_ACCESS;
  });
  afterEach(() => {
    delete process.env.PICKER_API_KEY;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.DRIVE_ACCESS;
  });

  // The Paperwork folder, and a scan the Drive app saved into a folder of its own
  async function scanInDrive(content = 'scan') {
    await loadTree(new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch }));
    const scans = h.fake.folder('Scans', h.fake.myDriveRoot);
    const scan = h.fake.add({ name: 'Scanned_20261016-0912.pdf', parents: [scans.id], content: new TextEncoder().encode(`%PDF-1.7 ${content}`) });
    return { scans, scan, inbox: h.fake.find('Inbox')! };
  }

  it("gives the owner the picker's token, key and project, when Drive access is limited to Paperwork's files", async () => {
    const session = await api<SessionInfo>('GET', '/session');
    expect(session.body.vault).toMatchObject({ access: 'app', grant: null, pickerUnavailable: null });
    const res = await fetch(base + '/drive/picker', { method: 'POST', headers: { cookie, 'x-paperwork': '1' } });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()) as PickerConfig).toEqual({ token: 'picker-token', apiKey: 'picker-key', appId: '123456789012' });
  });

  it("never hands out a token that opens the whole Drive, nor the owner's token to someone else", async () => {
    h.connection.scope = 'openid email profile https://www.googleapis.com/auth/drive';
    const wide = await api<{ error: string; code: string }>('POST', '/drive/picker');
    expect(wide.status).toBe(409);
    expect(wide.body.error).toMatch(/connect Drive again/);
    expect((await api<SessionInfo>('GET', '/session')).body.vault).toMatchObject({ grant: 'full' });

    h.connection.scope = NARROW;
    h.connection.ownerEmail = 'partner@example.com';
    expect((await api<{ error: string }>('POST', '/drive/picker')).body.error).toBe('Only partner@example.com, whose Drive Paperwork uses, can pick files from it.');
    expect((await api('POST', '/drive/import/anything')).status).toBe(409);

    h.connection.ownerEmail = 'me@example.com';
    process.env.DRIVE_ACCESS = 'full';
    expect((await api('POST', '/drive/picker')).status).toBe(409);
    delete process.env.DRIVE_ACCESS;
    delete process.env.PICKER_API_KEY;
    expect((await api<{ error: string }>('POST', '/drive/picker')).body.error).toMatch(/deploy\/setup\.sh/);
  });

  it('moves a picked file into the Inbox and files it', async () => {
    const { scan, scans } = await scanInDrive();

    const { status, body } = await api<UploadResult>('POST', `/drive/import/${scan.id}`);

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'filed', document: { id: scan.id, folderPath: ['Bills & Receipts', '2025'] } });
    expect(body.copied).toBeUndefined();
    const moved = h.fake.files.get(scan.id)!;
    expect(moved.parents).not.toContain(scans.id);
    expect(moved.properties).toMatchObject({ paperwork: 'doc', pwSource: 'drive' });
    expect(await index.get(scan.id)).not.toBeNull();
    expect(h.fake.destructive()).toEqual([]);
  });

  it('files a copy when Drive won\'t let Paperwork take the file out of its folder, leaving the original', async () => {
    const { scan, scans } = await scanInDrive();
    h.fake.lockedFolders.add(scans.id);

    const { body } = await api<UploadResult>('POST', `/drive/import/${scan.id}`);

    expect(body).toMatchObject({ status: 'filed', copied: true });
    expect(body.document!.id).not.toBe(scan.id);
    expect(h.fake.files.get(scan.id)).toMatchObject({ parents: [scans.id], name: 'Scanned_20261016-0912.pdf' });
    expect(h.fake.files.get(scan.id)!.properties).toBeUndefined();
    expect(h.fake.destructive()).toEqual([]);
  });

  it('leaves a file alone whose content is already in Paperwork', async () => {
    const { scan, scans } = await scanInDrive('same');
    expect((await api<UploadResult>('POST', `/drive/import/${scan.id}`)).body.status).toBe('filed');
    const again = h.fake.add({ name: 'Scanned again.pdf', parents: [scans.id], content: new TextEncoder().encode('%PDF-1.7 same') });

    const { body } = await api<UploadResult>('POST', `/drive/import/${again.id}`);

    expect(body).toMatchObject({ status: 'duplicate', duplicateOf: { id: scan.id } });
    expect(h.fake.files.get(again.id)!.parents).toEqual([scans.id]);
    // Picking a document that is in Paperwork already says so
    expect((await api<UploadResult>('POST', `/drive/import/${scan.id}`)).body).toMatchObject({ status: 'duplicate', duplicateOf: { id: scan.id } });
  });

  it('files a picked file into the folder it was picked for, and refuses a folder that is not for documents', async () => {
    const { scan, scans } = await scanInDrive();
    const company = (await api<CategoryInfo>('POST', '/folders', { name: 'Example UG' })).body;
    const folder = (await api<SubfolderInfo>('POST', '/folders', { name: 'Eröffnungsbilanz', parentId: company.id })).body;

    for (const into of [scans.id, h.fake.find('Inbox')!.id]) {
      expect(await api('POST', `/drive/import/${scan.id}?into=${into}`)).toEqual({ status: 400, body: { error: 'That is not a folder for documents in Paperwork.' } });
    }
    expect(h.fake.files.get(scan.id)!.parents).toEqual([scans.id]);

    const { body } = await api<UploadResult>('POST', `/drive/import/${scan.id}?into=${folder.id}`);

    expect(body).toMatchObject({ status: 'filed', document: { id: scan.id, folderId: folder.id, category: 'Example UG' } });
    expect(h.fake.files.get(scan.id)!.parents).toEqual([folder.id]);
    expect(h.fake.files.get(scan.id)!.properties).not.toHaveProperty('pwInto');
    expect(h.fake.destructive()).toEqual([]);
  });

  it("refuses folders and answers 404 for files Paperwork can't open", async () => {
    const { scans } = await scanInDrive();
    expect((await api('POST', `/drive/import/${scans.id}`)).status).toBe(403);
    expect((await api('POST', '/drive/import/not-picked')).status).toBe(404);
  });
});

describe('renaming a correspondent or topic', () => {
  it('renames in all documents, and explains a request it cannot take', async () => {
    const { file } = await filedDocument();
    await api('GET', '/library');

    const bad = await api<{ error: string }>('POST', '/rename', { correspondent: 'Stadtwerke Musterstadt', to: '  ' });
    expect(bad).toEqual({ status: 400, body: { error: 'Say which correspondent or topic to rename, and the new name.' } });

    const { status, body } = await api('POST', '/rename', { correspondent: 'Stadtwerke Musterstadt', to: 'SWM' });
    expect(status).toBe(200);
    expect(body).toEqual({ updated: 1, failed: 0 });
    expect(await index.get(file.id)).toMatchObject({ correspondent: 'SWM' });
    expect((await api('POST', '/rename', { correspondent: 'Nobody', to: 'Someone' })).body).toEqual({ updated: 0, failed: 0 });
  });
});

describe('topics shared across correspondents', () => {
  // Documents of the founding of a company, from the notary and the court, under two topics
  async function founding() {
    const { file } = await filedDocument();
    await api('GET', '/library');
    const court = (await index.all())[0];
    await index.put({ ...court, correspondent: 'Amtsgericht Musterstadt', topic: 'Example UG commercial register' });
    await index.put({ ...court, id: 'notary', correspondent: 'Dr. Erika Mustermann', topic: 'Example UG formation' });
    await index.put({ ...court, id: 'tax', correspondent: 'Finanzamt Musterstadt', topic: 'Income tax 2025' });
    return file;
  }

  it('suggests topics that look like one matter, asks Gemini only when new topics appeared, and forgets dismissed ones', async () => {
    await founding();
    h.suggest = vi.fn(async () => [{ topics: ['Example UG commercial register', 'Example UG formation'], to: 'Example UG formation', why: 'Founding of the company' }]);

    const first = await api<{ suggestions: unknown[] }>('GET', '/topics/suggestions');
    expect(first.body.suggestions).toEqual([{ topics: ['Example UG commercial register', 'Example UG formation'], to: 'Example UG formation', why: 'Founding of the company' }]);
    expect(vi.mocked(h.suggest).mock.calls[0][0].map(t => t.topic).sort()).toEqual(['Example UG commercial register', 'Example UG formation', 'Income tax 2025']);
    await api('GET', '/topics/suggestions');
    expect(h.suggest).toHaveBeenCalledTimes(1);

    expect((await api('POST', '/topics/suggestions/dismiss', { topics: ['Example UG formation'] })).status).toBe(400);
    const dismissed = await fetch(base + '/topics/suggestions/dismiss', {
      method: 'POST',
      headers: { cookie, 'x-paperwork': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ topics: ['Example UG formation', 'Example UG commercial register'] }),
    });
    expect(dismissed.status).toBe(204);
    expect((await api<{ suggestions: unknown[] }>('GET', '/topics/suggestions')).body.suggestions).toEqual([]);
    expect(h.suggest).toHaveBeenCalledTimes(1);
  });

  it('merges topics from different correspondents into one, in all their documents', async () => {
    const file = await founding();
    await index.remove('notary');
    await index.remove('tax');

    const bad = await api<{ error: string }>('POST', '/topics/merge', { from: [], to: 'x' });
    expect(bad).toEqual({ status: 400, body: { error: 'Say which topics to merge, and the name they get.' } });

    const { body } = await api('POST', '/topics/merge', { from: ['Example UG commercial register'], to: 'Example UG formation' });
    expect(body).toEqual({ updated: 1, failed: 0 });
    expect(await index.get(file.id)).toMatchObject({ topic: 'Example UG formation' });
    expect(h.fake.files.get(file.id)!.description).toContain('Topic: Example UG formation');

    // A topic rename reaches every correspondent's documents
    expect((await api('POST', '/rename', { topic: 'Example UG formation', to: 'Example UG founding' })).body).toEqual({ updated: 1, failed: 0 });
    expect(await index.get(file.id)).toMatchObject({ topic: 'Example UG founding' });
  });
});

describe('settings', () => {
  it('check each new document unless set otherwise, and change only what is given', async () => {
    setStoreForTests(new MemoryStore());
    expect((await api('GET', '/settings')).body).toEqual({ views: [], review: 'manual' });
    expect((await api('PUT', '/settings', { review: 'automatic' })).body).toEqual({ views: [], review: 'automatic' });
    const views = [{ id: 'v1', name: 'Taxes', filters: { categoryId: 'taxes' } }];
    expect((await api('PUT', '/settings', { views })).body).toMatchObject({ views: [{ id: 'v1', name: 'Taxes' }], review: 'automatic' });
    expect((await api('PUT', '/settings', { review: 'sometimes' })).body).toMatchObject({ review: 'automatic' });
  });
});

describe('contracts and taxes', () => {
  it('answers at once with what was read, and explains a request it cannot take', async () => {
    expect(await api<ContractsResponse>('GET', '/contracts')).toEqual({ status: 200, body: { contracts: [], pending: 0, problem: null, hidden: [] } });
    expect((await api<{ error: string }>('POST', '/contracts/hidden', { topic: 'Gym' })).status).toBe(400);
    expect((await api<ContractsResponse>('POST', '/contracts/hidden', { topic: 'Gym', hidden: true })).body.hidden).toEqual([]);

    await filedDocument();
    await api('GET', '/library');
    expect((await api<TaxResponse>('GET', '/tax/2025')).body).toEqual({ years: [2025], result: null });
    expect((await api<{ error: string }>('GET', '/tax/1066')).status).toBe(400);
    expect((await api<{ error: string }>('POST', '/tax/next/refresh')).status).toBe(400);
  });
});

describe('email', () => {
  it('saves the address and the senders, shows the address in the session, and explains a mistake', async () => {
    process.env.INBOUND_EMAIL_SECRET = 's3cret-value';
    try {
      const saved = await api<EmailSetup>('PUT', '/email', { address: 'papers@example.com', senders: ['partner@example.org'] });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ address: 'papers@example.com', secret: 's3cret-value' });
      expect(saved.body.senders).toContainEqual({ address: 'partner@example.org', fixed: false });

      const { body } = await api<SessionInfo>('GET', '/session');
      expect(body.vault?.email).toEqual({ configured: true, address: 'papers@example.com' });

      const wrong = await api<{ error: string }>('PUT', '/email', { senders: ['partner'] });
      expect(wrong).toEqual({ status: 400, body: { error: '“partner” isn\'t an email address.' } });
      expect((await api<EmailSetup>('GET', '/email')).body.senders).toContainEqual({ address: 'partner@example.org', fixed: false });
    } finally {
      delete process.env.INBOUND_EMAIL_SECRET;
    }
  });
});

describe("the file for the app's own viewer", () => {
  it('hands over PDFs as they are and Google Docs as PDF, never as a page, and nothing it cannot show', async () => {
    const { file } = await filedDocument();
    const get = (id: string) => fetch(`${base}/documents/${id}/file`, { headers: { cookie } });

    const pdf = await get(file.id);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-security-policy')).toBe('sandbox');
    expect(pdf.headers.get('content-disposition')).toMatch(/^inline; filename\*=UTF-8''/);
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');

    const folder = h.fake.files.get(file.id)!.parents[0];
    const gdoc = h.fake.add({ name: 'Notes', mimeType: 'application/vnd.google-apps.document', parents: [folder], properties: { paperwork: 'doc' } });
    const exported = await get(gdoc.id);
    expect(exported.headers.get('content-type')).toBe('application/pdf');
    expect(await exported.text()).toBe('%PDF export of Notes');

    const html = h.fake.add({ name: 'page.html', mimeType: 'text/html', parents: [folder], properties: { paperwork: 'doc' }, content: new TextEncoder().encode('<script>alert(1)</script>') });
    expect((await get(html.id)).status).toBe(415);
    const outside = h.fake.add({ name: 'private.pdf', parents: [h.fake.myDriveRoot], content: new TextEncoder().encode('%PDF-1.7') });
    expect((await get(outside.id)).status).toBe(404);
  });
});

describe('folders and files kept with a document', () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  // A file sent as the raw body, as the app sends uploads; without a type, as phones may send a Word file
  const send = (path: string, data: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { cookie, 'x-paperwork': '1', ...headers }, body: data });

  it('adds a folder right under the Paperwork folder, and explains a request it cannot take', async () => {
    await filedDocument();
    expect(await api('POST', '/folders', {})).toEqual({ status: 400, body: { error: 'Give the folder a name.' } });
    expect((await api('POST', '/folders', { name: 'Example UG', description: 5 })).status).toBe(400);
    expect(await api('POST', '/folders', { name: 'bills & receipts' })).toEqual({ status: 400, body: { error: 'There is a folder named bills & receipts already.' } });
    expect((await api('POST', '/folders', { name: 'Loans', parentId: 'somewhere' })).status).toBe(400);

    const { status, body } = await api<CategoryInfo>('POST', '/folders', { name: 'Example UG', description: 'My company: its contracts and statements.' });

    expect(status).toBe(200);
    expect(body).toMatchObject({ name: 'Example UG', description: 'My company: its contracts and statements.', count: 0 });
    expect(body.webViewLink).toBe(`https://drive.google.com/drive/folders/${body.id}`);
    expect((await api<LibraryResponse>('GET', '/library')).body.categories.map(c => c.name)).toContain('Example UG');
  });

  it('keeps a file sent without a type as the Word file its name says, and lists it with its document', async () => {
    const { file } = await filedDocument();
    expect((await send(`/documents/${file.id}/files`, new Uint8Array())).status).toBe(400);

    const res = await send(`/documents/${file.id}/files`, new TextEncoder().encode('draft'), {
      'x-file-name': encodeURIComponent('Darlehensvertrag.docx'),
      'x-file-label': encodeURIComponent('Entwurf'),
    });

    expect(res.status).toBe(200);
    const result = (await res.json()) as AttachResult;
    expect(result).toMatchObject({ status: 'kept', attachment: { documentId: file.id, label: 'Entwurf', mimeType: DOCX } });
    const kept = h.fake.files.get(result.attachment!.id)!;
    expect(kept).toMatchObject({ mimeType: DOCX, name: '2025-03-14 Stadtwerke Musterstadt - Electricity bill March - Entwurf.docx', parents: file.parents });
    expect((await api('GET', `/documents/${kept.id}`)).status).toBe(404);
    expect((await fetch(`${base}/documents/${kept.id}/file`, { headers: { cookie } })).status).toBe(404);

    // One whose document is gone is left out
    h.fake.add({ name: 'Left behind - Draft.docx', mimeType: DOCX, parents: file.parents, properties: { paperwork: 'attachment', pwOf: 'gone' } });
    const { body } = await api<LibraryResponse>('GET', '/library');
    expect(body.attachments).toEqual([result.attachment]);
    expect(body.documents.map(d => d.id)).toEqual([file.id]);
    expect(body.inbox).toEqual([]);
  });

  it('refuses a file larger than Cloud Run takes in one request, saying how large it may be', async () => {
    const { file } = await filedDocument();
    const before = h.fake.files.size;
    const large = new Uint8Array(30 * 1024 * 1024 + 1);

    for (const path of ['/upload', `/documents/${file.id}/files`]) {
      const res = await send(path, large, { 'x-file-name': 'Kontoauszug.pdf', 'content-type': 'application/pdf' });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'The file is larger than 30 MB.' });
    }
    expect(h.fake.files.size).toBe(before);
  });

  it('takes the type of an upload sent without one from its name', async () => {
    await filedDocument();
    const res = await send('/upload', new TextEncoder().encode('Kontoauszug Oktober'), { 'x-file-name': 'Kontoauszug.txt', 'content-type': 'application/octet-stream' });
    const result = (await res.json()) as UploadResult;
    expect(result.status).toBe('filed');
    expect(h.fake.files.get(result.document!.id)!.mimeType).toBe('text/plain');
  });

  it('shows the library when the kept files cannot be listed', async () => {
    const { file } = await filedDocument();
    await send(`/documents/${file.id}/files`, new TextEncoder().encode('draft'), { 'x-file-name': 'Plan.xlsx' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const drive = h.fake.fetch;
    h.fake.fetch = async (input, init) =>
      decodeURIComponent(String(input)).includes("value='attachment'") ? new Response('{}', { status: 500 }) : drive(input, init);

    const { status, body } = await api<LibraryResponse>('GET', '/library');

    expect(status).toBe(200);
    expect(body.attachments).toEqual([]);
    expect(body.documents.map(d => d.id)).toEqual([file.id]);
  });

  it('makes a document a file kept with another one, and a document of its own again', async () => {
    const { file } = await filedDocument();
    const notes = h.fake.add({ name: 'Notes.txt', mimeType: 'text/plain', parents: file.parents, ...docLabels({ ...billMeta, title: 'Notes' }, 'Notes.txt'), content: new TextEncoder().encode('notes') });
    await api('GET', '/library');

    expect(await api('POST', `/documents/${notes.id}/attach-to`, {})).toEqual({ status: 400, body: { error: 'Say which document to keep it with.' } });
    expect(await api('POST', `/documents/${notes.id}/attach-to`, { parentId: notes.id })).toEqual({ status: 400, body: { error: 'A document can’t be kept with itself.' } });
    const kept = await api<AttachResult>('POST', `/documents/${notes.id}/attach-to`, { parentId: file.id });
    expect(kept).toMatchObject({ status: 200, body: { status: 'kept', attachment: { id: notes.id, documentId: file.id } } });
    expect((await api<LibraryResponse>('GET', '/library')).body).toMatchObject({ documents: [{ id: file.id }], attachments: [{ id: notes.id }] });

    const back = await api<UploadResult>('POST', `/attachments/${notes.id}/detach`);
    expect(back).toMatchObject({ status: 200, body: { status: 'filed', document: { id: notes.id } } });
    expect((await api('POST', `/attachments/${notes.id}/detach`)).status).toBe(404);
    expect((await api<LibraryResponse>('GET', '/library')).body.attachments).toEqual([]);
  });
});

describe('possible duplicates', () => {
  it('takes the owner’s answer about a possible duplicate, and explains one it cannot take', async () => {
    const { file } = await filedDocument();
    // A photo of the bill, marked as a possible copy of it
    const meta = { ...billMeta, title: 'Electricity bill March (photo)' };
    const name = fileName(meta, { name: 'photo.jpg', mimeType: 'image/jpeg' });
    const labels = docLabels(meta, name);
    const photo = h.fake.add({ name, mimeType: 'image/jpeg', parents: file.parents, ...labels, properties: { ...labels.properties, pwMaybeDup: file.id }, content: new TextEncoder().encode('photo') });
    const library = await api<LibraryResponse>('GET', '/library');
    expect(library.body.documents.find(d => d.id === photo.id)).toMatchObject({ possibleDuplicateOf: file.id });
    expect(library.body.documents.find(d => d.id === file.id)).not.toHaveProperty('possibleDuplicateOf');

    for (const choice of [undefined, 'both', 'delete']) {
      expect(await api('POST', `/documents/${photo.id}/possible-duplicate`, { choice, of: file.id })).toEqual({ status: 400, body: { error: 'Say whether to keep both, move it to Duplicates or keep it with the original.' } });
    }
    // The original the owner was shown, so a mark moved meanwhile isn't decided unseen
    for (const of of [undefined, '', 42]) {
      expect(await api('POST', `/documents/${photo.id}/possible-duplicate`, { choice: 'keep-both', of })).toEqual({ status: 400, body: { error: 'Say which document it may be a copy of.' } });
    }
    expect(await api('POST', `/documents/${photo.id}/possible-duplicate`, { choice: 'duplicate', of: 'another' })).toEqual({
      status: 409,
      body: { error: 'Paperwork now thinks this may be a copy of another document. Compare it with that one first.', code: 'duplicate' },
    });
    expect(await api('PATCH', `/documents/${photo.id}`, { notDuplicate: 'yes' })).toEqual({ status: 400, body: { error: 'Say whether it is a copy.' } });
    expect(await api('PATCH', `/documents/${photo.id}`, { notDuplicate: true })).toEqual({ status: 400, body: { error: 'Say which document it is no copy of.' } });
    expect(await api('PATCH', `/documents/${photo.id}`, { notDuplicate: true, duplicateOf: 'another' })).toMatchObject({ status: 409, body: { code: 'duplicate' } });
    expect(h.fake.files.get(photo.id)!.properties).toMatchObject({ pwMaybeDup: file.id });
    h.fake.touch(file.id, f => (f.trashed = true));
    expect(await api('POST', `/documents/${photo.id}/possible-duplicate`, { choice: 'keep-with', of: file.id })).toEqual({
      status: 409,
      body: { error: 'The document it may be a copy of is no longer in Paperwork, so it stays a document of its own.', code: 'duplicate' },
    });
    h.fake.touch(file.id, f => (f.trashed = false));

    const kept = await api<DuplicateChoiceResult>('POST', `/documents/${photo.id}/possible-duplicate`, { choice: 'keep-both', of: file.id });
    expect(kept).toMatchObject({ status: 200, body: { choice: 'keep-both', document: { id: photo.id } } });
    expect(kept.body.document).not.toHaveProperty('possibleDuplicateOf');
    expect(kept.body.document).not.toHaveProperty('notDuplicates');
    expect(await api('POST', `/documents/${photo.id}/possible-duplicate`, { choice: 'duplicate', of: file.id })).toEqual({
      status: 409,
      body: { error: 'This document isn’t marked as a possible duplicate any more.', code: 'duplicate' },
    });
    expect((await api('POST', `/documents/nothing/possible-duplicate`, { choice: 'duplicate', of: file.id })).status).toBe(404);
  });
});

describe('folders for a matter', () => {
  const send = (path: string, data: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { cookie, 'x-paperwork': '1', ...headers }, body: data });

  // A filed document, the company's category and a folder in it, made through the API
  async function matter() {
    const { file } = await filedDocument();
    const company = (await api<CategoryInfo>('POST', '/folders', { name: 'Example UG' })).body;
    const made = await api<SubfolderInfo>('POST', '/folders', { name: 'Eröffnungsbilanz', description: 'For the tax advisor', parentId: company.id });
    return { file, company, folder: made.body, status: made.status };
  }

  it('makes a folder inside a category, lists it with its category, and explains a request it cannot take', async () => {
    const { company, folder, status } = await matter();

    expect(status).toBe(200);
    expect(folder).toEqual({ id: folder.id, name: 'Eröffnungsbilanz', path: ['Eröffnungsbilanz'], webViewLink: `https://drive.google.com/drive/folders/${folder.id}` });
    expect(company.folders).toEqual([]);
    expect(await api('POST', '/folders', { name: '2026', parentId: company.id })).toEqual({
      status: 400,
      body: { error: 'Names like 2026 are kept for year folders. Give the folder another name.' },
    });
    expect(await api('POST', '/folders', { name: 'eröffnungsbilanz', parentId: company.id })).toEqual({ status: 400, body: { error: 'There is a folder named eröffnungsbilanz already.' } });
    expect((await api('POST', '/folders', { name: 'Loans', parentId: 5 })).status).toBe(400);

    const { body } = await api<LibraryResponse>('GET', '/library');
    expect(body.categories.find(c => c.id === company.id)!.folders).toEqual([folder]);
    expect(body.categories.find(c => c.name === 'Bills & Receipts')!.folders).toEqual([]);
  });

  it('files an upload into the folder given in X-Into, and refuses one that is not for documents', async () => {
    const { company, folder } = await matter();
    const inbox = h.fake.find('Inbox')!;
    const statement = new TextEncoder().encode('Kontoauszug Oktober');
    const headers = { 'x-file-name': 'Kontoauszug.txt', 'content-type': 'text/plain' };

    for (const into of [inbox.id, 'nowhere']) {
      const refused = await send('/upload', statement, { ...headers, 'x-into': into });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'That is not a folder for documents in Paperwork.' });
    }
    expect(h.fake.childrenOf(inbox.id)).toEqual([]);

    const result = (await (await send('/upload', statement, { ...headers, 'x-into': folder.id })).json()) as UploadResult;

    expect(result).toMatchObject({ status: 'filed', document: { folderId: folder.id, categoryId: company.id, folderPath: ['Example UG', 'Eröffnungsbilanz'] } });
    expect(h.fake.files.get(result.document!.id)!.parents).toEqual([folder.id]);
  });

  it('moves a document into the folder, and explains a request it cannot take', async () => {
    const { file, company, folder } = await matter();
    await api('GET', '/library');

    expect(await api('PATCH', `/documents/${file.id}`, { folderId: 5 })).toEqual({ status: 400, body: { error: 'Say which folder to move it to.' } });
    expect(await api('PATCH', `/documents/${file.id}`, { folderId: h.fake.find('Inbox')!.id })).toEqual({
      status: 400,
      body: { error: 'That is not a folder for documents in Paperwork.' },
    });
    expect(h.fake.files.get(file.id)!.parents).not.toEqual([folder.id]);

    const { status, body } = await api<DocumentInfo>('PATCH', `/documents/${file.id}`, { folderId: folder.id });

    expect(status).toBe(200);
    expect(body).toMatchObject({ folderId: folder.id, categoryId: company.id, category: 'Example UG', folderPath: ['Example UG', 'Eröffnungsbilanz'] });
    expect(h.fake.files.get(file.id)!.parents).toEqual([folder.id]);
  });

  it('moves the documents of a topic into the folder, and explains a request it cannot take', async () => {
    const { file, company, folder } = await matter();
    const topic = 'Example UG formation';
    await api('GET', '/library');
    await api('PATCH', `/documents/${file.id}`, { topic });

    const explained = { status: 400, body: { error: 'Say which topic to move, and the folder to move it to.' } };
    for (const body of [{}, { topic }, { topic: '  ', folderId: folder.id }, { topic, folderId: 5 }, { topic: 7, folderId: folder.id }, { topic, folderId: '' }]) {
      expect(await api('POST', '/topics/move', body)).toEqual(explained);
    }
    expect(await api('POST', '/topics/move', { topic, folderId: h.fake.find('Inbox')!.id })).toEqual({
      status: 400,
      body: { error: 'That is not a folder for documents in Paperwork.' },
    });
    expect(h.fake.files.get(file.id)!.parents).not.toEqual([folder.id]);

    expect(await api('POST', '/topics/move', { topic, folderId: folder.id })).toEqual({ status: 200, body: { updated: 1, failed: 0 } });
    expect(h.fake.files.get(file.id)!.parents).toEqual([folder.id]);
    expect((await api<LibraryResponse>('GET', '/library')).body.documents).toMatchObject([{ id: file.id, folderId: folder.id, categoryId: company.id }]);
    expect((await api('POST', '/topics/move', { topic: 'Nothing like it', folderId: folder.id })).body).toEqual({ updated: 0, failed: 0 });
  });

  it('saves a view of a folder', async () => {
    const views = [{ id: 'v1', name: 'Eröffnungsbilanz', filters: { folderId: 'folder-1', categoryId: 7 } }];
    expect((await api<Settings>('PUT', '/settings', { views })).body.views).toEqual([{ id: 'v1', name: 'Eröffnungsbilanz', filters: { folderId: 'folder-1' } }]);
  });
});
