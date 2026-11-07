// One document: a preview of the file (or the text Paperwork read from it) next to what Paperwork knows about
// it, all of it editable. Saving renames the file in Drive and moves it when the folder or year changes; a
// document still waiting in the Inbox for its check stays there until it is checked ("Correct"), unless a folder
// for a matter is chosen for it, which takes it there still to check. A possible copy of another document says
// so instead, with the owner's three choices (PossibleDuplicate).
import React, { Suspense, lazy, useEffect, useId, useRef, useState } from 'react';
import { Building2, Check, CheckCircle2, ChevronRight, CircleDashed, Copy, ExternalLink, Eye, FileText, Layers, Loader2, Plus, RotateCw, ScanText, Star, Wand2, X } from 'lucide-react';
import {
  DOCUMENT_TYPES,
  AttachmentInfo,
  Deadline,
  DocumentInfo,
  DocumentText,
  DocumentType,
  DocumentUpdate,
  CategoryInfo,
  DuplicateChoice,
  DuplicateChoiceResult,
  TextSource,
  UploadResult,
} from '../../shared/types';
import { ApiError, api } from '../lib/api';
import type { SetAside } from '../lib/duplicates';
import { holdReload } from '../lib/iap';
import { firstSentence } from '../lib/companies';
import { chosenPlace, folderLabel } from '../lib/folders';
import { SOURCE, formatDate, formatSize } from '../lib/format';
import { destination, filedIn, inSubfolder, placeOf } from '../lib/review';
import { companyPath, topicPath } from '../lib/router';
import { topicChoices } from '../lib/topics';
import { AppLink, DeadlineKindLabel } from './companyParts';
import { DocumentFiles, FolderSelect, JustKept, KeepWithAnother, NewFolderDialog } from './DocumentFiles';
import { DuplicateBusy, PossibleDuplicate } from './PossibleDuplicate';
import { ItemDraft, PurchaseItems, editedItems, itemProblem, sameItemRows, sameItems, toItemDrafts } from './PurchaseItems';
import { Button, CheckToggle, EmptyState, Field, IconButton, LinkButton, Notice, SegmentedControl, Select, Spinner, cx, inputClass, textareaClass } from './ui';

// pdf.js is large: loaded the first time a PDF is shown
const PdfView = lazy(() => import('./PdfView'));

// Shown as PDF pages (Google's own formats are turned into PDF by the server); photos as they are
const PDF_TYPES = new Set([
  'application/pdf',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
]);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

function useWide(): boolean {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const change = () => setWide(list.matches);
    list.addEventListener('change', change);
    return () => list.removeEventListener('change', change);
  }, []);
  return wide;
}

// A deadline as it is being edited; the key keeps each row's inputs in place while rows come and go
interface DeadlineDraft extends Deadline {
  key: number;
}

let nextDeadlineKey = 0;

// As many as the server keeps per document
const MAX_DEADLINES = 12;

// Dates the date inputs accept; also keeps a mistyped year (20266) out of the picker
const MIN_DATE = '1900-01-01';
const MAX_DATE = '2199-12-31';

interface Draft {
  title: string;
  // A category, or a folder for a matter inside one
  folderId: string;
  type: string;
  correspondent: string;
  date: string;
  amount: string;
  currency: string;
  dueDate: string;
  references: string;
  action: string;
  tags: string;
  summary: string;
  topic: string;
  gist: string;
  deadlines: DeadlineDraft[];
  items: ItemDraft[];
}

type Fields = Omit<Draft, 'deadlines' | 'items'>;

const toFields = (d: DocumentInfo): Fields => ({
  title: d.title,
  folderId: (inSubfolder(d) ? d.folderId : d.categoryId) ?? '',
  type: d.type ?? '',
  correspondent: d.correspondent ?? '',
  date: d.date ?? '',
  amount: d.amount !== null ? String(d.amount) : '',
  currency: d.currency ?? '',
  dueDate: d.dueDate ?? '',
  references: d.references ?? '',
  action: d.action ?? '',
  tags: d.tags.join(', '),
  summary: d.summary,
  topic: d.topic ?? '',
  gist: d.gist ?? '',
});

const toDraft = (d: DocumentInfo): Draft => ({
  ...toFields(d),
  deadlines: d.deadlines.map(x => ({ ...x, key: nextDeadlineKey++ })),
  items: toItemDrafts(d.items ?? []),
});

// The deadlines as they would be saved: rows left empty don't count. A purchase's return or warranty date keeps its
// kind (rows added here have none).
const editedDeadlines = (rows: DeadlineDraft[]): Deadline[] =>
  rows.filter(r => r.date || r.what.trim()).map(r => ({ date: r.date, what: r.what.trim(), done: r.done, ...(r.kind ? { kind: r.kind } : {}) }));

// A row with a date but nothing said about it, or the other way round
const incompleteDeadline = (r: DeadlineDraft) => !!r.date !== !!r.what.trim();

// Deadlines compared as the server keeps them (without the rows' keys)
const sameDeadlines = (a: Deadline[], b: Deadline[]) =>
  JSON.stringify(a.map(({ date, what, done, kind }) => ({ date, what, done, kind }))) ===
  JSON.stringify(b.map(({ date, what, done, kind }) => ({ date, what, done, kind })));

function changes(doc: DocumentInfo, draft: Draft): DocumentUpdate {
  const before = toFields(doc);
  const update: DocumentUpdate = {};
  if (draft.title !== before.title) update.title = draft.title;
  // A category moves it to its year folder there (out of a folder for a matter too); a folder for a matter into it
  if (draft.folderId !== before.folderId && draft.folderId) update.folderId = draft.folderId;
  if (draft.type !== before.type) update.type = (draft.type || null) as DocumentType | null;
  if (draft.correspondent !== before.correspondent) update.correspondent = draft.correspondent || null;
  if (draft.date !== before.date) update.date = draft.date || null;
  if (draft.amount !== before.amount) {
    const n = Number(draft.amount.replace(',', '.'));
    update.amount = draft.amount.trim() && Number.isFinite(n) ? n : null;
  }
  if (draft.currency !== before.currency) update.currency = draft.currency || null;
  if (draft.dueDate !== before.dueDate) update.dueDate = draft.dueDate || null;
  if (draft.references !== before.references) update.references = draft.references || null;
  if (draft.action !== before.action) update.action = draft.action || null;
  if (draft.tags !== before.tags) update.tags = draft.tags.split(',').map(t => t.trim()).filter(Boolean);
  if (draft.summary !== before.summary) update.summary = draft.summary;
  // Topics group documents by their exact name, so stray spaces don't count; empty clears it
  if (draft.topic.trim() !== before.topic) update.topic = draft.topic.trim() || null;
  if (draft.gist.trim() !== before.gist) update.gist = draft.gist.trim() || null;
  // All deadlines at once, done flags included: the server takes the list as given
  const deadlines = editedDeadlines(draft.deadlines);
  if (!sameDeadlines(deadlines, doc.deadlines)) update.deadlines = deadlines;
  // The items too, all at once
  const items = editedItems(draft.items);
  if (!sameItems(items, doc.items ?? [])) update.items = items;
  return update;
}

// The draft made again from a fresher copy of the document, keeping what was changed in it since `base` (the
// draft as it was when the fresh copy was asked for). Any change to the deadline rows keeps them all, a row just
// added and still empty included; the same for the items.
function rebase(draft: Draft, base: Draft, fresh: DocumentInfo): Draft {
  const next = toDraft(fresh);
  for (const field of Object.keys(toFields(fresh)) as (keyof Fields)[]) if (draft[field] !== base[field]) next[field] = draft[field];
  if (!sameDeadlines(draft.deadlines, base.deadlines)) next.deadlines = draft.deadlines;
  if (!sameItemRows(draft.items, base.items)) next.items = draft.items;
  return next;
}

// Types of document that list what was bought: they offer adding items even when Paperwork read none
const PURCHASE_TYPES = new Set(['receipt', 'invoice']);

const TEXT_SOURCE: Record<TextSource, string> = {
  pdf: 'Text from the PDF',
  ocr: 'Read from the scan by AI',
  text: 'Text of the file',
  none: 'No text found in this document',
};

// Not read yet: in a few minutes, or tomorrow when reading for search has stopped for today (`paused`)
const textSourceLabel = (source: TextSource | null, paused: boolean) =>
  source ? TEXT_SOURCE[source] : paused ? 'Not read yet' : 'Not read yet; Paperwork reads it within a few minutes';

export const DocumentView: React.FC<{
  id: string;
  initial: DocumentInfo | null;
  // With their folders for a matter
  categories: CategoryInfo[];
  // The library's documents: the others in its folder, and those to pick from to keep it with or move here
  documents: DocumentInfo[];
  // The files kept with it
  attachments: AttachmentInfo[];
  // The language of the names in Drive
  language: 'en' | 'de';
  knownCorrespondents: string[];
  // Each company's topics, and all topics: the Topic field suggests the From field's company's own first
  topicsByCompany: Map<string, string[]>;
  allTopics: string[];
  // Opens one of the app's pages (here: a company's or a topic's), leaving the document
  onNavigate: (to: string) => void;
  // Reading for search has stopped for today (the AI budget is kept for filing)
  indexPaused: boolean;
  onClose: () => void;
  // Another document opened over this one (Back returns), or in its place (it became a file kept with that one)
  onOpen: (id: string) => void;
  onSwitch: (id: string) => void;
  // "Add a document to this folder": the dialog for adding documents, filing them into it
  onAddToFolder: (folder: { id: string; path: string }) => void;
  onChange: (doc: DocumentInfo) => void;
  onReload: () => Promise<unknown>;
  // This document made a file kept with another one, which then opens in its place and says so (`justKept`)
  onKeptWith: (kept: JustKept) => void;
  justKept: JustKept | null;
  // A possible copy moved to the Duplicates folder from here: its original then opens in its place and says so
  // (`justSetAside`)
  onSetAside: (moved: SetAside) => void;
  justSetAside: SetAside | null;
}> = ({
  id,
  initial,
  categories,
  documents,
  attachments,
  language,
  knownCorrespondents,
  topicsByCompany,
  allTopics,
  indexPaused,
  onClose,
  onOpen,
  onSwitch,
  onAddToFolder,
  onChange,
  onReload,
  onNavigate,
  onKeptWith,
  justKept,
  onSetAside,
  justSetAside,
}) => {
  const [doc, setDoc] = useState<DocumentInfo | null>(initial);
  const [draft, setDraft] = useState<Draft | null>(initial ? toDraft(initial) : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'check' | 'refile' | 'star' | Exclude<DuplicateBusy, null>>(null);
  // Why a choice about a possible copy wasn't taken, shown in its panel
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  // Where "Correct" just filed it, said once the banner has gone
  const [checkedNote, setCheckedNote] = useState<string | null>(null);
  // A save or a new reading answered before the document fetched on opening: that answer is the newer copy
  const hasNewerCopy = useRef(false);
  // Phones show one side at a time: the details, or the pane with the preview or the text
  const [tab, setTab] = useState<'details' | 'pane'>('details');
  const [pane, setPane] = useState<'preview' | 'text'>('preview');
  // Side by side (the lg breakpoint), the preview is on screen from the start
  const wide = useWide();
  const [imageFailed, setImageFailed] = useState(false);
  const [text, setText] = useState<DocumentText | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [copied, setCopied] = useState<null | 'done' | 'failed'>(null);
  const [focusDeadline, setFocusDeadline] = useState<number | null>(null);
  // The category "New folder in …" makes a folder in
  const [newFolderIn, setNewFolderIn] = useState<CategoryInfo | null>(null);
  const topicListId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api<DocumentInfo>(`/api/documents/${id}`)
      .then(fresh => {
        if (cancelled || hasNewerCopy.current) return;
        setDoc(fresh);
        // What was typed while it was on its way stays; everything else comes from the fresh copy
        setDraft(d => (d && initial ? rebase(d, toDraft(initial), fresh) : toDraft(fresh)));
      })
      .catch(err => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The text is fetched the first time it is shown (and again after the document was read again)
  useEffect(() => {
    if (pane !== 'text' || text || textError) return;
    let cancelled = false;
    api<DocumentText>(`/api/documents/${id}/text`)
      .then(t => !cancelled && setText(t))
      .catch(err => !cancelled && setTextError(err.message));
    return () => {
      cancelled = true;
    };
  }, [id, pane, text, textError]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    // A dialog open over the document (Add, a picker, adding documents to its folder) closes on its own first
    const onKey = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[aria-modal="true"]');
      if (e.key === 'Escape' && dialogs[dialogs.length - 1] === dialogRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const update = doc && draft ? changes(doc, draft) : {};
  const deadlineIncomplete = !!draft?.deadlines.some(incompleteDeadline);
  const itemIncomplete = !!draft?.items.some(itemProblem);
  const incomplete = deadlineIncomplete || itemIncomplete;
  // An item that can't be saved (a price that isn't a number) may not change what would be saved; it is a change all
  // the same, so Save shows, waiting for it
  const dirty = Object.keys(update).length > 0 || incomplete;
  // Changes not saved yet: an ended Google sign-in shows a notice rather than reloading the page over them (lib/iap.ts)
  useEffect(() => (dirty ? holdReload() : undefined), [dirty]);
  // Where checking files it, with the folder and date as edited: a folder for a matter whatever the date
  const chosen = draft ? chosenPlace(categories, draft.folderId) : null;
  const goesTo =
    doc && draft ? (chosen?.folder ? folderLabel(chosen.category, chosen.folder) : destination(doc, chosen?.category.name ?? doc.category, draft.date || null)) : '';
  // The edits and the check in one request; the server applies the edits, then moves it out of the Inbox
  const check = () => save('check', { ...update, needsReview: false });
  // The document it may be a copy of (one listed, and not marked itself), and those that may be copies of it
  const original = doc?.possibleDuplicateOf ? (documents.find(d => d.id === doc.possibleDuplicateOf && !d.possibleDuplicateOf) ?? null) : null;
  const copies = doc ? documents.filter(d => d.possibleDuplicateOf === doc.id) : [];

  // `save` sends the edits; `check` ("Correct") the edits together with the check, which files a document waiting
  // in the Inbox; `keep` the edits together with "Keep both" for a possible copy; `star` sends only its own change
  // and leaves the edits be
  async function save(kind: 'save' | 'check' | 'keep' | 'star', body: DocumentUpdate) {
    if (!doc) return;
    // The draft as sent: anything typed while the save is on its way is kept when it comes back, on top of the
    // document as the server saved it
    const sent = draft;
    const wasInInbox = doc.inInbox;
    setBusy(kind);
    setError(null);
    setDuplicateError(null);
    if (kind !== 'star') setCheckedNote(null);
    try {
      const saved = await api<DocumentInfo>(`/api/documents/${doc.id}`, { method: 'PATCH', body });
      hasNewerCopy.current = true;
      setDoc(saved);
      if (kind !== 'star') setDraft(d => (!d || !sent || d === sent ? toDraft(saved) : rebase(d, sent, saved)));
      if (kind === 'check' && !saved.needsReview) setCheckedNote(wasInInbox ? `Checked and filed in ${filedIn(saved)}.` : `Checked. It stays in ${filedIn(saved)}.`);
      if (kind === 'keep') setCheckedNote('Kept both. You won’t be asked about these two again.');
      onChange(saved);
      // Its kept files moved or were renamed along with it (one left behind was brought next to it)
      if (kind !== 'star' && attachments.length && (saved.name !== doc.name || attachments.some(a => a.folderId !== saved.folderId))) onReload();
    } catch (err) {
      if (kind === 'keep') {
        // No longer a document in Paperwork: set aside already (in another window, say)
        if (err instanceof ApiError && err.status === 404) {
          onReload();
          onClose();
          return;
        }
        setDuplicateError((err as Error).message);
        // Its mark changed meanwhile: shown as it is now
        if (err instanceof ApiError && err.code === 'duplicate') onReload();
      } else setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // What a possible copy is. Keep both saves the edits with it; moving it to Duplicates or keeping it with the
  // original as a file drops them, and the original opens in its place and says what became of it.
  async function choose(choice: DuplicateChoice) {
    if (!doc || !original) return;
    // With the original shown, so a mark moved to another one meanwhile isn't decided unseen
    if (choice === 'keep-both') return save('keep', { ...update, notDuplicate: true, duplicateOf: original.id });
    setBusy(choice === 'duplicate' ? 'move' : 'attach');
    setError(null);
    setDuplicateError(null);
    setCheckedNote(null);
    try {
      const result = await api<DuplicateChoiceResult>(`/api/documents/${encodeURIComponent(doc.id)}/possible-duplicate`, { method: 'POST', body: { choice, of: original.id } });
      if (choice === 'duplicate') onSetAside({ id: doc.id, title: doc.title, originalId: original.id, folderUrl: result.duplicatesFolderUrl ?? null });
      else if (result.attachment) onKeptWith({ title: doc.title, attachment: result.attachment });
      onSwitch(original.id);
      onReload();
    } catch (err) {
      // No longer a document in Paperwork: done already (in another window, say)
      if (err instanceof ApiError && err.status === 404) {
        onReload();
        onClose();
        return;
      }
      setDuplicateError((err as Error).message);
      // Its mark changed meanwhile (or its original left Paperwork): shown as it is now
      if (err instanceof ApiError && err.code === 'duplicate') onReload();
    } finally {
      setBusy(null);
    }
  }

  async function refile() {
    if (!doc) return;
    setBusy('refile');
    setError(null);
    setCheckedNote(null);
    try {
      const result = await api<UploadResult>(`/api/documents/${doc.id}/refile`, { method: 'POST' });
      if (result.document) {
        hasNewerCopy.current = true;
        setDoc(result.document);
        setDraft(toDraft(result.document));
        onChange(result.document);
        if (attachments.length && (result.document.name !== doc.name || result.document.folderId !== doc.folderId)) onReload();
        setText(null);
        setTextError(null);
      } else {
        setError(result.error ?? 'Paperwork could not read this document again.');
        await onReload();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const set = (patch: Partial<Draft>) => setDraft(d => (d ? { ...d, ...patch } : d));
  const setDeadline = (key: number, patch: Partial<Deadline>) =>
    setDraft(d => (d ? { ...d, deadlines: d.deadlines.map(r => (r.key === key ? { ...r, ...patch } : r)) } : d));
  const addDeadline = () => {
    const key = nextDeadlineKey++;
    setFocusDeadline(key);
    setDraft(d => (d && d.deadlines.length < MAX_DEADLINES ? { ...d, deadlines: [...d.deadlines, { key, date: '', what: '', done: false }] } : d));
  };
  const removeDeadline = (key: number) => setDraft(d => (d ? { ...d, deadlines: d.deadlines.filter(r => r.key !== key) } : d));
  const changeItems = (change: (rows: ItemDraft[]) => ItemDraft[]) => setDraft(d => (d ? { ...d, items: change(d.items) } : d));

  async function copyText() {
    try {
      await navigator.clipboard.writeText(text?.text ?? '');
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  }

  // The file itself, from Paperwork's server: PDFs (and Google Docs, as PDF) drawn in the app, images as they
  // are. Loaded once the preview is on screen.
  const mime = doc?.mimeType ?? '';
  const fileUrl = `/api/documents/${encodeURIComponent(id)}/file`;
  const noPreview = (
    <EmptyState
      icon={<FileText className="w-5 h-5" />}
      title="No preview for this file"
      description="Paperwork shows PDFs, Google Docs and photos here. Open this one in Google Drive, or read the text Paperwork took from it."
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {doc && (
            <LinkButton href={doc.webViewLink} target="_blank" rel="noreferrer" icon={<ExternalLink className="w-4 h-4" />}>
              Open in Drive
            </LinkButton>
          )}
          <Button icon={<ScanText className="w-4 h-4" />} onClick={() => setPane('text')}>
            Show the text
          </Button>
        </div>
      }
    />
  );
  const previewShown = pane === 'preview' && (tab === 'pane' || wide);
  const preview = (
    <div className={cx('flex-1 min-h-0 flex-col', pane === 'preview' ? 'flex' : 'hidden')}>
      {!doc || !previewShown ? (
        <div className="flex-1 min-h-[60vh] lg:min-h-0 bg-surface-2" />
      ) : PDF_TYPES.has(mime) ? (
        <Suspense fallback={<div className="flex-1 min-h-[60vh] lg:min-h-0 bg-surface-2" />}>
          <PdfView url={fileUrl} title={doc.title} fallback={noPreview} />
        </Suspense>
      ) : IMAGE_TYPES.has(mime) && !imageFailed ? (
        <div className="flex-1 min-h-[60vh] lg:min-h-0 overflow-auto bg-surface-2 p-3 flex items-start justify-center">
          <img src={fileUrl} alt={doc.title} className="max-w-full h-auto bg-white shadow-sm rounded-sm" onError={() => setImageFailed(true)} />
        </div>
      ) : (
        <div className="flex-1 min-h-[60vh] lg:min-h-0 overflow-y-auto bg-surface-2">{noPreview}</div>
      )}
    </div>
  );

  const textPane = pane === 'text' && (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {textError ? (
        <div className="p-4">
          <Notice
            tone="danger"
            action={
              <button className="text-sm font-medium underline" onClick={() => setTextError(null)}>
                Try again
              </button>
            }
          >
            {textError}
          </Notice>
        </div>
      ) : !text ? (
        <div className="flex justify-center pt-16">
          <Spinner className="w-5 h-5" />
        </div>
      ) : text.text.trim() ? (
        <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-ink px-4 sm:px-5 py-4">{text.text}</pre>
      ) : (
        <EmptyState
          icon={<ScanText className="w-5 h-5" />}
          title={textSourceLabel(text.source, indexPaused)}
          description={
            text.source !== null
              ? "It may be a photo without words, or a kind of file Paperwork can't read. It can still be found by its title, sender and summary."
              : indexPaused
                ? "Today's AI budget is used up, so reading continues after midnight UTC. Until then, it can be found by its title, sender and summary."
                : 'Until then, it can be found by its title, sender and summary.'
          }
        />
      )}
    </div>
  );
  const hasText = pane === 'text' && !!text?.text.trim();

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={doc?.title ?? 'Document'}
        onClick={e => e.stopPropagation()}
        className="w-full max-w-6xl h-[94dvh] sm:h-[90vh] bg-surface border border-line rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col overflow-hidden"
      >
        <header className="flex items-start gap-3 px-4 sm:px-5 py-3 border-b border-line">
          <FileText className="w-5 h-5 text-ink-3 mt-1 shrink-0 hidden sm:block" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base sm:text-lg font-semibold leading-snug truncate">{doc?.title ?? 'Loading…'}</h2>
            {doc && (
              <p className="text-xs text-ink-2 truncate">
                {placeOf(doc)} · added {formatDate(doc.addedAt)}
                {doc.source ? ` ${SOURCE[doc.source]}` : ''}
                {doc.size ? ` · ${formatSize(doc.size)}` : ''}
              </p>
            )}
          </div>
          {doc && (
            <div className="flex items-center gap-1 shrink-0">
              <IconButton label={doc.starred ? 'Unstar' : 'Star'} onClick={() => save('star', { starred: !doc.starred })} disabled={busy === 'star'}>
                <Star className={cx('w-4 h-4', doc.starred && 'fill-warning text-warning')} />
              </IconButton>
              <a
                href={doc.webViewLink}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in Google Drive"
                title="Open in Google Drive"
                className="inline-flex items-center justify-center w-9 h-9 rounded-lg text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
              <IconButton label="Close" onClick={onClose}>
                <X className="w-4 h-4" />
              </IconButton>
            </div>
          )}
        </header>

        <div className="lg:hidden px-4 pt-3">
          <SegmentedControl
            ariaLabel="Show"
            value={tab === 'details' ? 'details' : pane}
            onChange={v => {
              setTab(v === 'details' ? 'details' : 'pane');
              if (v !== 'details') setPane(v);
            }}
            options={[
              { value: 'details', label: 'Details' },
              { value: 'preview', label: <span className="inline-flex items-center gap-1.5"><Eye className="w-3.5 h-3.5" />Preview</span> },
              { value: 'text', label: <span className="inline-flex items-center gap-1.5"><ScanText className="w-3.5 h-3.5" />Text</span> },
            ]}
          />
        </div>

        <div className="flex-1 min-h-0 lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <div className={cx('min-h-0 h-full flex-col lg:border-r lg:border-line', tab === 'pane' ? 'flex' : 'hidden lg:flex')}>
            <div className={cx('items-center gap-3 px-4 py-2 border-b border-line', hasText ? 'flex' : 'hidden lg:flex')}>
              <div className="hidden lg:block">
                <SegmentedControl
                  ariaLabel="Show"
                  value={pane}
                  onChange={setPane}
                  options={[
                    { value: 'preview', label: 'Preview' },
                    { value: 'text', label: 'Text' },
                  ]}
                />
              </div>
              {hasText && (
                <>
                  <span className="flex-1 min-w-0 text-xs text-ink-2 truncate">{textSourceLabel(text!.source, indexPaused)}</span>
                  <Button size="sm" variant="ghost" icon={copied === 'done' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} onClick={copyText}>
                    {copied === 'done' ? 'Copied' : copied === 'failed' ? "Couldn't copy" : 'Copy'}
                  </Button>
                </>
              )}
            </div>
            {preview}
            {textPane}
          </div>
          <div className={cx('min-h-0 h-full overflow-y-auto', tab === 'details' ? 'block' : 'hidden lg:block')}>
            {!doc || !draft ? (
              <div className="flex justify-center pt-16">
                {error ? <Notice tone="danger">{error}</Notice> : <Loader2 className="w-5 h-5 animate-spin text-ink-3" />}
              </div>
            ) : (
              <div className="p-4 sm:p-5 space-y-4">
                {/* One warning at a time: a possible copy's owner says what it is first, and checks it after Keep both */}
                {original && (
                  <PossibleDuplicate
                    doc={doc}
                    original={original}
                    busy={busy === 'keep' || busy === 'move' || busy === 'attach' ? busy : null}
                    error={duplicateError}
                    onChoose={choose}
                    onOpenOriginal={onOpen}
                    onDismissError={() => setDuplicateError(null)}
                    dirty={dirty}
                    showFacts
                    incomplete={deadlineIncomplete ? 'Finish the deadline below first to keep both.' : itemIncomplete ? 'Finish the item below first to keep both.' : null}
                  />
                )}
                {!original && doc.needsReview && (
                  <section aria-labelledby={`${topicListId}-check`} className="rounded-xl border border-warning/35 bg-warning/8 p-4">
                    <h3 id={`${topicListId}-check`} className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                      <CircleDashed className="w-4 h-4 shrink-0 text-warning" strokeWidth={2.5} />
                      Is this right?
                    </h3>
                    <p className="text-sm text-ink-2 mt-1">
                      {doc.inInbox
                        ? 'Paperwork read this document and filled in the details below. It waits in the Inbox until you’ve checked them; change anything that’s off first.'
                        : inSubfolder(doc)
                          ? `Paperwork read this document and filled in the details below. It stays in ${placeOf(doc)}; check the details and change anything that’s off.`
                          : 'Paperwork wasn’t sure about this one. Check the folder and the details below, and change anything that’s off.'}
                    </p>
                    <Button
                      variant="primary"
                      wrap
                      className="mt-3 w-full sm:w-auto"
                      icon={<Check className="w-4 h-4" strokeWidth={2.5} />}
                      onClick={check}
                      loading={busy === 'check'}
                      disabled={incomplete || (!!busy && busy !== 'check')}
                    >
                      {/* "Insurance / 2026" kept together when the label wraps on a phone */}
                      {doc.inInbox ? `Correct — file it in ${goesTo.replace(/ \/ /g, '\u00a0/\u00a0')}` : 'Correct'}
                    </Button>
                    {dirty && (
                      <p className="text-xs text-ink-3 mt-2">
                        {deadlineIncomplete ? 'Finish the deadline below first.' : itemIncomplete ? 'Finish the item below first.' : 'Your changes below are saved with it.'}
                      </p>
                    )}
                  </section>
                )}
                {checkedNote && (
                  <Notice icon={<CheckCircle2 className="w-4 h-4 text-success" />}>
                    <span role="status">{checkedNote}</span>
                  </Notice>
                )}
                {justSetAside && (
                  <Notice icon={<Copy className="w-4 h-4 text-ink-3" />}>
                    <span role="status">
                      “{justSetAside.title}” was moved to the{' '}
                      {justSetAside.folderUrl ? (
                        <a className="font-medium text-accent-ink hover:underline" href={justSetAside.folderUrl} target="_blank" rel="noreferrer">
                          Duplicates folder
                        </a>
                      ) : (
                        'Duplicates folder'
                      )}
                      . To undo, move it back into Paperwork › Inbox in Google Drive; delete it there if you don’t need it.
                    </span>
                  </Notice>
                )}
                {copies.map(copy => (
                  <Notice key={copy.id} icon={<Copy className="w-4 h-4 text-warning" />}>
                    “{copy.title}” may be a copy of this document.{' '}
                    <button className="font-medium text-accent-ink hover:underline" onClick={() => onOpen(copy.id)}>
                      Open it
                    </button>
                  </Notice>
                ))}
                {error && <Notice tone="danger">{error}</Notice>}

                {(doc.correspondent || doc.topic) && (
                  // Its company's page, and its topic's (with the documents of every company in it)
                  <nav aria-label="Company and topic" className="flex items-center gap-1.5 min-w-0 rounded-lg bg-surface-2 px-3 py-2 text-sm">
                    {doc.correspondent && (
                      <>
                        <Building2 className="w-4 h-4 shrink-0 text-ink-3" />
                        <AppLink
                          to={companyPath(doc.correspondent)}
                          onNavigate={onNavigate}
                          title={`All documents from ${doc.correspondent}`}
                          className={cx('font-medium text-accent-ink hover:underline truncate', doc.topic ? 'shrink-0 max-w-[45%]' : 'min-w-0')}
                        >
                          {doc.correspondent}
                        </AppLink>
                      </>
                    )}
                    {doc.correspondent && doc.topic && <ChevronRight className="w-3.5 h-3.5 shrink-0 text-ink-3" />}
                    {doc.topic && (
                      <>
                        {!doc.correspondent && <Layers className="w-4 h-4 shrink-0 text-ink-3" />}
                        <AppLink
                          to={topicPath(doc.topic)}
                          onNavigate={onNavigate}
                          title={`Topic: ${doc.topic}, with the documents of every company`}
                          className="min-w-0 font-medium text-accent-ink hover:underline truncate"
                        >
                          {doc.topic}
                        </AppLink>
                      </>
                    )}
                  </nav>
                )}

                <DocumentFiles
                  doc={doc}
                  documents={documents}
                  attachments={attachments}
                  language={language}
                  onOpen={onOpen}
                  onAddToFolder={onAddToFolder}
                  onChange={onChange}
                  onReload={onReload}
                  justKept={justKept}
                />

                <Field label="Title">
                  <input className={inputClass} value={draft.title} onChange={e => set({ title: e.target.value })} />
                </Field>
                {/* The whole width: a folder for a matter is named with its category ("Example UG / Eröffnungsbilanz") */}
                <Field label="Folder">
                  <FolderSelect categories={categories} value={draft.folderId} onChange={folderId => set({ folderId })} onNewFolder={setNewFolderIn} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Type">
                    <Select value={draft.type} onChange={e => set({ type: e.target.value })}>
                      <option value="">Unknown</option>
                      {Object.entries(DOCUMENT_TYPES).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Document date">
                    <input type="date" min={MIN_DATE} max={MAX_DATE} className={inputClass} value={draft.date} onChange={e => set({ date: e.target.value })} />
                  </Field>
                </div>
                <Field label="From">
                  <input className={inputClass} list="paperwork-correspondents" value={draft.correspondent} onChange={e => set({ correspondent: e.target.value })} />
                </Field>
                <datalist id="paperwork-correspondents">
                  {knownCorrespondents.map(c => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <Field label="Topic" hint="The contract, policy, account, case or tax year it belongs to, named the same for all its documents, whoever sent them. Empty for a one-off.">
                  <input
                    className={inputClass}
                    list={topicListId}
                    maxLength={100}
                    placeholder="e.g. Car insurance VW Golf"
                    autoComplete="off"
                    value={draft.topic}
                    onChange={e => set({ topic: e.target.value })}
                  />
                </Field>
                <datalist id={topicListId}>
                  {topicChoices(allTopics, topicsByCompany.get(draft.correspondent.trim()) ?? []).map(t => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <div className="grid grid-cols-[1fr_5.5rem_1fr] gap-3">
                  <Field label="Amount">
                    <input inputMode="decimal" className={inputClass} value={draft.amount} onChange={e => set({ amount: e.target.value })} />
                  </Field>
                  <Field label="Currency">
                    <input className={cx(inputClass, 'uppercase')} maxLength={3} value={draft.currency} onChange={e => set({ currency: e.target.value.toUpperCase() })} />
                  </Field>
                  <Field label="Due">
                    <input type="date" min={MIN_DATE} max={MAX_DATE} className={inputClass} value={draft.dueDate} onChange={e => set({ dueDate: e.target.value })} />
                  </Field>
                </div>
                {/* What was bought, for a receipt or a shop's invoice; hidden for other documents without items */}
                {(draft.items.length > 0 || (doc.items ?? []).length > 0 || PURCHASE_TYPES.has(draft.type)) && (
                  <PurchaseItems rows={draft.items} currency={draft.currency.trim() || null} onChange={changeItems} />
                )}
                <div>
                  <div className="flex items-center justify-between gap-2 min-h-8 mb-1.5">
                    <span className="text-[13px] font-medium text-ink">Deadlines</span>
                    {draft.deadlines.length < MAX_DEADLINES && (
                      <Button variant="ghost" size="sm" className="-mr-2" icon={<Plus className="w-4 h-4" />} onClick={addDeadline}>
                        Add deadline
                      </Button>
                    )}
                  </div>
                  {draft.deadlines.length > 0 && (
                    <div className="space-y-3 sm:space-y-2">
                      {draft.deadlines.map(row => {
                        // Screen readers hear which deadline each control belongs to
                        const name = row.what.trim() ? `“${row.what.trim()}”` : 'the new deadline';
                        return (
                          <div key={row.key}>
                            {/* One line on wider screens; on phones the date sits above the description, which
                                would otherwise be squeezed to a few letters */}
                            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] sm:grid-cols-[auto_9.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5">
                              <CheckToggle
                                className="mx-1"
                                checked={row.done}
                                label={row.done ? `Mark ${name} as not done` : `Mark ${name} as done`}
                                onChange={done => setDeadline(row.key, { done })}
                              />
                              <input
                                type="date"
                                min={MIN_DATE}
                                max={MAX_DATE}
                                aria-label={`Date of ${name}`}
                                autoFocus={row.key === focusDeadline}
                                className={cx(inputClass, row.done && 'text-ink-3')}
                                value={row.date}
                                onChange={e => setDeadline(row.key, { date: e.target.value })}
                              />
                              <input
                                aria-label={row.date ? `What happens on ${formatDate(row.date, 'long')}` : 'What the new deadline is for'}
                                placeholder="e.g. Pay the bill"
                                maxLength={120}
                                className={cx(inputClass, 'col-start-2 row-start-2 sm:col-start-3 sm:row-start-1', row.done && 'line-through text-ink-3')}
                                value={row.what}
                                onChange={e => setDeadline(row.key, { what: e.target.value })}
                              />
                              <IconButton
                                label={`Remove ${name}`}
                                size="sm"
                                className="col-start-3 row-start-1 sm:col-start-4 -mr-1"
                                onClick={() => removeDeadline(row.key)}
                              >
                                <X className="w-4 h-4" />
                              </IconButton>
                            </div>
                            {/* A purchase's last day to return it, or the end of its warranty: once past, it lapses rather
                                than being overdue */}
                            {row.kind && <DeadlineKindLabel kind={row.kind} className="mt-1.5 ml-9" />}
                            {incompleteDeadline(row) && (
                              <p className="text-xs text-danger mt-1 ml-9">{row.date ? 'Say what happens on this date.' : 'Pick a date for this deadline.'}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <p className="text-xs text-ink-3 mt-1.5">
                    {draft.deadlines.length >= MAX_DEADLINES
                      ? `A document can have up to ${MAX_DEADLINES} deadlines. Remove one to add another.`
                      : draft.deadlines.length && original
                        ? `Not in Deadlines while this may be a copy of “${original.title}”.`
                        : draft.deadlines.length
                          ? 'Dates this document asks something by. Ticking one off is remembered by Paperwork, not written to Drive.'
                          : 'None yet. Add one for anything this document asks you to do by a certain date.'}
                  </p>
                </div>
                <Field label="To do" hint="What this document asks of you, if anything">
                  <input className={inputClass} value={draft.action} onChange={e => set({ action: e.target.value })} />
                </Field>
                <Field label="References" hint="Customer, contract, policy or invoice numbers">
                  <input className={inputClass} value={draft.references} onChange={e => set({ references: e.target.value })} />
                </Field>
                <Field label="Tags" hint="Separated by commas">
                  <input className={inputClass} value={draft.tags} onChange={e => set({ tags: e.target.value })} />
                </Field>
                <Field
                  label="Update"
                  hint={
                    draft.gist.trim()
                      ? "One line on the timelines of its company and topic: what this document says or changes"
                      : "One line on the timelines of its company and topic: what this document says or changes. Empty: the summary's first sentence is shown."
                  }
                >
                  <input
                    className={inputClass}
                    maxLength={160}
                    placeholder={firstSentence(draft.summary, 160) || 'e.g. Premium for 2027 rises to 642.18 EUR'}
                    value={draft.gist}
                    onChange={e => set({ gist: e.target.value })}
                  />
                </Field>
                <Field label="Summary">
                  <textarea className={cx(textareaClass, 'min-h-28')} value={draft.summary} onChange={e => set({ summary: e.target.value })} />
                </Field>

                <div className="pt-2 border-t border-line flex flex-wrap items-center gap-2">
                  <Button variant="ghost" size="sm" icon={<Wand2 className="w-4 h-4" />} onClick={refile} loading={busy === 'refile'}>
                    Read again with AI
                  </Button>
                  <KeepWithAnother
                    doc={doc}
                    documents={documents}
                    hasKeptFiles={attachments.length > 0}
                    onKept={(parentId, result) => {
                      if (result.attachment) onKeptWith({ title: doc.title, attachment: result.attachment });
                      onSwitch(parentId);
                      onReload();
                    }}
                  />
                  <LinkButton href={doc.webViewLink} target="_blank" rel="noreferrer" variant="ghost" size="sm" icon={<ExternalLink className="w-4 h-4" />}>
                    Open in Drive
                  </LinkButton>
                </div>
              </div>
            )}
          </div>
        </div>

        {dirty && doc && (
          <footer className="flex items-center justify-end gap-2 px-4 sm:px-5 py-3 border-t border-line bg-surface-2/60">
            <span className={cx('text-xs mr-auto', incomplete ? 'text-danger' : 'text-ink-3 hidden sm:inline')}>
              {deadlineIncomplete
                ? 'Each deadline needs a date and what happens then.'
                : itemIncomplete
                  ? 'Each item needs a name, and its quantity and price in numbers.'
                  : doc.inInbox
                    ? update.folderId && chosen?.folder
                      ? `Saving moves it into ${goesTo}, still to check.`
                      : original
                        ? 'Save keeps it in the Inbox, marked as a possible duplicate.'
                        : 'Save keeps it in the Inbox, still to check.'
                    : update.folderId || (update.date && !inSubfolder(doc))
                      ? 'Saving moves the file to its new folder in Drive.'
                      : original
                        ? 'Save keeps it marked as a possible duplicate.'
                        : doc.needsReview
                          ? 'Save keeps it marked To check.'
                          : 'Saving updates the file in Drive.'}
            </span>
            <Button onClick={() => setDraft(toDraft(doc))} disabled={busy === 'save' || busy === 'check' || busy === 'keep'} icon={<RotateCw className="w-4 h-4" />}>
              Undo
            </Button>
            {doc.needsReview && !original ? (
              // Saving alone keeps it to check; "Correct" saves and checks it, as in the banner above
              <>
                <Button onClick={() => save('save', update)} loading={busy === 'save'} disabled={incomplete || busy === 'check'}>
                  Save
                </Button>
                <Button
                  variant="primary"
                  icon={<Check className="w-4 h-4" strokeWidth={2.5} />}
                  onClick={check}
                  loading={busy === 'check'}
                  disabled={incomplete || busy === 'save'}
                  aria-label={doc.inInbox ? `Save and file it in ${goesTo}` : 'Save and mark as checked'}
                  title={doc.inInbox ? `Save and file it in ${goesTo}` : 'Save and mark as checked'}
                >
                  Correct
                </Button>
              </>
            ) : (
              // A possible copy is checked once the owner has said what it is (Keep both, above)
              <Button variant="primary" onClick={() => save('save', update)} loading={busy === 'save'} disabled={incomplete || busy === 'keep'}>
                Save
              </Button>
            )}
          </footer>
        )}
        <NewFolderDialog
          category={newFolderIn}
          afterwards="Save the document afterwards to move it into the new folder."
          onClose={() => setNewFolderIn(null)}
          onMade={async folder => {
            // Listed in the Folder field once the library has it; the move is saved with the other edits
            await onReload();
            set({ folderId: folder.id });
            setNewFolderIn(null);
          }}
        />
      </div>
    </div>
  );
};
