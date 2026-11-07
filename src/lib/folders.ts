// The folders documents are filed in: the categories, and the folders for a matter inside them ("Example UG /
// Eröffnungsbilanz"), where documents stay whatever their date.
import type { CategoryInfo, DocumentInfo, SubfolderInfo } from '../../shared/types';
import { inSubfolder } from './review';

export interface Place {
  category: CategoryInfo;
  // The folder for a matter, or null for the category itself
  folder: SubfolderInfo | null;
}

// The category a folder ID is in, and the folder for a matter when it is one
export function chosenPlace(categories: CategoryInfo[], id: string): Place | null {
  for (const category of categories) {
    if (category.id === id) return { category, folder: null };
    const folder = category.folders.find(f => f.id === id);
    if (folder) return { category, folder };
  }
  return null;
}

export const folderLabel = (category: CategoryInfo, folder: SubfolderInfo) => [category.name, ...folder.path].join(' / ');

export const placeLabel = (place: Place) => (place.folder ? folderLabel(place.category, place.folder) : place.category.name);

// Each category followed by its folders for a matter, with their numbers of documents (a category's includes those in
// its folders), for the Library's Folder filter
export function folderChoices(categories: CategoryInfo[], documents: DocumentInfo[]): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const doc of documents) if (doc.folderId) counts.set(doc.folderId, (counts.get(doc.folderId) ?? 0) + 1);
  return categories.flatMap(c => [
    { value: c.id, label: c.name, count: c.count },
    ...c.folders.map(f => ({ value: f.id, label: folderLabel(c, f), count: counts.get(f.id) ?? 0 })),
  ]);
}

// Whether moving a document to `place` would leave it where it is, as the server decides (server/pipeline.ts
// moveTopic): in that folder for a matter or, for a category, anywhere in it but in one of its folders for a matter
// (a document waiting in the Inbox for its check counts as in its category)
export const alreadyIn = (doc: DocumentInfo, place: Place) =>
  place.folder ? doc.folderId === place.folder.id : doc.categoryId === place.category.id && !inSubfolder(doc);

// Where most of these documents are: a folder for a matter, or a category (in its year folders, or waiting in the
// Inbox for it); the first listed on a tie, '' when none is known. A move starts there, so it doesn't take documents
// out of their folder for a matter unless that is chosen.
export function commonFolder(categories: CategoryInfo[], documents: DocumentInfo[]): string {
  const counts = new Map<string, number>();
  for (const doc of documents) {
    const id = inSubfolder(doc) ? doc.folderId : doc.categoryId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best = '';
  for (const id of categories.flatMap(c => [c.id, ...c.folders.map(f => f.id)])) if ((counts.get(id) ?? 0) > (counts.get(best) ?? 0)) best = id;
  return best;
}
