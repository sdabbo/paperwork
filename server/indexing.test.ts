// Writing documents into the index: merging Drive with what only the index knows, chunks and embeddings.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentInfo } from '../shared/types.js';
import { DocIndex, MemoryIndexBackend, setIndexForTests } from './docIndex.js';
import type { DriveFile } from './drive.js';
import { DocMeta, fileName } from './metadata.js';
import { billMeta, chunk, docLabels, indexedDoc, prose, testTree, wordVector } from './testing/fixtures.js';

const h = vi.hoisted(() => ({
  embed: null as unknown as (texts: string[], task: string) => Promise<number[][]>,
}));

vi.mock('./gemini.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./gemini.js')>();
  return { ...actual, embed: (texts: string[], task: string) => h.embed(texts, task) };
});

const { carryDone, changed, embedMissing, fromDrive, headerChanged, indexDetails, indexStatus, indexWithText, toInfo } = await import('./indexing.js');
const { headerText, splitText } = await import('./text.js');

let index: DocIndex;
const tree = testTree();
const embedFails = () => {
  h.embed = vi.fn(async () => {
    throw new Error('The embedding model is unavailable.');
  });
};

beforeEach(() => {
  h.embed = vi.fn(async (texts: string[]) => texts.map(t => wordVector(t)));
  index = new DocIndex(new MemoryIndexBackend());
  setIndexForTests(index);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// A document as filing leaves it in Drive: named, labelled and described
function driveFile(meta: Partial<DocMeta> = {}, overrides: Partial<DriveFile> = {}): DriveFile {
  const m = { ...billMeta, ...meta };
  const name = fileName(m, { name: 'scan.pdf', mimeType: 'application/pdf' });
  return {
    id: 'doc1',
    name,
    mimeType: 'application/pdf',
    parents: ['bills-2025'],
    ...docLabels(m, name),
    starred: false,
    createdTime: '2026-10-16T08:00:00.000Z',
    modifiedTime: '2026-10-16T09:00:00.000Z',
    size: '48213',
    md5Checksum: 'md5-of-the-file',
    webViewLink: 'https://drive.google.com/file/d/doc1/view',
    hasThumbnail: true,
    ...overrides,
  };
}

const longReferences = Array.from({ length: 6 }, (_, i) => `Contract ${i + 1}: DE-2025-${String(i + 1).repeat(8)}`).join(' · ');

describe('an index entry from Drive', () => {
  it('takes what Drive knows, and starts without text or embeddings', () => {
    const entry = fromDrive(tree, driveFile(), null);
    expect(entry).toMatchObject({
      id: 'doc1',
      title: 'Electricity bill March',
      category: 'Bills & Receipts',
      folderPath: ['Bills & Receipts', '2025'],
      correspondent: 'Stadtwerke Musterstadt',
      amount: 87.45,
      dueDate: '2025-04-25',
      // Read back from the deadlines written into the description
      deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: false }],
      references: 'Customer: 88123',
      textSource: null,
      textLength: 0,
      md5: 'md5-of-the-file',
      embedded: false,
    });
    expect(Date.parse(entry.indexedAt)).not.toBeNaN();
  });

  it('keeps long values whole where Drive holds a shortened copy', () => {
    const correspondent = 'Stadtwerke Musterstadt Versorgungs GmbH, Kundenservice Energie und Wasser, Emmy-Noether-Straße 2, 12345 Musterstadt, Deutschland';
    const action = 'Pay 87.45 EUR by 2025-04-25 to IBAN DE02 1203 0000 0000 2020 51, quoting customer number 88123 and invoice number 2025-0042';
    const title = 'Electricity bill for March 2025 with the annual meter reading, the new tariff from April onwards and the new monthly instalment';
    const meta = { references: longReferences, correspondent, action, title };
    const file = driveFile(meta);
    for (const key of ['pwRef', 'pwFrom', 'pwTodo', 'pwTitle']) expect(file.properties![key].endsWith('…')).toBe(true);

    const previous = indexedDoc('doc1', meta);
    const entry = fromDrive(tree, file, previous);
    expect(entry).toMatchObject(meta);
    // Without the index, the shortened copies are all there is
    expect(fromDrive(tree, file, null).references).toBe(file.properties!.pwRef);
  });

  it("takes Drive's value when it isn't shortened, or when the index has a different one", () => {
    const shortened = driveFile({ references: longReferences });
    expect(fromDrive(tree, shortened, indexedDoc('doc1', { references: `Policy: 1 · ${longReferences}` })).references).toBe(shortened.properties!.pwRef);
    expect(fromDrive(tree, driveFile({ references: 'Customer: 1' }), indexedDoc('doc1', { references: 'Customer: 1 · Contract: 2' })).references).toBe('Customer: 1');
  });

  it('lets what filing or an edit just set win over both', () => {
    const entry = fromDrive(tree, driveFile({ references: longReferences }), indexedDoc('doc1', { references: longReferences, correspondent: 'Old' }), {
      title: 'Edited title',
      references: null,
      correspondent: 'New sender',
      action: null,
      tags: ['edited'],
    });
    expect(entry).toMatchObject({ title: 'Edited title', references: null, correspondent: 'New sender', action: null, tags: ['edited'] });
  });

  it('keeps the full list of tags when Drive could only hold the first few', () => {
    const tags = ['electricity', 'utilities', 'stadtwerke musterstadt', 'annual statement 2025', 'customer number 88123', 'meter reading', 'household', 'tariff change'];
    const file = driveFile({ tags });
    expect(file.properties!.pwTags.endsWith('…')).toBe(true);
    expect(fromDrive(tree, file, indexedDoc('doc1', { tags })).tags).toEqual(tags);
    // Tags the index has that don't start the same way are not Drive's tags shortened
    expect(fromDrive(tree, file, indexedDoc('doc1', { tags: ['other'] })).tags).toEqual(file.properties!.pwTags.split(','));
    // Tags that fit in Drive are Drive's
    expect(fromDrive(tree, driveFile({ tags: ['home'] }), indexedDoc('doc1', { tags: ['home', 'garden'] })).tags).toEqual(['home']);
  });

  it("keeps the index's deadlines, with what is done, when Drive has only the main due date", () => {
    const deadlines = [
      { date: '2025-04-25', what: 'Pay 87.45 EUR', done: true },
      { date: '2025-12-31', what: 'Contract ends', done: false },
    ];
    expect(fromDrive(tree, driveFile(), indexedDoc('doc1', { deadlines })).deadlines).toEqual(deadlines);
  });

  it('carries "done" over to the same deadline when the document is read again', () => {
    const previous = indexedDoc('doc1', { deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: true }] });
    const entry = fromDrive(tree, driveFile(), previous, {
      deadlines: [
        { date: '2025-04-25', what: ' pay 87.45 eur ', done: false },
        { date: '2025-04-26', what: 'Pay 87.45 EUR', done: false },
        { date: '2025-12-31', what: 'Contract ends', done: false },
      ],
    });
    expect(entry.deadlines.map(d => d.done)).toEqual([true, false, false]);
  });

  it('takes deadlines edited in the app as they are, so a deadline can be ticked off and on again', () => {
    const previous = indexedDoc('doc1', { deadlines: [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: true }] });
    const given = [{ date: '2025-04-25', what: 'Pay 87.45 EUR', done: false }];
    expect(fromDrive(tree, driveFile(), previous, { deadlines: given, deadlinesAsGiven: true }).deadlines).toEqual(given);
  });

  it("keeps the text's source and length unless new text comes with it", () => {
    const previous = indexedDoc('doc1', { textSource: 'ocr', textLength: 1234, embedded: true, indexedAt: '2026-01-01T00:00:00.000Z' });
    expect(fromDrive(tree, driveFile(), previous)).toMatchObject({ textSource: 'ocr', textLength: 1234, embedded: true, indexedAt: '2026-01-01T00:00:00.000Z' });
    expect(fromDrive(tree, driveFile(), previous, { text: { text: 'Hello there', source: 'pdf' } })).toMatchObject({ textSource: 'pdf', textLength: 11 });
  });

  it("keeps the file's checksum, or the one the index has when Drive gives none", () => {
    expect(fromDrive(tree, driveFile({}, { md5Checksum: undefined }), indexedDoc('doc1', { md5: 'known' })).md5).toBe('known');
    expect(fromDrive(tree, driveFile({}, { md5Checksum: undefined }), null).md5).toBeNull();
    expect(fromDrive(tree, driveFile(), indexedDoc('doc1', { md5: 'old' })).md5).toBe('md5-of-the-file');
  });

  it('follows a rename, a move and a star made in Drive', () => {
    const previous = fromDrive(tree, driveFile(), null);
    const entry = fromDrive(tree, driveFile({}, { name: 'Strom März.pdf', parents: ['insurance'], starred: true }), previous);
    expect(entry).toMatchObject({ name: 'Strom März.pdf', title: 'Strom März', category: 'Insurance', folderPath: ['Insurance'], starred: true });
  });

  it('takes the mark of a possible copy and the owner’s “Keep both” answers from Drive, and keeps whether it was checked', () => {
    const labelled = (properties: Record<string, string>, overrides: Partial<DriveFile> = {}) => {
      const file = driveFile({}, overrides);
      return { ...file, properties: { ...file.properties, ...properties } };
    };
    const entry = fromDrive(tree, labelled({ pwMaybeDup: 'original', pwNotDup: 'AAAAAAAA,BBBBBBBB,broken' }), null);
    expect(entry).toMatchObject({ possibleDuplicateOf: 'original', notDuplicates: ['AAAAAAAA', 'BBBBBBBB'] });
    expect(entry).not.toHaveProperty('dupChecked');
    // Drive is the truth for both: taken off there, gone here
    const previous = { ...entry, dupChecked: 1 };
    const unmarked = fromDrive(tree, driveFile(), previous);
    expect(unmarked).not.toHaveProperty('possibleDuplicateOf');
    expect(unmarked).not.toHaveProperty('notDuplicates');
    expect(unmarked.dupChecked).toBe(1);
    expect(fromDrive(tree, driveFile(), previous, { dupChecked: 0 }).dupChecked).toBe(0);
    // New content is checked again
    expect(fromDrive(tree, driveFile({}, { md5Checksum: 'new-content' }), previous)).not.toHaveProperty('dupChecked');
  });
});

describe('carrying "done" over', () => {
  it('matches the same date and description, ignoring case and spaces', () => {
    const previous = [
      { date: '2025-01-01', what: 'Pay', done: true },
      { date: '2025-02-01', what: 'Reply', done: false },
    ];
    expect(carryDone([{ date: '2025-01-01', what: 'PAY ', done: false }], previous)).toEqual([{ date: '2025-01-01', what: 'PAY ', done: true }]);
    expect(carryDone([{ date: '2025-02-01', what: 'Reply', done: true }], previous)[0].done).toBe(true);
    expect(carryDone([{ date: '2025-03-01', what: 'Pay', done: false }], previous)[0].done).toBe(false);
    expect(carryDone([{ date: '2025-03-01', what: 'Pay', done: false }], undefined)[0].done).toBe(false);
  });
});

describe('what counts as a change', () => {
  const base = indexedDoc('a', { summary: 'A bill.', tags: ['home'], deadlines: [{ date: '2025-01-01', what: 'Pay', done: false }] });

  it('is anything the app shows', () => {
    expect(changed(null, base)).toBe(true);
    expect(changed(base, structuredClone(base))).toBe(false);
    for (const change of [{ starred: true }, { name: 'x.pdf' }, { folderPath: ['Insurance'] }, { textLength: 10 }, { md5: 'x' }, { summary: 'B' }, { deadlines: [{ date: '2025-01-01', what: 'Pay', done: true }] }]) {
      expect(changed(base, { ...base, ...change })).toBe(true);
    }
  });

  it("isn't the index's own bookkeeping", () => {
    expect(changed(base, { ...base, indexedAt: '2030-01-01T00:00:00.000Z', embedded: true, indexTries: 2, dupChecked: 1 })).toBe(false);
  });

  it('is a mark as a possible copy, or a “Keep both” answer, set or taken off', () => {
    expect(changed(base, { ...base, possibleDuplicateOf: 'b' })).toBe(true);
    expect(changed({ ...base, possibleDuplicateOf: 'b' }, base)).toBe(true);
    expect(changed(base, { ...base, notDuplicates: ['AAAAAAAA'] })).toBe(true);
    expect(headerChanged(base, { ...base, possibleDuplicateOf: 'b', notDuplicates: ['AAAAAAAA'] })).toBe(false);
  });

  it('needs a new header embedding only when the facts in the header change', () => {
    expect(headerChanged(null, base)).toBe(true);
    for (const change of [{ title: 'x' }, { summary: 'B' }, { tags: ['work'] }, { category: 'Insurance' }, { amount: 3 }, { deadlines: [] }]) {
      expect(headerChanged(base, { ...base, ...change })).toBe(true);
    }
    for (const change of [{ starred: true }, { name: 'x.pdf' }, { folderPath: ['x'] }, { textLength: 99 }]) {
      expect(headerChanged(base, { ...base, ...change })).toBe(false);
    }
  });
});

describe('indexing a document with its text', () => {
  const doc = indexedDoc('doc1', { title: 'Car insurance policy', summary: 'Allianz car insurance.', textSource: 'pdf' });

  it('writes the details as chunk 0 and the text as the chunks after it, all embedded', async () => {
    const text = Array.from({ length: 12 }, (_, i) => prose(6, i + 1)).join('\n\n');
    const saved = await indexWithText({ ...doc, textLength: text.length }, text);
    const pieces = splitText(text);
    expect(pieces.length).toBeGreaterThan(1);

    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.embed).toHaveBeenCalledWith([headerText(doc), ...pieces], 'RETRIEVAL_DOCUMENT');
    const chunks = await index.chunks('doc1');
    expect(chunks.map(c => c.n)).toEqual(pieces.map((_, i) => i).concat(pieces.length));
    expect(chunks[0].text).toBe(headerText(doc));
    expect(chunks.slice(1).map(c => c.text)).toEqual(pieces);
    expect(chunks.every(c => c.embedding?.length)).toBe(true);

    expect(saved).toMatchObject({ embedded: true, indexTries: 0 });
    expect(await index.get('doc1')).toEqual(saved);
  });

  it('replaces the chunks of an earlier, longer text', async () => {
    await index.putChunks('doc1', [0, 1, 2, 3, 4].map(n => chunk('doc1', n, `old ${n}`, [1])));
    await indexWithText(doc, 'A short text.');
    expect((await index.chunks('doc1')).map(c => c.text)).toEqual([headerText(doc), 'A short text.']);
  });

  it('writes only the details for a document without text', async () => {
    await indexWithText({ ...doc, textSource: 'none' }, '');
    expect((await index.chunks('doc1')).map(c => c.n)).toEqual([0]);
  });

  it('still writes the document and its text when embedding fails, to be embedded later', async () => {
    embedFails();
    const saved = await indexWithText({ ...doc, indexTries: 2 }, 'Some text.');
    expect(saved).toMatchObject({ embedded: false, indexTries: 0, textSource: 'pdf' });
    expect(await index.get('doc1')).toMatchObject({ embedded: false });
    const chunks = await index.chunks('doc1');
    expect(chunks.map(c => [c.n, c.embedding])).toEqual([
      [0, null],
      [1, null],
    ]);
  });

  it('indexes the start of a very long document', async () => {
    const text = prose(12_000).slice(0, 150_000);
    await indexWithText(doc, text);
    const chunks = await index.chunks('doc1');
    expect(chunks).toHaveLength(46);
    expect(text.startsWith(chunks[1].text)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('only the first 45'));
  });
});

describe('indexing changed details', () => {
  async function indexed() {
    const doc = indexedDoc('doc1', { summary: 'A bill.', textSource: 'pdf' });
    return indexWithText(doc, 'The text of the bill.');
  }

  it("writes the entry alone when the header's facts are unchanged", async () => {
    const previous = await indexed();
    const before = await index.chunks('doc1');
    vi.mocked(h.embed).mockClear();
    const saved = await indexDetails({ ...previous, starred: true }, previous);
    expect(h.embed).not.toHaveBeenCalled();
    expect(saved).toMatchObject({ starred: true, embedded: true });
    expect(await index.get('doc1')).toMatchObject({ starred: true });
    expect(await index.chunks('doc1')).toEqual(before);
  });

  it('embeds the header again, and only the header, when its facts changed', async () => {
    const previous = await indexed();
    const [, textChunk] = await index.chunks('doc1');
    vi.mocked(h.embed).mockClear();
    const next = { ...previous, summary: 'A bill for March, paid.' };
    const saved = await indexDetails(next, previous);
    expect(h.embed).toHaveBeenCalledTimes(1);
    expect(h.embed).toHaveBeenCalledWith([headerText(next)], 'RETRIEVAL_DOCUMENT');
    const chunks = await index.chunks('doc1');
    expect(chunks[0]).toEqual(chunk('doc1', 0, headerText(next), wordVector(headerText(next))));
    expect(chunks[1]).toEqual(textChunk);
    expect(saved.embedded).toBe(true);
  });

  it('marks a new document as not yet searchable until its text is read', async () => {
    const saved = await indexDetails(indexedDoc('doc2', { textSource: null }), null);
    expect(saved.embedded).toBe(false);
    expect((await index.chunks('doc2')).map(c => [c.n, !!c.embedding])).toEqual([[0, true]]);
  });

  it('marks a new document without any text as searchable once its header is embedded', async () => {
    expect((await indexDetails(indexedDoc('doc2', { textSource: 'none' }), null)).embedded).toBe(true);
  });

  it('keeps a document whose text was never embedded marked for another try', async () => {
    const previous = indexedDoc('doc1', { textSource: 'pdf', embedded: false });
    await index.putChunks('doc1', [chunk('doc1', 0, headerText(previous)), chunk('doc1', 1, 'text')]);
    const saved = await indexDetails({ ...previous, starred: true }, previous);
    expect(saved.embedded).toBe(false);
    expect((await index.chunks('doc1'))[1].embedding).toBeNull();
  });

  it('writes the details without an embedding when embedding fails', async () => {
    const previous = await indexed();
    embedFails();
    const saved = await indexDetails({ ...previous, summary: 'Changed.' }, previous);
    expect(saved.embedded).toBe(false);
    expect((await index.chunks('doc1'))[0]).toMatchObject({ text: headerText({ ...previous, summary: 'Changed.' }), embedding: null });
    expect(await index.get('doc1')).toMatchObject({ summary: 'Changed.', embedded: false });
  });
});

describe('embedding what is missing', () => {
  it('embeds only the chunks without an embedding', async () => {
    const doc = indexedDoc('doc1', { textSource: 'pdf', embedded: false });
    await index.putChunks('doc1', [chunk('doc1', 0, headerText(doc), [1, 2]), chunk('doc1', 1, 'one'), chunk('doc1', 2, 'two', [3, 4])]);
    const saved = await embedMissing(doc);
    expect(h.embed).toHaveBeenCalledWith(['one'], 'RETRIEVAL_DOCUMENT');
    expect(saved.embedded).toBe(true);
    expect(await index.get('doc1')).toMatchObject({ embedded: true });
    expect((await index.chunks('doc1')).map(c => c.embedding)).toEqual([[1, 2], wordVector('one'), [3, 4]]);
  });

  it('writes the header again when its facts changed since', async () => {
    const doc = indexedDoc('doc1', { textSource: 'pdf', summary: 'New summary.' });
    await index.putChunks('doc1', [chunk('doc1', 0, 'Title: an old header', [1, 2]), chunk('doc1', 1, 'one', [3, 4])]);
    await embedMissing(doc);
    expect(h.embed).toHaveBeenCalledWith([headerText(doc)], 'RETRIEVAL_DOCUMENT');
    expect((await index.chunks('doc1'))[0]).toEqual(chunk('doc1', 0, headerText(doc), wordVector(headerText(doc))));
  });

  it('adds a missing header', async () => {
    const doc = indexedDoc('doc1', { textSource: 'pdf' });
    await index.putChunks('doc1', [chunk('doc1', 1, 'one', [3, 4])]);
    await embedMissing(doc);
    expect((await index.chunks('doc1')).map(c => [c.n, c.text])).toEqual([
      [0, headerText(doc)],
      [1, 'one'],
    ]);
  });

  it('asks for nothing when everything is embedded', async () => {
    const doc = indexedDoc('doc1', { textSource: 'pdf', embedded: false });
    await index.putChunks('doc1', [chunk('doc1', 0, headerText(doc), [1]), chunk('doc1', 1, 'one', [2])]);
    expect((await embedMissing(doc)).embedded).toBe(true);
    expect(h.embed).not.toHaveBeenCalled();
  });

  it('fails when embedding fails, so the caller can count the try or wait for the budget', async () => {
    const doc = indexedDoc('doc1', { textSource: 'pdf' });
    await index.putChunks('doc1', [chunk('doc1', 0, headerText(doc)), chunk('doc1', 1, 'one')]);
    embedFails();
    await expect(embedMissing(doc)).rejects.toThrow('unavailable');
    expect(await index.get('doc1')).toBeNull();
  });
});

describe('index status and what the app gets', () => {
  it('counts documents searchable by meaning and those still waiting', () => {
    const docs = [
      indexedDoc('a', { textSource: 'pdf', embedded: true }),
      indexedDoc('b', { textSource: 'none', embedded: true }),
      indexedDoc('c', { textSource: null, embedded: false }),
      indexedDoc('d', { textSource: 'ocr', embedded: false }),
      indexedDoc('e', { textSource: null, embedded: true }),
    ];
    expect(indexStatus(docs)).toEqual({ documents: 5, searchable: 2, pending: 3, paused: false, topicsPending: 0 });
    expect(indexStatus([], true)).toEqual({ documents: 0, searchable: 0, pending: 0, paused: true, topicsPending: 0 });
  });

  it("leaves out the index's bookkeeping", () => {
    const info = toInfo(indexedDoc('a', { md5: 'x', embedded: true, indexTries: 2, removedAt: '2026-01-01T00:00:00.000Z', notDuplicates: ['AAAAAAAA'], dupChecked: 1 }));
    const expected: DocumentInfo = structuredClone(indexedDoc('a'));
    for (const key of ['md5', 'embedded', 'indexedAt', 'indexTries', 'removedAt', 'described']) delete (expected as any)[key];
    expect(info).toEqual(expected);
    expect(Object.keys(info).sort()).toEqual(Object.keys(expected).sort());
  });
});

describe('after the follow-up fixes', () => {
  it('leaves documents it gave up on out of those still waiting', () => {
    const docs = [
      indexedDoc('a', { textSource: null, embedded: false, indexTries: 3 }),
      indexedDoc('b', { textSource: null, embedded: false, indexTries: 1 }),
      indexedDoc('c', { textSource: 'pdf', embedded: true, indexTries: 5 }),
    ];
    expect(indexStatus(docs)).toEqual({ documents: 3, searchable: 1, pending: 1, paused: false, topicsPending: 0 });
  });

  it("doesn't count ticking a deadline off as a change to the header", () => {
    const a = indexedDoc('a', { deadlines: [{ date: '2026-11-30', what: 'Cancel', done: false }] });
    expect(headerChanged(a, { ...a, deadlines: [{ date: '2026-11-30', what: 'Cancel', done: true }] })).toBe(false);
    expect(headerChanged(a, { ...a, deadlines: [{ date: '2026-12-01', what: 'Cancel', done: false }] })).toBe(true);
  });
});
