// Finance's read-only feed (finance.ts): what Finance gets of the contracts and receipts, field by field and masked,
// what it never gets, and that answering it never calls Gemini, Drive or Google (their modules throw here). The IAP
// gate in front of it is iap.test.ts's; here a stand-in says who is asking.
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexedDoc } from './docIndex.js';

const h = vi.hoisted(() => {
  const called: string[] = [];
  // The module as it is, but each of its functions (a lower-case name) throws and is noted; its classes stay, so
  // `instanceof LimitError` still works
  const throwing = async (name: string, importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    return Object.fromEntries(
      Object.entries(actual).map(([key, value]) => [
        key,
        typeof value === 'function' && /^[a-z]/.test(key)
          ? () => {
              called.push(`${name}.${key}`);
              throw new Error(`${name}.${key} must not be called by the feed`);
            }
          : value,
      ])
    );
  };
  return { called, throwing };
});

vi.mock('./gemini.js', importOriginal => h.throwing('gemini', importOriginal));
vi.mock('./google.js', importOriginal => h.throwing('google', importOriginal));
vi.mock('./drive.js', importOriginal => h.throwing('drive', importOriginal));

const { DocIndex, MemoryIndexBackend, setIndexForTests } = await import('./docIndex.js');
const { MemoryStore, setStoreForTests } = await import('./store.js');
const { indexedDoc } = await import('./testing/fixtures.js');
const { contracts, setHidden } = await import('./contracts.js');
const { HEALTH_PARTS, capped, financeRouter, isHealth, maskNumbers } = await import('./finance.js');
type Terms = import('./contracts.js').Terms;

const APP = 'https://paperwork-app-123456789012.europe-west3.run.app';
const IBAN = 'DE89 3704 0044 0532 0130 00';
const IBAN_PLAIN = 'DE89370400440532013000';
const CARD = '4111 1111 1111 1111';
const CAR = 'Car insurance VW Golf';
const GYM = 'Gym membership';
const HIDDEN = 'Old phone contract';
const ACCOUNT_TOPIC = `Current account ${IBAN_PLAIN}`;

const terms = (overrides: Partial<Terms> = {}): Terms => ({
  name: 'Comprehensive car insurance VW Golf',
  kind: 'insurance',
  provider: 'Allianz',
  reference: `KH-4471-2290, paid from ${IBAN}`,
  amount: 642.18,
  currency: 'EUR',
  interval: 'year',
  since: '2021-12-01',
  renewal: 'year',
  renews: '2027-01-01',
  notice: '1 month before the end of the insurance year',
  noticePeriod: { count: 1, unit: 'month' },
  cancelBy: null,
  status: 'active',
  endsOn: null,
  latest: `Premium for 2027 rises to 642.18 EUR, debited from ${IBAN_PLAIN}`,
  documentIds: ['car-policy'],
  ...overrides,
});

// Every field a document may carry, so that anything not mapped would show
const full = (id: string, overrides: Partial<IndexedDoc>) =>
  indexedDoc(id, {
    summary: 'The whole summary of the document',
    tags: ['tag'],
    action: 'Pay by Friday',
    gist: 'What changed',
    deadlines: [{ date: '2026-12-01', what: 'Pay', done: false }],
    textSource: 'pdf',
    textLength: 900,
    ...overrides,
  });

let index: InstanceType<typeof DocIndex>;
let store: InstanceType<typeof MemoryStore>;
let logged: Record<string, unknown>[];

async function library() {
  // A contract with its policy, a premium letter and a statement naming an IBAN
  await index.put(full('car-policy', { topic: CAR, type: 'policy', correspondent: 'Allianz', title: 'Car insurance policy', date: '2021-11-02', references: 'Policy: KH-4471-2290 · Customer: 88123', needsReview: false }));
  await index.put(full('car-2026', { topic: CAR, type: 'letter', correspondent: 'Allianz', title: `Premium 2027 from ${IBAN}`, date: '2026-10-08', amount: 642.18, currency: 'EUR', references: `Policy: KH-4471-2290 ·  Customer: 88123 · IBAN: ${IBAN} · Card: ${CARD}`, needsReview: true }));
  // A membership with many documents: the feed lists 20
  for (let i = 1; i <= 25; i++) {
    const day = String(i).padStart(2, '0');
    await index.put(full(`gym-${day}`, { topic: GYM, type: 'invoice', correspondent: 'FitX', title: `Membership fee ${day}`, date: `2026-01-${day}`, amount: 24.99, currency: 'EUR', references: `Member: 7781 · Invoice: ${day}` }));
  }
  // A contract the owner hid in Paperwork, and a topic named after an account
  await index.put(full('phone-1', { topic: HIDDEN, type: 'contract', correspondent: 'Telekom', title: 'Phone contract', date: '2020-05-01' }));
  await index.put(full('account-1', { topic: ACCOUNT_TOPIC, type: 'statement', correspondent: 'ING', title: 'Account fees', date: '2026-09-30' }));
  // No contract
  await index.put(full('tax-1', { topic: 'Income tax 2025', type: 'tax', correspondent: 'Finanzamt Musterstadt', date: '2026-09-18' }));
  await store.set('contracts', {
    version: 1,
    topics: [
      { topic: CAR, hash: 'old', terms: terms() },
      { topic: GYM, hash: 'old', terms: terms({ name: 'FitX membership', kind: 'membership', provider: 'FitX', reference: 'Member 7781', amount: 24.99, interval: 'month', renewal: 'month', renews: '2026-12-01', noticePeriod: null, notice: null, latest: null, documentIds: ['gym-03', 'gym-01'] }) },
      { topic: HIDDEN, hash: 'old', terms: terms({ name: 'Phone', kind: 'telecom', provider: 'Telekom', reference: 'T-1', documentIds: ['phone-1'] }) },
      { topic: ACCOUNT_TOPIC, hash: 'old', terms: terms({ name: `Account ${IBAN_PLAIN}`, kind: 'finance', provider: 'ING', reference: null, amount: 4.9, interval: 'month', noticePeriod: { count: 2, unit: 'week' }, documentIds: [] }) },
      { topic: 'Income tax 2025', hash: 'old', terms: null },
    ],
  });
  await setHidden(HIDDEN, true);
}

const item = (name: string, price: number | null, extra: Partial<{ details: string | null; quantity: number; code: string | null }> = {}) => ({ name, details: null, quantity: 1, price, code: null, ...extra });

async function receipts() {
  await index.put(full('shop', { type: 'receipt', correspondent: 'Globetrotter', title: 'Hiking pants', date: '2026-10-01', amount: 199.9, currency: 'EUR', items: [item('Norrøna Falketind pants', 179.9, { details: 'Size M', code: '7090' }), item('Socks', 20)] }));
  await index.put(full('shop-copy', { type: 'receipt', correspondent: 'Globetrotter', title: 'Hiking pants (photo)', date: '2026-10-01', amount: 199.9, currency: 'EUR', items: [item('Norrøna Falketind pants', 179.9)], possibleDuplicateOf: 'shop' }));
  await index.put(full('pfand', { type: 'receipt', correspondent: 'REWE', title: 'Groceries', date: '2026-09-20', amount: 12.5, currency: 'EUR', items: [item('Water', 3.5), item('Bread', 2.99)] }));
  await index.put(full('no-price', { type: 'invoice', correspondent: 'Amazon', title: `Order paid with ${CARD}`, date: '2026-09-15', amount: 30, currency: 'EUR', items: [item('Cable', null), item('Charger', 30)] }));
  await index.put(full('no-total', { type: 'receipt', correspondent: 'Bakery', title: 'Bakery', date: '2026-09-10', amount: null, items: [item('Pretzel', 1.2)] }));
  await index.put(full('till', { type: 'receipt', correspondent: 'Kiosk', title: 'Kiosk', date: '2026-09-05', amount: 2.5, currency: 'EUR', items: [] }));
  await index.put(full('pharmacy', { type: 'receipt', correspondent: 'Löwen-Apotheke', category: 'Rechnungen & Belege', folderPath: ['Rechnungen & Belege', '2026'], title: 'Ibuprofen and nasal spray', date: '2026-08-30', amount: 11.48, currency: 'EUR', items: [item('Ibuprofen 400', 5.99, { details: '20 Stück', quantity: 1, code: 'PZN-01234567' }), item('Nasenspray', 5.49, { quantity: 1, code: 'PZN-07654321' })] }));
  await index.put(full('doctor', { type: 'invoice', correspondent: 'Hausarztpraxis Dr. Weber', category: 'Bills & Receipts', title: 'Invoice Dr. Weber, blood test', date: '2026-08-20', amount: 45, currency: 'EUR', items: [item('Blood test', 45, { details: 'GOÄ 3550' })] }));
  await index.put(full('optician', { type: 'invoice', correspondent: 'Fielmann', category: 'Gesundheit', folderPath: ['Gesundheit', '2026'], title: 'Glasses', date: '2026-08-10', amount: 120, currency: 'EUR', items: [item('Varifocal lenses', 120)] }));
  await index.put(full('clinic', { type: 'medical', correspondent: 'Klinikum', title: 'Discharge note with bill', date: '2026-08-05', amount: 10, currency: 'EUR', items: [item('Daily charge', 10)] }));
  await index.put(full('surgery-supplies', { type: 'invoice', correspondent: 'Praxisbedarf Müller GmbH', title: 'Paper towels', date: '2026-08-01', amount: 15, currency: 'EUR', items: [item('Paper towels', 15, { details: '12 rolls', code: '4006381333931' })] }));
  // Not receipts: no items and another type
  await index.put(full('letter', { type: 'letter', correspondent: 'Stadtwerke', title: 'Letter', date: '2026-09-01', amount: 80 }));
  await index.put(full('payslip', { type: 'payslip', correspondent: 'Employer', title: 'Payslip August', date: '2026-08-31', amount: 3000 }));
  await index.put(full('record', { type: 'medical', correspondent: 'Dr. Weber', title: 'Blood test results', date: '2026-08-21' }));
  // Before the range asked for
  await index.put(full('old', { type: 'receipt', correspondent: 'Old shop', title: 'Old', date: '2025-01-01', amount: 5, currency: 'EUR', items: [item('Thing', 5)] }));
}

let server: Server;
let base: string;
const savedAppUrl = process.env.APP_URL;

beforeAll(async () => {
  process.env.APP_URL = APP;
  const app = express();
  // Stands in for iap.ts: the principal the gate would have set (none, owner, relay or finance)
  app.use((req, res, next) => {
    const principal = req.get('x-principal') ?? 'finance';
    if (principal !== 'none') res.locals.iap = { email: 'someone@example.com', sub: '1', principal };
    next();
  });
  app.use('/internal/finance', financeRouter);
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
  await new Promise(resolve => server.close(resolve));
});

beforeEach(async () => {
  store = new MemoryStore();
  setStoreForTests(store);
  index = new DocIndex(new MemoryIndexBackend());
  setIndexForTests(index);
  h.called.length = 0;
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logged.push(JSON.parse(line)));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await library();
  await receipts();
});

async function get(pathAndQuery: string, principal = 'finance') {
  const res = await fetch(`${base}/internal/finance${pathAndQuery}`, { headers: { 'x-principal': principal } });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
}

type Body = Record<string, any>;
const contractsBody = async () => (await get('/contracts')).body as Body;
const purchasesBody = async (query = '?since=2026-01-01&until=2026-10-31') => (await get(`/purchases${query}`)).body as Body;
const contractOf = (body: Body, topic: string) => body.contracts.find((c: Body) => c.key === crypto.createHash('sha1').update(topic).digest('hex').slice(0, 16));
const receiptOf = (body: Body, id: string) => body.receipts.find((r: Body) => r.id === id);

// Every key anywhere in a value
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(v => keysOf(v, out));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      out.add(key);
      keysOf(inner, out);
    }
  }
  return out;
}

describe('what Finance gets, field by field', () => {
  it('a contract, its documents, a receipt and an item carry exactly these keys', async () => {
    const feed = await contractsBody();
    expect(Object.keys(feed).sort()).toEqual(['contracts', 'pending', 'problem', 'today', 'version']);
    expect(Object.keys(feed.contracts[0]).sort()).toEqual(
      ['amount', 'cancelBy', 'currency', 'documents', 'endsOn', 'interval', 'key', 'kind', 'latest', 'name', 'notice', 'noticePeriod', 'provider', 'reference', 'references', 'renewal', 'renews', 'since', 'status', 'topic', 'url', 'yearly'].sort()
    );
    expect(Object.keys(feed.contracts[0].documents[0]).sort()).toEqual(['amount', 'checked', 'currency', 'date', 'id', 'title', 'type', 'url']);
    const purchases = await purchasesBody();
    expect(Object.keys(purchases).sort()).toEqual(['receipts', 'since', 'today', 'until', 'version']);
    expect(Object.keys(receiptOf(purchases, 'shop')).sort()).toEqual(['capped', 'checked', 'currency', 'date', 'id', 'items', 'modifiedAt', 'store', 'title', 'total', 'type', 'url']);
    expect(Object.keys(receiptOf(purchases, 'shop').items[0]).sort()).toEqual(['code', 'details', 'line', 'name', 'price', 'quantity']);
  });

  it('nothing of the documents’ text, summary, links, folders, tags, actions, gists or deadlines, anywhere', async () => {
    const forbidden = ['summary', 'text', 'webViewLink', 'folderPath', 'folderId', 'category', 'categoryId', 'tags', 'action', 'gist', 'deadlines', 'correspondent', 'documentIds', 'hidden', 'name'];
    const contractKeys = keysOf(await contractsBody());
    // A contract has a name; nothing else does
    for (const key of forbidden.filter(k => k !== 'name')) expect(contractKeys.has(key), key).toBe(false);
    expect(contractKeys.has('items')).toBe(false);
    const receiptKeys = keysOf((await purchasesBody()).receipts);
    for (const key of forbidden.filter(k => k !== 'name')) expect(receiptKeys.has(key), key).toBe(false);
    const raw = JSON.stringify(await contractsBody()) + JSON.stringify(await purchasesBody());
    expect(raw).not.toContain('The whole summary');
    expect(raw).not.toContain('drive.google.com');
    expect(raw).not.toContain('Pay by Friday');
  });

  it('the contracts as Paperwork last read them, in its order, with today and how many topics wait', async () => {
    const feed = await contractsBody();
    const listed = await contracts(false);
    expect(feed.version).toBe(1);
    expect(feed.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(feed.pending).toBe(listed.pending);
    expect(feed.problem).toBeNull();
    expect(feed.contracts.map((c: Body) => c.name)).toEqual(listed.contracts.map(c => maskNumbers(c.name)));
    expect(feed.contracts).toHaveLength(3);
  });

  it('a contract’s terms as they are, its notice period as a number and a unit, its key from its topic', async () => {
    const car = contractOf(await contractsBody(), CAR);
    expect(car).toMatchObject({
      topic: CAR,
      name: 'Comprehensive car insurance VW Golf',
      kind: 'insurance',
      provider: 'Allianz',
      amount: 642.18,
      currency: 'EUR',
      interval: 'year',
      yearly: 642.18,
      since: '2021-12-01',
      renewal: 'year',
      notice: '1 month before the end of the insurance year',
      noticePeriod: { count: 1, unit: 'month' },
      status: 'active',
      endsOn: null,
    });
    expect(car.key).toBe(crypto.createHash('sha1').update(CAR).digest('hex').slice(0, 16));
    expect(car.key).toMatch(/^[0-9a-f]{16}$/);
    expect(contractOf(await contractsBody(), GYM).noticePeriod).toBeNull();
    expect(contractOf(await contractsBody(), ACCOUNT_TOPIC).noticePeriod).toEqual({ count: 2, unit: 'week' });
  });

  it('links into Paperwork: the topic’s page and each document', async () => {
    const car = contractOf(await contractsBody(), CAR);
    expect(car.url).toBe(`${APP}/topics/Car%20insurance%20VW%20Golf`);
    expect(car.documents.map((d: Body) => d.url)).toEqual([`${APP}/?doc=car-policy`, `${APP}/?doc=car-2026`]);
  });

  it('the documents the terms come from first, then the newest, at most 20; checked unless waiting for review', async () => {
    const feed = await contractsBody();
    const gym = contractOf(feed, GYM);
    expect(gym.documents).toHaveLength(20);
    expect(gym.documents.slice(0, 4).map((d: Body) => d.id)).toEqual(['gym-03', 'gym-01', 'gym-25', 'gym-24']);
    expect(gym.documents[0]).toEqual({ id: 'gym-03', title: 'Membership fee 03', date: '2026-01-03', type: 'invoice', amount: 24.99, currency: 'EUR', checked: true, url: `${APP}/?doc=gym-03` });
    const car = contractOf(feed, CAR);
    expect(car.documents.map((d: Body) => [d.id, d.checked])).toEqual([
      ['car-policy', true],
      ['car-2026', false],
    ]);
  });

  it('the reference numbers of the topic’s documents, split, trimmed and once each', async () => {
    const car = contractOf(await contractsBody(), CAR);
    expect(car.references).toEqual(['Policy: KH-4471-2290', 'Customer: 88123', 'IBAN: DE89 … 3000', 'Card: •••• 1111']);
    const gym = contractOf(await contractsBody(), GYM);
    // From the newest 20 documents, at most 30
    expect(gym.references[0]).toBe('Member: 7781');
    expect(gym.references).toHaveLength(21);
    expect(gym.references).not.toContain('Invoice: 01');
  });

  it('at most 30 references of at most 120 characters', async () => {
    await index.put(full('long', { topic: CAR, type: 'letter', date: '2026-10-09', references: [...Array.from({ length: 40 }, (_, i) => `Ref: ${i}`), `Note: ${'x'.repeat(300)}`].join(' · ') }));
    const car = contractOf(await contractsBody(), CAR);
    expect(car.references).toHaveLength(30);
    expect(Math.max(...car.references.map((r: string) => r.length))).toBeLessThanOrEqual(120);
  });

  it('leaves out a topic the owner hid in Paperwork, with its documents, and topics that are no contracts', async () => {
    const raw = JSON.stringify(await contractsBody());
    expect(raw).not.toContain(HIDDEN);
    expect(raw).not.toContain('phone-1');
    expect(raw).not.toContain('Telekom');
    expect(raw).not.toContain('Income tax');
  });
});

describe('numbers that look like an IBAN or a card', () => {
  it('an IBAN, written together or in groups of four, keeps its first four and last four characters', () => {
    expect(maskNumbers(IBAN)).toBe('DE89 … 3000');
    expect(maskNumbers(IBAN_PLAIN)).toBe('DE89 … 3000');
    expect(maskNumbers(`Paid from ${IBAN}, thank you`)).toBe('Paid from DE89 … 3000, thank you');
    expect(maskNumbers('IBAN: AT61 1904 3002 3457 3201')).toBe('IBAN: AT61 … 3201');
    expect(maskNumbers('GB29NWBK60161331926819 and DE89370400440532013000')).toBe('GB29 … 6819 and DE89 … 3000');
    // A mistyped one too (no checksum test)
    expect(maskNumbers('DE00 3704 0044 0532 0130 00')).toBe('DE00 … 3000');
  });

  it('whatever space separates the groups: a no-break, narrow or thin one, as text from a PDF may hold', () => {
    for (const space of [' ', ' ', ' ', ' ']) {
      expect(maskNumbers(['DE89', '3704', '0044', '0532', '0130', '00'].join(space)), JSON.stringify(space)).toBe('DE89 … 3000');
      expect(maskNumbers(`IBAN: ${['AT61', '1904', '3002', '3457', '3201'].join(space)}, thank you`), JSON.stringify(space)).toBe('IBAN: AT61 … 3201, thank you');
      expect(maskNumbers(`Card ${['4111', '1111', '1111', '1111'].join(space)} charged`), JSON.stringify(space)).toBe('Card •••• 1111 charged');
    }
  });

  it('however many spaces, tabs or line breaks separate the groups, as a pasted or laid-out text may hold', () => {
    for (const space of ['  ', '\t', ' \t ', '\n', '\r\n', '\u00a0 ', '\u2003']) {
      const label = JSON.stringify(space);
      expect(maskNumbers(`IBAN: ${['DE89', '3704', '0044', '0532', '0130', '00'].join(space)}`), label).toBe('IBAN: DE89 … 3000');
      expect(maskNumbers(`Card ${['4111', '1111', '1111', '1111'].join(space)} charged`), label).toBe('Card •••• 1111 charged');
      expect(maskNumbers(`IBAN DE89${space}37040044${space}0532013000, Commerzbank`), label).toBe('IBAN DE89 … 3000, Commerzbank');
    }
    // A line break inside the number masks all of it, not only up to the break
    expect(maskNumbers('IBAN: DE89 3704 0044\n0532 0130 00')).toBe('IBAN: DE89 … 3000');
    // Words and short numbers still stay, also across a line break
    expect(maskNumbers('Tarif XL12\n3456 Komfort')).toBe('Tarif XL12\n3456 Komfort');
    expect(maskNumbers('KW45  2026')).toBe('KW45  2026');
  });

  it('gives up at once on a long run of digits that ends in a letter', () => {
    const started = performance.now();
    expect(maskNumbers(`DE89${'1'.repeat(28)}x`)).toBe(`DE89${'1'.repeat(28)}x`);
    // Grouped by three, so only the digits-only rule can take it: everything up to the last whole group is masked
    expect(maskNumbers(`${['DE89', ...Array(14).fill('123')].join(' ')}x`)).toBe('DE89 … 3123 123x');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('a German IBAN whose digits are grouped otherwise than by four', () => {
    expect(maskNumbers('IBAN DE89 37040044 0532013000')).toBe('IBAN DE89 … 3000');
    expect(maskNumbers('IBAN DE893704 0044 0532 0130 00, Commerzbank')).toBe('IBAN DE89 … 3000, Commerzbank');
    expect(maskNumbers('DE89 370 400 440 532 013 000')).toBe('DE89 … 3000');
    // Too few digits for one, or words after it: as they are
    expect(maskNumbers('Tarif XL12 3456 Komfort')).toBe('Tarif XL12 3456 Komfort');
    expect(maskNumbers('KW45 2026')).toBe('KW45 2026');
  });

  it('a card number that passes the Luhn check shows its last four digits only', () => {
    expect(maskNumbers(CARD)).toBe('•••• 1111');
    expect(maskNumbers('Card 4111-1111-1111-1111 charged')).toBe('Card •••• 1111 charged');
    expect(maskNumbers('Visa 4012888888881881 on 2026-10-01')).toBe('Visa •••• 1881 on 2026-10-01');
    expect(maskNumbers('5555 5555 5555 4444 2026')).toBe('•••• 4444 2026');
  });

  it('keeps contract numbers, dates and words that only look a little like one', () => {
    expect(maskNumbers('Policy 123456789012')).toBe('Policy 123456789012');
    // 16 digits that fail the Luhn check
    expect(maskNumbers('Contract 1234 5678 9012 3456')).toBe('Contract 1234 5678 9012 3456');
    expect(maskNumbers('KH-4471-2290 from 2026-10-01')).toBe('KH-4471-2290 from 2026-10-01');
    // Case-sensitive and grouped by four: words after something like "ab01" stay
    expect(maskNumbers('gilt ab01 Januar bis zum Monatsende')).toBe('gilt ab01 Januar bis zum Monatsende');
    expect(maskNumbers('Tarif XL12 Komfort plus Familie')).toBe('Tarif XL12 Komfort plus Familie');
  });

  it('are masked in the feed: reference, references, latest, titles and the topic, whose link then is the Contracts page', async () => {
    const feed = await contractsBody();
    const car = contractOf(feed, CAR);
    expect(car.reference).toBe('KH-4471-2290, paid from DE89 … 3000');
    expect(car.latest).toBe('Premium for 2027 rises to 642.18 EUR, debited from DE89 … 3000');
    expect(car.documents[1].title).toBe('Premium 2027 from DE89 … 3000');
    const account = contractOf(feed, ACCOUNT_TOPIC);
    expect(account.topic).toBe('Current account DE89 … 3000');
    expect(account.name).toBe('Account DE89 … 3000');
    expect(account.url).toBe(`${APP}/contracts`);
    const raw = JSON.stringify(feed) + JSON.stringify(await purchasesBody());
    for (const clear of [IBAN, IBAN_PLAIN, '3704', '0532', CARD, '4111111111111111']) expect(raw, clear).not.toContain(clear);
  });
});

describe('the receipts', () => {
  it('only receipts and documents with items, no possible copies, in the range asked, newest first', async () => {
    const feed = await purchasesBody();
    expect(feed).toMatchObject({ version: 1, since: '2026-01-01', until: '2026-10-31' });
    expect(feed.receipts.map((r: Body) => r.id)).toEqual(['shop', 'pfand', 'no-price', 'no-total', 'till', 'pharmacy', 'doctor', 'optician', 'clinic', 'surgery-supplies']);
  });

  it('until is today unless given', async () => {
    const feed = await purchasesBody('?since=2026-01-01');
    expect(feed.until).toBe(feed.today);
  });

  it('a receipt with its store, total, date, check and its items with their lines on the receipt', async () => {
    const shop = receiptOf(await purchasesBody(), 'shop');
    expect(shop).toEqual({
      id: 'shop',
      url: `${APP}/?doc=shop`,
      title: 'Hiking pants',
      store: 'Globetrotter',
      date: '2026-10-01',
      type: 'receipt',
      total: 199.9,
      currency: 'EUR',
      checked: true,
      modifiedAt: '2026-10-16T08:00:00.000Z',
      capped: false,
      items: [
        { line: 0, name: 'Norrøna Falketind pants', details: 'Size M', quantity: 1, price: 179.9, code: '7090' },
        { line: 1, name: 'Socks', details: null, quantity: 1, price: 20, code: null },
      ],
    });
    expect(receiptOf(await purchasesBody(), 'no-price').title).toBe('Order paid with •••• 1111');
  });

  it('capped when the items don’t add up to the total: a deposit left out, a price unknown, no total', async () => {
    const feed = await purchasesBody();
    expect(receiptOf(feed, 'shop').capped).toBe(false);
    expect(receiptOf(feed, 'pfand').capped).toBe(true);
    expect(receiptOf(feed, 'no-price').capped).toBe(true);
    expect(receiptOf(feed, 'no-total').capped).toBe(true);
    expect(receiptOf(feed, 'till').capped).toBe(true);
    // Within a cent of the total counts as adding up
    expect(capped(indexedDoc('x', { amount: 0.3, items: [item('a', 0.1), item('b', 0.2)] }))).toBe(false);
  });

  it('health receipts come without title, item names, details and codes; amounts, store and quantities stay', async () => {
    const feed = await purchasesBody();
    for (const id of ['pharmacy', 'doctor', 'optician', 'clinic']) {
      const receipt = receiptOf(feed, id);
      expect(receipt.title, id).toBeNull();
      for (const i of receipt.items) expect([i.name, i.details, i.code], id).toEqual([null, null, null]);
    }
    const pharmacy = receiptOf(feed, 'pharmacy');
    expect(pharmacy).toMatchObject({ store: 'Löwen-Apotheke', total: 11.48, date: '2026-08-30' });
    expect(pharmacy.items).toEqual([
      { line: 0, name: null, details: null, quantity: 1, price: 5.99, code: null },
      { line: 1, name: null, details: null, quantity: 1, price: 5.49, code: null },
    ]);
    const raw = JSON.stringify(feed);
    for (const word of ['Ibuprofen', 'Nasenspray', 'PZN', 'blood test', 'Blood test', 'GOÄ', 'Varifocal', 'Discharge', 'Daily charge']) expect(raw, word).not.toContain(word);
  });

  it('a store is a health store by parts of its words, “Praxis” only as a whole word', async () => {
    expect(receiptOf(await purchasesBody(), 'surgery-supplies')).toMatchObject({ title: 'Paper towels', items: [{ name: 'Paper towels', details: '12 rolls', code: '4006381333931' }] });
    const store = (correspondent: string) => isHealth(indexedDoc('x', { type: 'receipt', correspondent }));
    for (const health of ['Löwen-Apotheke', 'Shop-Apotheke', 'DocMorris', 'Zahnarzt Dr. Kaya', 'Hausarztpraxis Dr. Weber', 'Augenoptik Schmidt', 'Physiotherapiepraxis Lang', 'Praxis Dr. Ott', 'MVZ am Markt', 'Sanitätshaus Meyer', 'Orthopädie-Technik', 'Hörakustik Klein']) {
      expect(store(health), health).toBe(true);
    }
    for (const other of ['Praxisbedarf Müller GmbH', 'REWE', 'Globetrotter', 'Laborbedarf Versand']) expect(store(other), other).toBe(false);
    expect(HEALTH_PARTS).toContain('apothek');
    // By the Health folder, in either language, and by type
    expect(isHealth(indexedDoc('x', { category: 'Health', folderPath: ['Health', '2026'] }))).toBe(true);
    expect(isHealth(indexedDoc('x', { category: null, folderPath: ['gesundheit'] }))).toBe(true);
    expect(isHealth(indexedDoc('x', { type: 'medical', correspondent: 'Anyone' }))).toBe(true);
  });

  it('asked for exactly since (a day), optionally until (a day, not before since), at most 400 days apart', async () => {
    for (const query of [
      '',
      '?until=2026-10-01',
      '?since=2026-1-01',
      '?since=2026-02-30',
      '?since=yesterday',
      '?since=2026-10-01&until=2026-09-30',
      // 401 days
      '?since=2025-01-01&until=2026-02-06',
      '?since=2026-01-01&limit=5',
      '?since=2026-01-01&since=2026-02-01',
      '?since=2026-01-01&until=2026-02-01&until=2026-03-01',
      '?since=',
    ]) {
      const res = await get(`/purchases${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body, query).toEqual({ error: 'bad-request' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    // 400 days
    expect((await get('/purchases?since=2025-01-01&until=2026-02-05')).status).toBe(200);
    // The contracts take no query at all
    expect((await get('/contracts?all=1')).status).toBe(400);
  });
});

describe('what answering it may and may not do', () => {
  it('never calls Gemini, Drive or Google, and never has Paperwork read topics again', async () => {
    await contractsBody();
    await purchasesBody();
    expect(h.called).toEqual([]);
    // Each topic still waits as before: contracts(true) would have read them (and called Gemini, which throws)
    expect((await contractsBody()).pending).toBe((await contracts(false)).pending);
    expect(h.called).toEqual([]);
  });

  it('503 with Retry-After while Paperwork’s index is empty', async () => {
    setIndexForTests(new DocIndex(new MemoryIndexBackend()));
    for (const route of ['/contracts', '/purchases?since=2026-01-01']) {
      const res = await get(route);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('30');
      expect(res.body).toEqual({ error: 'index-empty' });
    }
  });

  it('a plain 500 when reading fails, logged by the error’s name, never its message', async () => {
    class Failing extends MemoryStore {
      override async get<T>(): Promise<T | null> {
        throw new TypeError('Allianz KH-4471-2290 could not be read');
      }
    }
    setStoreForTests(new Failing());
    const res = await get('/contracts');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'failed' });
    expect(logged).toContainEqual({ severity: 'ERROR', message: 'Finance feed failed', error: 'TypeError' });
    expect(JSON.stringify(logged)).not.toContain('Allianz');
  });

  it('checks the principal itself, before anything else: the owner, the relay or nobody is refused', async () => {
    for (const principal of ['owner', 'relay', 'none']) {
      const res = await get('/contracts', principal);
      expect(res.status, principal).toBe(403);
      expect(res.text).toBe('Forbidden');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('answers 404 to anything else under it, and nothing may be cached', async () => {
    for (const route of ['/other', '/contracts/', '/Contracts', '/']) {
      const res = await get(route);
      expect(res.status, route).toBe(404);
      expect(res.text).toBe('');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect((await get('/contracts')).headers.get('cache-control')).toBe('no-store');
    expect((await get('/purchases?since=2026-01-01')).headers.get('cache-control')).toBe('no-store');
  });

  it('logs one line per request: which path, the status, how many and how long, nothing of what', async () => {
    await get('/contracts');
    await get('/purchases?since=2026-01-01&until=2026-10-31');
    await get('/purchases');
    const served = logged.filter(l => l.message === 'Finance feed served');
    expect(served.map(l => [l.path, l.status, l.count])).toEqual([
      ['/internal/finance/contracts', 200, 3],
      ['/internal/finance/purchases', 200, 10],
      ['/internal/finance/purchases', 400, 0],
    ]);
    expect(served.every(l => typeof l.ms === 'number')).toBe(true);
    const raw = JSON.stringify(logged);
    for (const word of ['Allianz', 'Globetrotter', 'DE89', '2026-01-01']) expect(raw, word).not.toContain(word);
  });

  it('imports nothing that reaches Google: not google.ts, drive.ts or gemini.ts', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'finance.ts'), 'utf8');
    for (const module of ['./google.js', './drive.js', './gemini.js', './vault.js', './oauth.js']) expect(source).not.toContain(`from '${module}'`);
    // Never a whole DocumentInfo or Contract passed on
    expect(source).not.toMatch(/\.\.\.(d|doc|c|contract|info)\b/);
  });
});
