import { describe, expect, it } from 'vitest';
import { defaultYear, formAbout, typedValue, yearParam } from './taxes';

const now = new Date('2026-10-20T12:00:00');

describe('a figure as it is typed into ELSTER', () => {
  it('leaves the currency out of an amount', () => {
    expect(typedValue('68.400,00 €')).toBe('68.400,00');
    expect(typedValue('68.400,00 EUR')).toBe('68.400,00');
    expect(typedValue('€ 1.234,56')).toBe('1.234,56');
    expect(typedValue('EUR 950')).toBe('950');
    expect(typedValue('312,00 €')).toBe('312,00');
    expect(typedValue(' 12,50 Euro ')).toBe('12,50');
  });

  it('keeps the sign of a back payment, as a plain minus', () => {
    expect(typedValue('-1.204,00 €')).toBe('-1.204,00');
    expect(typedValue('− 1.204,00 €')).toBe('-1.204,00');
  });

  it('keeps dates, numbers without a currency and text as printed', () => {
    expect(typedValue('15.03.2025')).toBe('15.03.2025');
    expect(typedValue('01.01.–31.12.2025')).toBe('01.01.–31.12.2025');
    expect(typedValue('2025')).toBe('2025');
    expect(typedValue('1')).toBe('1');
    expect(typedValue('Deutsches Rotes Kreuz e. V.')).toBe('Deutsches Rotes Kreuz e. V.');
    expect(typedValue('1.234,56 € (Erstattung)')).toBe('1.234,56 € (Erstattung)');
    expect(typedValue('Europa 2025')).toBe('Europa 2025');
  });
});

describe('the year the page shows', () => {
  it('reads the year from the address', () => {
    expect(yearParam(new URLSearchParams('year=2025'), now)).toBe(2025);
    expect(yearParam(new URLSearchParams('year=2027'), now)).toBe(2027);
  });

  it('ignores a year that is no tax year', () => {
    expect(yearParam(new URLSearchParams(''), now)).toBeNull();
    expect(yearParam(new URLSearchParams('year=1989'), now)).toBeNull();
    expect(yearParam(new URLSearchParams('year=2028'), now)).toBeNull();
    expect(yearParam(new URLSearchParams('year=25'), now)).toBeNull();
    expect(yearParam(new URLSearchParams('year=2025abc'), now)).toBeNull();
  });

  it('is last year without one, when there are documents for it', () => {
    expect(defaultYear([2026, 2025, 2024], now)).toBe(2025);
  });

  it('is the newest year with documents otherwise', () => {
    expect(defaultYear([2026, 2023], now)).toBe(2026);
    expect(defaultYear([2023, 2022], now)).toBe(2023);
  });

  it('is last year while the years aren’t known, or there are none', () => {
    expect(defaultYear(null, now)).toBe(2025);
    expect(defaultYear([], now)).toBe(2025);
  });
});

describe('what a form is for', () => {
  it('explains each ELSTER form', () => {
    expect(formAbout('Anlage N')).toBe('Employment: wages and work expenses');
    expect(formAbout('Other')).toBe('Other documents for the return');
  });
});
