import { describe, expect, it } from 'vitest';
import type { DocumentInfo } from '../../shared/types';
import { awaitsCheck, destination, inSubfolder, placeOf, toCheck, toCheckWithin } from './review';

const doc = (fields: Partial<DocumentInfo>) =>
  ({ category: 'Example UG', date: '2026-10-20', addedAt: '2026-10-21T09:00:00Z', inInbox: false, folderPath: [], ...fields }) as DocumentInfo;

describe('where a document is and goes', () => {
  it('tells a folder for a matter from a category, a year folder and the Inbox', () => {
    expect(inSubfolder(doc({ folderPath: ['Example UG', 'Eröffnungsbilanz'] }))).toBe(true);
    expect(inSubfolder(doc({ folderPath: ['Example UG', '2026', 'Eröffnungsbilanz'] }))).toBe(true);
    expect(inSubfolder(doc({ folderPath: ['Example UG', '2026'] }))).toBe(false);
    expect(inSubfolder(doc({ folderPath: ['Example UG'] }))).toBe(false);
    expect(inSubfolder(doc({ folderPath: ['Inbox'], inInbox: true }))).toBe(false);
  });

  it('shows a document in its folder for a matter where it is; a category chosen files it in its year folder', () => {
    const placed = doc({ folderPath: ['Example UG', 'Eröffnungsbilanz'] });
    expect(placeOf(placed)).toBe('Example UG / Eröffnungsbilanz');
    // As the server does: its category chosen takes it out of the folder for a matter
    expect(destination(placed, 'Example UG', '2024-01-02')).toBe('Example UG / 2024');
    expect(destination(placed, 'Insurance', '2024-01-02')).toBe('Insurance / 2024');
    expect(destination(doc({ folderPath: ['Example UG', '2026'] }), 'Example UG', '2025-03-01')).toBe('Example UG / 2025');
    expect(placeOf(doc({ folderPath: ['Inbox'], inInbox: true }))).toBe('Inbox → Example UG / 2026');
  });
});

describe('what is to check', () => {
  it('lists documents not checked yet and possible copies, the newest arrivals first', () => {
    const waiting = doc({ id: 'waiting', needsReview: true, inInbox: true, addedAt: '2026-11-03T08:00:00Z' });
    // Automatic mode: filed and not to check, but it may be a copy of another document
    const copy = doc({ id: 'copy', needsReview: false, possibleDuplicateOf: 'bill', addedAt: '2026-11-04T08:00:00Z' });
    const checked = doc({ id: 'checked', needsReview: false });
    expect(awaitsCheck(copy)).toBe(true);
    expect(awaitsCheck(checked)).toBe(false);
    expect(awaitsCheck(doc({ needsReview: false, possibleDuplicateOf: null }))).toBe(false);
    expect(toCheck([checked, waiting, copy]).map(d => d.id)).toEqual(['copy', 'waiting']);
  });
});

describe('the To check count', () => {
  const docs = [
    doc({ id: 'work', categoryId: 'work', needsReview: false, tags: [], deadlines: [] }),
    doc({ id: 'bill', categoryId: 'bills', needsReview: true, tags: [], deadlines: [] }),
    doc({ id: 'copy', categoryId: 'bills', needsReview: false, possibleDuplicateOf: 'other', tags: [], deadlines: [] }),
  ];

  it('counts within the other filters, as many as the chip then lists', () => {
    expect(toCheckWithin(docs, {})).toBe(2);
    expect(toCheckWithin(docs, { categoryId: 'bills' })).toBe(2);
    // A folder with nothing to check
    expect(toCheckWithin(docs, { categoryId: 'work' })).toBe(0);
    // The chip's own filter doesn't change it
    expect(toCheckWithin(docs, { categoryId: 'work', review: true })).toBe(0);
  });
});
