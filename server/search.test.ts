// Searching by meaning (the index) and by words (Drive's full-text search), ranked together.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDrive } from './testing/fakeDrive.js';
import { MemoryStore, setStoreForTests } from './store.js';
import { ChunkHit, DocIndex, MemoryIndexBackend, setIndexForTests } from './docIndex.js';
import { billMeta, chunk, docLabels, indexedDoc } from './testing/fixtures.js';

const h = vi.hoisted(() => ({
  fake: null as unknown as import('./testing/fakeDrive.js').FakeDrive,
  connection: null as any,
  embed: null as unknown as (texts: string[], task: string) => Promise<number[][]>,
}));

vi.mock('./google.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./google.js')>();
  return {
    ...actual,
    getConnection: async () => h.connection,
    rememberRootFolder: async (id: string) => {
      h.connection.rootFolderId = id;
    },
  };
});

vi.mock('./gemini.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./gemini.js')>();
  return { ...actual, embed: (texts: string[], task: string) => h.embed(texts, task) };
});

const { fuse, search, semanticRanking, snippet } = await import('./search.js');
const { loadTree, forgetTree } = await import('./vault.js');
const { Drive } = await import('./drive.js');

let index: DocIndex;
const drive = () => new Drive({ accessToken: async () => 'token', fetch: h.fake.fetch, sleep: async () => {} });

beforeEach(() => {
  h.fake = new FakeDrive();
  h.connection = { ownerEmail: 'me@example.com', refreshToken: 'sealed', scope: '', connectedAt: '' };
  // The question "car insurance" points this way; the stored chunks below point near it or away
  h.embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0, 0]));
  setStoreForTests(new MemoryStore());
  index = new DocIndex(new MemoryIndexBackend());
  setIndexForTests(index);
  forgetTree();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const hit = (fileId: string, distance: number, n = 1, text = `${fileId} text`): ChunkHit => ({ fileId, n, text, distance });

describe('snippets', () => {
  const long = `${'Allgemeine Bedingungen. '.repeat(20)}Ihre Kfz-Versicherung (car insurance) beginnt am 1. Dezember. ${'Weitere Hinweise. '.repeat(20)}`;

  it('show the passage around the first word of the query that occurs', () => {
    const s = snippet(long, 'car insurance');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('Kfz-Versicherung (car insurance) beginnt');
    expect(s.length).toBe(220 + 2);
    // A little of what comes before, for context
    expect(s.indexOf('car')).toBe(61);
  });

  it('start at the beginning when no word of the query occurs', () => {
    const s = snippet(long, 'pension');
    expect(s.startsWith('Allgemeine Bedingungen.')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });

  it('ignore words of one or two letters, which occur everywhere', () => {
    expect(snippet(long, 'an in insurance').indexOf('insurance')).toBeLessThan(80);
  });

  it('flatten line breaks and runs of spaces', () => {
    expect(snippet('Line one\n\nline   two\tand three', 'two')).toBe('Line one line two and three');
  });

  it('show a short text whole', () => {
    expect(snippet('Premium 412,80 EUR, due 1 December.', 'premium')).toBe('Premium 412,80 EUR, due 1 December.');
  });
});

describe('ranking by meaning', () => {
  it("takes each document's best chunk, best documents first", () => {
    const ranked = semanticRanking([hit('a', 0.3, 1), hit('b', 0.25, 2), hit('a', 0.2, 0), hit('b', 0.31, 3)]);
    expect(ranked.map(h => [h.fileId, h.n])).toEqual([
      ['a', 0],
      ['b', 2],
    ]);
  });

  it('drops documents much further away than the best one', () => {
    expect(semanticRanking([hit('a', 0.2), hit('b', 0.34), hit('c', 0.36), hit('d', 0.9)]).map(h => h.fileId)).toEqual(['a', 'b']);
  });

  it('never keeps a document that is far off, even when it is the best there is', () => {
    expect(semanticRanking([hit('a', 0.5), hit('b', 0.62)]).map(h => h.fileId)).toEqual(['a']);
    expect(semanticRanking([hit('a', 0.65), hit('b', 0.7)])).toEqual([]);
  });

  it('is empty without hits', () => {
    expect(semanticRanking([])).toEqual([]);
  });
});

describe('fusing rankings', () => {
  it('scores by rank: 1 / (30 + rank)', () => {
    const scores = fuse([['a', 'b', 'c']]);
    expect(scores.get('a')).toBeCloseTo(1 / 31);
    expect(scores.get('b')).toBeCloseTo(1 / 32);
    expect(scores.get('c')).toBeCloseTo(1 / 33);
  });

  it('adds up the scores of a document found both ways', () => {
    const scores = fuse([
      ['a', 'b'],
      ['c', 'b'],
    ]);
    expect(scores.get('b')).toBeCloseTo(2 / 32);
    // Found both ways, second each time, beats first in only one of them
    expect(scores.get('b')!).toBeGreaterThan(scores.get('a')!);
    expect(scores.get('a')).toBeCloseTo(scores.get('c')!);
  });

  it('is empty for no rankings', () => {
    expect(fuse([]).size).toBe(0);
    expect(fuse([[], []]).size).toBe(0);
  });
});

describe('searching', () => {
  // Documents in Drive and the index: some found by meaning, some by words, some not at all
  async function library() {
    const tree = await loadTree(drive());
    const root = h.fake.find('Paperwork')!;
    const folder = (name: string) => h.fake.childrenOf(root.id).find(f => f.name === name)!.id;
    const add = (name: string, folderId: string, content: string) =>
      h.fake.add({ name, parents: [folderId], ...docLabels({ ...billMeta, title: name }, name), content: new TextEncoder().encode(content) });

    const policy = add('Car policy.pdf', folder('Insurance'), 'Allianz car insurance policy for the VW Golf');
    const bill = add('Electricity.pdf', folder('Bills & Receipts'), 'Stadtwerke electricity bill');
    const household = add('Household.pdf', folder('Housing'), 'Hausrat und Haftpflicht');
    const letter = add('Letter.pdf', folder('Insurance'), 'About your car insurance: the premium rises');
    const unindexed = add('New.pdf', folder('Insurance'), 'Another car insurance letter, not in the index yet');
    const outside = h.fake.add({ name: 'Elsewhere.pdf', parents: [h.fake.myDriveRoot], properties: { paperwork: 'doc' }, content: new TextEncoder().encode('car insurance kept elsewhere') });

    for (const f of [policy, bill, household, letter, outside]) await index.put(indexedDoc(f.id, { name: f.name }));
    await index.putChunks(policy.id, [
      chunk(policy.id, 0, 'Title: Car policy', [0.8, 0.2, 0]),
      chunk(policy.id, 1, 'Kfz-Haftpflicht und Vollkasko für den VW Golf. Car insurance with Allianz, 412,80 EUR a year.', [0.95, 0.05, 0]),
    ]);
    await index.putChunks(bill.id, [chunk(bill.id, 1, 'Strom März', [0, 1, 0])]);
    await index.putChunks(household.id, [chunk(household.id, 0, 'Title: Household insurance', [0.7, 0.3, 0])]);
    // Chunks of a document that has left the index
    await index.putChunks('gone', [chunk('gone', 1, 'car insurance', [1, 0, 0])]);
    return { tree, policy, bill, household, letter, unindexed, outside };
  }

  it('finds documents with the words by meaning and by words, best of both first; one only further off in meaning is left out', async () => {
    const { tree, policy, letter } = await library();

    const result = await search(drive(), tree, 'car insurance');

    expect(h.embed).toHaveBeenCalledWith(['car insurance'], 'RETRIEVAL_QUERY');
    expect(result.semantic).toBe(true);
    // The household insurance is near in meaning, but has no "car" and is much further off than the policy
    expect(result.hits.map(h => [h.id, h.match])).toEqual([
      [policy.id, 'words'],
      [letter.id, 'words'],
    ]);
    expect(result.hits[0].score).toBeCloseTo(2 / 31);
    expect(result.hits[1].score).toBeCloseTo(1 / 32);
  });

  it('keeps a few documents without the words that are about as close in meaning as the best, after the matches', async () => {
    const { tree, policy, letter } = await library();
    const insurance = h.fake.childrenOf(h.fake.find('Paperwork')!.id).find(f => f.name === 'Insurance')!;
    const near = [];
    for (let i = 0; i < 7; i++) {
      const name = `Kfz ${i}.pdf`;
      const file = h.fake.add({ name, parents: [insurance.id], ...docLabels({ ...billMeta, title: name }, name), content: new TextEncoder().encode('Kfz') });
      await index.put(indexedDoc(file.id, { name }));
      await index.putChunks(file.id, [chunk(file.id, 1, 'Kfz-Haftpflicht und Vollkasko', [0.97 - i * 0.001, 0.03 + i * 0.001, 0])]);
      near.push(file.id);
    }

    const { hits } = await search(drive(), tree, 'car insurance');

    expect(hits.slice(0, 2).map(h => h.id)).toEqual([policy.id, letter.id]);
    expect(hits.slice(2).map(h => [h.id, h.match])).toEqual(near.slice(0, 5).map(id => [id, 'meaning']));
    expect(hits[2].snippet).toBe('Kfz-Haftpflicht und Vollkasko');
  });

  it('counts the words in what Paperwork knows about a document (its title, sender, summary, items) as a match', async () => {
    const { tree } = await library();
    const insurance = h.fake.childrenOf(h.fake.find('Paperwork')!.id).find(f => f.name === 'Insurance')!;
    const file = h.fake.add({ name: 'Scan.pdf', parents: [insurance.id], properties: { paperwork: 'doc' }, content: new TextEncoder().encode('') });
    await index.put(indexedDoc(file.id, { title: 'ECO Battery Park amendment', correspondent: 'Vispiron' }));
    // A question near nothing indexed, as "battery park" is to car insurance
    h.embed = vi.fn(async (texts: string[]) => texts.map(() => [0, 0, 1]));
    const { hits } = await search(drive(), tree, 'battery park');
    expect(hits.map(h => [h.id, h.match])).toEqual([[file.id, 'words']]);
  });

  it("shows the passage of the document's text that matched", async () => {
    const { tree, policy, letter } = await library();
    const { hits } = await search(drive(), tree, 'car insurance');
    const byId = new Map(hits.map(h => [h.id, h.snippet]));
    expect(byId.get(policy.id)).toContain('Car insurance with Allianz');
    // A match on words alone has no passage to show
    expect(byId.get(letter.id)).toBeNull();
  });

  it('leaves out documents the index has no entry for, and files outside the Paperwork folder', async () => {
    const { tree, unindexed, outside, bill } = await library();
    const ids = (await search(drive(), tree, 'car insurance')).hits.map(h => h.id);
    expect(ids).not.toContain(unindexed.id);
    expect(ids).not.toContain(outside.id);
    expect(ids).not.toContain('gone');
    expect(ids).not.toContain(bill.id);
  });

  it('falls back to words alone when searching by meaning is unavailable', async () => {
    const { tree, policy, letter } = await library();
    h.embed = vi.fn(async () => {
      throw new Error("Paperwork's search has used today's budget.");
    });
    const result = await search(drive(), tree, 'car insurance');
    expect(result.semantic).toBe(false);
    expect(result.hits.map(h => [h.id, h.snippet])).toEqual([
      [policy.id, null],
      [letter.id, null],
    ]);
  });

  it("still finds by meaning when Drive's search fails", async () => {
    const { tree, policy } = await library();
    const failing = new Drive({
      accessToken: async () => 'token',
      sleep: async () => {},
      fetch: async (input, init) =>
        String(input).includes('fullText') ? new Response(JSON.stringify({ error: { message: 'Search is unavailable' } }), { status: 400 }) : h.fake.fetch(input, init),
    });
    const result = await search(failing, tree, 'car insurance');
    expect(result.semantic).toBe(true);
    expect(result.hits.map(h => h.id)).toEqual([policy.id]);
  });

  it('finds nothing when nothing matches', async () => {
    const { tree } = await library();
    h.embed = vi.fn(async (texts: string[]) => texts.map(() => [0, 0, 1]));
    expect(await search(drive(), tree, 'pension')).toEqual({ hits: [], semantic: true });
  });

  it('returns at most 50 documents', async () => {
    const tree = await loadTree(drive());
    const insurance = h.fake.childrenOf(h.fake.find('Paperwork')!.id).find(f => f.name === 'Insurance')!;
    for (let i = 0; i < 60; i++) {
      const name = `Letter ${i}.pdf`;
      const file = h.fake.add({ name, parents: [insurance.id], ...docLabels({ ...billMeta, title: name }, name), content: new TextEncoder().encode('insurance') });
      await index.put(indexedDoc(file.id));
    }
    expect((await search(drive(), tree, 'insurance')).hits).toHaveLength(50);
  });
});
