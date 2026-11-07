import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { GenerateContentConfig } from '@google/genai';
import { DocIndex, MemoryIndexBackend, setIndexForTests } from './docIndex.js';
import { MemoryStore, setStoreForTests } from './store.js';
import { chunk, indexedDoc } from './testing/fixtures.js';

type Generate = (contents: unknown, config: GenerateContentConfig, label: string) => Promise<{ text?: string }>;
const h = vi.hoisted(() => ({ generate: null as unknown as Mock<Generate> }));

vi.mock('./gemini.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./gemini.js')>();
  return { ...actual, generate: (contents: unknown, config: GenerateContentConfig, label: string) => h.generate(contents, config, label) };
});

const { LimitError } = await import('./gemini.js');
const { contractOf, contracts, currentTerm, setHidden } = await import('./contracts.js');
type Terms = import('./contracts.js').Terms;

const NOW = '2026-10-20';
let index: DocIndex;

const terms = (overrides: Partial<Terms> = {}): Terms => ({
  name: 'Comprehensive car insurance VW Golf',
  kind: 'insurance',
  provider: 'Allianz',
  reference: 'KH-4471-2290',
  amount: 642.18,
  currency: 'EUR',
  interval: 'year',
  since: '2021-12-01',
  renewal: 'year',
  renews: '2027-01-01',
  notice: '1 month before the end of the insurance year',
  noticePeriod: { count: 1, unit: 'month' },
  cancelBy: null,
  status: 'active',
  endsOn: null,
  latest: 'Premium for 2027 rises to 642.18 EUR',
  documentIds: ['car-2026'],
  ...overrides,
});

// The text of the prompt Gemini was given in call `n`
const promptOf = (n: number) => (h.generate.mock.calls[n][0] as { parts: { text: string }[] }[])[0].parts[0].text;

// Gemini's answer: each topic it is shown, contract or not as `answers` says
function answering(answers: Record<string, object | false>) {
  h.generate.mockImplementation(async contents => {
    const text = (contents as { parts: { text: string }[] }[])[0].parts[0].text;
    const topics = [...text.matchAll(/^Topic: (".*?"),/gm)].map(m => JSON.parse(m[1]) as string);
    return {
      text: JSON.stringify({
        topics: topics.map(topic => (answers[topic] ? { topic, isContract: true, ...answers[topic] } : { topic, isContract: false })),
      }),
    };
  });
}

beforeEach(async () => {
  setStoreForTests(new MemoryStore());
  index = new DocIndex(new MemoryIndexBackend());
  setIndexForTests(index);
  h.generate = vi.fn<Generate>();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const car = 'Car insurance VW Golf';
  await index.put(indexedDoc('car-policy', { topic: car, type: 'policy', correspondent: 'Allianz', title: 'Car insurance policy', date: '2021-11-02', textSource: 'pdf', textLength: 900 }));
  await index.putChunks('car-policy', [chunk('car-policy', 0, 'header'), chunk('car-policy', 1, 'Der Vertrag verlängert sich um ein Jahr, wenn nicht einen Monat vor Ablauf gekündigt wird.')]);
  await index.put(indexedDoc('car-2026', { topic: car, type: 'letter', correspondent: 'Allianz', title: 'Premium adjustment 2027', date: '2026-10-08', amount: 642.18, currency: 'EUR', gist: 'Premium for 2027 rises to 642.18 EUR' }));
  await index.put(indexedDoc('tax-1', { topic: 'Income tax 2025', type: 'tax', correspondent: 'Finanzamt Musterstadt', date: '2026-09-18' }));
  await index.put(indexedDoc('receipt', { title: 'Hiking pants', date: '2026-05-01' }));
});

describe('the terms that apply now', () => {
  it('reckons the last day to cancel from the notice period, and moves on to the next term once it has passed', () => {
    // A month before 1 January 2027 is 30 November
    expect(currentTerm(terms(), NOW)).toEqual({ renews: '2027-01-01', cancelBy: '2026-11-30' });
    // Three months before is 30 September, already past: the chance is next year's
    expect(currentTerm(terms({ noticePeriod: { count: 3, unit: 'month' } }), NOW)).toEqual({ renews: '2028-01-01', cancelBy: '2027-09-30' });
  });

  it('prefers the deadline the documents give, and moves dates read a year ago on by a term', () => {
    expect(currentTerm(terms({ cancelBy: '2026-11-15' }), NOW)).toEqual({ renews: '2027-01-01', cancelBy: '2026-11-15' });
    expect(currentTerm(terms({ renews: '2026-01-01', cancelBy: '2025-11-15' }), NOW)).toEqual({ renews: '2027-01-01', cancelBy: '2026-11-15' });
  });

  it('moves on month by month for contracts that renew monthly, from the first date (no drift at month ends)', () => {
    expect(currentTerm(terms({ renewal: 'month', renews: '2026-11-01' }), NOW)).toEqual({ renews: '2026-12-01', cancelBy: '2026-10-31' });
    expect(currentTerm(terms({ renewal: 'month', renews: '2026-01-31', noticePeriod: null, cancelBy: null }), NOW)).toEqual({ renews: '2026-10-31', cancelBy: null });
  });

  it('knows nothing ahead for a term that just ends, or without dates', () => {
    expect(currentTerm(terms({ renewal: null, renews: '2026-06-01' }), NOW)).toEqual({ renews: null, cancelBy: null });
    expect(currentTerm(terms({ renewal: null, renews: '2027-03-01', noticePeriod: null }), NOW)).toEqual({ renews: '2027-03-01', cancelBy: null });
    expect(currentTerm(terms({ renews: null, noticePeriod: null, cancelBy: '2026-12-01' }), NOW)).toEqual({ renews: null, cancelBy: '2026-12-01' });
  });

  it('carries the notice period as a number and a unit, and none when the read had none', () => {
    const docs = [indexedDoc('a')];
    expect(contractOf('Car', terms(), docs, NOW).noticePeriod).toEqual({ count: 1, unit: 'month' });
    expect(contractOf('Car', terms({ noticePeriod: null }), docs, NOW).noticePeriod).toBeNull();
    // Stored before the field existed
    const { noticePeriod: _left, ...older } = terms();
    expect(contractOf('Car', older as Terms, docs, NOW).noticePeriod).toBeNull();
  });

  it('gives the price for a year, and a cancelled contract its end instead of a next term', () => {
    const docs = [indexedDoc('a'), indexedDoc('b')];
    expect(contractOf('Gym', terms({ amount: 39.9, interval: 'month' }), docs, NOW)).toMatchObject({ yearly: 478.8, documents: 2, status: 'active' });
    expect(contractOf('Gym', terms({ status: 'cancelled', endsOn: '2026-12-31' }), docs, NOW)).toMatchObject({ status: 'cancelled', renews: null, cancelBy: null, endsOn: '2026-12-31' });
    expect(contractOf('Gym', terms({ status: 'cancelled', endsOn: '2026-06-30' }), docs, NOW)).toMatchObject({ status: 'ended' });
  });
});

describe('reading contracts from topics', () => {
  it('asks Gemini about each topic once, with its documents and the text of its policy, and keeps the contracts', async () => {
    answering({
      'Car insurance VW Golf': {
        name: 'Comprehensive car insurance VW Golf',
        kind: 'insurance',
        provider: 'Allianz',
        amount: '642,18 €',
        currency: 'EUR',
        interval: 'year',
        renewal: 'year',
        renews: '2027-01-01',
        noticeCount: 1,
        noticeUnit: 'month',
        status: 'active',
        documentIds: ['car-2026', 'not-in-topic'],
      },
    });

    expect(await contracts(false, NOW)).toEqual({ contracts: [], pending: 2, problem: null, hidden: [] });
    const read = await contracts(true, NOW);

    expect(h.generate).toHaveBeenCalledTimes(1);
    const prompt = promptOf(0);
    expect(prompt).toContain('Topic: "Car insurance VW Golf", 2 documents');
    expect(prompt).toContain('Premium for 2027 rises to 642.18 EUR');
    expect(prompt).toContain('verlängert sich um ein Jahr');
    expect(prompt).toContain('Topic: "Income tax 2025"');
    expect(prompt).not.toContain('Hiking pants');
    expect(read.pending).toBe(0);
    expect(read.contracts).toEqual([
      expect.objectContaining({ topic: 'Car insurance VW Golf', amount: 642.18, yearly: 642.18, renews: '2027-01-01', cancelBy: '2026-11-30', documentIds: ['car-2026'], documents: 2 }),
    ]);

    await contracts(true, NOW);
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('reads a topic again when its documents change, and keeps showing what it knew meanwhile', async () => {
    answering({ 'Car insurance VW Golf': { name: 'Car insurance', kind: 'insurance', amount: '598.40', currency: 'EUR', interval: 'year' } });
    await contracts(true, NOW);
    await index.put(indexedDoc('car-2027', { topic: 'Car insurance VW Golf', title: 'Premium adjustment 2028', date: '2027-10-01', gist: 'Premium rises' }));

    const before = await contracts(false, NOW);
    expect(before.pending).toBe(1);
    expect(before.contracts[0].amount).toBe(598.4);

    answering({ 'Car insurance VW Golf': { name: 'Car insurance', kind: 'insurance', amount: '701.00', currency: 'EUR', interval: 'year' } });
    const after = await contracts(true, NOW);
    expect(promptOf(1)).not.toContain('Income tax 2025');
    expect(after).toMatchObject({ pending: 0, contracts: [expect.objectContaining({ amount: 701 })] });
  });

  it('tidies what Gemini answers', async () => {
    answering({ 'Car insurance VW Golf': { name: '  Car\ninsurance ', kind: 'spaceship', amount: '-3', currency: 'euro', interval: 'fortnight', renews: '2027-02-30', noticeCount: 400, noticeUnit: 'month', status: 'paused' } });
    const [c] = (await contracts(true, NOW)).contracts;
    expect(c).toMatchObject({ name: 'Car insurance', kind: 'other', amount: null, currency: null, interval: null, renews: null, notice: null, status: 'active', yearly: null });
  });

  it('leaves out topics the owner says are no contracts, and takes them back', async () => {
    answering({ 'Car insurance VW Golf': { name: 'Car insurance', kind: 'insurance' } });
    await contracts(true, NOW);
    await setHidden('Car insurance VW Golf', true);
    expect(await contracts(false, NOW)).toMatchObject({ contracts: [], hidden: ['Car insurance VW Golf'], pending: 0 });
    await setHidden('Car insurance VW Golf', false);
    expect((await contracts(false, NOW)).contracts).toHaveLength(1);
  });

  it('says why it stopped when the AI budget is used up, and tries again later', async () => {
    h.generate.mockRejectedValue(new LimitError("Paperwork's AI has used today's budget."));
    expect(await contracts(true, NOW)).toMatchObject({ pending: 2, problem: "Paperwork's AI has used today's budget." });
  });
});
