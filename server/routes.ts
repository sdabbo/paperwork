// The app's API (/api) and the Google sign-in round trip (/auth).
import express, { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { Readable } from 'stream';
import { EXPORT_AS_PDF, mimeFromName } from './extract.js';
import {
  AiAccess,
  AttachResult,
  CategoryInfo,
  DocumentInfo,
  DocumentText,
  DocumentUpdate,
  DuplicateChoiceResult,
  EmailSetupChange,
  IndexStatus,
  LibraryResponse,
  NewAiClient,
  NewFolder,
  PickerConfig,
  RenameRequest,
  SavedView,
  SessionInfo,
  Settings,
  SubfolderInfo,
  TopicMerge,
  TopicMove,
  TopicSuggestions,
  VaultStatus,
} from '../shared/types.js';
import { recentActivity, lastSyncSummary } from './activity.js';
import { AccessProblem, appList, readAccess, registrationOf } from './aiApps.js';
import { ask, AskTurn } from './ask.js';
import { AttachProblem, attachExisting, attachFile, listAttachments } from './attachments.js';
import { currentUser, endSession, isAllowed, localPath, rememberOAuth, requireUser, startSession, takeOAuth } from './auth.js';
import { config } from './config.js';
import { contracts, setHidden } from './contracts.js';
import { DriveError, DriveGuardError } from './drive.js';
import { SetupProblem, changeEmailSetup, emailSetup, inboundAddress } from './email.js';
import { LimitError } from './gemini.js';
import {
  NotConnectedError,
  SIGN_IN_SCOPES,
  accessToken,
  authorizationUrl,
  driveScope,
  exchangeCode,
  forgetConnection,
  getConnection,
  getDrive,
  grantOf,
  pickerUnavailable,
  pkcePair,
  saveConnection,
  verifyIdToken,
} from './google.js';
import { P } from './metadata.js';
import { ClientProblem, addClient, allowApps, changeRegistration, connections, disconnect, manualClients, mcpUrl, recentEvents, removeClient } from './oauth.js';
import {
  DuplicateProblem,
  addFile,
  detachFile,
  importFromDrive,
  mergeTopics,
  moveTopic,
  refile,
  renameAll,
  resolvePossibleDuplicate,
  retryFile,
  setDeadlineDone,
  syncVault,
  updateDocument,
} from './pipeline.js';
import { dismissSuggestion, topicSuggestions } from './topics.js';
import { getSettings, saveSettings } from './settings.js';
import { getIndex } from './docIndex.js';
import { changed, fromDrive, indexDetails, indexStatus, toInfo } from './indexing.js';
import { indexedDocuments } from './library.js';
import { search } from './search.js';
import { taxReturn } from './taxes.js';
import { backlogPaused } from './sync.js';
import { joinChunks } from './text.js';
import {
  FolderProblem,
  Tree,
  VaultProblem,
  categoryInfos,
  createFolder,
  forgetTree,
  getDocument,
  isFiledDocument,
  listDocuments,
  listInbox,
  loadTree,
  subfolderInfo,
} from './vault.js';

// ---------- Vault status ----------

async function vaultStatus(email: string | undefined): Promise<VaultStatus> {
  const connection = await getConnection();
  const grant = connection && !connection.broken ? grantOf(connection.scope) : null;
  const status: VaultStatus = {
    connected: !!connection && !connection.broken,
    ownerEmail: connection?.ownerEmail ?? null,
    access: config.driveAccess,
    grant: grant && grant !== config.driveAccess ? grant : null,
    pickerUnavailable: pickerUnavailable(connection, email),
    rootUrl: null,
    inboxUrl: null,
    rootName: config.rootFolderName,
    language: config.language,
    problem: connection?.broken ? "Google stopped accepting Paperwork's access to Drive. Connect Drive again." : null,
    email: { configured: !!config.inboundSecret, address: await inboundAddress() },
  };
  if (status.connected) {
    try {
      const tree = await loadTree(getDrive());
      status.rootUrl = tree.root.webViewLink;
      status.inboxUrl = tree.inbox.webViewLink;
    } catch (err) {
      status.problem = err instanceof VaultProblem || err instanceof NotConnectedError ? err.message : `Google Drive is not answering: ${(err as Error).message}`;
    }
  }
  return status;
}

// ---------- Sign-in ----------

export const authRouter = express.Router();

const backWithError = (res: Response, message: string) => res.redirect(`/?error=${encodeURIComponent(message)}`);

// ?next=/path returns there afterwards (a link to a document, an AI app asking to connect)
authRouter.get('/signin', async (req, res) => {
  if (!config.googleClientId) return backWithError(res, 'Google sign-in is not set up: GOOGLE_CLIENT_ID is missing.');
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString('hex');
  await rememberOAuth(res, { state, verifier, purpose: 'signin', next: localPath(req.query.next) ?? undefined });
  res.redirect(authorizationUrl({ scopes: SIGN_IN_SCOPES, state, challenge, offline: false }));
});

authRouter.get('/connect', async (req, res) => {
  const user = await currentUser(req);
  if (!user) return res.redirect('/auth/signin');
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomBytes(16).toString('hex');
  await rememberOAuth(res, { state, verifier, purpose: 'connect' });
  res.redirect(authorizationUrl({ scopes: [...SIGN_IN_SCOPES, driveScope()], state, challenge, offline: true, loginHint: user.email }));
});

authRouter.get('/callback', async (req, res) => {
  const saved = await takeOAuth(req, res);
  if (req.query.error) {
    return backWithError(res, req.query.error === 'access_denied' ? 'Signing in with Google was cancelled.' : `Google sign-in failed: ${req.query.error}`);
  }
  if (!saved || typeof req.query.code !== 'string' || req.query.state !== saved.state) {
    return backWithError(res, 'That sign-in link has expired. Please try again.');
  }
  try {
    const tokens = await exchangeCode(req.query.code, saved.verifier);
    if (!tokens.id_token) throw new Error('Google sent no identity.');
    const user = await verifyIdToken(tokens.id_token);
    if (!isAllowed(user.email)) return backWithError(res, `${user.email} is not allowed to use this Paperwork. Ask its owner to add the address to ALLOWED_EMAILS.`);
    await startSession(res, user);

    if (saved.purpose === 'connect') {
      if (!tokens.scope?.split(' ').includes(driveScope())) {
        return backWithError(res, "Paperwork needs access to Google Drive to work. Please connect again and allow Drive on Google's screen.");
      }
      if (!tokens.refresh_token) {
        return backWithError(res, 'Google did not grant lasting access. Remove Paperwork at myaccount.google.com/permissions, then connect again.');
      }
      const existing = await getConnection();
      if (existing && !existing.broken && existing.ownerEmail !== user.email) {
        return backWithError(res, `Google Drive is already connected through ${existing.ownerEmail}. They can disconnect it in Settings first.`);
      }
      await saveConnection(user.email, tokens.refresh_token, tokens.scope);
      forgetTree();
      // Creates the Paperwork folder now, so it's there to scan into
      try {
        await loadTree(getDrive(), { fresh: true });
      } catch (err) {
        console.error('Setting up the Paperwork folder failed:', err);
      }
      return res.redirect('/?connected=1');
    }
    res.redirect(localPath(saved.next) ?? '/');
  } catch (err) {
    console.error('Google sign-in failed:', err);
    backWithError(res, `Google sign-in failed: ${(err as Error).message}`);
  }
});

authRouter.post('/signout', (req, res) => {
  if (req.get('x-paperwork') !== '1') return res.status(403).end();
  endSession(res);
  res.status(204).end();
});

// ---------- API ----------

export const apiRouter = express.Router();

apiRouter.get('/session', async (req, res) => {
  const user = await currentUser(req);
  const body: SessionInfo = { user, vault: user ? await vaultStatus(user.email) : null };
  res.json(body);
});

apiRouter.use(requireUser);

// Uploads arrive as the raw file; everything else is JSON. Cloud Run takes at most 32 MiB in a request over HTTP/1,
// so files up to 30 MB.
const rawFile = express.raw({ type: () => true, limit: '30mb' });

// The name and type of a file sent as the raw body: the type by its extension when the browser gave none, as
// phones do for Word files
function sentFile(req: Request) {
  const name = decodeURIComponent(req.get('x-file-name') || 'Upload').replace(/[/\\]/g, ' ').slice(0, 200);
  return { name, mimeType: mimeFromName(name, req.get('content-type') || '') };
}

// X-Into: the ID of a folder to file it into ("Add a document to this folder"), checked by the pipeline
apiRouter.post('/upload', rawFile, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'The file is empty.' });
  res.json(await addFile({ ...sentFile(req), data: new Uint8Array(req.body), source: 'upload', into: req.get('x-into') }));
});

// A file kept with a document, e.g. its Word draft (attachments.ts): stored next to it, never read
apiRouter.post('/documents/:id/files', rawFile, async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'The file is empty.' });
  const label = decodeURIComponent(req.get('x-file-label') || '');
  const body: AttachResult = await attachFile(String(req.params.id), { ...sentFile(req), label, data: new Uint8Array(req.body) });
  res.json(body);
});

apiRouter.use(express.json({ limit: '1mb' }));

// The documents from the index (filled from Drive first when empty, library.ts); straight from Drive (without deadlines and search) when the index can't be read
async function libraryDocuments(tree: Tree): Promise<{ documents: DocumentInfo[]; index: IndexStatus }> {
  try {
    const indexed = await indexedDocuments(tree);
    const status = indexStatus(indexed);
    return { documents: indexed.map(toInfo), index: { ...status, paused: status.pending > 0 && (await backlogPaused()) } };
  } catch (err) {
    console.error('Reading the search index failed; listing the documents from Drive instead:', err);
    const documents = await listDocuments(getDrive(), tree);
    return { documents, index: { documents: documents.length, searchable: 0, pending: 0, paused: false, topicsPending: 0 } };
  }
}

apiRouter.get('/library', async (_req, res) => {
  const drive = getDrive();
  const tree = await loadTree(drive);
  const [{ documents, index }, inboxFiles, lastSync, kept] = await Promise.all([
    libraryDocuments(tree),
    listInbox(drive, tree),
    lastSyncSummary(),
    // The library shows without the kept files when they can't be listed
    listAttachments(drive, tree).catch(err => {
      console.error('Listing the files kept with documents failed:', err);
      return [];
    }),
  ]);
  const listed = new Set(documents.map(d => d.id));
  const body: LibraryResponse = {
    documents,
    categories: categoryInfos(tree, documents),
    inbox: inboxFiles.map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      addedAt: f.createdTime ?? '',
      state: f.properties?.[P.state] === 'failed' ? 'failed' : f.properties?.[P.state] === 'unsupported' ? 'unsupported' : 'waiting',
      error: f.properties?.[P.error] ?? null,
      webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`,
    })),
    // Those of documents that are gone are left out (Paperwork never deletes them)
    attachments: kept.filter(a => listed.has(a.documentId)),
    duplicatesFolderUrl: tree.duplicates?.webViewLink ?? null,
    lastSync,
    index,
  };
  res.json(body);
});

apiRouter.post('/sync', async (_req, res) => {
  res.json(await syncVault('app'));
});

apiRouter.get('/activity', async (_req, res) => {
  res.json({ entries: await recentActivity() });
});

// Fresh from Drive, merged with what the index knows (and the index brought up to date if Drive changed).
// Read under the document's lock, so it can't write back a state older than an edit finishing meanwhile.
apiRouter.get('/documents/:id', async (req, res) => {
  const drive = getDrive();
  const tree = await loadTree(drive);
  const index = getIndex();
  const id = String(req.params.id);
  const info = await index.lock(id, async () => {
    const { file, doc } = await getDocument(drive, tree, id);
    // Only filed documents are in the index (not a file in the Inbox or among the duplicates)
    if (!isFiledDocument(tree, file)) return doc;
    try {
      const previous = await index.getAny(file.id);
      const live = previous?.removedAt ? null : previous;
      let entry = fromDrive(tree, file, previous);
      if (changed(live, entry)) entry = await indexDetails(entry, live);
      return toInfo(entry);
    } catch (err) {
      console.error(`Updating ${file.name} in the search index failed:`, err);
      return doc;
    }
  });
  res.json(info);
});

// The document's text as the index has it (read from the PDF, or transcribed from a scan)
apiRouter.get('/documents/:id/text', async (req, res) => {
  const doc = await getIndex().get(String(req.params.id));
  if (!doc) return res.status(404).json({ error: 'This document is not in Paperwork.' });
  const chunks = (await getIndex().chunks(doc.id)).filter(c => c.n > 0);
  const body: DocumentText = { text: joinChunks(chunks.map(c => c.text)), source: doc.textSource };
  res.json(body);
});

apiRouter.post('/documents/:id/deadlines', async (req, res) => {
  const { date, what, done } = req.body ?? {};
  if (typeof date !== 'string' || typeof what !== 'string' || typeof done !== 'boolean') {
    return res.status(400).json({ error: 'Say which deadline (date and what) and whether it is done.' });
  }
  res.json(await setDeadlineDone(String(req.params.id), { date, what }, done));
});

apiRouter.patch('/documents/:id', async (req, res) => {
  const update = (req.body ?? {}) as DocumentUpdate;
  const { deadlines, items } = update;
  if (deadlines !== undefined && !(Array.isArray(deadlines) && deadlines.every(d => d && typeof d === 'object' && typeof d.date === 'string' && typeof d.what === 'string'))) {
    return res.status(400).json({ error: 'Deadlines need a date and a description each.' });
  }
  if (items !== undefined && !(Array.isArray(items) && items.every(i => i && typeof i === 'object' && typeof i.name === 'string' && i.name.trim()))) {
    return res.status(400).json({ error: 'Each item needs a name.' });
  }
  if (update.folderId !== undefined && (typeof update.folderId !== 'string' || !update.folderId)) {
    return res.status(400).json({ error: 'Say which folder to move it to.' });
  }
  if (update.notDuplicate !== undefined && typeof update.notDuplicate !== 'boolean') return res.status(400).json({ error: 'Say whether it is a copy.' });
  // Keep both names the document the owner compared it with: a mark that names another one now is asked about again
  if (update.notDuplicate === true && (typeof update.duplicateOf !== 'string' || !update.duplicateOf)) {
    return res.status(400).json({ error: 'Say which document it is no copy of.' });
  }
  res.json(await updateDocument(String(req.params.id), update));
});

apiRouter.post('/documents/:id/refile', async (req, res) => {
  res.json(await refile(String(req.params.id)));
});

// A document made a file kept with another one, e.g. a draft filed as a document of its own
apiRouter.post('/documents/:id/attach-to', async (req, res) => {
  const parentId = req.body?.parentId;
  if (typeof parentId !== 'string' || !parentId) return res.status(400).json({ error: 'Say which document to keep it with.' });
  const body: AttachResult = await attachExisting(String(req.params.id), parentId);
  res.json(body);
});

// What the owner says about a possible duplicate: two different documents, the same one (to Duplicates), or the
// same one kept as a file with the original. `of` names the original they were shown, so a mark moved to another
// one meanwhile isn't decided unseen.
apiRouter.post('/documents/:id/possible-duplicate', async (req, res) => {
  const { choice, of } = req.body ?? {};
  if (choice !== 'keep-both' && choice !== 'duplicate' && choice !== 'keep-with') {
    return res.status(400).json({ error: 'Say whether to keep both, move it to Duplicates or keep it with the original.' });
  }
  if (typeof of !== 'string' || !of) return res.status(400).json({ error: 'Say which document it may be a copy of.' });
  const body: DuplicateChoiceResult = await resolvePossibleDuplicate(String(req.params.id), choice, of);
  res.json(body);
});

// A kept file made a document of its own: filed from the Inbox like a new one
apiRouter.post('/attachments/:id/detach', async (req, res) => {
  res.json(await detachFile(String(req.params.id)));
});

// A new folder: right under the Paperwork folder, e.g. for a company (Settings), answered as a CategoryInfo; or with
// parentId, inside a category (or one of its folders) for a matter, answered as a SubfolderInfo
apiRouter.post('/folders', async (req, res) => {
  const { name, description, parentId } = (req.body ?? {}) as Partial<NewFolder>;
  if (typeof name !== 'string' || !name.trim() || (description != null && typeof description !== 'string') || (parentId != null && typeof parentId !== 'string')) {
    return res.status(400).json({ error: 'Give the folder a name.' });
  }
  const drive = getDrive();
  const folder = await createFolder(drive, await loadTree(drive), { name, description: description ?? undefined, parentId: parentId ?? undefined });
  if (folder.role !== 'category') {
    const body: SubfolderInfo = subfolderInfo(folder);
    return res.json(body);
  }
  const body: CategoryInfo = { id: folder.id, name: folder.name, description: folder.description, count: 0, webViewLink: folder.webViewLink, folders: [] };
  res.json(body);
});

// Google's file picker, for scans made with the Drive app and other files elsewhere in Drive (with Drive access
// limited to Paperwork's own files). The browser gets the owner's Drive token for picking: limited to
// Paperwork's own and picked files, and never handed out while it could open the whole Drive.
class PickerUnavailable extends Error {}

async function assertPicker(email: string | undefined) {
  const reason = pickerUnavailable(await getConnection(), email);
  if (reason) throw new PickerUnavailable(reason);
}

apiRouter.post('/drive/picker', async (_req, res) => {
  await assertPicker(res.locals.user?.email);
  const body: PickerConfig = { token: await accessToken(), apiKey: config.pickerApiKey, appId: config.pickerAppId };
  res.setHeader('Cache-Control', 'no-store');
  res.json(body);
});

// A file picked in the picker: moved into the Inbox and filed (pipeline.ts); ?into= the ID of a folder to file it into
apiRouter.post('/drive/import/:id', async (req, res) => {
  await assertPicker(res.locals.user?.email);
  const into = req.query.into;
  res.json(await importFromDrive(String(req.params.id), into === undefined ? undefined : String(into)));
});

// A correspondent, or a topic, renamed (or merged into another) in all its documents
apiRouter.post('/rename', async (req, res) => {
  const { correspondent, topic, to } = (req.body ?? {}) as Partial<RenameRequest>;
  const named = (v: unknown) => typeof v === 'string' && !!v.trim();
  if (!named(to) || !(named(topic) || named(correspondent)) || (topic != null && typeof topic !== 'string') || (correspondent != null && typeof correspondent !== 'string')) {
    return res.status(400).json({ error: 'Say which correspondent or topic to rename, and the new name.' });
  }
  res.json(await renameAll({ correspondent, topic, to: to! }));
});

// Topics that look like the same matter (topics.ts), to merge or dismiss
apiRouter.get('/topics/suggestions', async (_req, res) => {
  const body: TopicSuggestions = { suggestions: await topicSuggestions() };
  res.json(body);
});

apiRouter.post('/topics/suggestions/dismiss', async (req, res) => {
  const topics = req.body?.topics;
  if (!Array.isArray(topics) || topics.length < 2 || !topics.every(t => typeof t === 'string')) {
    return res.status(400).json({ error: 'Say which topics are different matters.' });
  }
  await dismissSuggestion(topics);
  res.status(204).end();
});

apiRouter.post('/topics/merge', async (req, res) => {
  const { from, to } = (req.body ?? {}) as Partial<TopicMerge>;
  if (!Array.isArray(from) || !from.length || !from.every(t => typeof t === 'string') || typeof to !== 'string' || !to.trim()) {
    return res.status(400).json({ error: 'Say which topics to merge, and the name they get.' });
  }
  res.json(await mergeTopics({ from, to }));
});

// A topic's documents moved into a folder (Topic page), with their kept files; a folder that is not for documents
// is explained by the pipeline (FolderProblem)
apiRouter.post('/topics/move', async (req, res) => {
  const { topic, folderId } = (req.body ?? {}) as Partial<TopicMove>;
  if (typeof topic !== 'string' || !topic.trim() || topic.length > 300 || typeof folderId !== 'string' || !folderId) {
    return res.status(400).json({ error: 'Say which topic to move, and the folder to move it to.' });
  }
  res.json(await moveTopic(topic, folderId));
});

apiRouter.post('/inbox/:id/retry', async (req, res) => {
  res.json(await retryFile(String(req.params.id)));
});

// The file itself, for the app's own viewer. (Drive's preview needs the browser's Google sign-in inside the
// page, which phones often don't allow.) PDFs and images as they are, Google Docs, Sheets and Slides as PDF; anything else is
// opened in Drive. Never served as a page: no other type, and sandboxed should a browser try.
const VIEWABLE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

apiRouter.get('/documents/:id/file', async (req, res) => {
  const drive = getDrive();
  const { file } = await getDocument(drive, await loadTree(drive), String(req.params.id));
  const asPdf = EXPORT_AS_PDF.has(file.mimeType);
  const type = asPdf ? 'application/pdf' : file.mimeType;
  if (!VIEWABLE.has(type)) return res.status(415).json({ error: 'Paperwork can’t show this kind of file. Open it in Drive.' });
  const upstream = asPdf ? await drive.exportResponse(file.id, type) : await drive.downloadResponse(file.id);
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(asPdf ? `${file.name}.pdf` : file.name)}`);
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.setHeader('Cache-Control', 'private, max-age=300');
  const length = upstream.headers.get('content-length');
  if (length) res.setHeader('Content-Length', length);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body as import('stream/web').ReadableStream).pipe(res);
});

apiRouter.get('/documents/:id/thumbnail', async (req, res) => {
  const drive = getDrive();
  await getDocument(drive, await loadTree(drive), String(req.params.id));
  const thumb = await drive.thumbnail(String(req.params.id));
  if (!thumb) return res.status(404).end();
  res.setHeader('Content-Type', thumb.headers.get('content-type') || 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(await thumb.arrayBuffer()));
});

// By meaning (the search index) and by words (Drive's full-text search), ranked together (search.ts)
apiRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 200);
  if (!q) return res.json({ hits: [], semantic: true });
  const drive = getDrive();
  res.json(await search(drive, await loadTree(drive), q));
});

apiRouter.post('/ask', async (req, res) => {
  const question = String(req.body?.question ?? '').trim().slice(0, 2000);
  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .filter((t: any) => (t?.role === 'user' || t?.role === 'assistant') && typeof t.text === 'string')
    .map((t: any): AskTurn => ({ role: t.role, text: t.text }));
  if (!question) return res.status(400).json({ error: 'Ask a question.' });
  const drive = getDrive();
  const documents = (await indexedDocuments(await loadTree(drive))).map(toInfo);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    for await (const event of ask(drive, question, history, documents)) res.write(JSON.stringify(event) + '\n');
  } catch (err) {
    res.write(JSON.stringify({ type: 'error', error: err instanceof LimitError ? err.message : 'Paperwork could not answer that just now. Please try again.' }) + '\n');
    console.error('Ask failed:', err);
  }
  res.end();
});

// ---------- Settings ----------

function cleanView(view: any): SavedView | null {
  if (!view || typeof view.name !== 'string' || !view.name.trim()) return null;
  const f = view.filters ?? {};
  const s = (v: unknown, max = 200) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
  return {
    id: s(view.id, 40) ?? crypto.randomUUID(),
    name: view.name.trim().slice(0, 60),
    filters: {
      query: s(f.query),
      categoryId: s(f.categoryId, 100),
      folderId: s(f.folderId, 100),
      type: s(f.type, 30) as SavedView['filters']['type'],
      year: s(f.year, 4),
      correspondent: s(f.correspondent),
      topic: s(f.topic),
      tags: Array.isArray(f.tags) ? f.tags.filter((t: unknown) => typeof t === 'string').slice(0, 10) : undefined,
      starred: f.starred === true || undefined,
      review: f.review === true || undefined,
      sort: ['date', 'added', 'title', 'amount', 'due'].includes(f.sort) ? f.sort : undefined,
      order: f.order === 'asc' || f.order === 'desc' ? f.order : undefined,
    },
  };
}

apiRouter.get('/settings', async (_req, res) => {
  res.json(await getSettings());
});

// What is given changes (saved views, review mode); the rest stays
apiRouter.put('/settings', async (req, res) => {
  const change: Partial<Settings> = {};
  if (Array.isArray(req.body?.views)) change.views = req.body.views.map(cleanView).filter(Boolean).slice(0, 50) as SavedView[];
  if (req.body?.review === 'manual' || req.body?.review === 'automatic') change.review = req.body.review;
  res.json(await saveSettings(change));
});

// ---------- AI apps (mcp.ts, oauth.ts) ----------

const aiAccess = async (): Promise<AiAccess> => {
  const [connected, clients, events, access] = await Promise.all([connections(), manualClients(), recentEvents(), readAccess()]);
  return { url: mcpUrl(), connections: connected, clients, events, apps: appList(access), registration: registrationOf(access) };
};

apiRouter.get('/mcp', async (_req, res) => {
  res.json(await aiAccess());
});

// Which apps may connect: { apps: ['gemini', …] }
apiRouter.put('/mcp/apps', async (req, res) => {
  try {
    await allowApps(req.body?.apps, res.locals.user.email);
  } catch (err) {
    if (err instanceof AccessProblem) return res.status(400).json({ error: err.message });
    throw err;
  }
  res.json(await aiAccess());
});

// "Connect an AI app": { open: true } lets an allowed app register itself for a quarter of an hour
apiRouter.post('/mcp/registration', async (req, res) => {
  if (typeof req.body?.open !== 'boolean') return res.status(400).json({ error: 'Say whether to open or close the window for connecting an app.' });
  await changeRegistration(req.body.open, res.locals.user.email);
  res.json(await aiAccess());
});

apiRouter.delete('/mcp/connections/:id', async (req, res) => {
  await disconnect(String(req.params.id));
  res.json(await aiAccess());
});

// An app that asks for a client ID and secret instead of registering itself (Gemini, when it can't)
apiRouter.post('/mcp/clients', async (req, res) => {
  try {
    const { client, secret } = await addClient({ redirectUri: req.body?.redirectUri, name: req.body?.name }, res.locals.user.email);
    res.setHeader('Cache-Control', 'no-store');
    const body: NewAiClient = { client, secret, access: await aiAccess() };
    res.json(body);
  } catch (err) {
    if (err instanceof ClientProblem) return res.status(400).json({ error: err.message });
    throw err;
  }
});

apiRouter.delete('/mcp/clients/:id', async (req, res) => {
  await removeClient(String(req.params.id));
  res.json(await aiAccess());
});

// ---------- Contracts ----------

// As read so far, at once
apiRouter.get('/contracts', async (_req, res) => {
  res.json(await contracts());
});

// Reads topics that changed first (a few requests' worth); the page asks again while some are pending
apiRouter.post('/contracts/refresh', async (_req, res) => {
  res.json(await contracts(true));
});

// A topic that isn't a contract after all, or is one again
apiRouter.post('/contracts/hidden', async (req, res) => {
  const { topic, hidden } = req.body ?? {};
  if (typeof topic !== 'string' || !topic.trim() || topic.length > 300 || typeof hidden !== 'boolean') {
    return res.status(400).json({ error: 'Say which topic, and whether it is a contract.' });
  }
  await setHidden(topic, hidden);
  res.json(await contracts());
});

// ---------- Tax return ----------

function taxYearParam(value: unknown): number | null {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1990 && year <= new Date().getFullYear() + 1 ? year : null;
}

apiRouter.get('/tax/:year', async (req, res) => {
  const year = taxYearParam(req.params.year);
  if (!year) return res.status(400).json({ error: 'That is not a tax year.' });
  res.json(await taxReturn(year));
});

// Reads the year's documents (again): a request or a few, up to a minute
apiRouter.post('/tax/:year/refresh', async (req, res) => {
  const year = taxYearParam(req.params.year);
  if (!year) return res.status(400).json({ error: 'That is not a tax year.' });
  res.json(await taxReturn(year, true));
});

// ---------- Email ----------

// Has the shared secret in it, for setting up the mail service: never kept by the browser's cache
apiRouter.get('/email', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await emailSetup());
});

apiRouter.put('/email', async (req, res) => {
  const change: EmailSetupChange = {};
  if (req.body?.address !== undefined) change.address = req.body.address;
  if (req.body?.senders !== undefined) change.senders = req.body.senders;
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await changeEmailSetup(change));
  } catch (err) {
    if (err instanceof SetupProblem) return res.status(400).json({ error: err.message });
    throw err;
  }
});

apiRouter.post('/disconnect', async (_req, res) => {
  await forgetConnection();
  forgetTree();
  res.json(await vaultStatus(res.locals.user?.email));
});

// ---------- Errors ----------

apiRouter.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof NotConnectedError) return res.status(409).json({ error: err.message, code: 'not_connected' });
  if (err instanceof VaultProblem) return res.status(409).json({ error: err.message, code: 'vault_problem' });
  if (err instanceof LimitError) return res.status(429).json({ error: err.message, code: 'limit' });
  if (err instanceof PickerUnavailable) return res.status(409).json({ error: err.message, code: 'picker' });
  if (err instanceof FolderProblem || err instanceof AttachProblem) return res.status(400).json({ error: err.message });
  if (err instanceof DuplicateProblem) return res.status(409).json({ error: err.message, code: 'duplicate' });
  if (err instanceof DriveGuardError) {
    console.error(err);
    return res.status(403).json({ error: err.message, code: 'refused' });
  }
  if (err instanceof DriveError) return res.status(err.status === 404 ? 404 : 502).json({ error: err.message, code: 'drive' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'The file is larger than 30 MB.' });
  console.error('API error:', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

