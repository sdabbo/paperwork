import { describe, expect, it } from 'vitest';
import { citedSources } from './citations';

const given = ['Pension statement', 'Social insurance', 'Health insurance', 'Disability insurance', 'Tax certificate', 'Payslip'];

describe('the sources an answer cites', () => {
  it('keeps only the documents cited, numbered in the order first cited', () => {
    const { markdown, sources } = citedSources('Points: 8.0027 [4]. Value 40.79 EUR [1]. Again [4].', given);
    expect(sources).toEqual(['Disability insurance', 'Pension statement']);
    expect(markdown).toBe('Points: 8.0027 [1](#source-4). Value 40.79 EUR [2](#source-1). Again [1](#source-4).');
  });

  it('reads lists of citations', () => {
    const { markdown, sources } = citedSources('Both say so [2, 5] and [5; 6].', given);
    expect(sources).toEqual(['Social insurance', 'Tax certificate', 'Payslip']);
    expect(markdown).toBe('Both say so [1](#source-2)[2](#source-5) and [2](#source-5)[3](#source-6).');
  });

  it('leaves brackets alone that cite no document given', () => {
    const { markdown, sources } = citedSources('The tax year [2025] and note [7], or [1, 9].', given);
    expect(sources).toEqual([]);
    expect(markdown).toBe('The tax year [2025] and note [7], or [1, 9].');
  });

  it('has no sources when the answer cites none', () => {
    expect(citedSources('The documents don’t say.', given).sources).toEqual([]);
  });
});
