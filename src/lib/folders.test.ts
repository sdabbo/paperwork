import { describe, expect, it } from 'vitest';
import type { CategoryInfo, DocumentInfo } from '../../shared/types';
import { alreadyIn, chosenPlace, commonFolder, folderChoices, placeLabel } from './folders';

const link = (id: string) => `https://drive.google.com/drive/folders/${id}`;
const categories: CategoryInfo[] = [
  { id: 'cat-bills', name: 'Bills & Receipts', description: '', count: 1, webViewLink: link('cat-bills'), folders: [] },
  {
    id: 'cat-ug',
    name: 'Example UG',
    description: 'Documents of my company',
    count: 4,
    webViewLink: link('cat-ug'),
    folders: [
      { id: 'sub-eb', name: 'Eröffnungsbilanz', path: ['Eröffnungsbilanz'], webViewLink: link('sub-eb') },
      { id: 'sub-bank', name: 'Bank', path: ['Eröffnungsbilanz', 'Bank'], webViewLink: link('sub-bank') },
    ],
  },
];

const doc = (id: string, fields: Partial<DocumentInfo>) =>
  ({ id, categoryId: 'cat-ug', category: 'Example UG', inInbox: false, folderPath: ['Example UG', '2026'], folderId: 'y-ug-2026', ...fields }) as DocumentInfo;

const inEb = { folderPath: ['Example UG', 'Eröffnungsbilanz'], folderId: 'sub-eb' };
const waiting = { inInbox: true, folderPath: ['Inbox'], folderId: 'inbox' };
const bills = { categoryId: 'cat-bills', category: 'Bills & Receipts', folderPath: ['Bills & Receipts', '2026'], folderId: 'y-bills-2026' };

describe('folders for documents', () => {
  it('lists each category with its folders for a matter, counting the documents right in each', () => {
    const documents = [doc('a', inEb), doc('b', inEb), doc('c', {}), doc('d', { folderPath: ['Example UG', 'Eröffnungsbilanz', 'Bank'], folderId: 'sub-bank' })];
    expect(folderChoices(categories, documents)).toEqual([
      { value: 'cat-bills', label: 'Bills & Receipts', count: 1 },
      { value: 'cat-ug', label: 'Example UG', count: 4 },
      { value: 'sub-eb', label: 'Example UG / Eröffnungsbilanz', count: 2 },
      { value: 'sub-bank', label: 'Example UG / Eröffnungsbilanz / Bank', count: 1 },
    ]);
    expect(placeLabel(chosenPlace(categories, 'sub-bank')!)).toBe('Example UG / Eröffnungsbilanz / Bank');
    expect(placeLabel(chosenPlace(categories, 'cat-ug')!)).toBe('Example UG');
    expect(chosenPlace(categories, 'y-ug-2026')).toBeNull();
  });

  it('tells which documents a move would leave where they are, as the server does', () => {
    const ug = chosenPlace(categories, 'cat-ug')!;
    const eb = chosenPlace(categories, 'sub-eb')!;
    // A category: anywhere in it but in one of its folders for a matter, or waiting in the Inbox with it as its category
    expect(alreadyIn(doc('year', {}), ug)).toBe(true);
    expect(alreadyIn(doc('root', { folderPath: ['Example UG'], folderId: 'cat-ug' }), ug)).toBe(true);
    expect(alreadyIn(doc('inbox', waiting), ug)).toBe(true);
    expect(alreadyIn(doc('matter', inEb), ug)).toBe(false);
    expect(alreadyIn(doc('other', bills), ug)).toBe(false);
    // A folder for a matter: only the documents right in it
    expect(alreadyIn(doc('matter', inEb), eb)).toBe(true);
    expect(alreadyIn(doc('year', {}), eb)).toBe(false);
    expect(alreadyIn(doc('inbox', waiting), eb)).toBe(false);
  });

  it('starts a move where most of the documents are, a folder for a matter counting apart from its category', () => {
    expect(commonFolder(categories, [doc('a', inEb), doc('b', inEb)])).toBe('sub-eb');
    // Most are in the folder for a matter: moving the rest in, not all of them out to the year folders
    expect(commonFolder(categories, [doc('a', inEb), doc('b', inEb), doc('c', waiting)])).toBe('sub-eb');
    expect(commonFolder(categories, [doc('a', inEb), doc('b', {}), doc('c', waiting)])).toBe('cat-ug');
    expect(commonFolder(categories, [doc('a', inEb), doc('b', bills), doc('c', bills)])).toBe('cat-bills');
    // A tie: the first listed
    expect(commonFolder(categories, [doc('a', inEb), doc('b', bills)])).toBe('cat-bills');
    expect(commonFolder(categories, [doc('a', { categoryId: null, category: null, ...waiting })])).toBe('');
  });
});
