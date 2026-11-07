// The Taxes page's plain parts: which year it shows, what each ELSTER form is for, and a figure as it is typed
// into ELSTER.
import { TAX_FORMS } from '../../shared/types';
import type { TaxForm } from '../../shared/types';

// The year in the page's address (/taxes?year=2025), when it is one the server takes
export function yearParam(params: URLSearchParams, now = new Date()): number | null {
  const raw = params.get('year')?.trim() ?? '';
  if (!/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1990 && year <= now.getFullYear() + 1 ? year : null;
}

// The year shown when the address names none: last year, the return usually due, when there are documents for
// it; otherwise the newest year there are documents for. Last year too while the years aren't known yet.
export function defaultYear(years: number[] | null, now = new Date()): number {
  const last = now.getFullYear() - 1;
  return !years?.length || years.includes(last) ? last : years[0];
}

export const formAbout = (form: TaxForm): string => TAX_FORMS.find(f => f.form === form)?.about ?? '';

// An amount with its currency before or after it: "68.400,00 €", "EUR 1.234,56", "-312,00 EUR"
const AMOUNT = /^(?:(?:€|EUR|Euro)\s*)?([-+−]?\s*\d(?:[\d.,\s]*\d)?)(?:\s*(?:€|EUR|Euro))?$/iu;

// What to type into ELSTER for a figure: an amount without its currency ("68.400,00 €" → "68.400,00"), dates and
// anything else as printed
export function typedValue(value: string): string {
  const text = value.trim();
  const match = AMOUNT.exec(text);
  // A number without a currency (a year, a tax class) stays as it is too
  if (!match || match[0].length === match[1].length) return text;
  return match[1].replace(/\s+/g, '').replace('−', '-');
}
