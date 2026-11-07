// The check for possible duplicates (duplicates.ts): the same document as another file is found, documents made from
// one template (monthly bills, payslips, till receipts of one shop) are told apart, on realistic texts.
import { describe, expect, it } from 'vitest';
import type { PurchaseItem } from '../shared/types.js';
import { DupFacts, compare, compareByText, companyKey, containment, copyAndOriginal, periodOf, rankCandidates, refClasses, sameCompany, textSignals } from './duplicates.js';
import { MAX_NOT_DUP, P, addDupTag, dupTag, parseDupTags } from './metadata.js';
import {
  amendmentText,
  annualBillText,
  feeNoticeText,
  invoiceText,
  letterText,
  ocrOf,
  payslipText,
  pollingCardText,
  premiumBillText,
  receiptText,
  shopText,
  statementText,
} from './testing/fixtures.js';

// A document's facts as the index has them: by default the March electricity bill
const facts = (id: string, over: Partial<DupFacts> = {}): DupFacts => ({
  id,
  title: 'Electricity bill March 2025',
  type: 'invoice',
  correspondent: 'Stadtwerke Musterstadt',
  date: '2025-03-14',
  amount: 87.45,
  currency: 'EUR',
  references: 'Customer: 88123 · Invoice no: 2025-0412',
  items: [],
  topic: null,
  addedAt: '2026-10-16T08:00:00.000Z',
  notDuplicates: [],
  possibleDuplicateOf: null,
  ...over,
});

const bought = (items: { name: string; price: number }[]): PurchaseItem[] => items.map(i => ({ name: i.name, details: null, quantity: 1, price: i.price, code: null }));

const march = { number: '2025-0412', date: '2025-03-14', period: '2025-03', amount: 87.45, customer: '88123' };
const april = { number: '2025-0512', date: '2025-04-14', period: '2025-04', amount: 87.45, customer: '88123' };
const coffee = [
  { name: 'Cappuccino', price: 3.4 },
  { name: 'Butter croissant', price: 1.9 },
];
const weekly = [
  { name: 'Bio Bananen', price: 1.99 },
  { name: 'Vollmilch 3,5%', price: 1.29 },
  { name: 'Roggenbrot', price: 3.49 },
];
const evening = [
  { name: 'Äpfel Braeburn', price: 2.49 },
  { name: 'Butter', price: 2.29 },
  { name: 'Espresso', price: 1.99 },
];
const policy = { date: '2025-11-02', premium: 642.18, policy: 'KH-4711-0815' };
const insurer = (id: string, over: Partial<DupFacts> = {}) =>
  facts(id, { title: 'Premium adjustment 2026', type: 'letter', correspondent: 'Allianz Versicherungs-AG', date: '2025-11-02', amount: 642.18, references: 'Policy: KH-4711-0815', topic: 'Car insurance VW Golf', ...over });
const receipt = (id: string, items: { name: string; price: number }[], over: Partial<DupFacts> = {}) =>
  facts(id, { title: 'Receipt REWE', type: 'receipt', correspondent: 'REWE Markt GmbH', amount: Math.round(items.reduce((s, i) => s + i.price, 0) * 100) / 100, references: null, items: bought(items), ...over });
const payslip = (id: string, month: string, over: Partial<DupFacts> = {}) =>
  facts(id, { title: `Payslip ${month} 2025`, type: 'payslip', correspondent: 'Muster GmbH', amount: 3120.44, references: 'Personnel no: 004711', ...over });
const statement = (id: string, account: string) =>
  facts(id, { title: 'Account statement March 2025', type: 'statement', correspondent: 'Stadtsparkasse Musterstadt', date: '2025-03-31', amount: null, references: `Account: …${account}` });
const shopItems = [
  { name: "Arc'teryx Beta SV Jacket", price: 679.99 },
  { name: 'Fibertec Textile Guard Eco', price: 28.82 },
];
// Letters from one template for different members of the household, told apart by one number of no known kind
const feeNotice = (id: string, reference: string) =>
  facts(id, { title: 'Kita fee notice 2025/26', type: 'notice', correspondent: 'Landeshauptstadt Musterstadt', date: '2025-11-02', amount: 245, references: `Aktenzeichen: ${reference}` });
const premiumBill = (id: string, policy: string, over: Partial<DupFacts> = {}) =>
  facts(id, { title: 'Premium invoice 2026', type: 'policy', correspondent: 'HUK-COBURG', date: '2025-11-20', amount: 312.4, references: `Vers.-Nr.: ${policy}`, ...over });
const pollingCard = (id: string, number: string) =>
  facts(id, { title: 'Election notice Bundestag 2025', type: 'notice', correspondent: 'Landeshauptstadt Musterstadt', date: '2025-01-20', amount: null, references: `Nummer im Wählerverzeichnis: ${number}` });
const carPolicy = { policy: '123/456789-K', what: 'Kfz-Haftpflicht', date: '2025-11-20', premium: 312.4 };
const annualBill = (id: string, amount: number) => facts(id, { title: 'Annual electricity bill 2025', date: '2026-01-15', amount, references: 'Customer: 88123 · Invoice no: 2026-0099' });

interface Pair {
  name: string;
  a: DupFacts;
  ta: string;
  b: DupFacts;
  tb: string;
  verdict: 'flag' | 'no';
  // Text found by meaning alone (the backlog's nearest pass)
  byText?: boolean;
}

// The pairs of the spec's table (§1.8), with the texts as the index would have them: a PDF's own text, or Gemini's
// transcription of a scan or photo (ocrOf)
const pairs: Pair[] = [
  { name: 'an emailed PDF and a phone scan of the same invoice', a: facts('a'), ta: invoiceText(march), b: facts('bb'), tb: ocrOf(invoiceText(march)), verdict: 'flag' },
  { name: 'the same invoice with the scan’s date read two days off', a: facts('a'), ta: invoiceText(march), b: facts('bb', { date: '2025-03-16' }), tb: ocrOf(invoiceText(march)), verdict: 'flag' },
  { name: 'the same invoice with no date read from the scan', a: facts('a'), ta: invoiceText(march), b: facts('bb', { date: null }), tb: ocrOf(invoiceText(march)), verdict: 'flag' },
  {
    name: 'a PDF downloaded again, made anew with the same invoice number',
    a: facts('a'),
    ta: invoiceText({ ...march, printed: '2025-03-14' }),
    b: facts('bb'),
    tb: invoiceText({ ...march, printed: '2026-11-02' }),
    verdict: 'flag',
  },
  { name: 'the same bill with the sender misread on the scan', a: facts('a'), ta: invoiceText(march), b: facts('bb', { correspondent: 'SWM Versorgungs GmbH' }), tb: ocrOf(invoiceText(march)), verdict: 'flag' },
  { name: 'a letter scanned twice', a: insurer('a'), ta: ocrOf(letterText(policy), 0), b: insurer('bb'), tb: ocrOf(letterText(policy), 1), verdict: 'flag' },
  { name: 'a till receipt photographed twice', a: receipt('a', coffee), ta: ocrOf(receiptText({ time: '08:12', bon: '1234', items: coffee }), 0), b: receipt('bb', coffee), tb: ocrOf(receiptText({ time: '08:12', bon: '1234', items: coffee }), 1), verdict: 'flag' },
  {
    name: 'an order confirmation and the invoice for it (accepted: the owner decides)',
    a: facts('a', { title: "Order confirmation Arc'teryx jacket", type: 'other', correspondent: 'Bergzeit GmbH', date: '2025-10-20', amount: 708.81, references: 'Order no: 300123456 · Customer: 5512345', items: bought(shopItems) }),
    ta: shopText({ kind: 'order', date: '2025-10-20', order: '300123456' }),
    b: facts('bb', { title: "Invoice Arc'teryx jacket", correspondent: 'Bergzeit GmbH', date: '2025-10-20', amount: 708.81, references: 'Order no: 300123456 · Invoice no: RE-2025-88123 · Customer: 5512345', items: bought(shopItems) }),
    tb: shopText({ kind: 'invoice', date: '2025-10-20', order: '300123456', invoice: 'RE-2025-88123' }),
    verdict: 'flag',
  },
  {
    name: 'two monthly electricity bills for the same amount',
    a: facts('a'),
    ta: invoiceText(march),
    b: facts('bb', { title: 'Electricity bill April 2025', date: '2025-04-14', references: 'Customer: 88123 · Invoice no: 2025-0512' }),
    tb: invoiceText(april),
    verdict: 'no',
  },
  {
    name: 'two monthly bills for the same amount, the date missing on one',
    a: facts('a'),
    ta: invoiceText(march),
    b: facts('bb', { title: 'Electricity bill April 2025', date: null, references: 'Customer: 88123 · Invoice no: 2025-0512' }),
    tb: ocrOf(invoiceText(april)),
    verdict: 'no',
  },
  {
    name: 'two monthly bills told apart by their texts alone (plain titles, no invoice numbers read)',
    a: facts('a', { title: 'Electricity bill', references: 'Customer: 88123' }),
    ta: invoiceText(march),
    b: facts('bb', { title: 'Electricity bill', date: null, references: 'Customer: 88123' }),
    tb: invoiceText(april),
    verdict: 'no',
  },
  {
    name: 'payslips for October and November with the same net pay',
    a: payslip('a', 'October', { date: '2025-10-31' }),
    ta: payslipText({ month: '2025-10', gross: 5200, net: 3120.44 }),
    b: payslip('bb', 'November', { date: '2025-11-30' }),
    tb: payslipText({ month: '2025-11', gross: 5200, net: 3120.44 }),
    verdict: 'no',
  },
  {
    name: 'payslips with no dates read and plain titles',
    a: payslip('a', 'October', { title: 'Payslip', date: null }),
    ta: payslipText({ month: '2025-10', gross: 5200, net: 3120.44 }),
    b: payslip('bb', 'November', { title: 'Payslip', date: null }),
    tb: payslipText({ month: '2025-11', gross: 5200, net: 3120.44 }),
    verdict: 'no',
  },
  {
    name: 'two coffees at one shop on one day, for the same amount',
    a: receipt('a', coffee),
    ta: receiptText({ time: '08:12', bon: '1234', items: coffee }),
    b: receipt('bb', coffee),
    tb: receiptText({ time: '15:47', bon: '1301', items: coffee }),
    verdict: 'no',
  },
  {
    name: 'two shops at one supermarket on one day, different items for the same amount',
    a: receipt('a', weekly),
    ta: receiptText({ time: '10:05', bon: '2201', items: weekly }),
    b: receipt('bb', evening),
    tb: receiptText({ time: '17:31', bon: '2388', items: evening }),
    verdict: 'no',
  },
  {
    name: 'two shops at one supermarket on one day, different items and amounts',
    a: receipt('a', weekly),
    ta: receiptText({ time: '10:05', bon: '2201', items: weekly }),
    b: receipt('bb', [...evening, { name: 'Kaffee', price: 6.99 }]),
    tb: receiptText({ time: '17:31', bon: '2388', items: [...evening, { name: 'Kaffee', price: 6.99 }] }),
    verdict: 'no',
  },
  {
    name: 'the statements of two accounts on the same day',
    a: statement('a', '4567'),
    ta: statementText({ iban: 'DE12 7015 0000 0001 2345 67', date: '2025-03-31', balance: 1234.56, lines: [{ date: '2025-03-03', text: 'Miete März', amount: -950 }] }),
    b: statement('bb', '6543'),
    tb: statementText({ iban: 'DE44 7015 0000 0009 8765 43', date: '2025-03-31', balance: 512.3, lines: [{ date: '2025-03-05', text: 'Sparplan', amount: -200 }] }),
    verdict: 'no',
  },
  {
    name: 'the two pages of one letter scanned on their own',
    a: insurer('a'),
    ta: ocrOf(letterText(policy)),
    b: insurer('bb', { title: 'Premium breakdown car insurance', date: null, amount: null }),
    tb: ocrOf(letterText({ ...policy, page: 2 })),
    verdict: 'no',
  },
  {
    name: 'the daycare fee notices of twins, alike but for the file number',
    a: feeNotice('a', 'KG-2025-4711'),
    ta: feeNoticeText({ reference: 'KG-2025-4711', child: 'Lena', date: '2025-11-02', amount: 245 }),
    b: feeNotice('bb', 'KG-2025-4712'),
    tb: feeNoticeText({ reference: 'KG-2025-4712', child: 'Paul', date: '2025-11-02', amount: 245 }),
    verdict: 'no',
  },
  {
    name: 'the premium bills for the car and the household, alike but for the policy number',
    a: premiumBill('a', '123/456789-K'),
    ta: premiumBillText(carPolicy),
    b: premiumBill('bb', '123/456790-H'),
    tb: premiumBillText({ ...carPolicy, policy: '123/456790-H', what: 'Hausratversicherung' }),
    verdict: 'no',
  },
  {
    name: 'the polling cards of two voters in the household',
    a: pollingCard('a', '1187'),
    ta: pollingCardText({ number: '1187', name: 'Frau Anna Muster' }),
    b: pollingCard('bb', '1188'),
    tb: pollingCardText({ number: '1188', name: 'Herrn Max Muster' }),
    verdict: 'no',
  },
  {
    name: 'two letters from one insurer on one day, for one policy and premium (numbers alike, wording not)',
    a: insurer('a'),
    ta: letterText(policy),
    b: insurer('bb', { title: 'Policy amendment car insurance' }),
    tb: amendmentText(policy),
    verdict: 'no',
  },
  { name: 'the same bill read once as an invoice and once as a statement', a: facts('a'), ta: invoiceText(march), b: facts('bb', { type: 'statement' }), tb: ocrOf(invoiceText(march)), verdict: 'flag' },
  { name: 'the same bill read once as an invoice and once as a medical record', a: facts('a'), ta: invoiceText(march), b: facts('bb', { type: 'medical' }), tb: ocrOf(invoiceText(march)), verdict: 'flag' },
  {
    name: 'the same premium bill read once as a policy and once as an invoice',
    a: premiumBill('a', carPolicy.policy),
    ta: premiumBillText(carPolicy),
    b: premiumBill('bb', carPolicy.policy, { type: 'invoice' }),
    tb: ocrOf(premiumBillText(carPolicy)),
    verdict: 'flag',
  },
  {
    name: 'a year’s bill with its total read on one and what is left to pay on the other',
    a: annualBill('a', 60.72),
    ta: annualBillText(),
    b: annualBill('bb', 1044.72),
    tb: ocrOf(annualBillText()),
    verdict: 'flag',
  },
  {
    name: 'the same bill titled by its period on one and by its month of issue on the other',
    a: facts('a', { title: 'Electricity bill February 2025' }),
    ta: invoiceText(march),
    b: facts('bb'),
    tb: ocrOf(invoiceText(march)),
    verdict: 'flag',
  },
  { name: 'by meaning: a scan whose amount was misread', a: facts('a'), ta: invoiceText(march), b: facts('bb', { amount: 84.75 }), tb: ocrOf(invoiceText(march)), verdict: 'flag', byText: true },
  {
    name: 'by meaning: the daycare fee notices of twins',
    a: feeNotice('a', 'KG-2025-4711'),
    ta: feeNoticeText({ reference: 'KG-2025-4711', child: 'Lena', date: '2025-11-02', amount: 245 }),
    b: feeNotice('bb', 'KG-2025-4712'),
    tb: feeNoticeText({ reference: 'KG-2025-4712', child: 'Paul', date: '2025-11-02', amount: 245 }),
    verdict: 'no',
    byText: true,
  },
  { name: 'by meaning: the same bill read as an invoice and as a statement', a: facts('a'), ta: invoiceText(march), b: facts('bb', { type: 'statement', amount: 84.75 }), tb: ocrOf(invoiceText(march)), verdict: 'flag', byText: true },
  {
    name: 'by meaning: two monthly bills',
    a: facts('a'),
    ta: invoiceText(march),
    b: facts('bb', { title: 'Electricity bill April 2025', date: '2025-04-14', references: 'Customer: 88123 · Invoice no: 2025-0512' }),
    tb: invoiceText(april),
    verdict: 'no',
    byText: true,
  },
];

const judge = (p: Pair, flip = false) => {
  const check = p.byText ? compareByText : compare;
  return flip ? check(p.b, textSignals(p.tb), p.a, textSignals(p.ta)) : check(p.a, textSignals(p.ta), p.b, textSignals(p.tb));
};

describe('possible duplicates', () => {
  it.each(pairs)('$verdict: $name', p => {
    expect(textSignals(p.ta).usable && textSignals(p.tb).usable).toBe(true);
    expect(judge(p).verdict).toBe(p.verdict);
  });

  it('gives the same answer either way round', () => {
    for (const p of pairs) expect(judge(p, true), p.name).toEqual(judge(p));
  });

  it('scores the close calls as expected', () => {
    const verdict = (name: string) => judge(pairs.find(p => p.name === name)!);
    // Facts 10 (company, date, amount, type) + references 2 + title 1, and the texts all but the same
    expect(verdict('an emailed PDF and a phone scan of the same invoice')).toMatchObject({ score: 19, why: expect.stringMatching(/^same company, date and amount; 100% of numbers/) });
    // 3 + 1 + 3 + 1 + 2 + 1, the text 6
    expect(verdict('the same invoice with the scan’s date read two days off')).toMatchObject({ score: 17, why: expect.stringContaining('2 days apart') });
    expect(verdict('the same bill with the sender misread on the scan')).toMatchObject({ score: 16, why: expect.stringMatching(/^same date and amount/) });
    // Same template: the wording matches, the numbers don't (invoice number, dates, period)
    const monthly = verdict('two monthly bills told apart by their texts alone (plain titles, no invoice numbers read)');
    expect(monthly.verdict).toBe('no');
    expect(monthly.why).toMatch(/different document numbers/);
    expect(verdict('two monthly bills for the same amount, the date missing on one').why).toBe('different invoice numbers');
    expect(verdict('payslips with no dates read and plain titles')).toMatchObject({ verdict: 'no', why: expect.stringMatching(/6\d% of numbers/) });
    expect(verdict('two coffees at one shop on one day, for the same amount').why).toBe('different document numbers');
    expect(verdict('two shops at one supermarket on one day, different items for the same amount').why).toBe('different items');
    expect(verdict('the statements of two accounts on the same day').why).toBe('different account numbers');
    expect(verdict('payslips for October and November with the same net pay').why).toBe('not alike');
    // The one number of no known kind tells them apart, compared under the same label
    expect(verdict('the daycare fee notices of twins, alike but for the file number').why).toBe('different reference numbers');
    expect(verdict('the polling cards of two voters in the household').why).toBe('different reference numbers');
    // The letterhead's and the policy's numbers are shared, the wording isn't
    expect(verdict('two letters from one insurer on one day, for one policy and premium (numbers alike, wording not)')).toMatchObject({ verdict: 'no', why: expect.stringMatching(/^same company, date and amount; \d+% of numbers and [34]\d% of wording/) });
  });

  it('tells two till receipts apart by their times when their numbers weren’t read', () => {
    const strip = (text: string) => text.replace(/Bon-Nr\.: \d+/, '').replace(/TSE-Transaktionsnummer: \d+/, '');
    const a = textSignals(strip(receiptText({ time: '08:12', bon: '1234', items: coffee })));
    const b = textSignals(strip(receiptText({ time: '15:47', bon: '1301', items: coffee })));
    expect(a.labelled.size + b.labelled.size).toBe(0);
    expect(compare(receipt('a', coffee), a, receipt('bb', coffee), b)).toMatchObject({ verdict: 'no', why: 'different times' });
  });

  it('marks on facts alone only what never comes twice with the same facts', () => {
    // A photo Gemini found no text in: the same company, date and amount, an invoice of no series
    expect(compare(facts('a'), 'never', facts('bb'), 'never')).toMatchObject({ verdict: 'flag', score: 13 });
    expect(compare(facts('a'), textSignals(invoiceText(march)), facts('bb'), 'never').verdict).toBe('flag');
    // A receipt, a payslip, a document of a series (a topic both share), a type unknown, or a date off
    expect(compare(receipt('a', coffee), 'never', receipt('bb', coffee), 'never').verdict).toBe('no');
    expect(compare(payslip('a', 'October', { date: '2025-10-31' }), 'never', payslip('bb', 'October', { date: '2025-10-31' }), 'never').verdict).toBe('no');
    expect(compare(facts('a', { topic: 'Electricity Lindwurmstraße' }), 'never', facts('bb', { topic: 'Electricity Lindwurmstraße' }), 'never').verdict).toBe('no');
    expect(compare(facts('a', { type: 'other' }), 'never', facts('bb', { type: 'other' }), 'never').verdict).toBe('no');
    expect(compare(facts('a'), 'never', facts('bb', { date: '2025-03-15' }), 'never').verdict).toBe('no');
    // Types that don't go together, or one-template letters told apart by a number of no known kind
    expect(compare(facts('a'), 'never', facts('bb', { type: 'policy' }), 'never').verdict).toBe('no');
    expect(compare(feeNotice('a', 'KG-2025-4711'), 'never', feeNotice('bb', 'KG-2025-4712'), 'never')).toMatchObject({ verdict: 'no', why: 'different reference numbers' });
    expect(compare(feeNotice('a', 'KG-2025-4711'), 'never', feeNotice('bb', 'KG-2025-4711'), 'never').verdict).toBe('flag');
    // Amounts read differently are left to the texts, never marked on facts alone
    expect(compare(annualBill('a', 60.72), 'never', annualBill('bb', 1044.72), 'never').verdict).toBe('no');
    expect(compare(annualBill('a', 60.72), 'never', annualBill('bb', 1044.72), 'pending').verdict).toBe('no');
  });

  it('waits for a text still to be read, unless the other has none to be had', () => {
    expect(compare(facts('a'), textSignals(invoiceText(march)), facts('bb'), 'pending').verdict).toBe('defer');
    expect(compare(facts('a'), 'pending', facts('bb'), 'pending').verdict).toBe('defer');
    expect(compare(facts('a'), 'never', facts('bb'), 'pending').verdict).toBe('flag');
    // Told apart by its facts already: nothing to wait for
    expect(compare(facts('a'), 'pending', facts('bb', { date: '2025-04-14' }), 'pending').verdict).toBe('no');
  });

  it('never asks about a pair the owner kept both of, either way round, nor about a document marked already', () => {
    const a = facts('a');
    const b = facts('bb');
    expect(compare(a, 'never', b, 'never').verdict).toBe('flag');
    expect(compare({ ...a, notDuplicates: [dupTag('bb')] }, 'never', b, 'never').verdict).toBe('no');
    expect(compare(a, 'never', { ...b, notDuplicates: [dupTag('a')] }, 'never').verdict).toBe('no');
    expect(compare(a, 'never', { ...b, notDuplicates: [dupTag('c')] }, 'never').verdict).toBe('flag');
    expect(compare(a, 'never', { ...b, possibleDuplicateOf: 'c' }, 'never').verdict).toBe('no');
    expect(compare({ ...a, possibleDuplicateOf: 'c' }, 'never', b, 'never').verdict).toBe('no');
    expect(compare(a, 'never', a, 'never').verdict).toBe('no');
    expect(compareByText({ ...a, notDuplicates: [dupTag('bb')] }, textSignals(invoiceText(march)), b, textSignals(ocrOf(invoiceText(march)))).verdict).toBe('no');
  });

  it('takes the likeliest candidates first, at most three, leaving out those their facts tell apart', () => {
    const self = facts('new', { addedAt: '2026-11-01T08:00:00.000Z' });
    const docs = [
      facts('far', { date: '2025-04-14' }),
      facts('near', { date: '2025-03-15', addedAt: '2026-10-01T08:00:00.000Z' }),
      facts('same', { addedAt: '2026-10-02T08:00:00.000Z' }),
      facts('older', { addedAt: '2026-09-01T08:00:00.000Z' }),
      facts('other-invoice', { references: 'Customer: 88123 · Invoice no: 2025-0413' }),
      facts('april', { title: 'Electricity bill April 2025', date: null }),
      facts('no-date', { date: null }),
      facts('new'),
    ];
    // Ties go to the one added closest in time
    expect(rankCandidates(self, docs).map(d => d.id)).toEqual(['same', 'older', 'near']);
    // A title's period is left to the texts
    expect(rankCandidates(facts('new', { title: 'Electricity bill February 2025' }), [facts('march')]).map(d => d.id)).toEqual(['march']);
  });

  it('takes the latest of documents alike for a rescan with little read, as it comes soon after its original', () => {
    const bill = (id: string, month: number) => facts(id, { title: 'Electricity bill', date: null, amount: null, references: 'Customer: 88123', addedAt: `2026-0${month}-01T08:00:00.000Z` });
    const docs = [1, 2, 3, 4, 5, 6].map(month => bill(`m${month}`, month));
    expect(rankCandidates(bill('rescan', 7), docs).map(d => d.id)).toEqual(['m6', 'm5', 'm4']);
  });

  it('takes the document added later as the copy', () => {
    const older = facts('a', { addedAt: '2026-10-01T08:00:00.000Z' });
    const newer = facts('b', { addedAt: '2026-10-02T08:00:00.000Z' });
    expect(copyAndOriginal(older, newer)).toEqual({ copy: newer, original: older });
    expect(copyAndOriginal(newer, older)).toEqual({ copy: newer, original: older });
    const twin = facts('c', { addedAt: newer.addedAt });
    expect(copyAndOriginal(twin, newer).copy.id).toBe('c');
  });
});

describe('the facts compared', () => {
  it('takes the same company however it was spelled', () => {
    expect(companyKey('Stadtwerke Musterstadt GmbH')).toBe('stadtwerkemusterstadt');
    expect(sameCompany('Stadtwerke Musterstadt GmbH', 'Stadtwerke Musterstadt')).toBe(true);
    expect(sameCompany('Telekom', 'Telekom Deutschland GmbH')).toBe(true);
    expect(sameCompany('Sportverein Isar e.V.', 'Sportverein Isar eV')).toBe(true);
    expect(sameCompany('AXA', 'AXA ARAG')).toBe(false);
    expect(sameCompany('Stadtwerke Musterstadt', 'Stadtsparkasse Musterstadt')).toBe(false);
    expect(sameCompany(null, 'Telekom')).toBe(false);
    expect(sameCompany('GmbH', 'GmbH')).toBe(false);
  });

  it('reads references by what they are', () => {
    const refs = refClasses('Kundennummer: 88123 · Rechnungsnummer: 2025-0412 · Vertragskonto: 400123456 · IBAN: DE89 3704 0044 0532 0130 00 · Zähler: 1ESY1160612345');
    expect(Object.fromEntries(refs)).toEqual({ customer: ['88123'], invoice: ['20250412'], contract: ['400123456'], account: ['3000'], other: ['1esy1160612345'] });
    expect(Object.fromEntries(refClasses('Kd.-Nr.: 4711 · Kennzeichen: M-AB 1234'))).toEqual({ customer: ['4711'], other: ['mab1234'] });
    // Two invoice numbers in two languages, one apart: two invoices
    expect(compare(facts('a', { references: 'Invoice no: 2025-0412' }), 'never', facts('bb', { references: 'Rechnungsnummer: 2025-0413' }), 'never')).toMatchObject({ verdict: 'no', why: 'different invoice numbers' });
    // A card or account given by its last digits on one, in full on the other: the same
    expect(compare(facts('a', { references: 'Account: …1234' }), 'never', facts('bb', { references: 'IBAN: DE89…1234' }), 'never').verdict).toBe('flag');
    expect(compare(facts('a', { references: 'Customer: 0088123' }), 'never', facts('bb', { references: 'Kundennummer: 88123' }), 'never').verdict).toBe('flag');
  });

  it('reads the period a title names', () => {
    expect(periodOf('Payslip October 2025')).toEqual({ month: 10, year: 2025 });
    expect(periodOf('Gehaltsabrechnung 10/2025')).toEqual({ month: 10, year: 2025 });
    expect(periodOf('Stromrechnung März')).toEqual({ month: 3 });
    expect(periodOf('Abschlag Mrz. 2025')).toEqual({ month: 3, year: 2025 });
    expect(periodOf('Statement 2025-07')).toEqual({ month: 7, year: 2025 });
    expect(periodOf('VAT return Q3 2025')).toEqual({ year: 2025, quarter: 3 });
    expect(periodOf('Umsatzsteuer 3. Quartal 2025')).toEqual({ year: 2025, quarter: 3 });
    expect(periodOf('Electricity bill')).toEqual({});
    expect(compare(facts('a', { title: 'Electricity bill Q1' }), 'never', facts('bb', { title: 'Electricity bill Q2' }), 'never').why).toBe('different quarters');
    expect(compare(facts('a', { title: 'Annual statement 2024' }), 'never', facts('bb', { title: 'Annual statement 2025' }), 'never').why).toBe('different years');
  });

  it('tells two purchases apart by their items, forgiving one line missed', () => {
    const three = bought(weekly);
    expect(compare(facts('a', { items: three }), 'never', facts('bb', { items: three.slice(0, 2) }), 'never').verdict).toBe('flag');
    expect(compare(facts('a', { items: three }), 'never', facts('bb', { items: bought(evening) }), 'never').why).toBe('different items');
  });
});

describe('the texts compared', () => {
  it('finds amounts, dates, times, IBANs and numbers however they are written', () => {
    const signals = textSignals('Betrag 1.234,56 EUR, amount 1,234.56, Rest 87,45 und 87.45, am 14.03.2025 oder 2025-03-14 und 5.4.25 um 18:03:40, IBAN DE89 3704 0044 0532 0130 00, Rechnung 2025-0412, Zähler 1ESY1160612345, Kunde 88123');
    expect([...signals.ids].sort()).toEqual(['a:123456', 'a:8745', 'd:20250314', 'd:20250405', 'n:20250412', 'n:88123', 't:1803', 'x:1esy1160612345', 'x:de89370400440532013000']);
    expect([...signals.times]).toEqual(['t:1803']);
  });

  it('reads the document’s own number after its label, not a word', () => {
    expect([...textSignals('Rechnungsnummer: 2025-0412 · Bon-Nr. 4711 · Invoice no. INV-88 · Rechnungsnummer | R-77 · geben Sie die Rechnungsnummer als Verwendungszweck an').labelled]).toEqual(['20250412', '4711', 'inv88', 'r77']);
  });

  it('compares only texts with enough in them', () => {
    expect(textSignals('Stadtwerke Musterstadt. Rechnung März 2025. Betrag 87,45 EUR.').usable).toBe(false);
    expect(textSignals(invoiceText(march)).usable).toBe(true);
    // A text too short counts as none: the pair is judged on its facts
    expect(compare(facts('a'), textSignals('Rechnung 87,45 EUR'), facts('bb'), textSignals(invoiceText(march))).verdict).toBe('flag');
  });

  it('lets a one-page scan match its longer PDF', () => {
    expect(containment(new Set(['a', 'b']), new Set(['a', 'b', 'c', 'd']))).toBe(1);
    expect(containment(new Set(['a', 'b']), new Set(['a', 'c']))).toBe(0.5);
    expect(containment(new Set(), new Set(['a']))).toBe(0);
  });
});

describe('the owner’s answers in Drive', () => {
  it('keeps a dozen, each once, dropping the oldest, within one Drive label', () => {
    let value = addDupTag(undefined, 'doc-1');
    expect(parseDupTags(value)).toEqual([dupTag('doc-1')]);
    expect(addDupTag(value, 'doc-1')).toBe(value);
    for (let i = 2; i <= 14; i++) value = addDupTag(value, `doc-${i}`);
    const tags = parseDupTags(value);
    expect(tags).toHaveLength(MAX_NOT_DUP);
    expect(tags[0]).toBe(dupTag('doc-3'));
    expect(tags.at(-1)).toBe(dupTag('doc-14'));
    expect(Buffer.byteLength(P.notDup) + Buffer.byteLength(value)).toBeLessThanOrEqual(124);
    // A long Drive ID fits beside its key too
    expect(Buffer.byteLength(P.maybeDup) + 44).toBeLessThanOrEqual(124);
  });

  it('ignores what isn’t a tag', () => {
    expect(parseDupTags(`junk,${dupTag('x')},,toolongtobeatag,short,${dupTag('y')}…`)).toEqual([dupTag('x')]);
    expect(parseDupTags(undefined)).toEqual([]);
  });
});
