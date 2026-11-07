import { describe, expect, it } from 'vitest';
import type { DocumentInfo } from '../../shared/types';
import { upcoming } from '../../shared/filter';
import { openDeadlines, nextDeadline } from './companies';
import { activeFlags, heldBackSummary, matchReason, onlyOnCopy } from './duplicates';
import { purchases } from './purchases';

const today = '2026-11-04';

const doc = (fields: Partial<DocumentInfo>) =>
  ({
    id: 'x',
    title: 'Electricity bill October',
    type: 'invoice',
    correspondent: 'Stadtwerke Musterstadt',
    date: '2026-10-28',
    amount: 87.45,
    currency: 'EUR',
    deadlines: [],
    items: [],
    needsReview: false,
    inInbox: false,
    addedAt: '2026-10-29T08:00:00Z',
    ...fields,
  }) as DocumentInfo;

const pay = { date: '2026-11-18', what: 'Pay 87.45 EUR', done: false };
const bill = doc({ id: 'bill', deadlines: [pay] });
// The paper scan of the same bill, filed later and marked as a possible copy
const scan = doc({ id: 'scan', possibleDuplicateOf: 'bill', addedAt: '2026-11-02T10:00:00Z', deadlines: [pay] });
// Next month's bill, with the same amount
const november = doc({ id: 'nov', title: 'Electricity bill November', date: '2026-11-28', deadlines: [{ date: '2026-12-18', what: 'Pay 87.45 EUR', done: false }] });

describe('marks that count', () => {
  it('keeps a mark while its original is in the library and not marked itself', () => {
    const library = [bill, scan, november];
    expect(activeFlags(library)).toBe(library);
  });

  it('clears a mark whose original left Paperwork, or that names a marked document, and leaves the others as they were', () => {
    const orphan = doc({ id: 'orphan', possibleDuplicateOf: 'gone' });
    const chained = doc({ id: 'chained', possibleDuplicateOf: 'scan' });
    const shown = activeFlags([bill, scan, chained, orphan, november]);
    expect(shown.map(d => [d.id, d.possibleDuplicateOf ?? null])).toEqual([
      ['bill', null],
      ['scan', 'bill'],
      ['chained', null],
      ['orphan', null],
      ['nov', null],
    ]);
    // Unchanged documents are the same objects, so nothing that depends on them redraws
    expect(shown[0]).toBe(bill);
    expect(shown[1]).toBe(scan);
    expect(shown[4]).toBe(november);
    expect(shown[2]).not.toBe(chained);
  });

  it('clears both marks of two documents marked as each other’s copy', () => {
    const shown = activeFlags([doc({ id: 'a', possibleDuplicateOf: 'b' }), doc({ id: 'b', possibleDuplicateOf: 'a' })]);
    expect(shown.map(d => d.possibleDuplicateOf)).toEqual([null, null]);
  });
});

describe('why they may be the same', () => {
  it('names what the two have in common', () => {
    expect(matchReason(scan, bill)).toBe('Same company, date and amount.');
    // "Stadtwerke Musterstadt GmbH" is the same company
    expect(matchReason(doc({ correspondent: 'Stadtwerke Musterstadt GmbH', date: '2026-10-30' }), bill)).toBe(
      'Same company and amount, dated 2 days apart, and nearly the same text.'
    );
    expect(matchReason(doc({ date: '2026-10-29' }), bill)).toBe('Same company and amount, dated 1 day apart, and nearly the same text.');
    expect(matchReason(doc({ amount: null, currency: null }), bill)).toBe('Same company and date, and nearly the same text.');
    // The sender misread on a poor scan
    expect(matchReason(doc({ correspondent: 'Stadtwerk Munch' }), bill)).toBe('Nearly the same text.');
    expect(matchReason(doc({ correspondent: null }), bill)).toBe('Nearly the same text.');
    // Another currency is another amount
    expect(matchReason(doc({ currency: 'CHF' }), bill)).toBe('Same company and date, and nearly the same text.');
  });
});

describe('deadlines only on the copy', () => {
  it('lists the copy’s open deadlines the original doesn’t have', () => {
    const reminder = { date: '2026-11-25', what: 'Send the meter reading', done: false };
    const copy = doc({ id: 'scan', possibleDuplicateOf: 'bill', deadlines: [{ ...pay, what: 'pay 87.45 eur ' }, reminder, { date: '2026-11-30', what: 'Done already', done: true }] });
    expect(onlyOnCopy(copy, bill, today)).toEqual([reminder]);
    expect(onlyOnCopy(scan, bill, today)).toEqual([]);
  });

  it('leaves out a return date that has passed', () => {
    const returned = doc({ id: 'r', deadlines: [{ date: '2026-10-01', what: 'Last day to return', done: false, kind: 'return' }] });
    expect(onlyOnCopy(returned, bill, today)).toEqual([]);
  });
});

describe('deadlines not counted while a document may be a copy', () => {
  it('counts the copy’s open deadlines once, under its original', () => {
    const summary = heldBackSummary([bill, scan, november], undefined, today);
    expect(summary.count).toBe(1);
    expect(summary.copies).toEqual([{ doc: scan, original: bill }]);
    expect(heldBackSummary([bill, november], undefined, today)).toEqual({ count: 0, copies: [] });
  });

  it('counts only what the list would show', () => {
    const later = doc({ id: 'later', possibleDuplicateOf: 'bill', deadlines: [{ date: '2027-06-01', what: 'Renew', done: false }] });
    const soon = (i: { deadline: { date: string } }) => i.deadline.date <= '2027-01-03';
    expect(heldBackSummary([bill, scan, later], soon, today).count).toBe(1);
    expect(heldBackSummary([bill, scan, later], undefined, today).count).toBe(2);
  });

  it('lists the deadline once on Deadlines, Coming up, the company and topic pages', () => {
    const library = [bill, scan, november];
    expect(upcoming(library, today).map(i => i.doc.id)).toEqual(['bill', 'nov']);
    expect(openDeadlines(library, today).map(i => i.doc.id)).toEqual(['bill', 'nov']);
    expect(nextDeadline(library, today)?.doc.id).toBe('bill');
    // Once its original has left Paperwork, the copy's deadlines count again
    expect(openDeadlines([scan], today).map(i => i.doc.id)).toEqual(['scan']);
  });

  it('lists a receipt photographed twice once among the purchases', () => {
    const item = { name: 'Espresso', details: null, quantity: 1, price: 2.8, code: null };
    const receipt = doc({ id: 'r1', type: 'receipt', correspondent: 'Café Frischhut', items: [item] });
    const photo = doc({ id: 'r2', type: 'receipt', correspondent: 'Café Frischhut', items: [item], possibleDuplicateOf: 'r1' });
    expect(purchases([receipt, photo]).map(p => p.doc.id)).toEqual(['r1']);
    expect(purchases([photo]).map(p => p.doc.id)).toEqual(['r2']);
  });
});
