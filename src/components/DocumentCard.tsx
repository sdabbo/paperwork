// A document in the library: a card with its first page in the grid, a row in the list.
import React, { useState } from 'react';
import { CalendarClock, CircleDashed, Copy, FileText, Image as ImageIcon, Paperclip, Star } from 'lucide-react';
import type { DocumentInfo } from '../../shared/types';
import { lapsed } from '../lib/deadlines';
import { daysUntil, folderColor, formatAmount, formatDate, formatDay, relativeDay, typeLabel } from '../lib/format';
import { placeOf } from '../lib/review';
import { companyPath } from '../lib/router';
import { AppLink } from './companyParts';
import { cx } from './ui';

export const FileIcon: React.FC<{ mimeType: string; className?: string }> = ({ mimeType, className }) =>
  mimeType.startsWith('image/') ? <ImageIcon className={className} /> : <FileText className={className} />;

export const Thumbnail: React.FC<{ doc: DocumentInfo; className?: string; iconClass?: string }> = ({ doc, className, iconClass }) => {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cx('bg-surface-2 flex items-center justify-center overflow-hidden', className)}>
      {doc.hasThumbnail && !failed ? (
        <img
          src={`/api/documents/${doc.id}/thumbnail`}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="w-full h-full object-cover object-top"
        />
      ) : (
        <FileIcon mimeType={doc.mimeType} className={cx('text-ink-3', iconClass ?? 'w-6 h-6')} />
      )}
    </div>
  );
};

// The same mark wherever documents are listed: not checked yet (waiting in the Inbox for its check, or Paperwork
// wasn't sure about it). `overlay` sits on a card's first page; `md` matches the timeline's badges.
export const ToCheckBadge: React.FC<{ className?: string; overlay?: boolean; size?: 'sm' | 'md' }> = ({ className, overlay, size = 'sm' }) => (
  <span
    title="Not checked yet"
    className={cx(
      'inline-flex items-center gap-1 shrink-0 rounded-md font-medium whitespace-nowrap text-warning',
      size === 'md' ? 'h-6 px-2 text-xs' : 'h-5 px-1.5 text-[11px]',
      overlay ? 'bg-surface/95 shadow-sm ring-1 ring-warning/30' : 'bg-warning/12',
      className
    )}
  >
    <CircleDashed className="w-3 h-3 shrink-0" strokeWidth={2.5} aria-hidden />
    To check
  </span>
);

// A possible copy of another document, until the owner decides: shaped like ToCheckBadge, which it stands in for
export const DuplicateBadge: React.FC<{ className?: string; overlay?: boolean; size?: 'sm' | 'md' }> = ({ className, overlay, size = 'sm' }) => (
  <span
    title="May be a copy of another document; its deadlines aren’t counted until you check it"
    className={cx(
      'inline-flex items-center gap-1 shrink-0 rounded-md font-medium whitespace-nowrap text-warning',
      size === 'md' ? 'h-6 px-2 text-xs' : 'h-5 px-1.5 text-[11px]',
      overlay ? 'bg-surface/95 shadow-sm ring-1 ring-warning/30' : 'bg-warning/12',
      className
    )}
  >
    <Copy className="w-3 h-3 shrink-0" strokeWidth={2.5} aria-hidden />
    Duplicate?
  </span>
);

// The one mark a document gets: a possible copy, or else not checked yet (on the app's documents, where a mark whose
// original is gone is cleared)
export const ReviewBadge: React.FC<{ doc: DocumentInfo; className?: string; overlay?: boolean; size?: 'sm' | 'md' }> = ({ doc, ...props }) =>
  doc.possibleDuplicateOf ? <DuplicateBadge {...props} /> : doc.needsReview ? <ToCheckBadge {...props} /> : null;

// How many files are kept with a document (a Word draft, a spreadsheet), with a paperclip
export const KeptCount: React.FC<{ count: number; className?: string }> = ({ count, className }) => (
  <span title={`${count} ${count === 1 ? 'file' : 'files'} kept with it`} className={cx('inline-flex items-center gap-0.5 shrink-0 text-xs text-ink-3 tabular-nums', className)}>
    <Paperclip className="w-3 h-3 shrink-0" aria-hidden />
    <span aria-hidden>{count}</span>
    <span className="sr-only">
      , {count} {count === 1 ? 'file' : 'files'} kept with it
    </span>
  </span>
);

export const FolderTag: React.FC<{ name: string | null; className?: string; title?: string }> = ({ name, className, title }) =>
  name ? (
    <span title={title} className={cx('inline-flex items-center gap-1.5 text-xs text-ink-2 min-w-0', className)}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: folderColor(name) }} />
      <span className="truncate">{name}</span>
    </span>
  ) : null;

// How urgent a date is: overdue in red, within a week in amber, later in plain grey
export const dueTone = (date: string, done = false) => {
  const days = daysUntil(date);
  return done ? 'text-ink-3' : days < 0 ? 'text-danger' : days <= 7 ? 'text-warning' : 'text-ink-2';
};

// A document's main due date, on its card
export const DueTag: React.FC<{ date: string }> = ({ date }) => {
  const days = daysUntil(date);
  const text = days < 0 ? `overdue since ${formatDate(date)}` : days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due ${formatDate(date)}`;
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs font-medium', dueTone(date))}>
      <CalendarClock className="w-3.5 h-3.5" />
      {text}
    </span>
  );
};

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

// When a deadline is: "Overdue · Mon, 12 Oct", "In 5 days · Wed, 21 Oct", or just the day when it's further off
export const DeadlineWhen: React.FC<{ date: string; done?: boolean; icon?: boolean; className?: string }> = ({ date, done, icon = true, className }) => {
  const days = daysUntil(date);
  const lead = done ? null : days < 0 ? 'Overdue' : days <= 14 ? capitalize(relativeDay(date)) : null;
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap', dueTone(date, done), className)}>
      {icon && <CalendarClock className="w-3.5 h-3.5 shrink-0" />}
      {/* Cut short with an ellipsis rather than spilling out when its box is narrow */}
      <span className="truncate">{lead ? `${lead} · ${formatDay(date)}` : formatDay(date)}</span>
    </span>
  );
};

// The due date shown on a card: the main one, unless it was ticked off, is long past, or is a purchase's return or
// warranty date that has passed (it ended, it isn't overdue). A possible copy shows none: its deadlines aren't
// counted until the owner decides.
const openDueDate = (doc: DocumentInfo): string | null => {
  if (doc.possibleDuplicateOf) return null;
  const due = doc.dueDate;
  if (!due || daysUntil(due) < -14) return null;
  const same = doc.deadlines.filter(d => d.date === due);
  return same.length && same.every(d => d.done || lapsed(d)) ? null : due;
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A passage of the document's text that matched a search, with the query's words picked out
export const Snippet: React.FC<{ text: string; query?: string; className?: string }> = ({ text, query, className }) => {
  const terms = (query ?? '')
    .trim()
    .split(/\s+/)
    .filter(t => t.length > 1)
    .map(escapeRegExp);
  const parts = terms.length ? text.split(new RegExp(`(${terms.join('|')})`, 'gi')) : [text];
  return (
    <p className={cx('text-xs text-ink-3 leading-snug line-clamp-2 break-words', className)}>
      {parts.map((part, i) =>
        i % 2 ? (
          <mark key={i} className="bg-transparent text-ink-2 font-medium">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </p>
  );
};

const subtitle = (doc: DocumentInfo) => [doc.correspondent, formatDate(doc.date ?? doc.addedAt)].filter(Boolean).join(' · ');

interface ItemProps {
  doc: DocumentInfo;
  onOpen: (id: string) => void;
  // From a search: the passage that matched, and the query to pick its words out
  snippet?: string | null;
  query?: string;
  // The files kept with it
  kept?: number;
}

export const DocumentCard: React.FC<ItemProps> = ({ doc, onOpen, snippet, query, kept = 0 }) => {
  const due = openDueDate(doc);
  return (
    <button
      type="button"
      onClick={() => onOpen(doc.id)}
      className="group text-left bg-surface border border-line rounded-xl overflow-hidden hover:border-line-strong hover:shadow-sm transition flex flex-col"
    >
      <div className="relative">
        <Thumbnail doc={doc} className="aspect-[4/3] border-b border-line" iconClass="w-8 h-8" />
        {doc.starred && <Star className="absolute top-2 right-2 w-4 h-4 fill-warning text-warning drop-shadow" />}
        <ReviewBadge doc={doc} overlay className="absolute top-2 left-2" />
        {kept > 0 && <KeptCount count={kept} className="absolute bottom-2 right-2 h-5 px-1.5 rounded-md bg-surface/95 shadow-sm ring-1 ring-line text-ink-2" />}
      </div>
      <div className="p-3 flex-1 flex flex-col gap-1.5">
        <div className="text-sm font-medium text-ink leading-snug line-clamp-2">{doc.title}</div>
        {snippet && <Snippet text={snippet} query={query} />}
        <div className="text-xs text-ink-2 truncate">{subtitle(doc)}</div>
        <div className="mt-auto pt-1 flex items-center justify-between gap-2">
          <FolderTag name={doc.category} title={doc.inInbox ? placeOf(doc) : undefined} />
          {doc.amount !== null && <span className="text-xs font-medium text-ink tabular-nums">{formatAmount(doc.amount, doc.currency)}</span>}
        </div>
        {due && <DueTag date={due} />}
      </div>
    </button>
  );
};

// The whole row opens the document (its title's button stretches over it); on wider screens the sender is a link
// to the company's page on top of that. Phones keep it plain text, so a tap on the row always opens the document.
export const DocumentRow: React.FC<ItemProps & { onNavigate?: (to: string) => void }> = ({ doc, onOpen, snippet, query, onNavigate, kept = 0 }) => (
  <div className="relative flex items-center gap-3 px-3 py-2.5 hover:bg-surface-2 transition-colors">
    <Thumbnail doc={doc} className="w-10 h-12 rounded-md border border-line shrink-0" iconClass="w-4 h-4" />
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onOpen(doc.id)}
          className="min-w-0 text-left text-sm font-medium text-ink truncate after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent focus-visible:after:-outline-offset-2"
        >
          {doc.title}
        </button>
        {doc.starred && <Star className="w-3.5 h-3.5 shrink-0 fill-warning text-warning" />}
        {kept > 0 && <KeptCount count={kept} />}
        <ReviewBadge doc={doc} />
      </div>
      {snippet && <Snippet text={snippet} query={query} className="my-0.5" />}
      <div className="text-xs text-ink-2 truncate">
        {doc.correspondent && onNavigate ? (
          <>
            <span className="sm:hidden">{doc.correspondent}</span>
            <AppLink
              to={companyPath(doc.correspondent)}
              onNavigate={onNavigate}
              title={`All documents from ${doc.correspondent}`}
              className="hidden sm:inline relative z-10 hover:text-ink hover:underline"
            >
              {doc.correspondent}
            </AppLink>
          </>
        ) : (
          doc.correspondent
        )}
        {doc.correspondent && doc.type ? ' · ' : ''}
        {typeLabel(doc.type)}
      </div>
    </div>
    {/* In a box of its own: FolderTag's inline-flex would win over a hidden given to it, and squeeze the title on a phone */}
    <div className="hidden md:flex w-40 min-w-0">
      <FolderTag name={doc.category} title={doc.inInbox ? placeOf(doc) : undefined} />
    </div>
    <div className="hidden sm:block w-28 text-right text-xs text-ink-2 tabular-nums">{formatDate(doc.date ?? doc.addedAt)}</div>
    <div className="w-24 text-right text-sm text-ink tabular-nums">{formatAmount(doc.amount, doc.currency)}</div>
  </div>
);
