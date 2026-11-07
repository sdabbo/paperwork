// Possible duplicates: a new document that may be the same as one already in Paperwork, as a different file (the
// same letter scanned twice, an emailed PDF and a paper scan of one invoice, a PDF downloaded again). Exact copies,
// the same bytes, are caught before this by their checksum (pipeline.ts findDuplicate).
//
// Worked out from what the index has, without asking Gemini: the facts (company, date, amount, references, items)
// find the candidates, and the texts confirm them wherever both have one. The same pair always gets the same answer,
// so a pair the owner decided about ("Keep both", kept in Drive) isn't asked about again, even after the index was
// rebuilt. Documents made from one template (monthly bills, payslips, till receipts of one shop) are told apart by
// what differs between them: their numbers, periods, times and items. A pair found here is only a question for the
// owner (pipeline.ts marks it); nothing is moved or set aside without their answer.
import { fold } from '../shared/filter.js';
import type { DocumentType, PurchaseItem } from '../shared/types.js';
import type { IndexedDoc } from './docIndex.js';
import { dupTag } from './metadata.js';

// Raised when the matching changes, so every document is looked at again
export const DUP_CHECK_VERSION = 1;
// Candidates compared per document, the likeliest first
export const MAX_CANDIDATES = 3;
// Of a text, about as much as Gemini writes out of a scan (classify.ts)
const TEXT_COMPARE_CHARS = 30_000;
// A pair is marked from this many points, of which the texts give at least TEXT_CONFIRM when both have one, with at
// least WORDING_CONFIRM of their wording shared (numbers alone may be the letterhead's and the facts')
const FLAG_SCORE = 10;
const TEXT_CONFIRM = 3;
const WORDING_CONFIRM = 0.5;
// A pair found by meaning alone (the nearest pass) needs texts that are all but the same
const TEXT_ONLY_POINTS = 5;
// Days apart that still count as the same date read a little differently (a scan's date read off by a day or two)
const NEAR_DAYS = 3;
const TEXT_ONLY_DAYS = 7;

// A document's text for the check: there ('ready'), still to be read for the index ('pending'), or none to be had
export type TextState = 'ready' | 'pending' | 'never';

// What the check compares of a document, from its index entry
export interface DupFacts {
  id: string;
  title: string;
  type: DocumentType | null;
  correspondent: string | null;
  // YYYY-MM-DD
  date: string | null;
  amount: number | null;
  currency: string | null;
  // "Label: value · Label: value" (classify.ts)
  references: string | null;
  items: PurchaseItem[];
  topic: string | null;
  addedAt: string;
  // The documents the owner said this one is no copy of (metadata.ts dupTag)
  notDuplicates: string[];
  possibleDuplicateOf: string | null;
}

export const factsOf = (d: IndexedDoc): DupFacts => ({
  id: d.id,
  title: d.title,
  type: d.type,
  correspondent: d.correspondent,
  date: d.date,
  amount: d.amount,
  currency: d.currency,
  references: d.references,
  items: d.items ?? [],
  topic: d.topic,
  addedAt: d.addedAt,
  notDuplicates: d.notDuplicates ?? [],
  possibleDuplicateOf: d.possibleDuplicateOf ?? null,
});

// ---------- Facts ----------

// Legal forms and joining words, which one spelling of a company has and another leaves out
const LEGAL = new Set(['gmbh', 'mbh', 'ag', 'se', 'kg', 'kgaa', 'ohg', 'ug', 'haftungsbeschrankt', 'ev', 'eg', 'gbr', 'co', 'inc', 'ltd', 'llc', 'plc', 'sa', 'sarl', 'bv', 'nv', 'und', 'and']);

// Keys worked out before: the backlog compares each document with every other one, and a library has few senders
const keys = new Map<string, string>();

// "Stadtwerke Musterstadt GmbH" → "stadtwerkemusterstadt"
export function companyKey(name: string | null): string {
  if (!name) return '';
  let key = keys.get(name);
  if (key === undefined) {
    key = fold(name)
      .replace(/[.']/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter(t => t && !LEGAL.has(t))
      .join('');
    if (keys.size >= 10_000) keys.clear();
    keys.set(name, key);
  }
  return key;
}

// The same company, however it was spelled: "Telekom" and "Telekom Deutschland GmbH", but not "AXA" and "AXA ARAG"
export function sameCompany(a: string | null, b: string | null): boolean {
  const x = companyKey(a);
  const y = companyKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 5 && long.startsWith(short);
}

// Whole days between two dates; null when one is missing
export function daysApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const days = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(days) ? Math.round(days) : null;
}

type Money = Pick<DupFacts, 'amount' | 'currency'>;

// Both amounts set and the same (a currency missing on one side doesn't count against it)
export function sameMoney(a: Money, b: Money): boolean {
  return a.amount !== null && b.amount !== null && Math.abs(a.amount - b.amount) < 0.005 && (!a.currency || !b.currency || a.currency === b.currency);
}

// Types Gemini may give one document in either reading. Other pairs of types don't rule a pair out either (one bill
// read as an invoice, then as a statement): their texts decide, and facts alone never mark them.
const FAMILIES: DocumentType[][] = [
  ['invoice', 'receipt'],
  ['letter', 'notice', 'tax', 'form'],
  ['contract', 'policy'],
  ['payslip', 'tax', 'certificate'],
];

export function typesFit(a: DocumentType | null, b: DocumentType | null): 'same' | 'family' | 'unknown' | 'no' {
  if (!a || !b || a === 'other' || b === 'other') return 'unknown';
  if (a === b) return 'same';
  return FAMILIES.some(f => f.includes(a) && f.includes(b)) ? 'family' : 'no';
}

// Types that come again and again with the same facts (a coffee every morning, the same pay every month): never
// marked on their facts alone
const REPEATING = new Set<DocumentType | null>(['receipt', 'payslip', 'statement', 'ticket']);

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  januar: 1, janner: 1, februar: 2, marz: 3, mrz: 3, mai: 5, juni: 6, juli: 7, oktober: 10, okt: 10, dezember: 12, dez: 12,
};

export interface Period {
  month?: number;
  year?: number;
  quarter?: number;
}

// The period a title names, when it names one to tell documents apart ("Payslip October 2025", "Gehaltsabrechnung
// 10/2025", "Q3 2025"; classify.ts asks for titles like that)
export function periodOf(title: string): Period {
  const t = fold(title);
  const period: Period = {};
  const isoMonth = /\b((?:19|20)\d\d)-(0[1-9]|1[0-2])\b/.exec(t);
  const numericMonth = /\b(0?[1-9]|1[0-2])[./]((?:19|20)\d\d)\b/.exec(t);
  const named = (t.match(/[a-z]+/g) ?? []).find(w => MONTHS[w] !== undefined);
  if (isoMonth) period.month = Number(isoMonth[2]);
  else if (numericMonth) period.month = Number(numericMonth[1]);
  else if (named) period.month = MONTHS[named];
  const year = /\b(?:19|20)\d\d\b/.exec(t);
  if (year) period.year = Number(year[0]);
  const quarter = /\bq([1-4])\b/.exec(t) ?? /\b([1-4])\.?\s*quartal\b/.exec(t);
  if (quarter) period.quarter = Number(quarter[1]);
  return period;
}

type RefClass = 'invoice' | 'customer' | 'contract' | 'account' | 'order' | 'tax' | 'other';

// What a reference's label says it is; the first that fits. Short words only at the start of a word ("Kd.-Nr.", not
// "Taxi").
const REF_CLASSES: [RefClass, string[]][] = [
  ['invoice', ['rechnung', 'invoice', 'beleg', 'bon', 'receipt', 'quittung', 'transaktion', 'transaction', 'vorgang']],
  ['customer', ['kunde', 'customer', 'kd']],
  ['contract', ['vertrag', 'contract', 'police', 'policy', 'versicherungsschein', 'versicherungsnummer', 'mitglied', 'member']],
  ['account', ['konto', 'account', 'iban', 'karte', 'card']],
  ['order', ['bestell', 'order', 'auftrag']],
  ['tax', ['steuer', 'tax', 'idnr', 'stnr']],
];

const refClass = (label: string): RefClass =>
  REF_CLASSES.find(([, words]) => words.some(w => (w.length <= 3 ? new RegExp(`(^|[^a-z])${w}`).test(label) : label.includes(w))))?.[0] ?? 'other';

// The references by what they are, their values reduced to letters and digits (of an account or card, its last 4
// digits, as Gemini is asked to give them)
export function refClasses(references: string | null): Map<RefClass, string[]> {
  const classes = new Map<RefClass, string[]>();
  for (const part of (references ?? '').split(' · ')) {
    const at = part.indexOf(':');
    const cls = at > 0 ? refClass(fold(part.slice(0, at))) : 'other';
    let value = fold(at > 0 ? part.slice(at + 1) : part).replace(/[^a-z0-9]/g, '');
    if (cls === 'account') value = value.replace(/\D/g, '').slice(-4);
    if (value) classes.set(cls, [...(classes.get(cls) ?? []), value]);
  }
  return classes;
}

// The references of no known kind by their label, letters only ("Vers.-Nr." → "versnr"): a file or voter number,
// the one number that tells two family members' letters from one template apart
function otherRefs(references: string | null): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const part of (references ?? '').split(' · ')) {
    const at = part.indexOf(':');
    if (at <= 0) continue;
    const label = fold(part.slice(0, at));
    if (refClass(label) !== 'other') continue;
    const key = label.replace(/[^a-z]/g, '');
    const value = fold(part.slice(at + 1)).replace(/[^a-z0-9]/g, '');
    if (key && value) refs.set(key, [...(refs.get(key) ?? []), value]);
  }
  return refs;
}

// The same reference, read in full on one and shortened on the other ("…1234")
const sameValue = (a: string, b: string) => {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.endsWith(short);
};

const shareValue = (a: string[], b: string[]) => a.some(x => b.some(y => sameValue(x, y)));

// The prices of the items bought, as a list to compare (two of the same item cost the same)
const prices = (items: PurchaseItem[]) => items.filter(i => i.price !== null).map(i => (i.price! * 100).toFixed(0));

// Prices on one side and not on the other, the larger count of the two
function priceDifference(a: string[], b: string[]): number {
  const left = [...a];
  let missing = 0;
  for (const p of b) {
    const at = left.indexOf(p);
    if (at >= 0) left.splice(at, 1);
    else missing++;
  }
  return Math.max(missing, left.length);
}

// Whether a pair may be compared at all: two documents, neither marked as a copy already, not told apart by the owner
export function comparable(a: DupFacts, b: DupFacts): boolean {
  if (a.id === b.id || a.possibleDuplicateOf || b.possibleDuplicateOf) return false;
  if (a.notDuplicates.length && a.notDuplicates.includes(dupTag(b.id))) return false;
  return !(b.notDuplicates.length && b.notDuplicates.includes(dupTag(a.id)));
}

// facts: the same company, date and amount; near: the same company, the date a little off or missing, the amount the
// same or missing; money-day: the same amount on the same day, the company read differently (a poor scan)
export type CandidateKind = 'facts' | 'near' | 'money-day';

// The same company and an invoice number both read: one bill whose main amount was read differently
const sameInvoice = (a: DupFacts, b: DupFacts) => {
  const ia = refClasses(a.references).get('invoice');
  const ib = refClasses(b.references).get('invoice');
  return !!ia && !!ib && shareValue(ia, ib) && sameCompany(a.correspondent, b.correspondent);
};

export function candidateKind(a: DupFacts, b: DupFacts): CandidateKind | null {
  if (!comparable(a, b)) return null;
  const days = daysApart(a.date, b.date);
  if (days !== null && days > NEAR_DAYS) return null;
  const money = sameMoney(a, b);
  if (a.amount !== null && b.amount !== null && !money && !sameInvoice(a, b)) return null;
  if (sameCompany(a.correspondent, b.correspondent)) return days === 0 && money ? 'facts' : 'near';
  return days === 0 && money ? 'money-day' : null;
}

export function factsPoints(a: DupFacts, b: DupFacts): number {
  const days = daysApart(a.date, b.date);
  const fit = typesFit(a.type, b.type);
  const refsA = [...refClasses(a.references).values()].flat().filter(v => v.length >= 4);
  const refsB = [...refClasses(b.references).values()].flat().filter(v => v.length >= 4);
  const pricesA = prices(a.items);
  const pricesB = prices(b.items);
  return (
    (sameCompany(a.correspondent, b.correspondent) ? 3 : 0) +
    (days === 0 ? 3 : days !== null && days <= NEAR_DAYS ? 1 : 0) +
    (sameMoney(a, b) ? 3 : 0) +
    (fit === 'same' ? 1 : 0) +
    (shareValue(refsA, refsB) ? 2 : 0) +
    (fold(a.title).trim() === fold(b.title).trim() ? 1 : 0) +
    (pricesA.length >= 2 && pricesB.length >= 2 && priceDifference(pricesA, pricesB) === 0 ? 2 : 0)
  );
}

// ---------- Texts ----------

export interface TextSignals {
  // Numbers, dates, amounts, times and IDs in it ("d:20250314", "a:8745", "x:de89370400440532013000")
  ids: Set<string>;
  // Numbers labelled as the document's own: its invoice, receipt or transaction number
  labelled: Set<string>;
  // Times of day, as till receipts print them
  times: Set<string>;
  // Runs of three words, for its wording
  shingles: Set<string>;
  // Enough of it to compare
  usable: boolean;
}

const LABELLED =
  /\b(rechnungs?\s*-?\s*(?:nr|nummer|no)|invoice\s*(?:no|number|nr|#)|beleg\s*-?\s*(?:nr|nummer)|bon\s*-?\s*(?:nr|nummer)|receipt\s*(?:no|number|#)|transaktions?\s*-?\s*(?:nr|nummer)|vorgangs?\s*-?\s*(?:nr|nummer))\b\.?\s*[:#|]?\s*([a-z0-9][a-z0-9/-]{2,})/g;
const IBAN = /\b[a-z]{2}\d{2}(?: ?[a-z0-9]{4}){3,7}(?: ?[a-z0-9]{1,4})?\b/g;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DAY_FIRST = /\b(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})\b/g;
const TIME = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/g;
// "1.234,56", "1,234.56", "87,45" and "87.45": the whole euros, then the cents
const AMOUNT = /(?<![\d.,])(\d{1,3}(?:[.,' ]\d{3})+|\d+)[.,](\d{2})(?!\d)/g;
const JOINED = /\b\d+(?:[-/]\d+)+\b/g;
const TOKEN = /[a-z0-9]+(?:[-/][a-z0-9]+)*/g;
const DIGITS = /\d{5,}/g;

const pad = (n: string) => n.padStart(2, '0');

// What a text says that tells one document from another of the same kind
export function textSignals(text: string): TextSignals {
  let t = fold(text.slice(0, TEXT_COMPARE_CHARS));
  const ids = new Set<string>();
  const times = new Set<string>();
  const labelled = new Set<string>();
  for (const m of t.matchAll(LABELLED)) {
    // A number, not a word after the label ("the invoice number as reference")
    const value = m[2].replace(/[^a-z0-9]/g, '');
    if (/\d/.test(value)) labelled.add(value);
  }
  const words = t.split(/[^a-z]+/).filter(w => w.length >= 2);
  const shingles = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) shingles.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);

  // Each kind taken out of the text as it is found (replaced by a space), so its digits aren't counted again
  const take = (re: RegExp, id: (m: string, ...groups: string[]) => string | null) => {
    t = t.replace(re, (m: string, ...groups: string[]) => {
      const value = id(m, ...groups);
      if (!value) return m;
      ids.add(value);
      return ' ';
    });
  };
  take(IBAN, m => {
    const compact = m.replace(/ /g, '');
    return compact.length >= 15 && (compact.match(/\d/g) ?? []).length >= 10 ? `x:${compact}` : null;
  });
  take(ISO_DATE, (_m, y, mo, d) => `d:${y}${mo}${d}`);
  take(DAY_FIRST, (_m, d, mo, y) => `d:${y.length === 2 ? `20${y}` : y}${pad(mo)}${pad(d)}`);
  take(TIME, (_m, hh, mm) => {
    const time = `t:${pad(hh)}${mm}`;
    times.add(time);
    return time;
  });
  take(AMOUNT, (_m, whole, cents) => `a:${whole.replace(/\D/g, '')}${cents}`);
  take(JOINED, m => {
    const digits = m.replace(/\D/g, '');
    return digits.length >= 6 ? `n:${digits}` : null;
  });
  take(TOKEN, m => {
    const token = m.replace(/[-/]/g, '');
    const digits = (token.match(/\d/g) ?? []).length;
    return token.length >= 6 && digits >= 2 && digits < token.length ? `x:${token}` : null;
  });
  take(DIGITS, m => `n:${m}`);

  return { ids, labelled, times, shingles, usable: text.trim().length >= 200 && ids.size >= 3 && shingles.size >= 15 };
}

// How much of the smaller set is in the larger one: a one-page scan matches its three-page PDF
export function containment(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const x of small) if (large.has(x)) shared++;
  return shared / small.size;
}

interface TextMatch {
  points: number;
  ids: number;
  shingles: number;
}

// No edit distance: one character's tolerance would make sequential invoice numbers (…0412, …0413) the same, and
// the thresholds leave room for a few OCR slips
function textMatch(a: TextSignals, b: TextSignals): TextMatch {
  const ids = containment(a.ids, b.ids);
  const shingles = containment(a.shingles, b.shingles);
  const idPoints = ids >= 0.95 ? 4 : ids >= 0.85 ? 3 : ids >= 0.6 ? 0 : -4;
  const wordPoints = shingles >= 0.7 ? 2 : shingles >= 0.5 ? 1 : shingles >= 0.3 ? 0 : -2;
  return { points: idPoints + wordPoints, ids, shingles };
}

// ---------- The answer ----------

const disjoint = (a: Set<string>, b: Set<string>) => a.size > 0 && b.size > 0 && ![...a].some(x => b.has(x));

// What tells the two apart for certain, from their facts alone; `periods`: also the month, year or quarter their
// titles name (Gemini's own choice, which texts all but the same overrule)
function factsVeto(a: DupFacts, b: DupFacts, periods = true): string | null {
  const refsA = refClasses(a.references);
  const refsB = refClasses(b.references);
  // In a fixed order, so the answer is the same either way round
  for (const [cls] of REF_CLASSES) {
    if (refsA.has(cls) && refsB.has(cls) && !shareValue(refsA.get(cls)!, refsB.get(cls)!)) return `different ${cls} numbers`;
  }
  // References of no known kind ("Aktenzeichen", "Vers.-Nr."), compared only under the same label
  const othersA = otherRefs(a.references);
  const othersB = otherRefs(b.references);
  for (const label of [...othersA.keys()].sort()) {
    if (othersB.has(label) && !shareValue(othersA.get(label)!, othersB.get(label)!)) return 'different reference numbers';
  }
  const pa: Period = periods ? periodOf(a.title) : {};
  const pb: Period = periods ? periodOf(b.title) : {};
  if (pa.month && pb.month && pa.month !== pb.month) return 'different months';
  if (pa.year && pb.year && pa.year !== pb.year) return 'different years';
  if (pa.quarter && pb.quarter && pa.quarter !== pb.quarter) return 'different quarters';
  const pricesA = prices(a.items);
  const pricesB = prices(b.items);
  // One line more or less is a line Gemini missed
  if (pricesA.length >= 2 && pricesB.length >= 2 && priceDifference(pricesA, pricesB) >= 2) return 'different items';
  return null;
}

// … and with their texts, where both have one
function vetoOf(a: DupFacts, ta: TextSignals | null, b: DupFacts, tb: TextSignals | null): string | null {
  // A title's period is Gemini's own choice: where the texts are all but the same, they decide
  const veto = factsVeto(a, b, !(ta && tb && textMatch(ta, tb).points >= TEXT_ONLY_POINTS));
  if (veto || !ta || !tb) return veto;
  if (disjoint(ta.labelled, tb.labelled)) return 'different document numbers';
  if (disjoint(ta.times, tb.times)) return 'different times';
  return null;
}

const usable = (t: TextSignals | TextState): TextSignals | null => (typeof t !== 'string' && t.usable ? t : null);
const stateOf = (t: TextSignals | TextState): TextState => (typeof t === 'string' ? t : t.usable ? 'ready' : 'never');

const percent = (share: number) => `${Math.round(share * 100)}%`;

function listed(words: string[]): string {
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '');
}

// "same company, date and amount", "same company and amount, 2 days apart"
function factsWhy(a: DupFacts, b: DupFacts): string {
  const days = daysApart(a.date, b.date);
  const same = [sameCompany(a.correspondent, b.correspondent) && 'company', days === 0 && 'date', sameMoney(a, b) && 'amount'].filter((w): w is string => !!w);
  const apart = days ? `${days} ${days === 1 ? 'day' : 'days'} apart` : '';
  return [same.length ? `same ${listed(same)}` : '', apart].filter(Boolean).join(', ');
}

const textWhy = (m: TextMatch) => `${percent(m.ids)} of numbers and ${percent(m.shingles)} of wording shared`;

export interface Verdict {
  // flag: mark it for the owner's check; defer: ask again once the texts are read
  verdict: 'flag' | 'no' | 'defer';
  score: number;
  // For the activity log and tests, in English
  why: string;
}

// Whether `b` may be the same document as `a`. Symmetric: the same answer either way round.
export function compare(a: DupFacts, ta: TextSignals | TextState, b: DupFacts, tb: TextSignals | TextState): Verdict {
  const kind = candidateKind(a, b);
  if (!kind) return { verdict: 'no', score: 0, why: 'not alike' };
  const sa = usable(ta);
  const sb = usable(tb);
  const facts = factsPoints(a, b);
  const veto = vetoOf(a, sa, b, sb);
  if (veto) return { verdict: 'no', score: facts, why: veto };
  // Where both have a text, the texts always have to confirm it
  if (sa && sb) {
    const text = textMatch(sa, sb);
    const score = facts + text.points;
    const confirmed = text.points >= TEXT_CONFIRM && text.shingles >= WORDING_CONFIRM;
    return { verdict: confirmed && score >= FLAG_SCORE ? 'flag' : 'no', score, why: `${factsWhy(a, b)}; ${textWhy(text)}` };
  }
  // A text still to be read may confirm it or tell them apart; one that can't be had (a photo Gemini found no text
  // in) won't, so that pair is answered by its facts now
  if (stateOf(ta) !== 'never' && stateOf(tb) !== 'never') return { verdict: 'defer', score: facts, why: 'a text is still to be read' };
  // On facts alone only what never comes twice with the same facts: no receipt, payslip or statement, nothing of a
  // series (a topic both share)
  const alone =
    kind === 'facts' && !REPEATING.has(a.type) && !REPEATING.has(b.type) && ['same', 'family'].includes(typesFit(a.type, b.type)) && !(a.topic && a.topic === b.topic) && facts >= FLAG_SCORE;
  return { verdict: alone ? 'flag' : 'no', score: facts, why: factsWhy(a, b) };
}

// A pair found by meaning alone (nearest vectors in the backlog), whose facts may have been read differently: the
// texts have to be all but the same
export function compareByText(a: DupFacts, ta: TextSignals | TextState, b: DupFacts, tb: TextSignals | TextState): Verdict {
  const sa = usable(ta);
  const sb = usable(tb);
  if (!comparable(a, b) || !sa || !sb) return { verdict: 'no', score: 0, why: 'not alike' };
  const days = daysApart(a.date, b.date);
  if (!sameCompany(a.correspondent, b.correspondent) && !sameMoney(a, b) && !(days !== null && days <= TEXT_ONLY_DAYS)) return { verdict: 'no', score: 0, why: 'not alike' };
  const veto = vetoOf(a, sa, b, sb);
  const text = textMatch(sa, sb);
  if (veto) return { verdict: 'no', score: text.points, why: veto };
  return { verdict: text.points >= TEXT_ONLY_POINTS ? 'flag' : 'no', score: text.points, why: `nearly the same text; ${textWhy(text)}` };
}

// The documents `self` may be a copy of, judged by their facts, the likeliest first: most points, fewest days apart,
// added closest in time (a rescan comes soon after its original), the oldest. Those their numbers or items already
// tell apart are left out, so they don't take a place; their titles' periods are left to the texts (compare).
export function rankCandidates(self: DupFacts, docs: DupFacts[]): DupFacts[] {
  return docs
    .filter(d => candidateKind(self, d) && !factsVeto(self, d, false))
    .map(d => ({ d, points: factsPoints(self, d), days: daysApart(self.date, d.date) ?? NEAR_DAYS + 1 }))
    .map(x => ({ ...x, gap: Math.abs(Date.parse(x.d.addedAt) - Date.parse(self.addedAt)) }))
    .sort((x, y) => y.points - x.points || x.days - y.days || x.gap - y.gap || x.d.addedAt.localeCompare(y.d.addedAt))
    .slice(0, MAX_CANDIDATES)
    .map(x => x.d);
}

// Of a pair found, the copy is the one added later (by ID when added at the same moment); the other is the original
export function copyAndOriginal(a: DupFacts, b: DupFacts): { copy: DupFacts; original: DupFacts } {
  const later = a.addedAt > b.addedAt || (a.addedAt === b.addedAt && a.id > b.id);
  return later ? { copy: a, original: b } : { copy: b, original: a };
}
