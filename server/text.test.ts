// A document's text for the index: reading PDFs' text layers, telling scans apart, and the chunks.
import { describe, expect, it, vi } from 'vitest';
import { MAX_TEXT_CHARS, headerText, joinChunks, ownText, pdfText, splitText, tidy } from './text.js';
import { prose, scanPdf, textPdf } from './testing/fixtures.js';

const CHUNK = 3_500;
const OVERLAP = 300;

describe('reading a PDF text layer', () => {
  it('reads a page of text', async () => {
    const { text, pages } = await pdfText(await textPdf(['Stadtwerke Musterstadt – Rechnung März 2025. Betrag: 87,45 EUR, fällig am 25.04.2025.']));
    expect(pages).toBe(1);
    expect(text).toBe('Stadtwerke Musterstadt – Rechnung März 2025. Betrag: 87,45 EUR, fällig am 25.04.2025.');
  });

  it('reads several pages in order', async () => {
    const { text, pages } = await pdfText(await textPdf(['First page: the contract.', 'Second page: the conditions.', 'Third page: signatures.']));
    expect(pages).toBe(3);
    // Pages as paragraphs, so the index's pieces are cut between them where possible
    expect(text.split('\n\n')).toEqual(['First page: the contract.', 'Second page: the conditions.', 'Third page: signatures.']);
  });

  it('leaves the bytes it was given usable', async () => {
    const data = await textPdf(['Some text on a page.']);
    const size = data.byteLength;
    await pdfText(data);
    expect(data.byteLength).toBe(size);
    expect((await pdfText(data)).text).toBe('Some text on a page.');
  });
});

describe("a document's own text", () => {
  const pdf = (data: Uint8Array) => ({ kind: 'file' as const, mimeType: 'application/pdf', data });

  it('comes from the text layer of a PDF made on a computer', async () => {
    const body = prose(8);
    const own = await ownText(pdf(await textPdf([body])));
    expect(own?.source).toBe('pdf');
    expect(own?.text.replace(/\s+/g, ' ')).toBe(body);
  });

  it('is missing for a scan whose pages carry only a page number', async () => {
    const data = await textPdf(['Seite 1 von 4', 'Seite 2 von 4', 'Seite 3 von 4', 'Seite 4 von 4']);
    // There is some text, just not enough per page to be the document's own
    expect((await pdfText(data)).text.length).toBeGreaterThanOrEqual(40);
    expect(await ownText(pdf(data))).toBeNull();
  });

  it('is missing for a scan that is only an image', async () => {
    expect(await ownText(pdf(await scanPdf(2)))).toBeNull();
  });

  it('is missing, without an error, for a damaged PDF', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(ownText(pdf(new TextEncoder().encode('%PDF-1.7 not really a PDF')))).resolves.toBeNull();
    await expect(ownText(pdf(new Uint8Array()))).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is the text itself for text formats (Word, email, plain text)', async () => {
    expect(await ownText({ kind: 'text', text: '  Dear customer,\r\n\r\n\r\n\r\nyour   contract\t renews.  ' })).toEqual({
      text: 'Dear customer,\n\nyour contract renews.',
      source: 'text',
    });
  });

  it('is missing for photos, which have to be read from the image', async () => {
    expect(await ownText({ kind: 'file', mimeType: 'image/jpeg', data: new Uint8Array([0xff, 0xd8, 0xff]) })).toBeNull();
    expect(await ownText({ kind: 'file', mimeType: 'image/png', data: new Uint8Array([0x89, 0x50]) })).toBeNull();
  });

  it('is cut to the length the index keeps', async () => {
    const own = await ownText({ kind: 'text', text: 'word '.repeat(MAX_TEXT_CHARS) });
    expect(own?.text.length).toBe(MAX_TEXT_CHARS);
  });
});

describe('tidying text', () => {
  it('evens out line ends, spaces and blank lines', () => {
    expect(tidy('a\r\nb\rc')).toBe('a\nb\nc');
    expect(tidy('a  \t b  c')).toBe('a b c');
    expect(tidy('line   \n   next')).toBe('line\nnext');
    expect(tidy('one\n\n\n\n\ntwo')).toBe('one\n\ntwo');
    expect(tidy('  \n padded \n  ')).toBe('padded');
  });
});

describe('chunks', () => {
  const texts: Record<string, string> = {
    paragraphs: Array.from({ length: 40 }, (_, i) => prose(5, i + 1)).join('\n\n'),
    'one huge line without breaks': Array.from({ length: 4000 }, (_, i) => `w${(i * 7919) % 10007}`).join(' '),
    'many short lines': Array.from({ length: 3000 }, (_, i) => `Zeile ${i}: Posten ${i * 7}`).join('\n'),
    'a table with the same row again and again': Array.from({ length: 2000 }, () => 'Pos. 1 | Stromverbrauch | 87,45 EUR').join('\n'),
    'a phrase repeated': 'lorem ipsum dolor '.repeat(1500).trim(),
    'umlauts and other scripts': Array.from({ length: 30 }, (_, i) => `Grüße aus Musterstadt, Straße ${i}. Größe: ÄÖÜ äöü ß. Ελληνικά ${i}. Ünïcödé €${i},00.`).join('\n'),
    'shorter than one chunk': 'Your contract renews on 1 March 2026. Cancel by 1 February.',
  };

  it.each(Object.entries(texts))('come back together as the same text: %s', (_label, text) => {
    expect(joinChunks(splitText(text))).toBe(text);
  });

  it.each(Object.entries(texts))('are no larger than a chunk and, but for the last, not much smaller: %s', (_label, text) => {
    const pieces = splitText(text);
    expect(pieces.length).toBeGreaterThan(0);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(CHUNK);
    for (const piece of pieces.slice(0, -1)) expect(piece.length).toBeGreaterThanOrEqual(CHUNK * 0.6 - 2);
  });

  it.each(Object.entries(texts))('overlap, so a sentence cut in two is still found whole: %s', (_label, text) => {
    const pieces = splitText(text);
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i - 1].slice(-OVERLAP)).toContain(pieces[i].slice(0, OVERLAP - 50));
    }
  });

  it('are cut at the end of a paragraph or sentence where there is one', () => {
    const pieces = splitText(texts.paragraphs);
    expect(pieces.length).toBeGreaterThan(5);
    for (const piece of pieces) expect(piece).toMatch(/\.$/);
  });

  it('keep a short text whole', () => {
    expect(splitText('  A short letter.  ')).toEqual(['A short letter.']);
  });

  it('are none for empty text', () => {
    expect(splitText('')).toEqual([]);
    expect(splitText(' \n\n ')).toEqual([]);
    expect(joinChunks([])).toBe('');
  });

  it('cover the whole text, nothing more', () => {
    const text = texts.paragraphs;
    const pieces = splitText(text);
    for (const piece of pieces) expect(text).toContain(piece);
    expect(pieces[0].startsWith(text.slice(0, 100))).toBe(true);
    expect(pieces.at(-1)!.endsWith(text.slice(-100))).toBe(true);
  });

  it('can be made in other sizes', () => {
    const text = prose(60);
    const pieces = splitText(text, 500, 100);
    expect(pieces.length).toBeGreaterThan(5);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(500);
    expect(joinChunks(pieces, 100)).toBe(text);
  });
});

describe('the header chunk', () => {
  const doc = {
    title: 'Car insurance policy 2026',
    type: 'policy' as const,
    correspondent: 'Allianz',
    date: '2025-11-20',
    amount: 412.8,
    currency: 'EUR',
    category: 'Insurance',
    tags: ['car', 'insurance'],
    references: 'Policy: AS-4471-22',
    deadlines: [
      { date: '2025-12-01', what: 'Premium due', done: false },
      { date: '2026-11-30', what: 'Cancellation deadline', done: true },
    ],
    action: 'Pay 412.80 EUR by 2025-12-01',
    summary: 'Liability and comprehensive cover for the VW Golf.',
    topic: 'Car insurance VW Golf',
    gist: 'Premium for 2026: 412.80 EUR',
  };

  it('holds what Paperwork knows about the document, one fact per line', () => {
    expect(headerText(doc).split('\n')).toEqual([
      'Title: Car insurance policy 2026',
      'Type: Policy',
      'From: Allianz',
      'Topic: Car insurance VW Golf',
      'Date: 2025-11-20',
      'Amount: 412.8 EUR',
      'Folder: Insurance',
      'Tags: car, insurance',
      'References: Policy: AS-4471-22',
      'Deadlines: 2025-12-01 Premium due; 2026-11-30 Cancellation deadline',
      'To do: Pay 412.80 EUR by 2025-12-01',
      'Update: Premium for 2026: 412.80 EUR',
      'Summary: Liability and comprehensive cover for the VW Golf.',
    ]);
  });

  it('leaves out what is unknown', () => {
    const bare = { ...doc, type: null, correspondent: null, date: null, amount: null, currency: null, category: null, tags: [], references: null, deadlines: [], action: null, summary: '', topic: null, gist: null };
    expect(headerText(bare)).toBe('Title: Car insurance policy 2026');
  });

  it('keeps an amount of zero, and an amount without a currency', () => {
    expect(headerText({ ...doc, amount: 0, currency: null })).toContain('Amount: 0\n');
  });
});

describe('characters outside the basic plane', () => {
  it('are never split between two pieces', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const text = 'Rechnung 😀 '.repeat(800) + '🧾'.repeat(700);
    const pieces = splitText(text, 101, 11);
    expect(pieces.length).toBeGreaterThan(10);
    for (const piece of pieces) expect(lone.test(piece)).toBe(false);
  });
});

describe('PDFs partly typed, partly scanned', () => {
  it('are read from the image when more than a third of their pages have no text', async () => {
    // A typed cover letter in front of two scanned pages
    const mixed = await textPdf([prose(20), '', '']);
    expect(await ownText({ kind: 'file', mimeType: 'application/pdf', data: mixed })).toBeNull();
    // A page without text among several typed ones (a blank back page) doesn't count
    const typed = await textPdf([prose(10, 1), prose(10, 2), prose(10, 3), '']);
    expect(await ownText({ kind: 'file', mimeType: 'application/pdf', data: typed })).toMatchObject({ source: 'pdf' });
  });
});
