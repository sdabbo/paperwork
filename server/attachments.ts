// Files kept with a document: the Word draft of a signed contract, a spreadsheet that goes with a statement.
// Each is a Drive file of its own, next to its document and named after it ("… - Draft.docx"), labelled
// paperwork=attachment with its document's ID (pwOf). Paperwork never reads them, so they use no AI budget and
// are in no search. They are never in the index either: they are found in Drive by their labels, so a rebuilt
// index loses nothing. When Paperwork moves or renames a document, its kept files go along.
import { AttachResult, AttachmentInfo } from '../shared/types.js';
import { logActivity } from './activity.js';
import { md5 } from './crypto.js';
import { getIndex } from './docIndex.js';
import { Drive, DriveError, DriveFile, FILE_FIELDS, quote } from './drive.js';
import { isReadable } from './extract.js';
import { getDrive } from './google.js';
import { P, ROLE, addDupTag, attachmentLabel, attachmentName, cleanLabel, fit, nameHash, summaryFrom } from './metadata.js';
import { Tree, assertInside, folderOf, isFiledDocument, isInside, isKept, isSubfolder, loadTree, moveTarget, toDocumentInfo } from './vault.js';

// What the owner asked for that can't be done, e.g. keeping a document with itself
export class AttachProblem extends Error {}

// As much as Cloud Run takes in one request over HTTP/1 (32 MiB), with room to spare
const MAX_BYTES = 30 * 1024 * 1024;

function toAttachmentInfo(tree: Tree, file: DriveFile): AttachmentInfo {
  return {
    id: file.id,
    documentId: file.properties?.[P.of] ?? '',
    name: file.name,
    mimeType: file.mimeType,
    label: labelOf(file),
    size: file.size ? Number(file.size) : null,
    addedAt: file.createdTime ?? '',
    webViewLink: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
    folderId: folderOf(tree, file)?.id ?? null,
    readable: isReadable(file.mimeType),
  };
}

const labelOf = (file: DriveFile) => file.properties?.[P.label] || attachmentLabel(file);

// The kept files in the tree, or those of one document, oldest first
async function keptFiles(drive: Drive, tree: Tree, documentId?: string): Promise<DriveFile[]> {
  const q = documentId
    ? `properties has { key='${P.of}' and value=${quote(documentId)} } and trashed = false`
    : `properties has { key='${ROLE}' and value='attachment' } and trashed = false`;
  return (await drive.list(q, FILE_FIELDS, 'createdTime')).filter(f => isKept(f) && isInside(tree, f.parents));
}

export async function listAttachments(drive: Drive, tree: Tree, documentId?: string): Promise<AttachmentInfo[]> {
  return (await keptFiles(drive, tree, documentId)).map(f => toAttachmentInfo(tree, f));
}

// Files labelled with this content (documents and kept files carry their MD5 checksum)
const sameContent = (drive: Drive, checksum: string) => drive.list(`properties has { key='${P.md5}' and value=${quote(checksum)} } and trashed = false`);

const findFile = (drive: Drive, id: string) =>
  drive.get(id).catch(err => {
    if (err instanceof DriveError && err.status === 404) return null;
    throw err;
  });

// The document a kept file is kept with, while that is a filed document
export async function documentOf(drive: Drive, tree: Tree, file: DriveFile): Promise<DriveFile | null> {
  const id = file.properties?.[P.of];
  const document = id ? await findFile(drive, id) : null;
  return document && isFiledDocument(tree, document) ? document : null;
}

// The document a file with this content is kept with
export async function findKeptWith(drive: Drive, tree: Tree, checksum: string): Promise<DriveFile | null> {
  for (const file of await sameContent(drive, checksum)) {
    const document = isKept(file) && isInside(tree, file.parents) ? await documentOf(drive, tree, file) : null;
    if (document) return document;
  }
  return null;
}

// A kept file's description starts with a note naming its document, for whoever looks at it in Drive
const NOTE_START = 'Kept with "';
const keptNote = (document: DriveFile) =>
  `${NOTE_START}${document.name}" (${document.webViewLink ?? document.id}). Paperwork keeps it next to that document and doesn't read it.`;

// A description without that note: the rest (the summary it had as a document, the owner's own note) stays
const withoutNote = (description: string | undefined) => (description ?? '').split('\n\n').filter(p => p.trim() && !p.startsWith(NOTE_START));

// A description with that note up to date
const noted = (description: string | undefined, document: DriveFile) => [keptNote(document), ...withoutNote(description)].join('\n\n');

// What makes a kept file a file like any other again: its labels and the note naming its document go
export const unkeep = (file: DriveFile) => ({
  description: withoutNote(file.description).join('\n\n'),
  properties: { [ROLE]: null, [P.of]: null, [P.label]: null } as Record<string, null>,
});

const keptLabels = (documentId: string, label: string, name: string) => ({
  [ROLE]: 'attachment',
  [P.of]: documentId,
  [P.label]: fit(P.label, label),
  [P.nameHash]: nameHash(name),
});

// Keeps a file with a document: stored next to it, named after it, never read. Holds the document's lock, so an
// edit moving the document at the same time doesn't leave it behind.
export function attachFile(documentId: string, incoming: { name: string; mimeType: string; data: Uint8Array; label?: string | null }): Promise<AttachResult> {
  return getIndex().lock(documentId, async () => {
    if (incoming.data.byteLength > MAX_BYTES) throw new AttachProblem('The file is larger than 30 MB.');
    const drive = getDrive();
    const tree = await loadTree(drive);
    const document = await drive.get(documentId);
    if (!isFiledDocument(tree, document)) throw new DriveError('This document is not in Paperwork.', 404);

    const checksum = md5(incoming.data);
    const kept = await keptFiles(drive, tree, documentId);
    const already = kept.find(f => f.md5Checksum === checksum || f.properties?.[P.md5] === checksum);
    if (already) return { status: 'already-kept', attachment: toAttachmentInfo(tree, already) };
    const same = await sameContent(drive, checksum);
    // Filed as a document of its own (a draft uploaded before): offered to be kept with this one instead
    const filed = same.find(f => isFiledDocument(tree, f));
    if (filed?.id === documentId) throw new AttachProblem('This is the document’s own file.');
    if (filed) return { status: 'is-document', document: toDocumentInfo(tree, filed) };
    // Kept with a document that is gone (deleted in Drive to make way for a better scan, say): kept with this one
    // now, instead of a second copy next to the first
    for (const file of same.filter(f => isKept(f) && isInside(tree, f.parents))) {
      if (await documentOf(drive, tree, file)) continue;
      const label = cleanLabel(incoming.label);
      await drive.update(file.id, { properties: { [P.of]: documentId, ...(label ? { [P.label]: fit(P.label, label) } : {}) } });
      await followParent(drive, tree, document);
      await logActivity({ kind: 'edited', name: document.name, fileId: documentId, detail: `Kept ${incoming.name} with it` });
      return { status: 'kept', attachment: toAttachmentInfo(tree, await drive.get(file.id)) };
    }

    const folder = folderOf(tree, document)!;
    assertInside(tree, [folder.id], 'The document’s folder');
    const label = cleanLabel(incoming.label) ?? attachmentLabel(incoming);
    const name = attachmentName(document, incoming, label, kept.map(f => f.name));
    const created = await drive.createFile(
      {
        name,
        parents: [folder.id],
        description: keptNote(document),
        properties: { ...keptLabels(documentId, label, name), [P.md5]: checksum, [P.source]: 'upload' },
      },
      { data: incoming.data, mimeType: incoming.mimeType }
    );
    await logActivity({ kind: 'edited', name: document.name, fileId: documentId, detail: `Kept ${incoming.name} with it` });
    return { status: 'kept', attachment: toAttachmentInfo(tree, created) };
  });
}

// Makes a document a file kept with another one (a draft that was filed as a document of its own): named after
// that one, moved next to it and taken out of the index. Not for a document that has kept files itself, unless they
// are to go to that one too (`handOver`, for a possible duplicate kept with its original). `label`: what it is
// there ("Copy"); `flaggedAs`: only while it is still marked as a possible copy of that document.
export function attachExisting(id: string, parentId: string, options: { label?: string; handOver?: boolean; flaggedAs?: string } = {}): Promise<AttachResult> {
  return getIndex().lock(id, async () => {
    if (id === parentId) throw new AttachProblem('A document can’t be kept with itself.');
    const drive = getDrive();
    const tree = await loadTree(drive);
    const [file, parent] = await Promise.all([drive.get(id), findFile(drive, parentId)]);
    if (!isFiledDocument(tree, file)) throw new DriveError('This document is not in Paperwork.', 404);
    if (!parent || !isFiledDocument(tree, parent)) throw new AttachProblem('Files can only be kept with a document in Paperwork.');
    if (options.flaggedAs !== undefined && file.properties?.[P.maybeDup] !== options.flaggedAs) {
      throw new AttachProblem('This document isn’t marked as a possible copy of that one any more.');
    }
    const own = await keptFiles(drive, tree, id);
    if (own.length) {
      if (!options.handOver) throw new AttachProblem('Files are kept with this document. Make them documents of their own first.');
      // That one made a file kept with this one meanwhile (in another window, say): each kept with the other, both
      // would leave the library
      if (own.some(f => f.id === parentId)) throw new AttachProblem('That document is kept with this one now.');
      await handOver(drive, tree, id, parent);
      // One Drive refused to hand over would be left kept with a file
      if ((await keptFiles(drive, tree, id)).length) throw new AttachProblem('Files are kept with this document that couldn’t be moved over. Try again in a moment.');
    }

    const label = cleanLabel(options.label) ?? attachmentLabel(file);
    const name = attachmentName(parent, file, label, (await keptFiles(drive, tree, parentId)).map(f => f.name));
    const updated = await drive.update(
      id,
      {
        name,
        description: noted(summaryFrom(file.description ?? ''), parent),
        // No longer a possible copy, nor told apart from others: it is no document now
        properties: { ...keptLabels(parentId, label, name), [P.md5]: file.md5Checksum ?? null, [P.maybeDup]: null, [P.notDup]: null },
      },
      moveTarget(tree, file, folderOf(tree, parent)!.id)
    );
    // Out of the index for good, as a duplicate is; the next sync doesn't bring it back, as it is no document now
    await getIndex()
      .purge(id)
      .catch(err => console.error(`Taking ${file.name} out of the search index failed:`, err));
    // An edit may have moved or renamed the document meanwhile (it holds that one's lock, not this one's), after
    // taking its kept files along: this one follows it there too
    let kept = updated;
    const now = await findFile(drive, parentId).catch(() => null);
    if (now && (now.name !== parent.name || folderOf(tree, now)?.id !== folderOf(tree, parent)?.id)) {
      await followParent(drive, tree, now);
      kept = (await findFile(drive, id).catch(() => null)) ?? updated;
    }
    await logActivity({ kind: 'edited', name: parent.name, fileId: parentId, detail: `Kept ${file.name} with it` });
    return { status: 'kept', attachment: toAttachmentInfo(tree, kept) };
  });
}

// Takes a kept file's labels off and puts it into the Inbox, to be filed as a document of its own (pipeline.ts
// detachFile). One kept in a folder for a matter is filed back into it (pipeline.ts placement), as documents put
// there stay there. One Paperwork can't read is left as it is: it would only wait in the Inbox for good.
export async function detach(drive: Drive, tree: Tree, file: DriveFile): Promise<DriveFile> {
  if (!isKept(file) || file.trashed || !isInside(tree, file.parents)) throw new DriveError('This file is not kept with a document in Paperwork.', 404);
  if (!isReadable(file.mimeType)) throw new AttachProblem('Paperwork can’t read this kind of file, so it can’t be a document of its own. It stays where it is.');
  const folder = folderOf(tree, file);
  // Made a document of its own on purpose: never taken for a copy of the one it was kept with
  const former = file.properties?.[P.of];
  const unkept = unkeep(file);
  return drive.update(
    file.id,
    {
      description: unkept.description,
      properties: {
        ...unkept.properties,
        ...(isSubfolder(folder) ? { [P.into]: folder!.id } : {}),
        ...(former ? { [P.notDup]: addDupTag(file.properties?.[P.notDup], former) } : {}),
      },
    },
    moveTarget(tree, file, tree.inbox.id)
  );
}

// Takes a document's kept files along after Paperwork changed it: into its folder, named after it (a kept file
// renamed by hand in Drive keeps its name). Never fails the document's own change: what goes wrong is logged, and
// the next change puts it right.
export async function followParent(drive: Drive, tree: Tree, parent: DriveFile): Promise<void> {
  try {
    const folder = folderOf(tree, parent);
    const kept = await keptFiles(drive, tree, parent.id);
    const names = kept.map(f => f.name);
    for (const [i, file] of kept.entries()) {
      try {
        const named = file.properties?.[P.nameHash] === nameHash(file.name);
        const name = named ? attachmentName(parent, file, labelOf(file), names.filter((_, j) => j !== i)) : file.name;
        const description = noted(file.description, parent);
        const described = description !== (file.description ?? '');
        const move = folder && folderOf(tree, file)?.id !== folder.id ? moveTarget(tree, file, folder.id) : undefined;
        if (name === file.name && !described && !move) continue;
        await drive.update(
          file.id,
          { ...(name !== file.name ? { name, properties: { [P.nameHash]: nameHash(name) } } : {}), ...(described ? { description } : {}) },
          move
        );
        names[i] = name;
      } catch (err) {
        console.warn(`Moving ${file.name} along with ${parent.name} failed:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`Moving the files kept with ${parent.name} along failed:`, (err as Error).message);
  }
}

// A document that turned out to be a copy of another (pipeline.ts moveToDuplicates) hands its kept files over to
// that one, each on its own: one Drive refuses doesn't keep the others with the copy
export async function handOver(drive: Drive, tree: Tree, fromId: string, original: DriveFile): Promise<void> {
  try {
    const kept = await keptFiles(drive, tree, fromId);
    if (!kept.length) return;
    for (const file of kept) {
      // The original itself, kept with the copy meanwhile: never kept with itself
      if (file.id === original.id) continue;
      try {
        await drive.update(file.id, { properties: { [P.of]: original.id } });
      } catch (err) {
        console.warn(`Handing ${file.name} over to ${original.name} failed:`, (err as Error).message);
      }
    }
    await followParent(drive, tree, original);
  } catch (err) {
    console.warn(`Handing the files kept with a copy over to ${original.name} failed:`, (err as Error).message);
  }
}
