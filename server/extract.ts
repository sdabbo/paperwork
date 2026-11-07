// A Drive file as something Gemini can read: PDFs and images as they are, Google Docs/Sheets/Slides exported
// as PDF, Word files and plain text as text. Large files go through Gemini's file upload instead of inline.
import mammoth from 'mammoth';
import { FileState, Part, createPartFromBase64, createPartFromText, createPartFromUri } from '@google/genai';
import { Drive, DriveFile } from './drive.js';
import { getClient } from './gemini.js';

export type Readable = { kind: 'file'; mimeType: string; data: Uint8Array } | { kind: 'text'; text: string };

export class UnsupportedFile extends Error {}

const MAX_BYTES = 40 * 1024 * 1024;
// Inline data counts against the request size; larger files are uploaded to Gemini first
const MAX_INLINE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 200_000;

const AS_IS = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const EXPORT_AS_PDF = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
]);

export function isReadable(mimeType: string): boolean {
  return AS_IS.has(mimeType) || EXPORT_AS_PDF.has(mimeType) || mimeType === DOCX || mimeType.startsWith('text/');
}

const BY_EXTENSION: Record<string, string> = {
  docx: DOCX,
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  txt: 'text/plain',
};

// A file's type as the browser sent it, or by its extension when it sent none (phones often send Word files
// without one, or as application/octet-stream)
export function mimeFromName(name: string, given: string): string {
  const type = given.split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/octet-stream') return type;
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1].toLowerCase();
  return (ext && BY_EXTENSION[ext]) || 'application/octet-stream';
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// Content that is already in memory (an upload, an email attachment)
export async function readBytes(data: Uint8Array, mimeType: string): Promise<Readable> {
  if (data.byteLength > MAX_BYTES) throw new UnsupportedFile('The file is larger than 40 MB.');
  if (AS_IS.has(mimeType)) return { kind: 'file', mimeType, data };
  if (mimeType === DOCX) {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return { kind: 'text', text: value.slice(0, MAX_TEXT_CHARS) };
  }
  if (mimeType.startsWith('text/')) {
    const text = Buffer.from(data).toString('utf8');
    return { kind: 'text', text: (mimeType === 'text/html' ? htmlToText(text) : text).slice(0, MAX_TEXT_CHARS) };
  }
  throw new UnsupportedFile(`Paperwork can't read ${mimeType || 'this kind of'} files.`);
}

export async function readFile(drive: Drive, file: DriveFile): Promise<Readable> {
  if (EXPORT_AS_PDF.has(file.mimeType)) {
    return { kind: 'file', mimeType: 'application/pdf', data: await drive.export(file.id, 'application/pdf') };
  }
  if (!isReadable(file.mimeType)) throw new UnsupportedFile(`Paperwork can't read ${file.mimeType || 'this kind of'} files.`);
  if (file.size && Number(file.size) > MAX_BYTES) throw new UnsupportedFile('The file is larger than 40 MB.');
  return readBytes(await drive.download(file.id), file.mimeType);
}

// A document's text inside <document> tags for Gemini, with tags in the text itself defused, so a document
// can't end its own quote and pass the rest off as instructions
export const quoteDocument = (text: string, attributes = '') =>
  `<document${attributes}>\n${text.replace(/<(\/?)document/gi, '‹$1document')}\n</document>`;

export async function toPart(content: Readable): Promise<Part> {
  if (content.kind === 'text') return createPartFromText(quoteDocument(content.text));
  if (content.data.byteLength <= MAX_INLINE_BYTES) {
    return createPartFromBase64(Buffer.from(content.data).toString('base64'), content.mimeType);
  }
  const uploaded = await getClient().files.upload({
    file: new Blob([Buffer.from(content.data)], { type: content.mimeType }),
    config: { mimeType: content.mimeType },
  });
  let file = uploaded;
  for (let i = 0; i < 30 && file.state === FileState.PROCESSING && file.name; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    file = await getClient().files.get({ name: file.name });
  }
  if (!file.uri) throw new Error('Gemini did not accept the file.');
  return createPartFromUri(file.uri, file.mimeType ?? content.mimeType);
}
