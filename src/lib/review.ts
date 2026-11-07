// Documents waiting for the owner's check (needsReview): in review mode manual every new document waits in the
// Inbox, already shown everywhere, until it is checked; in automatic mode only those Paperwork was unsure about.
// A possible copy of another document is to check too, whatever the review mode, until the owner says what it is.
import { applyFilters } from '../../shared/filter';
import type { DocumentInfo, ViewFilters } from '../../shared/types';

// The year folder a document goes to: its own date's year, or the year it was added (as the server files it)
export const yearOf = (date: string | null | undefined, addedAt: string) => (date || addedAt || new Date().toISOString()).slice(0, 4);

// A folder for a matter, e.g. "Example UG / Eröffnungsbilanz": inside a category, not a year folder (as the server
// tells them apart). A document in one stays there whatever its date, also when it is checked or read again.
export const inSubfolder = (doc: DocumentInfo) =>
  !doc.inInbox && doc.folderPath.length > 1 && !/^\d{4}$/.test(doc.folderPath[doc.folderPath.length - 1]);

// Where checking files a document waiting in the Inbox: "Insurance / 2026" (a folder for a matter chosen for it is
// named by folders.ts folderLabel). `category` and `date` can be the ones being edited.
export function destination(doc: DocumentInfo, category: string | null = doc.category, date: string | null = doc.date): string {
  return category ? `${category} / ${yearOf(date, doc.addedAt)}` : 'its folder';
}

// Where the file is: "Inbox → Insurance / 2026" while it waits in the Inbox, its folder otherwise
export function placeOf(doc: DocumentInfo): string {
  if (doc.inInbox) return doc.category ? `Inbox → ${destination(doc)}` : 'Inbox';
  return doc.folderPath.join(' / ') || 'Paperwork';
}

// The folder a document was just filed in, from the server's answer
export const filedIn = (doc: DocumentInfo) => (doc.inInbox ? 'Inbox' : doc.folderPath.join(' / ') || destination(doc));

// May be a copy of another document (on the app's documents, where a mark naming a document that's gone is cleared:
// lib/duplicates.ts activeFlags)
export const isPossibleCopy = (d: DocumentInfo) => !!d.possibleDuplicateOf;

// In To check: not checked yet, or a possible copy to decide about
export const awaitsCheck = (d: DocumentInfo) => d.needsReview || isPossibleCopy(d);

// How many of the documents the other filters show are to check: what the To check chip lists when tapped, so in a
// folder with nothing to check it shows none (`found`: the documents the search found, as the library has them)
export const toCheckWithin = (documents: DocumentInfo[], filters: ViewFilters, found?: string[]) =>
  applyFilters(documents, { ...filters, review: true }, found).length;

// Everything to check, the newest arrivals first
export const toCheck = (documents: DocumentInfo[]) =>
  documents.filter(awaitsCheck).sort((a, b) => b.addedAt.localeCompare(a.addedAt) || (b.date ?? '').localeCompare(a.date ?? ''));
