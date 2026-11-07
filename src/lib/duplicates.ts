// Possible duplicates: a document Paperwork found may be a copy of one already in Paperwork (the same letter scanned
// and emailed, say). Its deadlines aren't counted until the owner says what it is: two different documents ("Keep
// both"), the same one (moved to the Duplicates folder), or the same one kept as a file with the original.
import type { Deadline, DocumentInfo } from '../../shared/types';
import { DeadlineItem, fold, heldBack, lapsed, localToday, possibleCopies } from '../../shared/filter';

// A possible copy just moved to the Duplicates folder: the original opens in its place and says so
export interface SetAside {
  id: string;
  title: string;
  originalId: string;
  folderUrl: string | null;
}

// The documents with only the marks that count (shared/filter.ts possibleCopies): a mark naming a document that's
// gone from the library, or one that is marked itself, is cleared. Documents that don't change stay the same objects,
// and the list stays the same list when none does.
export function activeFlags(documents: DocumentInfo[]): DocumentInfo[] {
  const copies = possibleCopies(documents);
  const stale = (d: DocumentInfo) => !!d.possibleDuplicateOf && !copies.has(d.id);
  if (!documents.some(stale)) return documents;
  return documents.map(d => (stale(d) ? { ...d, possibleDuplicateOf: null } : d));
}

// A company's name as compared here: "Stadtwerke Musterstadt GmbH" and "Stadtwerke Musterstadt" are the same company
const companyKey = (name: string | null) => fold(name ?? '').replace(/[^a-z0-9]+/g, '');

const sameCompany = (a: string | null, b: string | null) => {
  const [x, y] = [companyKey(a), companyKey(b)].sort((p, q) => p.length - q.length);
  return !!x && (x === y || (x.length >= 5 && y.startsWith(x)));
};

const sameAmount = (a: DocumentInfo, b: DocumentInfo) =>
  a.amount !== null && b.amount !== null && Math.abs(a.amount - b.amount) < 0.005 && (!a.currency || !b.currency || a.currency === b.currency);

const daysApart = (a: string, b: string) => Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

// Why Paperwork thinks they may be the same, from what it read from both (the server keeps no reason)
export function matchReason(doc: DocumentInfo, original: DocumentInfo): string {
  const company = sameCompany(doc.correspondent, original.correspondent);
  const days = doc.date && original.date ? daysApart(doc.date, original.date) : null;
  if (company && days === 0 && sameAmount(doc, original)) return 'Same company, date and amount.';
  if (company && days && sameAmount(doc, original)) return `Same company and amount, dated ${days} ${days === 1 ? 'day' : 'days'} apart, and nearly the same text.`;
  if (company && days === 0) return 'Same company and date, and nearly the same text.';
  return 'Nearly the same text.';
}

// Deadlines not ticked off yet and not lapsed
export const openOf = (doc: DocumentInfo, today = localToday()): Deadline[] => doc.deadlines.filter(d => !d.done && !lapsed(d, today));

// The copy's open deadlines the original doesn't have (the same day and words): they go with the copy if it is moved
// to Duplicates or kept with the original
export function onlyOnCopy(doc: DocumentInfo, original: DocumentInfo, today = localToday()): Deadline[] {
  const theirs = new Set(original.deadlines.map(d => `${d.date}|${fold(d.what.trim())}`));
  return openOf(doc, today).filter(d => !theirs.has(`${d.date}|${fold(d.what.trim())}`));
}

export interface HeldBack {
  // Open deadlines not counted
  count: number;
  // The documents they are on, each with the one it may be a copy of
  copies: { doc: DocumentInfo; original: DocumentInfo }[];
}

// The open deadlines left out of a list because their document may be a copy, to say so under it; `within` keeps
// those the list would show (the Library's "Coming up" lists two months)
export function heldBackSummary(documents: DocumentInfo[], within: (item: DeadlineItem) => boolean = () => true, today = localToday()): HeldBack {
  const items = heldBack(documents, today).filter(within);
  const originals = possibleCopies(documents);
  const docs = [...new Map(items.map(i => [i.doc.id, i.doc])).values()];
  return { count: items.length, copies: docs.map(doc => ({ doc, original: originals.get(doc.id)! })) };
}
