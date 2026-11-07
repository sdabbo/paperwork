// A document's text for the search index. PDFs with a text layer (most PDFs from computers: invoices,
// statements, letters sent as PDF) are read directly, for free. Scans and photos have no text layer; for those
// Gemini writes the text out while it reads the document (classify.ts), which is OCR.
//
// The index keeps the text in chunks (docIndex.ts): chunk 0 holds the document's title, facts and summary,
// the following chunks hold its text, each small enough for one embedding.
import { DOCUMENT_TYPES, DocumentInfo, TextSource } from '../shared/types.js';
import { Readable } from './extract.js';

// Below this many characters per page a PDF is taken to be a scan (page numbers and headers alone)
const MIN_CHARS_PER_PAGE = 80;
// A page with less text than this is a scanned page; a PDF with more than a third of them (a typed cover letter
// in front of scanned pages) is read from the image, so the scanned pages' text isn't missing
const MIN_CHARS_SCANNED_PAGE = 40;
// Text kept per document in the index
export const MAX_TEXT_CHARS = 150_000;
const CHUNK_CHARS = 3_500;
const CHUNK_OVERLAP = 300;

export async function pdfText(data: Uint8Array): Promise<{ text: string; pages: number; scannedPages: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  // pdf.js takes over the buffer it is given, so it gets a copy
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = text.map(tidy);
    return { text: pages.filter(Boolean).join('\n\n'), pages: totalPages, scannedPages: pages.filter(p => p.length < MIN_CHARS_SCANNED_PAGE).length };
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}

export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The text a document carries itself, or null when it has to be read from the image (a scan or photo)
export async function ownText(content: Readable): Promise<{ text: string; source: TextSource } | null> {
  if (content.kind === 'text') return { text: tidy(content.text).slice(0, MAX_TEXT_CHARS), source: 'text' };
  if (content.mimeType !== 'application/pdf') return null;
  try {
    const { text, pages, scannedPages } = await pdfText(content.data);
    const enough = text.length >= 40 && text.length >= MIN_CHARS_PER_PAGE * Math.max(1, pages);
    if (enough && scannedPages * 3 <= pages) return { text: text.slice(0, MAX_TEXT_CHARS), source: 'pdf' };
  } catch (err) {
    console.warn('Reading the PDF text layer failed:', (err as Error).message);
  }
  return null;
}

// Chunk 0: what Paperwork knows about the document, so a search for "car insurance 2027" finds it even when
// those words aren't in its text
export function headerText(
  doc: Pick<DocumentInfo, 'title' | 'type' | 'correspondent' | 'date' | 'amount' | 'currency' | 'category' | 'tags' | 'references' | 'deadlines' | 'action' | 'summary' | 'topic' | 'gist'> &
    Partial<Pick<DocumentInfo, 'items'>>
): string {
  const lines = [
    `Title: ${doc.title}`,
    doc.type ? `Type: ${DOCUMENT_TYPES[doc.type]}` : null,
    doc.correspondent ? `From: ${doc.correspondent}` : null,
    doc.topic ? `Topic: ${doc.topic}` : null,
    doc.date ? `Date: ${doc.date}` : null,
    doc.amount !== null ? `Amount: ${doc.amount}${doc.currency ? ` ${doc.currency}` : ''}` : null,
    doc.category ? `Folder: ${doc.category}` : null,
    doc.tags.length ? `Tags: ${doc.tags.join(', ')}` : null,
    doc.references ? `References: ${doc.references}` : null,
    doc.items?.length
      ? `Bought: ${doc.items.map(i => `${i.quantity > 1 ? `${i.quantity} × ` : ''}${i.name}${i.details ? ` (${i.details})` : ''}${i.price !== null ? ` ${i.price.toFixed(2)}` : ''}`).join('; ')}`
      : null,
    doc.deadlines.length ? `Deadlines: ${doc.deadlines.map(d => `${d.date} ${d.what}`).join('; ')}` : null,
    doc.action ? `To do: ${doc.action}` : null,
    doc.gist ? `Update: ${doc.gist}` : null,
    doc.summary ? `Summary: ${doc.summary}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

// The text in overlapping pieces, cut at paragraph or sentence ends where possible
export function splitText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const pieces: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const window = clean.slice(start + Math.floor(size * 0.6), end);
      const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. '));
      if (cut > 0) end = start + Math.floor(size * 0.6) + cut + 1;
    }
    // Never between the two halves of an emoji or other character outside the basic plane
    if (end < clean.length && isLowSurrogate(clean.charCodeAt(end))) end--;
    pieces.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
    if (isLowSurrogate(clean.charCodeAt(start))) start--;
  }
  return pieces.filter(Boolean);
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// The full text again, from the index's text chunks (their overlaps removed)
export function joinChunks(texts: string[], overlap = CHUNK_OVERLAP): string {
  let out = '';
  for (const t of texts) {
    if (!out) {
      out = t;
      continue;
    }
    // The next piece starts with the last `overlap` characters of the previous one, less the spaces trimmed
    // off either end. The search starts there: a longer match only means the text repeats itself (a table
    // row or a phrase again and again), and taking it would drop part of the text.
    const tail = out.slice(-overlap);
    let skip = 0;
    for (let len = Math.min(tail.length, t.length); len >= 20; len--) {
      if (tail.endsWith(t.slice(0, len))) {
        skip = len;
        break;
      }
    }
    out += (skip ? '' : '\n') + t.slice(skip);
  }
  return out;
}
