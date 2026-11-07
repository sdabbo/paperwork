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

const { candidates, taxReturn, taxYears } = await import('./taxes.js');

const NOW = '2026-10-20';
let index: DocIndex;

const promptsFor = (label: string) =>
  h.generate.mock.calls.filter(c => c[2] === label).map(c => (c[0] as { parts: { text: string }[] }[])[0].parts[0].text);

// Gemini picks these documents; it reads figures for each document it is shown
function answering(picks: object[], missing: object[] = []) {
  h.generate.mockImplementation(async (contents, _config, label) => {
    if (label === 'tax-pick') return { text: JSON.stringify({ documents: picks, missing }) };
    const ids = [...(contents as { parts: { text: string }[] }[])[0].parts[0].text.matchAll(/^Document (\S+), for/gm)].map(m => m[1]);
    return {
      text: JSON.stringify({
        documents: ids.map(id => ({ id, figures: [{ label: '3. Bruttoarbeitslohn', value: '68.400,00 €' }, { label: 'empty', value: '' }], prefilled: id === 'lstb', note: id === 'plumber' ? 'Only the labour costs count.' : '' })),
      }),
    };
  });
}

beforeEach(async () => {
  setStoreForTests(new MemoryStore());
  index = new DocIndex(new MemoryIndexBackend());
  setIndexForTests(index);
  h.generate = vi.fn<Generate>();
  await index.put(indexedDoc('lstb', { title: 'Lohnsteuerbescheinigung 2025', type: 'tax', correspondent: 'Muster GmbH', date: '2026-02-10', textSource: 'pdf', textLength: 800 }));
  await index.putChunks('lstb', [chunk('lstb', 0, 'header'), chunk('lstb', 1, '3. Bruttoarbeitslohn 68.400,00')]);
  await index.put(indexedDoc('plumber', { title: 'Bathroom repair', correspondent: 'Sanitär Hofbauer', date: '2025-06-03', amount: 840, currency: 'EUR' }));
  await index.put(indexedDoc('payslip', { title: 'Payslip May', type: 'payslip', date: '2025-05-31' }));
  await index.put(indexedDoc('later', { title: 'Electricity bill', date: '2026-03-01' }));
  await index.put(indexedDoc('old', { title: 'Old letter', date: '2019-03-01', summary: 'About 2025 plans' }));
});

describe('the documents for a tax year', () => {
  it('are the year’s own and those of the next two years that mention it', async () => {
    const docs = (await index.all()).map(d => ({ ...d }));
    expect(candidates(2025, docs).map(d => d.id)).toEqual(['lstb', 'payslip', 'plumber']);
    expect(taxYears(docs, NOW)).toEqual([2026, 2025, 2019]);
  });

  it('count a possible copy of another document once, while that one is there', async () => {
    const docs = (await index.all()).map(d => ({ ...d }));
    const scan = indexedDoc('plumber-scan', { title: 'Bathroom repair', correspondent: 'Sanitär Hofbauer', date: '2025-06-03', amount: 840, currency: 'EUR', possibleDuplicateOf: 'plumber' });
    expect(candidates(2025, [...docs, scan]).map(d => d.id)).toEqual(['lstb', 'payslip', 'plumber']);
    expect(candidates(2025, [...docs.filter(d => d.id !== 'plumber'), scan]).map(d => d.id)).toEqual(['lstb', 'payslip', 'plumber-scan']);
  });
});

describe('reading a tax year', () => {
  it('picks the documents by ELSTER form, reads their figures and keeps them', async () => {
    answering(
      [
        { id: 'plumber', form: 'Anlage Haushaltsnahe Aufwendungen', what: 'Plumber’s invoice for the bathroom' },
        { id: 'lstb', form: 'Anlage N', what: 'Lohnsteuerbescheinigung 2025 from Muster GmbH' },
        { id: 'unknown', form: 'Anlage N', what: 'Made up' },
        { id: 'payslip', form: 'Anlage Mars', what: 'A payslip' },
      ],
      [{ what: 'Certificate of health insurance contributions 2025', why: 'Payslips show contributions to TK.' }, { what: '', why: 'nothing' }]
    );

    expect(await taxReturn(2025, false, NOW)).toEqual({ years: [2026, 2025, 2019], result: null });
    const { result } = await taxReturn(2025, true, NOW);

    expect(promptsFor('tax-pick')[0]).toContain('Lohnsteuerbescheinigung 2025');
    expect(promptsFor('tax-pick')[0]).not.toContain('Electricity bill');
    expect(promptsFor('tax-figures').join('\n')).toContain('3. Bruttoarbeitslohn 68.400,00');
    expect(result).toMatchObject({
      year: 2025,
      stale: false,
      missing: [{ what: 'Certificate of health insurance contributions 2025', why: 'Payslips show contributions to TK.' }],
      sections: [
        { form: 'Anlage N', entries: [{ documentId: 'lstb', what: 'Lohnsteuerbescheinigung 2025 from Muster GmbH', prefilled: true, note: null, figures: [{ label: '3. Bruttoarbeitslohn', value: '68.400,00 €' }] }] },
        { form: 'Anlage Haushaltsnahe Aufwendungen', entries: [{ documentId: 'plumber', prefilled: false, note: 'Only the labour costs count.' }] },
        { form: 'Other', entries: [{ documentId: 'payslip' }] },
      ],
    });

    // Kept: no new questions until it is read again
    h.generate.mockClear();
    expect((await taxReturn(2025, false, NOW)).result?.sections).toHaveLength(3);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it('says when documents changed since, and reads figures again only for those that changed', async () => {
    answering([
      { id: 'plumber', form: 'Anlage Haushaltsnahe Aufwendungen', what: 'Plumber' },
      { id: 'lstb', form: 'Anlage N', what: 'Lohnsteuerbescheinigung' },
    ]);
    await taxReturn(2025, true, NOW);
    await index.put(indexedDoc('plumber', { title: 'Bathroom repair', correspondent: 'Sanitär Hofbauer', date: '2025-06-03', amount: 860, currency: 'EUR' }));

    expect((await taxReturn(2025, false, NOW)).result?.stale).toBe(true);
    h.generate.mockClear();
    const { result } = await taxReturn(2025, true, NOW);

    expect(result?.stale).toBe(false);
    const figures = promptsFor('tax-figures');
    expect(figures).toHaveLength(1);
    expect(figures[0]).toContain('Document plumber, for');
    expect(figures[0]).not.toContain('Document lstb, for');
  });

  it('shows nothing for documents that left Paperwork since', async () => {
    answering([{ id: 'plumber', form: 'Anlage Haushaltsnahe Aufwendungen', what: 'Plumber' }]);
    await taxReturn(2025, true, NOW);
    await index.remove('plumber');
    expect((await taxReturn(2025, false, NOW)).result).toMatchObject({ sections: [], stale: true });
  });
});
