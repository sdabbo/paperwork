import { describe, expect, it } from 'vitest';
import { activeFilters, applyFilters, deadlineItems, facets, fold, heldBack, localToday, possibleCopies, shiftMonths, upcoming } from './filter';
import { DocumentInfo } from './types';

const doc = (over: Partial<DocumentInfo>): DocumentInfo => ({
  id: 'x',
  name: 'x.pdf',
  title: 'Untitled',
  mimeType: 'application/pdf',
  categoryId: 'bills',
  category: 'Bills & Receipts',
  folderPath: ['Bills & Receipts', '2025'],
  folderId: 'y2025',
  type: 'invoice',
  correspondent: null,
  date: null,
  amount: null,
  currency: null,
  dueDate: null,
  deadlines: [],
  items: [],
  tags: [],
  references: null,
  action: null,
  summary: '',
  topic: null,
  gist: null,
  needsReview: false,
  inInbox: false,
  starred: false,
  source: 'drive',
  textSource: null,
  textLength: 0,
  addedAt: '2026-01-01T10:00:00Z',
  modifiedAt: '2026-01-01T10:00:00Z',
  size: 1000,
  webViewLink: '',
  hasThumbnail: false,
  ...over,
});

const docs = [
  doc({
    id: 'power',
    title: 'Electricity bill',
    correspondent: 'Stadtwerke Musterstadt',
    date: '2025-03-14',
    amount: 87.45,
    tags: ['electricity'],
    dueDate: '2026-10-20',
    deadlines: [{ date: '2026-10-20', what: 'Pay the bill', done: false }],
  }),
  doc({
    id: 'car',
    title: 'Car insurance policy',
    correspondent: 'Allianz',
    categoryId: 'ins',
    category: 'Insurance',
    type: 'policy',
    date: '2024-11-02',
    starred: true,
    summary: 'Renews every January',
    deadlines: [
      { date: '2026-09-25', what: 'Premium due', done: true },
      { date: '2026-10-05', what: 'Send the mileage', done: false },
      { date: '2026-11-30', what: 'Cancellation deadline', done: false },
      { date: '2027-01-01', what: 'Renews', done: false },
    ],
  }),
  doc({ id: 'pay', title: 'Payslip', correspondent: 'ACME', type: 'payslip', date: null, addedAt: '2026-10-01T09:00:00Z', needsReview: true }),
];

describe('filters', () => {
  it('search across title, sender, summary and tags, ignoring accents and case', () => {
    expect(applyFilters(docs, { query: 'musterstadt' }).map(d => d.id)).toEqual(['power']);
    expect(applyFilters(docs, { query: 'renews january' }).map(d => d.id)).toEqual(['car']);
    expect(applyFilters(docs, { query: '87.45' }).map(d => d.id)).toEqual(['power']);
  });

  it('include what the server found inside the files, best match first, then the other matches in order', () => {
    expect(applyFilters(docs, { query: 'IBAN' }, ['pay']).map(d => d.id)).toEqual(['pay']);
    // "insurance" matches the car policy's folder here; the server ranked the payslip and the bill above it
    expect(applyFilters(docs, { query: 'insurance' }, ['power', 'pay']).map(d => d.id)).toEqual(['power', 'pay', 'car']);
    // Matches of the server still have to pass the other filters
    expect(applyFilters(docs, { query: 'insurance', starred: true }, ['power', 'pay']).map(d => d.id)).toEqual(['car']);
    // Without a query, the server's matches (from an earlier one) don't count
    expect(applyFilters(docs, {}, ['car']).map(d => d.id)).toEqual(['pay', 'power', 'car']);
  });

  it('combine folder, type, year, sender, star and review', () => {
    expect(applyFilters(docs, { categoryId: 'ins' }).map(d => d.id)).toEqual(['car']);
    expect(applyFilters(docs, { year: '2025' }).map(d => d.id)).toEqual(['power']);
    expect(applyFilters(docs, { year: '2026' }).map(d => d.id)).toEqual(['pay']);
    expect(applyFilters(docs, { starred: true }).map(d => d.id)).toEqual(['car']);
    expect(applyFilters(docs, { review: true }).map(d => d.id)).toEqual(['pay']);
    expect(applyFilters(docs, { correspondent: 'Allianz', type: 'invoice' })).toEqual([]);
  });

  it('show the documents of a folder inside a category, not the rest of the category', () => {
    const company = { categoryId: 'ug', category: 'Example UG' };
    const loan = doc({ ...company, id: 'loan', folderId: 'opening', folderPath: ['Example UG', 'Eröffnungsbilanz'] });
    const statement = doc({ ...company, id: 'statement', folderId: 'ug-2026', folderPath: ['Example UG', '2026'] });
    const all = [...docs, loan, statement];
    expect(applyFilters(all, { folderId: 'opening' }).map(d => d.id)).toEqual(['loan']);
    expect(applyFilters(all, { categoryId: 'ug' }).map(d => d.id).sort()).toEqual(['loan', 'statement']);
    expect(applyFilters(all, { folderId: 'opening', starred: true })).toEqual([]);
    expect(activeFilters({ folderId: 'opening' })).toBe(1);
  });

  it('sort newest first by default, with undated documents by when they were added', () => {
    expect(applyFilters(docs, {}).map(d => d.id)).toEqual(['pay', 'power', 'car']);
    expect(applyFilters(docs, { sort: 'title' }).map(d => d.id)).toEqual(['car', 'power', 'pay']);
    // Without an amount: last, newest first
    expect(applyFilters(docs, { sort: 'amount' }).map(d => d.id)).toEqual(['power', 'pay', 'car']);
  });
});

describe('facets and deadlines', () => {
  it('count years, senders and tags', () => {
    const f = facets(docs);
    expect(f.years.map(y => y.value)).toEqual(['2026', '2025', '2024']);
    expect(f.correspondents.map(c => c.value)).toContain('Allianz');
    expect(f.tags).toEqual([{ value: 'electricity', count: 1 }]);
  });

  it('list deadlines not done yet from two weeks ago to two months ahead, soonest first', () => {
    const list = upcoming(docs, '2026-10-16');
    expect(list.map(i => [i.doc.id, i.deadline.what])).toEqual([
      ['car', 'Send the mileage'],
      ['power', 'Pay the bill'],
      ['car', 'Cancellation deadline'],
    ]);
    // The done premium and the renewal more than two months ahead are left out
    expect(upcoming(docs, '2026-12-01').map(i => i.deadline.what)).toEqual(['Cancellation deadline', 'Renews']);
    expect(upcoming(docs, '2027-03-01')).toEqual([]);
  });

  it('list every deadline of every document, soonest first', () => {
    expect(deadlineItems(docs).map(i => i.deadline.date)).toEqual(['2026-09-25', '2026-10-05', '2026-10-20', '2026-11-30', '2027-01-01']);
  });

  it('count days and months in calendar terms', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05');
    expect(shiftMonths('2026-10-16', 12)).toBe('2027-10-16');
    expect(shiftMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonths('2026-03-15', -3)).toBe('2025-12-15');
  });
});

describe('searching what was bought', () => {
  it('finds a document by its items, typed without special letters', () => {
    const receipt = doc({ id: 'r', items: [{ name: 'Norrøna Falketind Flex1 Pants', details: 'Size M', quantity: 1, price: 239, code: '1810-20' }] });
    const other = doc({ id: 'o' });
    expect(applyFilters([receipt, other], { query: 'norrona falketind' }).map(d => d.id)).toEqual(['r']);
    expect(applyFilters([receipt, other], { query: '1810-20' }).map(d => d.id)).toEqual(['r']);
    expect(fold('Straße Æble Øre Crème')).toBe('strasse aeble ore creme');
  });
});

describe('return and warranty dates', () => {
  it('lapse once past instead of coming up as overdue', () => {
    const receipt = doc({
      id: 'r',
      deadlines: [
        { date: '2026-06-28', what: 'Last day to return', done: false, kind: 'return' },
        { date: '2026-07-02', what: 'Pay the rest', done: false },
      ],
    });
    expect(upcoming([receipt], '2026-07-05').map(i => i.deadline.what)).toEqual(['Pay the rest']);
    expect(upcoming([receipt], '2026-06-20').map(i => i.deadline.what)).toEqual(['Last day to return', 'Pay the rest']);
  });
});

describe('possible copies', () => {
  const bill = doc({ id: 'bill', title: 'Electricity bill', deadlines: [{ date: '2026-10-20', what: 'Pay 87.45 EUR', done: false }] });
  // A photo of the same bill, marked as a possible copy of it until the owner decides
  const photo = doc({ id: 'photo', title: 'Electricity bill (photo)', possibleDuplicateOf: 'bill', deadlines: [{ date: '2026-10-20', what: 'Pay 87.45 EUR', done: false }] });

  it('count while their original is in the list and not marked itself', () => {
    expect([...possibleCopies([bill, photo])]).toEqual([['photo', bill]]);
    // The original left Paperwork, or the mark names the document itself
    expect(possibleCopies([photo]).size).toBe(0);
    expect(possibleCopies([doc({ id: 'self', possibleDuplicateOf: 'self' })]).size).toBe(0);
    // A chain: only the first mark counts; a cycle: neither
    const scan = doc({ id: 'scan', possibleDuplicateOf: 'photo' });
    expect([...possibleCopies([bill, photo, scan]).keys()]).toEqual(['photo']);
    expect(possibleCopies([doc({ id: 'a', possibleDuplicateOf: 'b' }), doc({ id: 'b', possibleDuplicateOf: 'a' })]).size).toBe(0);
  });

  it('have their deadlines counted once, and say which are held back', () => {
    expect(deadlineItems([bill, photo]).map(i => i.doc.id)).toEqual(['bill']);
    expect(upcoming([bill, photo], '2026-10-16').map(i => i.doc.id)).toEqual(['bill']);
    expect(heldBack([bill, photo], '2026-10-16').map(i => [i.doc.id, i.deadline.what])).toEqual([['photo', 'Pay 87.45 EUR']]);
    // Without the original, the copy's deadline counts again
    expect(deadlineItems([photo]).map(i => i.doc.id)).toEqual(['photo']);
    expect(heldBack([photo])).toEqual([]);
    // Done or lapsed deadlines aren't held back
    const done = doc({ ...photo, deadlines: [{ date: '2026-10-20', what: 'Pay', done: true }, { date: '2026-06-01', what: 'Last day to return', done: false, kind: 'return' }] });
    expect(heldBack([bill, done], '2026-10-16')).toEqual([]);
  });

  it('are to check, whether the AI was sure or not', () => {
    expect(applyFilters([bill, photo, doc({ id: 'unsure', needsReview: true })], { review: true }).map(d => d.id).sort()).toEqual(['photo', 'unsure']);
  });
});
