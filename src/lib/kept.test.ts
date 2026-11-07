import { describe, expect, it } from 'vitest';
import type { AttachmentInfo } from '../../shared/types';
import { config } from '../../server/config';
import { attachmentLabel, attachmentName, cleanLabel as serverLabel } from '../../server/metadata';
import { cleanLabel, followDocument, keptLabel, keptName, shortName } from './kept';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const document = { name: '2026-10-20 Example UG - Gesellschafterdarlehensvertrag.pdf', mimeType: PDF };

const kept = (name: string, fields: Partial<AttachmentInfo> = {}): AttachmentInfo => ({
  id: 'a',
  documentId: 'd',
  name,
  mimeType: 'application/octet-stream',
  label: 'Draft',
  size: null,
  addedAt: '',
  webViewLink: '',
  folderId: null,
  readable: false,
  ...fields,
});

describe('files kept with a document', () => {
  it('calls a word processor’s file a draft, anything else an attachment, in the language of the names in Drive', () => {
    expect(keptLabel({ name: 'Darlehensvertrag.docx', mimeType: '' }, 'en')).toBe('Draft');
    expect(keptLabel({ name: 'Darlehensvertrag.DOC', mimeType: '' }, 'en')).toBe('Draft');
    expect(keptLabel({ name: 'Vertrag.odt', mimeType: '' }, 'de')).toBe('Entwurf');
    expect(keptLabel({ name: 'Tilgungsplan.xlsx', mimeType: '' }, 'en')).toBe('Attachment');
    expect(keptLabel({ name: 'Tilgungsplan.xlsx', mimeType: '' }, 'de')).toBe('Anlage');
    expect(keptLabel({ name: 'notes', mimeType: '' }, 'de')).toBe('Anlage');
    // No extension, but a Word file's type
    expect(keptLabel({ name: 'notes', mimeType: DOCX }, 'en')).toBe('Draft');
  });

  it('names it after its document, and shows it without the document’s name', () => {
    expect(keptName(document, { name: 'v3.DOCX', mimeType: '' }, 'Draft')).toBe('2026-10-20 Example UG - Gesellschafterdarlehensvertrag - Draft.docx');
    expect(keptName(document, { name: 'plan', mimeType: '' }, 'Anlage')).toBe('2026-10-20 Example UG - Gesellschafterdarlehensvertrag - Anlage');
    expect(shortName(kept('2026-10-20 Example UG - Gesellschafterdarlehensvertrag - Draft 2.docx'), document)).toBe('Draft 2.docx');
    // A Google Doc has no extension: a dot in its name stays
    const order = { name: '2026-10-20 Amazon - Bestellung amazon.de', mimeType: 'application/vnd.google-apps.document' };
    expect(keptName(order, { name: 'Rechnung.xlsx', mimeType: '' }, 'Anlage')).toBe('2026-10-20 Amazon - Bestellung amazon.de - Anlage.xlsx');
    expect(shortName(kept('2026-10-20 Amazon - Bestellung amazon.de - Anlage.xlsx'), order)).toBe('Anlage.xlsx');
    // Renamed in Drive by hand, or cut short for a long name: shown as it is
    expect(shortName(kept('Vertrag final.docx'), document)).toBe('Vertrag final.docx');
  });

  it('names and labels it as the server does', () => {
    const files = [
      { name: 'Darlehensvertrag.docx', mimeType: DOCX },
      { name: 'notes', mimeType: DOCX },
      { name: 'Tilgungsplan.xlsx', mimeType: '' },
      { name: 'scan', mimeType: PDF },
    ];
    for (const file of files) {
      expect(keptLabel(file, config.language)).toBe(attachmentLabel(file));
      expect(keptName(document, file, keptLabel(file, config.language))).toBe(attachmentName(document, file));
    }
    for (const label of ['Entwurf 1/2', '  Signed: "final" ', 'x'.repeat(60)]) expect(cleanLabel(label)).toBe(serverLabel(label));
    expect(cleanLabel('Entwurf 1/2')).toBe('Entwurf 1 2');
  });

  it('moves along with its document when that one is saved into another folder', () => {
    const files = [kept('a', { id: 'a', documentId: 'd', folderId: 'old' }), kept('b', { id: 'b', documentId: 'other', folderId: 'old' })];
    expect(followDocument(files, { folderId: 'old' }, { id: 'd', folderId: 'new' }).map(a => a.folderId)).toEqual(['new', 'old']);
    // Not moved, or not known before: as they were
    expect(followDocument(files, { folderId: 'old' }, { id: 'd', folderId: 'old' })).toBe(files);
    expect(followDocument(files, undefined, { id: 'd', folderId: 'new' })).toBe(files);
  });
});
