// Dates, amounts and sizes in the reader's own conventions
import { DOCUMENT_TYPES, DocumentType } from '../../shared/types';

const locale = typeof navigator !== 'undefined' ? navigator.language : 'en';

export function formatDate(iso: string | null | undefined, style: 'short' | 'long' = 'short'): string {
  if (!iso) return '';
  const date = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(locale, style === 'long' ? { day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatAmount(amount: number | null, currency: string | null): string {
  if (amount === null) return '';
  try {
    return new Intl.NumberFormat(locale, currency ? { style: 'currency', currency } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

export function formatSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return rtf.format(-seconds, 'second');
  if (Math.abs(seconds) < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
  if (Math.abs(seconds) < 86400) return rtf.format(-Math.round(seconds / 3600), 'hour');
  return rtf.format(-Math.round(seconds / 86400), 'day');
}

// A day with its weekday ("Fri, 24 Oct"), with the year only when it isn't this year
export function formatDay(iso: string): string {
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) });
}

// A month from YYYY-MM ("October 2026")
export function formatMonth(month: string): string {
  const date = new Date(`${month}-15T12:00:00`);
  return Number.isNaN(date.getTime()) ? month : date.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}

// How far away a YYYY-MM-DD date is: "today", "tomorrow", "in 5 days", "3 days ago"; in months or years when
// it is further off ("in 20 months" reads better than "in 623 days")
export function relativeDay(date: string): string {
  const days = daysUntil(date);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(days) < 60) return rtf.format(days, 'day');
  if (Math.abs(days) < 730) return rtf.format(Math.round(days / 30.44), 'month');
  return rtf.format(Math.round(days / 365.25), 'year');
}

// Days from today until a YYYY-MM-DD date (negative when past)
export function daysUntil(date: string): number {
  const today = new Date();
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - start) / 86400000);
}

export const typeLabel = (type: DocumentType | null) => (type ? DOCUMENT_TYPES[type] : '');

// How a document arrived, after "added …": "added 3 Nov 2026 by email"
export const SOURCE: Record<string, string> = { email: 'by email', upload: 'in the app', drive: 'in Google Drive' };

// A stable color per folder name
export function folderColor(name: string | null): string {
  if (!name) return 'var(--ink-3)';
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `var(--c${(hash % 8) + 1})`;
}

// A day without its year, for lists grouped by year ("8 Oct")
export function formatDayMonth(iso: string): string {
  const date = new Date(`${iso}T12:00:00`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
}

// A day with the year only when it isn't this year ("14 Nov", "8 Jan 2027")
export function formatShortDate(iso: string): string {
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  const thisYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) });
}
