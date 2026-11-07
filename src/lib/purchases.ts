// What was bought: every item of every till receipt and shop's invoice in the library, with the shop, the day and
// the price, and whether it can still be returned or is under warranty (the document's deadlines with a kind).
// Worked out in the browser from the library, like the company and topic lists.
import type { Deadline, DocumentInfo, PurchaseItem } from '../../shared/types';
import { fold, localToday, possibleCopies } from '../../shared/filter';
import { newestFirst } from './companies';

export interface Purchase {
  doc: DocumentInfo;
  item: PurchaseItem;
  // Its line on the document, which tells two equal lines apart
  line: number;
  // Its name, details, code and shop, folded for searching ("norrona" finds Norrøna)
  text: string;
}

// Every item bought, the newest purchase first; a document's items in the order it lists them. A possible copy of
// another document (the same receipt photographed twice) is left out until the owner decides, so its items aren't
// listed twice.
export function purchases(documents: DocumentInfo[]): Purchase[] {
  const copies = possibleCopies(documents);
  return documents
    .filter(doc => !copies.has(doc.id))
    .sort(newestFirst)
    .flatMap(doc =>
      (doc.items ?? []).map((item, line) => ({
        doc,
        item,
        line,
        text: fold([item.name, item.details, item.code, doc.correspondent].filter(Boolean).join(' ')),
      }))
    );
}

// The purchases with every word of the query in their name, details, code or shop
export function findPurchases(list: Purchase[], query: string): Purchase[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  return terms.length ? list.filter(p => terms.every(t => p.text.includes(t))) : list;
}

// The last day to return it, while that is still ahead (today included) and not ticked off
export const returnBy = (doc: DocumentInfo, today = localToday()): Deadline | null =>
  doc.deadlines.find(d => d.kind === 'return' && !d.done && d.date >= today) ?? null;

// The end of its warranty, while that is still ahead (the latest, should a document give two)
export const warrantyUntil = (doc: DocumentInfo, today = localToday()): Deadline | null =>
  doc.deadlines.filter(d => d.kind === 'warranty' && d.date > today).pop() ?? null;
