// The Paperwork folder in the owner's Drive, and the rule that Paperwork stays inside it.
//
//   Paperwork/                  root; Paperwork creates it on first connect
//     Inbox/                    new documents land here (Drive app scans, uploads, forwarded email)
//     Duplicates/               documents that were already there (Paperwork can't delete them)
//     Bills & Receipts/2025/    categories (the folders right under the root) and years below them
//     Example UG/Loan/          a folder for a matter inside a category: documents put there stay there
//
// Folders are found by walking down from the root, so with DRIVE_ACCESS=full folders made by hand in Drive count
// too; with drive.file only the folders Paperwork made are seen. Every write
// checks that the file and the folders it touches are inside this tree (`assertInside`); together with the
// request guard in drive.ts, that is what limits Paperwork to "create and organize, inside its folder".
import { CategoryInfo, DocumentInfo, NewFolder, SubfolderInfo } from '../shared/types.js';
import { DEFAULT_CATEGORIES, SPECIAL_FOLDERS } from './categories.js';
import { config } from './config.js';
import { Drive, DriveError, DriveFile, DriveGuardError, FILE_FIELDS, FOLDER, quote } from './drive.js';
import { P, ROLE, clean, fromProperties, nameHash, sourceOf } from './metadata.js';
import { getConnection, rememberRootFolder } from './google.js';

export type FolderRole = 'root' | 'inbox' | 'duplicates' | 'category' | 'folder';

export interface Folder {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
  role: FolderRole;
  // The category (folder right under the root) this folder belongs to
  categoryId: string | null;
  // Names below the root, e.g. ["Bills & Receipts", "2025"]
  path: string[];
  webViewLink: string;
}

export interface Tree {
  root: Folder;
  inbox: Folder;
  duplicates: Folder | null;
  folders: Map<string, Folder>;
  categories: Folder[];
}

export class VaultProblem extends Error {}

// A folder the owner asked for that can't be made or used, e.g. its name is taken
export class FolderProblem extends Error {}

// Deep enough for Category/Year/anything someone adds by hand
const MAX_DEPTH = 4;
// Folders made in the app go at most this deep (Category/Folder/Folder), well within what is walked
const MAX_FOLDER_DEPTH = 3;
const TREE_TTL_MS = 60_000;

let cached: { tree: Tree; at: number } | null = null;

export function forgetTree() {
  cached = null;
}

const folderLink = (id: string) => `https://drive.google.com/drive/folders/${id}`;

function roleOf(file: DriveFile, parent: Folder): FolderRole {
  const marked = file.properties?.[ROLE];
  if (parent.role === 'root' && (marked === 'inbox' || marked === 'duplicates')) return marked;
  return parent.role === 'root' ? 'category' : 'folder';
}

async function walk(drive: Drive, rootFile: DriveFile): Promise<Tree> {
  const root: Folder = {
    id: rootFile.id,
    name: rootFile.name,
    description: rootFile.description ?? '',
    parentId: null,
    role: 'root',
    categoryId: null,
    path: [],
    webViewLink: folderLink(rootFile.id),
  };
  const folders = new Map([[root.id, root]]);
  let level = [root];
  for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
    const next: Folder[] = [];
    // Drive's search takes several parents at once; batches keep the query short
    for (let i = 0; i < level.length; i += 30) {
      const batch = level.slice(i, i + 30);
      const q = `(${batch.map(f => `${quote(f.id)} in parents`).join(' or ')}) and mimeType = ${quote(FOLDER)} and trashed = false`;
      for (const file of await drive.list(q, 'id,name,description,parents,properties')) {
        const parent = batch.find(f => file.parents?.includes(f.id));
        if (!parent || folders.has(file.id)) continue;
        const role = roleOf(file, parent);
        const folder: Folder = {
          id: file.id,
          name: file.name,
          description: file.description ?? '',
          parentId: parent.id,
          role,
          categoryId: role === 'category' ? file.id : parent.categoryId,
          path: [...parent.path, file.name],
          webViewLink: folderLink(file.id),
        };
        folders.set(folder.id, folder);
        next.push(folder);
      }
    }
    level = next;
  }

  const children = [...folders.values()].filter(f => f.parentId === root.id);
  // A folder with the Inbox's (or Duplicates') name counts as one when none is marked, e.g. made by hand
  const special = (role: 'inbox' | 'duplicates') => {
    const folder =
      children.find(f => f.role === role) ??
      children.find(f => f.role === 'category' && f.name.toLowerCase() === SPECIAL_FOLDERS[role].name[config.language].toLowerCase());
    if (folder && folder.role !== role) {
      folder.role = role;
      for (const f of folders.values()) if (f.categoryId === folder.id) f.categoryId = null;
    }
    return folder ?? null;
  };
  const inbox = special('inbox');
  const duplicates = special('duplicates');
  const categories = children.filter(f => f.role === 'category').sort((a, b) => a.name.localeCompare(b.name));
  return { root, inbox: inbox as Folder, duplicates, folders, categories };
}

async function createRoot(drive: Drive): Promise<DriveFile> {
  const root = await drive.createFolder({
    name: config.rootFolderName,
    description: SPECIAL_FOLDERS.root.description,
    properties: { [ROLE]: 'root' },
  });
  for (const category of DEFAULT_CATEGORIES) {
    await drive.createFolder({
      name: category.name[config.language],
      parents: [root.id],
      description: category.description,
      properties: { [ROLE]: 'category' },
    });
  }
  return root;
}

async function findRoot(drive: Drive): Promise<DriveFile | null> {
  const connection = await getConnection();
  if (connection?.rootFolderId) {
    try {
      const root = await drive.get(connection.rootFolderId, FILE_FIELDS);
      if (root.trashed) {
        throw new VaultProblem(`The ${root.name} folder is in your Drive's trash. Restore it in Google Drive to continue.`);
      }
      return root;
    } catch (err) {
      if (!(err instanceof DriveError && err.status === 404)) throw err;
      // Deleted for good (or no longer visible): look for another one, or start over
    }
  }
  const marked = await drive.list(`properties has { key='${ROLE}' and value='root' } and mimeType = ${quote(FOLDER)} and trashed = false`);
  return marked[0] ?? null;
}

let loading: Promise<Tree> | null = null;

// The tree, created on first use. Cached for a minute; folder changes made here clear the cache. Requests
// arriving together share one load, so the folder is never created twice. With `create: false`, and always on
// the public edge (roles.ts), nothing is created or remembered: a missing folder is a VaultProblem.
export function loadTree(drive: Drive, options: { fresh?: boolean; create?: boolean } = {}): Promise<Tree> {
  if (!options.fresh && cached && Date.now() - cached.at < TREE_TTL_MS) return Promise.resolve(cached.tree);
  const create = options.create !== false && config.role !== 'edge';
  loading ??= readTree(drive, create).finally(() => {
    loading = null;
  });
  return loading;
}

const NOT_FOUND = "Paperwork's folder in Google Drive wasn't found. Open Paperwork once, then try again.";

async function readTree(drive: Drive, create: boolean): Promise<Tree> {
  let rootFile = await findRoot(drive);
  if (!rootFile) {
    if (!create) throw new VaultProblem(NOT_FOUND);
    rootFile = await createRoot(drive);
  }
  const connection = await getConnection();
  if (create && connection && connection.rootFolderId !== rootFile.id) await rememberRootFolder(rootFile.id);

  let tree = await walk(drive, rootFile);
  if (!tree.inbox) {
    if (!create) throw new VaultProblem(NOT_FOUND);
    await drive.createFolder({
      name: SPECIAL_FOLDERS.inbox.name[config.language],
      parents: [tree.root.id],
      description: SPECIAL_FOLDERS.inbox.description,
      properties: { [ROLE]: 'inbox' },
    });
    tree = await walk(drive, rootFile);
  }
  cached = { tree, at: Date.now() };
  return tree;
}

// ---------- Staying inside ----------

export function isInside(tree: Tree, parents: string[] | undefined): boolean {
  return !!parents?.some(id => tree.folders.has(id));
}

export function assertInside(tree: Tree, parents: string[] | undefined, what = 'This file'): void {
  if (!isInside(tree, parents)) throw new DriveGuardError(`${what} is outside the ${tree.root.name} folder`);
}

export function folderOf(tree: Tree, file: DriveFile): Folder | null {
  for (const id of file.parents ?? []) {
    const folder = tree.folders.get(id);
    if (folder) return folder;
  }
  return null;
}

const YEAR = /^\d{4}$/;

// A folder named like a year inside the tree ("Bills & Receipts/2025"): documents in it go by their date
export const isYearFolder = (folder: Folder | null | undefined) => folder?.role === 'folder' && YEAR.test(folder.name);

// A folder inside a category that is not a year folder ("Example UG/Eröffnungsbilanz"), made in the app or by hand:
// documents put into it stay there, whatever their date
export const isSubfolder = (folder: Folder | null | undefined) => folder?.role === 'folder' && !!folder.categoryId && !YEAR.test(folder.name);

// A folder documents can be put into: a category, or a folder inside one (not a year folder, the Inbox, Duplicates
// or anything outside the tree)
export function documentFolder(tree: Tree, id: string): Folder {
  const folder = tree.folders.get(id);
  if (folder && (folder.role === 'category' || isSubfolder(folder))) return folder;
  throw new FolderProblem('That is not a folder for documents in Paperwork.');
}

// Moves a file within the tree, into `folder`
export function moveTarget(tree: Tree, file: DriveFile, folderId: string): { from: string[]; to: string } {
  assertInside(tree, file.parents);
  assertInside(tree, [folderId], 'The destination folder');
  // Only the tree's own folders are left; a file someone also keeps elsewhere stays there
  return { from: (file.parents ?? []).filter(id => tree.folders.has(id)), to: folderId };
}

// Moves a file from elsewhere in Drive into the Inbox: only for a file the owner picked in Google's file picker
// (pipeline.ts importFromDrive), which is how they ask for it to be taken into Paperwork. Folders stay put.
export function importTarget(tree: Tree, file: DriveFile): { from: string[]; to: string } {
  if (isInside(tree, file.parents)) throw new DriveGuardError(`This file is already in the ${tree.root.name} folder`);
  if (file.mimeType === FOLDER) throw new DriveGuardError('Folders are not moved into Paperwork');
  return { from: file.parents ?? [], to: tree.inbox.id };
}

// ---------- Folders on demand ----------

export function ensureDuplicates(drive: Drive, tree: Tree): Promise<Folder> {
  if (tree.duplicates) return Promise.resolve(tree.duplicates);
  return once(`${tree.root.id}/duplicates`, () => createDuplicates(drive, tree));
}

async function createDuplicates(drive: Drive, tree: Tree): Promise<Folder> {
  const name = SPECIAL_FOLDERS.duplicates.name[config.language];
  const created = await drive.createFolder({
    name,
    parents: [tree.root.id],
    description: SPECIAL_FOLDERS.duplicates.description,
    properties: { [ROLE]: 'duplicates' },
  });
  const folder: Folder = {
    id: created.id,
    name,
    description: SPECIAL_FOLDERS.duplicates.description,
    parentId: tree.root.id,
    role: 'duplicates',
    categoryId: null,
    path: [name],
    webViewLink: folderLink(created.id),
  };
  tree.folders.set(folder.id, folder);
  tree.duplicates = folder;
  return folder;
}

// Folders being created right now, so two documents of a new year don't each make one
const creating = new Map<string, Promise<Folder>>();

function once(key: string, make: () => Promise<Folder>): Promise<Folder> {
  let pending = creating.get(key);
  if (!pending) {
    pending = make().finally(() => creating.delete(key));
    creating.set(key, pending);
  }
  return pending;
}

// The year folder inside a category, made when the first document of that year arrives
export function ensureYearFolder(drive: Drive, tree: Tree, categoryId: string, year: string): Promise<Folder> {
  const category = tree.folders.get(categoryId);
  if (!category || category.role !== 'category') return Promise.reject(new DriveGuardError('Not a category folder'));
  const existing = [...tree.folders.values()].find(f => f.parentId === categoryId && f.name === year);
  if (existing) return Promise.resolve(existing);
  return once(`${categoryId}/${year}`, () => createYearFolder(drive, tree, category, year));
}

async function createYearFolder(drive: Drive, tree: Tree, category: Folder, year: string): Promise<Folder> {
  const categoryId = category.id;
  const created = await drive.createFolder({ name: year, parents: [categoryId] });
  const folder: Folder = {
    id: created.id,
    name: year,
    description: '',
    parentId: categoryId,
    role: 'folder',
    categoryId,
    path: [...category.path, year],
    webViewLink: folderLink(created.id),
  };
  tree.folders.set(folder.id, folder);
  return folder;
}

const MAX_FOLDER_NAME = 80;
const MAX_FOLDER_DESCRIPTION = 1000;

// A folder made in the app (with drive.file, Paperwork can't see a folder made by hand in Drive): a new category
// right under the root, e.g. for a company, or a folder for a matter inside a category (or inside such a folder).
// It is put into the cached tree as written, so the next sync sees nothing to check.
export async function createFolder(drive: Drive, tree: Tree, request: NewFolder): Promise<Folder> {
  const parent = request.parentId ? tree.folders.get(request.parentId) : tree.root;
  if (isYearFolder(parent)) throw new FolderProblem('New folders go next to the year folders, not into them.');
  if (!parent || !(parent.role === 'root' || parent.role === 'category' || isSubfolder(parent))) {
    throw new FolderProblem(`New folders go into the ${tree.root.name} folder or one of its folders.`);
  }
  if (parent.path.length >= MAX_FOLDER_DEPTH) throw new FolderProblem(`Folders go at most ${MAX_FOLDER_DEPTH} levels deep.`);
  const name = clean(request.name ?? '').slice(0, MAX_FOLDER_NAME).trim();
  if (!name) throw new FolderProblem('Give the folder a name.');
  const same = (other: string) => other.toLowerCase() === name.toLowerCase();
  // Taken for the Inbox and Duplicates even while there is none: a folder named so would be taken for one
  if (same(SPECIAL_FOLDERS.inbox.name[config.language]) || same(SPECIAL_FOLDERS.duplicates.name[config.language])) {
    throw new FolderProblem(`${name} is the name of a folder Paperwork keeps for itself.`);
  }
  // Inside a category, it would be taken for a year folder (filing puts documents of that year into it)
  if (parent.role !== 'root' && YEAR.test(name)) throw new FolderProblem('Names like 2026 are kept for year folders. Give the folder another name.');
  if ([...tree.folders.values()].some(f => f.parentId === parent.id && same(f.name))) throw new FolderProblem(`There is a folder named ${name} already.`);
  const description = (request.description ?? '').trim().slice(0, MAX_FOLDER_DESCRIPTION);
  if (parent.role === 'root') return once(`${tree.root.id}/category/${name.toLowerCase()}`, () => createCategory(drive, tree, name, description));
  return once(`${parent.id}/folder/${name.toLowerCase()}`, () => createSubfolder(drive, tree, parent, name, description));
}

async function createCategory(drive: Drive, tree: Tree, name: string, description: string): Promise<Folder> {
  const created = await drive.createFolder({
    name,
    parents: [tree.root.id],
    ...(description ? { description } : {}),
    properties: { [ROLE]: 'category' },
  });
  const folder: Folder = {
    id: created.id,
    name,
    description,
    parentId: tree.root.id,
    role: 'category',
    categoryId: created.id,
    path: [name],
    webViewLink: folderLink(created.id),
  };
  tree.folders.set(folder.id, folder);
  tree.categories.push(folder);
  tree.categories.sort((a, b) => a.name.localeCompare(b.name));
  return folder;
}

// A folder for a matter: no label, a folder by its place in the tree, like a year folder
async function createSubfolder(drive: Drive, tree: Tree, parent: Folder, name: string, description: string): Promise<Folder> {
  const created = await drive.createFolder({ name, parents: [parent.id], ...(description ? { description } : {}) });
  const folder: Folder = {
    id: created.id,
    name,
    description,
    parentId: parent.id,
    role: 'folder',
    categoryId: parent.categoryId,
    path: [...parent.path, name],
    webViewLink: folderLink(created.id),
  };
  tree.folders.set(folder.id, folder);
  return folder;
}

// ---------- Listing ----------

const DOC_QUERY = `properties has { key='${ROLE}' and value='doc' } and trashed = false`;

// A file kept with a document (attachments.ts). It is never a document itself: not filed, adopted, edited or
// indexed as one.
export const isKept = (file: DriveFile) => file.properties?.[ROLE] === 'attachment';
export const keptError = () => new DriveError('This file is kept with another document.', 404);

export function toDocumentInfo(tree: Tree, file: DriveFile): DocumentInfo {
  const meta = fromProperties(file.properties, file.description);
  const folder = folderOf(tree, file);
  const inInbox = folder?.role === 'inbox';
  // Waiting in the Inbox for its check: in the category it goes to
  const target = inInbox ? tree.folders.get(file.properties?.[P.target] ?? '') : null;
  const category = target?.role === 'category' ? target : folder?.categoryId ? tree.folders.get(folder.categoryId) : null;
  const stem = file.name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  // Renamed in Drive since Paperwork named it: the new name wins
  const renamed = file.properties?.[P.nameHash] !== nameHash(file.name);
  return {
    id: file.id,
    name: file.name,
    title: !renamed && meta.title ? meta.title : stem,
    mimeType: file.mimeType,
    categoryId: category?.id ?? null,
    category: category?.name ?? null,
    folderPath: folder?.path ?? [],
    folderId: folder?.id ?? null,
    type: meta.type,
    correspondent: meta.correspondent,
    date: meta.date,
    amount: meta.amount,
    currency: meta.currency,
    dueDate: meta.dueDate,
    deadlines: meta.deadlines,
    items: meta.items,
    tags: meta.tags,
    references: meta.references,
    action: meta.action,
    summary: meta.summary,
    topic: meta.topic,
    gist: meta.gist,
    needsReview: meta.needsReview,
    inInbox,
    starred: !!file.starred,
    source: sourceOf(file.properties),
    // Known only to the search index (indexing.ts fills these in)
    textSource: null,
    textLength: 0,
    addedAt: file.createdTime ?? '',
    modifiedAt: file.modifiedTime ?? '',
    size: file.size ? Number(file.size) : null,
    webViewLink: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
    hasThumbnail: !!file.hasThumbnail,
    // Left out when there is none, as for entries indexed before Paperwork looked for copies
    ...(file.properties?.[P.maybeDup] ? { possibleDuplicateOf: file.properties[P.maybeDup] } : {}),
  };
}

// A document described by Paperwork that waits in the Inbox until the owner has checked it (review mode
// manual). One moved back into the Inbox by hand, already checked, is filed again instead.
export function waitsForCheck(tree: Tree, file: DriveFile): boolean {
  return file.properties?.[ROLE] === 'doc' && file.properties?.[P.review] === '1' && folderOf(tree, file)?.role === 'inbox';
}

// A filed document that counts: labelled as one, inside the tree, not (back) in the Inbox unless it waits there
// for its check
export function isFiledDocument(tree: Tree, file: DriveFile): boolean {
  return file.properties?.[ROLE] === 'doc' && !file.trashed && isInside(tree, file.parents) && (folderOf(tree, file)?.role !== 'inbox' || waitsForCheck(tree, file));
}

// Every filed document in Drive. Documents moved out of the Paperwork folder in Drive no longer count.
export async function listDocumentFiles(drive: Drive, tree: Tree): Promise<DriveFile[]> {
  return (await drive.list(DOC_QUERY)).filter(f => isFiledDocument(tree, f));
}

export async function listDocuments(drive: Drive, tree: Tree): Promise<DocumentInfo[]> {
  return (await listDocumentFiles(drive, tree)).map(f => toDocumentInfo(tree, f));
}

export async function getDocument(drive: Drive, tree: Tree, id: string): Promise<{ file: DriveFile; doc: DocumentInfo }> {
  const file = await drive.get(id);
  if (file.trashed || !isInside(tree, file.parents)) throw new DriveError('This document is not in Paperwork.', 404);
  if (isKept(file)) throw keptError();
  return { file, doc: toDocumentInfo(tree, file) };
}

export const subfolderInfo = (folder: Folder): SubfolderInfo => ({ id: folder.id, name: folder.name, path: folder.path.slice(1), webViewLink: folder.webViewLink });

export function categoryInfos(tree: Tree, documents: DocumentInfo[]): CategoryInfo[] {
  const counts = new Map<string, number>();
  for (const doc of documents) if (doc.categoryId) counts.set(doc.categoryId, (counts.get(doc.categoryId) ?? 0) + 1);
  const subfolders = [...tree.folders.values()].filter(isSubfolder).sort((a, b) => a.path.join(' / ').localeCompare(b.path.join(' / ')));
  return tree.categories.map(c => ({
    id: c.id,
    name: c.name,
    description: c.description,
    count: counts.get(c.id) ?? 0,
    webViewLink: c.webViewLink,
    folders: subfolders.filter(f => f.categoryId === c.id).map(subfolderInfo),
  }));
}

// Files in the Inbox still to be read and filed, oldest first (not the documents waiting there for a check, nor
// the files kept with them)
export async function listInbox(drive: Drive, tree: Tree): Promise<DriveFile[]> {
  const files = await drive.list(`${quote(tree.inbox.id)} in parents and mimeType != ${quote(FOLDER)} and trashed = false`, FILE_FIELDS, 'createdTime');
  return files.filter(f => !waitsForCheck(tree, f) && !isKept(f));
}

// Files put straight into a category folder by hand, which Paperwork hasn't described yet (files kept with a
// document sit there too, labelled as such)
export async function listUnfiled(drive: Drive, tree: Tree): Promise<DriveFile[]> {
  const folders = [...tree.folders.values()].filter(f => f.role === 'category' || f.role === 'folder');
  const found: DriveFile[] = [];
  for (let i = 0; i < folders.length; i += 30) {
    const batch = folders.slice(i, i + 30);
    const q = `(${batch.map(f => `${quote(f.id)} in parents`).join(' or ')}) and mimeType != ${quote(FOLDER)} and trashed = false`;
    for (const file of await drive.list(q)) {
      const role = file.properties?.[ROLE];
      if (role !== 'doc' && role !== 'duplicate' && role !== 'attachment' && !file.mimeType.startsWith('application/vnd.google-apps.shortcut')) found.push(file);
    }
  }
  return found;
}
