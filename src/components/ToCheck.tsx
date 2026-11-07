// The top of the Inbox: every document waiting for the owner's check, with what Paperwork read from it laid out
// to be verified at a glance. "Correct" files it (in review mode manual, out of the Inbox into its folder); the
// item leaves the list at once and comes back with the reason if the server says no. A possible copy of another
// document waits for the owner to say what it is first (PossibleDuplicate), in either review mode.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCircle2, Copy, FolderInput, Paperclip, Pencil, TriangleAlert, X } from 'lucide-react';
import type { DocumentInfo, DuplicateChoice, DuplicateChoiceResult, ReviewMode } from '../../shared/types';
import { ApiError, api } from '../lib/api';
import { gistOf } from '../lib/companies';
import type { PatchDocument } from '../lib/deadlines';
import { SetAside, activeFlags } from '../lib/duplicates';
import { formatAmount, formatDate, typeLabel } from '../lib/format';
import { destination, filedIn, isPossibleCopy, placeOf, toCheck } from '../lib/review';
import { DeadlineBadge } from './companyParts';
import { Thumbnail } from './DocumentCard';
import type { JustKept } from './DocumentFiles';
import { PossibleDuplicate } from './PossibleDuplicate';
import { Button, Card, IconButton, Notice, cx } from './ui';

// Deadline badges per document before "+2 more"
const BADGES_SHOWN = 3;
// How long a checked document stays out of the list although a library loaded before the check still has it
const HIDE_AFTER_CHECK_MS = 20_000;
// How long "Filed in …" and its Undo stay
const CONFIRMATION_MS = 8000;

interface Checked {
  // As it was before the check, and as the server answered
  before: DocumentInfo;
  saved: DocumentInfo;
}

// What the owner said a possible copy is, said until dismissed or the next check
interface Decided {
  choice: DuplicateChoice;
  title: string;
  original: DocumentInfo;
  // Keep both: the document as saved
  saved?: DocumentInfo;
  folderUrl?: string | null;
}

const Fact: React.FC<{ label: string; children: React.ReactNode; wide?: boolean }> = ({ label, children, wide }) => (
  <>
    <dt className={cx('text-ink-3', wide && 'lg:col-start-1')}>{label}</dt>
    <dd className={cx('min-w-0 text-ink break-words', wide && 'lg:col-span-3')}>{children}</dd>
  </>
);

const Missing: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className="text-ink-3">{children}</span>;

const CheckItem: React.FC<{
  doc: DocumentInfo;
  // The document it may be a copy of: the owner says what it is first, and Correct waits until then
  original: DocumentInfo | null;
  error: string | null;
  onCheck: (doc: DocumentInfo) => void;
  onChoose: (doc: DocumentInfo, original: DocumentInfo, choice: DuplicateChoice) => void;
  onOpen: (id: string) => void;
  onDismissError: (id: string) => void;
}> = ({ doc, original, error, onCheck, onChoose, onOpen, onDismissError }) => {
  const gist = gistOf(doc);
  const deadlines = [...doc.deadlines].sort((a, b) => a.date.localeCompare(b.date));
  const more = deadlines.length - BADGES_SHOWN;
  const type = typeLabel(doc.type);
  const checkLabel = doc.inInbox ? `Correct: file “${doc.title}” in ${destination(doc)}` : `Correct: mark “${doc.title}” as checked`;
  const actions = (className: string) => (
    <div className={className}>
      <Button size="sm" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => onOpen(doc.id)} aria-label={`Edit “${doc.title}”`} className="flex-1 sm:flex-none">
        Edit
      </Button>
      {!original && (
        <Button
          size="sm"
          variant="accent"
          icon={<Check className="w-4 h-4" strokeWidth={2.5} />}
          onClick={() => onCheck(doc)}
          aria-label={checkLabel}
          title={checkLabel}
          data-check={doc.id}
          className="flex-1 sm:flex-none"
        >
          Correct
        </Button>
      )}
    </div>
  );
  return (
    // Phones give the details the item's whole width, under the first page and the title; wider screens keep
    // them beside the first page
    <li className="px-4 py-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 sm:gap-x-4">
      {/* The first page; the Edit button opens the same */}
      <button type="button" tabIndex={-1} aria-hidden onClick={() => onOpen(doc.id)} className="self-start sm:row-span-3 rounded-md hover:opacity-90 transition-opacity">
        <Thumbnail doc={doc} className="w-12 h-16 sm:w-14 sm:h-[4.5rem] rounded-md border border-line" iconClass="w-5 h-5" />
      </button>
      <div className="min-w-0 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink leading-snug break-words">{doc.title}</h3>
          {gist !== doc.title && <p className="text-sm text-ink-2 leading-snug mt-0.5 break-words">{gist}</p>}
        </div>
        {actions('hidden sm:flex items-center gap-2 shrink-0')}
      </div>
      <dl className="col-span-2 sm:col-span-1 sm:col-start-2 mt-3 sm:mt-2.5 grid grid-cols-[4.5rem_minmax(0,1fr)] lg:grid-cols-[4.5rem_minmax(0,1fr)_4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px] leading-5">
        <Fact label="From">{doc.correspondent ?? <Missing>No sender found</Missing>}</Fact>
        <Fact label="Topic">{doc.topic ?? <Missing>None (a one-off)</Missing>}</Fact>
        <Fact label="Date">
          {doc.date ? formatDate(doc.date) : <Missing>No date found</Missing>}
          {type && <span className="text-ink-2"> · {type}</span>}
        </Fact>
        <Fact label="Amount">{doc.amount !== null ? <span className="tabular-nums">{formatAmount(doc.amount, doc.currency)}</span> : <Missing>None</Missing>}</Fact>
        <Fact label="Folder" wide>
          <span className="inline-flex items-start gap-1.5 font-medium">
            <FolderInput className="w-3.5 h-3.5 mt-[3px] shrink-0 text-ink-3" />
            <span>{placeOf(doc)}</span>
          </span>
        </Fact>
        {deadlines.length > 0 && (
          <Fact label="Deadlines" wide>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {/* A possible copy's aren't counted (in Deadlines, Coming up) until the owner says what it is */}
              <span className="flex flex-wrap items-center gap-1.5">
                {deadlines.slice(0, BADGES_SHOWN).map(d => (
                  <DeadlineBadge key={`${d.date}|${d.what}`} deadline={d} />
                ))}
                {more > 0 && <span className="text-xs text-ink-3">+{more} more</span>}
              </span>
              {original && <span className="text-xs text-ink-2">Not counted yet</span>}
            </span>
          </Fact>
        )}
      </dl>
      {original && (
        <PossibleDuplicate
          className="col-span-2 sm:col-span-1 sm:col-start-2 mt-3"
          doc={doc}
          original={original}
          busy={null}
          error={error}
          onChoose={choice => onChoose(doc, original, choice)}
          onOpenOriginal={onOpen}
          onDismissError={() => onDismissError(doc.id)}
          firstChoiceData={doc.id}
          headingLevel={4}
        />
      )}
      {error && !original && (
        <div
          role="alert"
          className="col-span-2 sm:col-span-1 sm:col-start-2 mt-2.5 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[13px] text-ink"
        >
          <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0 text-danger" />
          <span className="flex-1 min-w-0 break-words">
            {doc.inInbox ? 'Not filed' : 'Not saved'}: {error}
          </span>
          <IconButton label="Dismiss" size="sm" className="-my-1.5 -mr-2" onClick={() => onDismissError(doc.id)}>
            <X className="w-3.5 h-3.5" />
          </IconButton>
        </div>
      )}
      {actions('col-span-2 sm:hidden flex items-center gap-2 mt-3')}
    </li>
  );
};

export const ToCheck: React.FC<{
  documents: DocumentInfo[];
  review: ReviewMode;
  // The Duplicates folder, linked when a possible copy was moved there (should the answer not name it)
  duplicatesFolderUrl?: string | null;
  onOpen: (id: string) => void;
  // Changes a document in the app's library (`patchDocument` from what it is now)
  onDocumentChange: (doc: DocumentInfo) => void;
  patchDocument: PatchDocument;
  // A possible copy kept with its original as a file, or moved to the Duplicates folder: out of the library at once
  onKeptWith: (kept: JustKept) => void;
  onSetAside: (moved: SetAside) => void;
  onReload: () => Promise<unknown>;
}> = ({ documents, review, duplicatesFolderUrl, onOpen, onDocumentChange, patchDocument, onKeptWith, onSetAside, onReload }) => {
  // Documents ticked here: out of the list while the check is on its way and a while after (until when)
  const [hidden, setHidden] = useState<Map<string, number>>(() => new Map());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [checked, setChecked] = useState<Checked | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [decided, setDecided] = useState<Decided | null>(null);
  // What was said about a tap further down the list, above it: scrolled to, so it doesn't just vanish (keyboard users
  // hear it, and their focus goes on to the next document)
  const noticeRef = useRef<HTMLDivElement>(null);
  const reveal = useRef(false);

  useEffect(() => {
    if (!checked) return;
    const timer = setTimeout(() => setChecked(null), CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [checked]);

  useEffect(() => {
    if (!(checked || decided) || !reveal.current) return;
    reveal.current = false;
    noticeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [checked, decided]);

  const now = Date.now();
  // A mark counts only while the document it names is listed (as the app's pages have it already)
  const shown = useMemo(() => activeFlags(documents), [documents]);
  const byId = useMemo(() => new Map(shown.map(d => [d.id, d])), [shown]);
  const list = useMemo(() => toCheck(shown).filter(d => (hidden.get(d.id) ?? 0) <= now), [shown, hidden, now]);

  const hide = (id: string, until: number | null) =>
    setHidden(m => {
      const next = new Map(m);
      if (until === null) next.delete(id);
      else next.set(id, until);
      return next;
    });
  const setError = (id: string, message: string | null) =>
    setErrors(m => {
      const next = new Map(m);
      if (message === null) next.delete(id);
      else next.set(id, message);
      return next;
    });

  // Keyboard users go on where they were: a document's first button (Correct, or a possible copy's first choice), or
  // the heading when none is left
  function focusOn(id: string | null) {
    requestAnimationFrame(() => {
      const target = id
        ? [...document.querySelectorAll<HTMLElement>(`[data-check="${CSS.escape(id)}"]`)].find(el => el.offsetParent !== null)
        : document.getElementById('to-check-heading');
      target?.focus();
    });
  }

  // The next document (or the one before) instead of losing their place
  function focusAfter(doc: DocumentInfo) {
    const i = list.findIndex(d => d.id === doc.id);
    focusOn((list[i + 1] ?? list[i - 1])?.id ?? null);
  }

  async function check(doc: DocumentInfo) {
    const keyboard = !!document.activeElement?.matches(':focus-visible');
    if (keyboard) focusAfter(doc);
    setError(doc.id, null);
    setUndoError(null);
    setDecided(null);
    hide(doc.id, Infinity);
    // Everywhere at once: the mark goes and the Inbox's count drops
    patchDocument(doc.id, d => ({ ...d, needsReview: false }));
    try {
      const saved = await api<DocumentInfo>(`/api/documents/${doc.id}`, { method: 'PATCH', body: { needsReview: false } });
      onDocumentChange(saved);
      // Marked as a possible copy meanwhile (by a run since this list loaded): back at once, to say what it is
      hide(doc.id, saved.possibleDuplicateOf ? null : Date.now() + HIDE_AFTER_CHECK_MS);
      reveal.current = !keyboard;
      setChecked({ before: doc, saved });
    } catch (err) {
      patchDocument(doc.id, d => ({ ...d, needsReview: true }));
      hide(doc.id, null);
      setError(doc.id, (err as Error).message);
    }
  }

  // What a possible copy is: two different documents (it stays to check in review mode manual, as any new document),
  // the same one (to the Duplicates folder), or the same one kept as a file with the original. The latter two take it
  // out of the list at once; it comes back with the reason if the server says no.
  async function choose(doc: DocumentInfo, original: DocumentInfo, choice: DuplicateChoice) {
    const stays = choice === 'keep-both' && doc.needsReview;
    const keyboard = !!document.activeElement?.matches(':focus-visible');
    if (keyboard) {
      if (stays) focusOn(doc.id);
      else focusAfter(doc);
    }
    setError(doc.id, null);
    setChecked(null);
    setUndoError(null);
    setDecided(null);
    if (!stays) hide(doc.id, Infinity);
    // Everywhere at once: the mark goes and its deadlines count again
    if (choice === 'keep-both') patchDocument(doc.id, d => ({ ...d, possibleDuplicateOf: null }));
    try {
      // The original shown, so a mark moved to another one meanwhile isn't decided unseen
      const result = await api<DuplicateChoiceResult>(`/api/documents/${encodeURIComponent(doc.id)}/possible-duplicate`, { method: 'POST', body: { choice, of: original.id } });
      reveal.current = !keyboard;
      if (choice === 'keep-both') {
        const saved = result.document ?? { ...doc, possibleDuplicateOf: null };
        if (result.document) onDocumentChange(result.document);
        hide(doc.id, saved.needsReview ? null : Date.now() + HIDE_AFTER_CHECK_MS);
        setDecided({ choice, title: saved.title, original, saved });
        return;
      }
      const folderUrl = result.duplicatesFolderUrl ?? duplicatesFolderUrl ?? null;
      if (choice === 'duplicate') onSetAside({ id: doc.id, title: doc.title, originalId: original.id, folderUrl });
      else if (result.attachment) onKeptWith({ title: doc.title, attachment: result.attachment });
      hide(doc.id, Date.now() + HIDE_AFTER_CHECK_MS);
      setDecided({ choice, title: doc.title, original, folderUrl });
      onReload();
    } catch (err) {
      if (choice === 'keep-both') patchDocument(doc.id, d => ({ ...d, possibleDuplicateOf: original.id }));
      // No longer a document in Paperwork: done already (in another window, say), so the library catches up
      if (err instanceof ApiError && err.status === 404) {
        hide(doc.id, Date.now() + HIDE_AFTER_CHECK_MS);
        onReload();
        return;
      }
      hide(doc.id, null);
      setError(doc.id, (err as Error).message);
      // Its mark changed meanwhile (or its original left Paperwork): shown as it is now
      if (err instanceof ApiError && err.code === 'duplicate') onReload();
    }
  }

  // Marks it to check again. A document already filed stays in its folder: Undo doesn't move it back.
  async function undo({ saved }: Checked) {
    setChecked(null);
    hide(saved.id, null);
    patchDocument(saved.id, d => ({ ...d, needsReview: true }));
    try {
      onDocumentChange(await api<DocumentInfo>(`/api/documents/${saved.id}`, { method: 'PATCH', body: { needsReview: true } }));
    } catch (err) {
      patchDocument(saved.id, d => ({ ...d, needsReview: false }));
      setUndoError(`“${saved.title}” couldn’t be marked to check again: ${(err as Error).message}`);
    }
  }

  // Shown while a check or a choice is on its way too, so the keyboard's focus has its heading to go to
  const sending = [...hidden.values()].includes(Infinity);
  if (review === 'automatic' && !list.length && !checked && !undoError && !decided && !sending) return null;
  const copies = list.some(isPossibleCopy);

  return (
    <section className="mb-8" aria-labelledby="to-check-heading">
      <div className="flex items-baseline gap-2 mb-1">
        <h2 id="to-check-heading" tabIndex={-1} className="text-[15px] font-semibold text-ink focus:outline-none">
          To check
        </h2>
        {list.length > 0 && <span className="text-sm text-ink-3 tabular-nums">{list.length}</span>}
      </div>
      <p className="text-sm text-ink-2 mb-3">
        {review === 'manual'
          ? `New documents wait here until you’ve checked what Paperwork read. Meanwhile they’re shown everywhere, marked To check.${copies ? ' Possible duplicates are marked; choose what they are first.' : ''}`
          : copies
            ? 'Paperwork filed these but wasn’t sure about them, or they may be copies of documents already in Paperwork. Check each one.'
            : list.some(d => d.inInbox)
              ? 'Check what Paperwork read. Documents still in the Inbox are filed once you’ve checked them.'
              : 'Paperwork filed these but wasn’t sure about them. Check the details and the folder.'}
      </p>

      <div ref={noticeRef} aria-live="polite" className="scroll-mt-4">
        {checked && (
          <Notice
            icon={<CheckCircle2 className="w-4 h-4 text-success" />}
            className="mb-3"
            action={
              <div className="flex items-center gap-1 -my-1.5 -mr-2">
                <button className="h-8 px-2 text-sm font-medium text-accent-ink hover:underline" onClick={() => undo(checked)}>
                  Undo
                </button>
                <IconButton label="Dismiss" size="sm" onClick={() => setChecked(null)}>
                  <X className="w-4 h-4" />
                </IconButton>
              </div>
            }
          >
            <span className="break-words">
              {checked.before.inInbox ? (
                <>
                  Filed <b className="font-medium">{checked.saved.title}</b> in {filedIn(checked.saved)}.
                </>
              ) : (
                <>
                  Checked <b className="font-medium">{checked.saved.title}</b>; it stays in {filedIn(checked.saved)}.
                </>
              )}
            </span>
          </Notice>
        )}
        {decided && (
          <Notice
            icon={
              decided.choice === 'keep-both' ? (
                <CheckCircle2 className="w-4 h-4 text-success" />
              ) : decided.choice === 'duplicate' ? (
                <Copy className="w-4 h-4 text-ink-3" />
              ) : (
                <Paperclip className="w-4 h-4 text-success" />
              )
            }
            className="mb-3"
            action={
              <div className="flex items-center gap-1 -my-1.5 -mr-2">
                {decided.choice === 'keep-with' && (
                  <button className="h-8 px-2 text-sm font-medium text-accent-ink hover:underline" onClick={() => onOpen(decided.original.id)}>
                    Open it
                  </button>
                )}
                <IconButton label="Dismiss" size="sm" onClick={() => setDecided(null)}>
                  <X className="w-4 h-4" />
                </IconButton>
              </div>
            }
          >
            <span className="break-words">
              {decided.choice === 'keep-both' ? (
                decided.saved?.needsReview ? (
                  <>
                    Kept both. <b className="font-medium">{decided.title}</b> is still to check.
                  </>
                ) : (
                  <>
                    Kept both. <b className="font-medium">{decided.title}</b> stays in {filedIn(decided.saved!)}.
                  </>
                )
              ) : decided.choice === 'duplicate' ? (
                <>
                  Moved <b className="font-medium">{decided.title}</b> to the{' '}
                  {decided.folderUrl ? (
                    <a className="font-medium text-accent-ink hover:underline" href={decided.folderUrl} target="_blank" rel="noreferrer">
                      Duplicates folder
                    </a>
                  ) : (
                    'Duplicates folder'
                  )}
                  . To undo, move it back into Paperwork › Inbox in Google Drive; delete it there if you don’t need it.
                </>
              ) : (
                <>
                  Kept <b className="font-medium">{decided.title}</b> with <b className="font-medium">{decided.original.title}</b> as a file.
                </>
              )}
            </span>
          </Notice>
        )}
        {undoError && (
          <Notice
            tone="danger"
            icon={<TriangleAlert className="w-4 h-4" />}
            className="mb-3"
            action={
              <IconButton label="Dismiss" size="sm" className="-my-1.5 -mr-2" onClick={() => setUndoError(null)}>
                <X className="w-4 h-4" />
              </IconButton>
            }
          >
            {undoError}
          </Notice>
        )}
      </div>

      {list.length > 0 ? (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {list.map(doc => (
              <CheckItem
                key={doc.id}
                doc={doc}
                original={doc.possibleDuplicateOf ? (byId.get(doc.possibleDuplicateOf) ?? null) : null}
                error={errors.get(doc.id) ?? null}
                onCheck={check}
                onChoose={choose}
                onOpen={onOpen}
                onDismissError={id => setError(id, null)}
              />
            ))}
          </ul>
        </Card>
      ) : (
        <Card className="px-4 py-3 flex items-center gap-2.5 text-sm text-ink-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 text-success" />
          <span>
            <span className="font-medium text-ink">Nothing to check.</span> New documents show up here once Paperwork has read them.
          </span>
        </Card>
      )}
    </section>
  );
};
