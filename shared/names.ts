// File names as Paperwork gives them in Drive, and what a file kept with a document is called: the same rules for
// the server, which names the files (server/metadata.ts), and the app, which shows the name a file will get.

export const MAX_NAME = 150;

export function extensionOf(name: string, mimeType: string): string {
  // Google Docs, Sheets and Slides have no extension
  if (mimeType.startsWith('application/vnd.google-apps.')) return '';
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  if (match) return `.${match[1].toLowerCase()}`;
  const known: Record<string, string> = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'text/plain': '.txt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  };
  return known[mimeType] ?? '';
}

// Without characters Drive or computers trip over in a name
export const clean = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// ---------- Files kept with a document ----------

// A word processor's file is usually the document's draft; anything else is kept as an attachment
const DRAFTS = new Set(['.docx', '.doc', '.odt', '.rtf', '.pages']);
const LABELS = { draft: { en: 'Draft', de: 'Entwurf' }, other: { en: 'Attachment', de: 'Anlage' } };

// What a kept file is, by its extension (or type), in the language of the names in Drive
export function keptLabel(file: { name: string; mimeType: string }, language: 'en' | 'de'): string {
  return LABELS[DRAFTS.has(extensionOf(file.name, file.mimeType)) ? 'draft' : 'other'][language];
}

// A label as the owner wrote it, fit for a file name
export const cleanLabel = (value: unknown): string | null => (typeof value === 'string' ? clean(value).slice(0, 40).trim() : '') || null;

// A document's name without its extension, which its kept files' names start with
export function keptStem(document: { name: string; mimeType: string }): string {
  const own = extensionOf(document.name, document.mimeType);
  return clean(document.name.toLowerCase().endsWith(own) ? document.name.slice(0, document.name.length - own.length) : document.name) || 'Document';
}

// A kept file's name: its document's name with the label, so Drive sorts it right after the document
// ("2026-10-20 Example UG - Loan agreement - Draft.docx"), and " 2", " 3", … when another kept file has that name
export function keptName(document: { name: string; mimeType: string }, file: { name: string; mimeType: string }, label: string, taken: string[] = []): string {
  const ext = extensionOf(file.name, file.mimeType);
  const stem = keptStem(document);
  const used = new Set(taken.map(n => n.toLowerCase()));
  for (let n = 1; ; n++) {
    const suffix = ` - ${label}${n > 1 ? ` ${n}` : ''}${ext}`;
    const base = stem.length > MAX_NAME - suffix.length ? stem.slice(0, MAX_NAME - suffix.length - 1).trimEnd() + '…' : stem;
    if (!used.has((base + suffix).toLowerCase())) return base + suffix;
  }
}
