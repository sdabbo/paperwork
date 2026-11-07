// Files kept with a document (a Word draft, a spreadsheet): what the app shows of them and calls them. The server
// stores each next to its document, named after it ("<document> - Draft.docx"), and never reads it; the rules for
// the names are the server's own (shared/names.ts).
import type { AttachmentInfo } from '../../shared/types';
import { keptStem } from '../../shared/names';

export { cleanLabel, keptLabel, keptName } from '../../shared/names';

// A kept file's name without its document's in front: "Draft.docx" for "2026-10-20 … Loan agreement - Draft.docx"
export function shortName(file: AttachmentInfo, document: { name: string; mimeType: string }): string {
  const lead = `${keptStem(document)} - `;
  return file.name.toLowerCase().startsWith(lead.toLowerCase()) && file.name.length > lead.length ? file.name.slice(lead.length) : file.name;
}

// The files kept with a document after it was saved: where it moved, they moved too (the server takes them along in
// the same request), so none shows as left behind while the library is loaded again
export function followDocument(attachments: AttachmentInfo[], before: { folderId: string | null } | undefined, doc: { id: string; folderId: string | null }): AttachmentInfo[] {
  if (!before || before.folderId === doc.folderId || !attachments.some(a => a.documentId === doc.id)) return attachments;
  return attachments.map(a => (a.documentId === doc.id ? { ...a, folderId: doc.folderId } : a));
}
