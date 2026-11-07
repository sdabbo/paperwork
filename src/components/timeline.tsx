// What the company and topic pages share: their open deadlines, the timeline of documents grouped by year, the
// link back to their index and the note after a rename or merge. On a company's page the timeline names each
// document's topic; on a topic's page each document's company, which is what varies there.
import React, { useEffect, useId, useMemo, useState } from 'react';
import { CalendarClock, Check, ChevronLeft, Layers, TriangleAlert, X } from 'lucide-react';
import type { DocumentInfo } from '../../shared/types';
import { localToday, shiftDate } from '../../shared/filter';
import { OpenDeadline, RECENT_OVERDUE_DAYS, countLabel, docDay, gistOf, openDeadlines } from '../lib/companies';
import { SaveDeadlineDone, useDeadlineDone } from '../lib/deadlines';
import { heldBackSummary } from '../lib/duplicates';
import { formatAmount, formatDate, formatDay, formatDayMonth, relativeDay, typeLabel } from '../lib/format';
import { pagePath } from '../lib/router';
import { AppLink, CompanyMark, DeadlineBadge, DeadlineKindLabel } from './companyParts';
import { KeptCount, ReviewBadge, dueTone } from './DocumentCard';
import { Card, CheckToggle, IconButton, Notice, cx } from './ui';

// Open deadlines shown before "Show all"
const DEADLINES_SHOWN = 4;
// Deadline badges per timeline entry before "+2 more"
const BADGES_SHOWN = 3;

// What a list names besides each document's title: its topic (on a company's page), its company (on a topic's
// page), or nothing
export type Detail = 'topic' | 'company' | null;

const detailOf = (doc: DocumentInfo, detail: Detail) => (detail === 'topic' ? doc.topic : detail === 'company' ? doc.correspondent : null);

// ---------- Open deadlines ----------

const DeadlineRow: React.FC<{ item: OpenDeadline; detail: Detail; busy: boolean; onOpen: (id: string) => void; onDone: (item: OpenDeadline) => void }> = ({
  item,
  detail,
  busy,
  onOpen,
  onDone,
}) => {
  const { doc, deadline } = item;
  const extra = detailOf(doc, detail);
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <CheckToggle className="mt-0.5" checked={false} disabled={busy} label={`Mark “${deadline.what}” as done`} onChange={() => onDone(item)} />
      <button type="button" onClick={() => onOpen(doc.id)} className="group min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="min-w-0 text-sm font-medium text-ink break-words">{deadline.what}</span>
          {deadline.kind && <DeadlineKindLabel kind={deadline.kind} />}
        </div>
        <div className={cx('text-xs mt-0.5', dueTone(deadline.date))}>
          {formatDay(deadline.date)} · {relativeDay(deadline.date)}
        </div>
        <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
          <span className="text-xs text-ink-2 truncate">
            {detail === 'company' && extra && <span className="font-medium text-ink">{extra} · </span>}
            <span className="group-hover:underline">{doc.title}</span>
            {detail === 'topic' && extra && <span className="text-ink-3"> · {extra}</span>}
          </span>
          <ReviewBadge doc={doc} />
        </div>
      </button>
      {doc.amount !== null && <div className="shrink-0 text-sm tabular-nums text-ink text-right">{formatAmount(doc.amount, doc.currency)}</div>}
    </li>
  );
};

// A possible copy's deadlines aren't listed until the owner says what it is; a line under the list says so, with the
// way to its check (the document, or To check in the Inbox for several)
export const OpenDeadlines: React.FC<{
  documents: DocumentInfo[];
  detail: Detail;
  onOpen: (id: string) => void;
  onNavigate: (to: string) => void;
  onDeadlineDone: SaveDeadlineDone;
}> = ({ documents, detail, onOpen, onNavigate, onDeadlineDone }) => {
  const { setDone, error, pending } = useDeadlineDone(onDeadlineDone);
  const headingId = useId();
  const [showAll, setShowAll] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  // The deadline just ticked off, for a moment, so a mistaken tap can be taken back
  const [justDone, setJustDone] = useState<OpenDeadline | null>(null);
  useEffect(() => {
    if (!justDone) return;
    const timer = setTimeout(() => setJustDone(null), 8000);
    return () => clearTimeout(timer);
  }, [justDone]);

  const items = useMemo(() => openDeadlines(documents), [documents]);
  const held = useMemo(() => heldBackSummary(documents), [documents]);
  const recentFrom = shiftDate(localToday(), -RECENT_OVERDUE_DAYS);
  const older = items.filter(i => i.deadline.date < recentFrom);
  const listed = showOlder ? items : items.filter(i => i.deadline.date >= recentFrom);
  const shown = showAll ? listed : listed.slice(0, DEADLINES_SHOWN);
  if (!items.length && !held.count && !justDone && !error) return null;

  const key = (i: OpenDeadline) => `${i.doc.id}|${i.deadline.date}|${i.deadline.what}`;
  return (
    <section className="mb-8" aria-labelledby={headingId}>
      <h2 id={headingId} className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2 mb-2">
        <CalendarClock className="w-4 h-4" />
        Open deadlines
        {items.length > 0 && <span className="font-normal text-ink-3 tabular-nums">{items.length}</span>}
      </h2>
      {error && (
        <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} className="mb-2">
          {error}
        </Notice>
      )}
      {justDone && !error && (
        <Notice
          icon={<Check className="w-4 h-4 text-success" />}
          className="mb-2"
          action={
            <button
              className="text-sm font-medium text-accent-ink hover:underline"
              onClick={() => {
                const doc = documents.find(d => d.id === justDone.doc.id);
                if (doc) setDone(doc, justDone.deadline, false);
                setJustDone(null);
              }}
            >
              Undo
            </button>
          }
        >
          Marked “{justDone.deadline.what}” as done.
        </Notice>
      )}
      {(shown.length > 0 || older.length > 0) && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {older.length > 0 && !showOlder && (
              <li className="px-4 py-2.5 text-[13px] text-ink-2">
                {older.length === 1 ? 'One deadline from more than three months ago was' : `${older.length} deadlines from more than three months ago were`} never
                ticked off.{' '}
                <button className="font-medium text-accent-ink hover:underline" onClick={() => setShowOlder(true)}>
                  Show {older.length === 1 ? 'it' : 'them'}
                </button>
              </li>
            )}
            {shown.map(item => (
              <DeadlineRow
                key={key(item)}
                item={item}
                detail={detail}
                busy={pending.has(key(item))}
                onOpen={onOpen}
                onDone={async i => {
                  setJustDone(null);
                  if (await setDone(i.doc, i.deadline, true)) setJustDone(i);
                }}
              />
            ))}
            {listed.length > DEADLINES_SHOWN && (
              <li>
                <button className="w-full px-4 py-2.5 text-left text-[13px] font-medium text-accent-ink hover:bg-surface-2" onClick={() => setShowAll(!showAll)}>
                  {showAll ? 'Show fewer' : `Show all ${listed.length}`}
                </button>
              </li>
            )}
          </ul>
        </Card>
      )}
      {held.count > 0 && (
        <p className={cx('text-xs text-ink-2', (shown.length > 0 || older.length > 0) && 'mt-2')}>
          Not counted: {held.count === 1 ? '1 deadline' : `${held.count} deadlines`} from{' '}
          {held.copies.length === 1 ? 'a possible duplicate' : `${held.copies.length} possible duplicates`}.{' '}
          {held.copies.length === 1 ? (
            <button className="font-medium text-accent-ink hover:underline" onClick={() => onOpen(held.copies[0].doc.id)}>
              Check it
            </button>
          ) : (
            <AppLink to={pagePath('inbox')} onNavigate={onNavigate} className="font-medium text-accent-ink hover:underline">
              Check them
            </AppLink>
          )}
        </p>
      )}
    </section>
  );
};

// ---------- Timeline ----------

// `kept`: how many files are kept with it
const TimelineEntry: React.FC<{ doc: DocumentInfo; detail: Detail; kept: number; onOpen: (id: string) => void }> = ({ doc, detail, kept, onOpen }) => {
  const day = docDay(doc);
  const gist = gistOf(doc);
  const type = typeLabel(doc.type);
  const deadlines = [...doc.deadlines].sort((a, b) => a.date.localeCompare(b.date));
  const hidden = deadlines.length - BADGES_SHOWN;
  const showTopic = detail === 'topic' && !!doc.topic;
  const badges = showTopic || deadlines.length > 0 || doc.needsReview || !!doc.possibleDuplicateOf || kept > 0;
  const sender = detail === 'company' ? doc.correspondent?.trim() || null : null;
  const when = (
    <>
      <time dateTime={day} title={doc.date ? formatDate(day, 'long') : 'No date on the document; placed by the day it was added'}>
        {doc.date ? formatDayMonth(day) : `Added ${formatDayMonth(day)}`}
      </time>
      {type && ` · ${type}`}
    </>
  );
  return (
    <li className={cx('relative', detail === 'company' ? 'pl-9' : 'pl-7')}>
      {detail === 'company' ? (
        // Each document's sender marks it on the line, so who wrote when stands out at a glance
        <span aria-hidden className="absolute left-0 top-3 rounded-md bg-canvas">
          {sender ? <CompanyMark name={sender} size="sm" /> : <span className="flex w-[22px] h-[22px] items-center justify-center rounded-md border border-dashed border-line-strong text-[10px] text-ink-3">?</span>}
        </span>
      ) : (
        <span aria-hidden className="absolute left-[5px] top-[1.15rem] w-[11px] h-[11px] rounded-full border-2 border-ink-3 bg-canvas" />
      )}
      <button
        type="button"
        onClick={() => onOpen(doc.id)}
        className="w-full text-left bg-surface border border-line rounded-xl px-3.5 py-3 hover:border-line-strong hover:shadow-sm transition"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {detail === 'company' ? (
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={cx('min-w-0 text-[13px] font-semibold break-words', sender ? 'text-ink' : 'text-ink-3 font-medium')}>{sender ?? 'No sender'}</span>
                <span className="text-xs text-ink-3 whitespace-nowrap">{when}</span>
              </div>
            ) : (
              <div className="text-xs text-ink-3">{when}</div>
            )}
            <div className={cx('text-sm text-ink leading-snug mt-0.5 line-clamp-2 break-words', detail !== 'company' && 'font-medium')}>{doc.title}</div>
          </div>
          {doc.amount !== null && <div className="shrink-0 text-sm font-medium text-ink tabular-nums">{formatAmount(doc.amount, doc.currency)}</div>}
        </div>
        {gist !== doc.title && <p className="text-sm text-ink-2 leading-snug mt-1 break-words">{gist}</p>}
        {badges && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {showTopic && (
              <span className="inline-flex items-center gap-1 min-w-0 max-w-full h-6 px-2 rounded-md text-xs font-medium bg-accent-soft text-accent-ink">
                <Layers className="w-3 h-3 shrink-0" />
                <span className="truncate">{doc.topic}</span>
              </span>
            )}
            <ReviewBadge doc={doc} size="md" />
            {kept > 0 && <KeptCount count={kept} className="h-6 px-2 rounded-md bg-surface-2 font-medium text-ink-2" />}
            {deadlines.slice(0, BADGES_SHOWN).map(d => (
              <DeadlineBadge key={`${d.date}|${d.what}`} deadline={d} />
            ))}
            {hidden > 0 && <span className="text-xs text-ink-3">+{hidden} more</span>}
          </div>
        )}
      </button>
    </li>
  );
};

// `kept`: how many files are kept with each document (none when it isn't there)
export const Timeline: React.FC<{ documents: DocumentInfo[]; detail: Detail; kept: Map<string, number>; onOpen: (id: string) => void }> = ({
  documents,
  detail,
  kept,
  onOpen,
}) => {
  // Newest first already; grouped by year in that order
  const years = useMemo(() => {
    const groups = new Map<string, DocumentInfo[]>();
    for (const doc of documents) {
      const year = docDay(doc).slice(0, 4);
      if (groups.has(year)) groups.get(year)!.push(doc);
      else groups.set(year, [doc]);
    }
    return [...groups.entries()];
  }, [documents]);
  return (
    <div className="space-y-6">
      {years.map(([year, docs]) => (
        <section key={year} aria-label={`${year}, ${countLabel(docs.length)}`}>
          <h3 className="flex items-center gap-3 mb-2.5">
            <span className="text-sm font-semibold text-ink tabular-nums">{year}</span>
            <span className="text-xs text-ink-3">{countLabel(docs.length)}</span>
            <span aria-hidden className="flex-1 h-px bg-line" />
          </h3>
          <ol
            className={cx(
              'relative space-y-2.5 before:absolute before:top-2 before:bottom-2 before:w-px before:bg-line-strong',
              detail === 'company' ? 'before:left-[10.5px]' : 'before:left-[10px]'
            )}
          >
            {docs.map(doc => (
              <TimelineEntry key={doc.id} doc={doc} detail={detail} kept={kept.get(doc.id) ?? 0} onOpen={onOpen} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
};

// ---------- Around the pages ----------

export const BackLink: React.FC<{ to: string; label: string; onNavigate: (to: string) => void }> = ({ to, label, onNavigate }) => (
  <AppLink
    to={to}
    onNavigate={onNavigate}
    className="inline-flex items-center gap-0.5 -ml-1 mb-3 h-7 pr-2 rounded-md text-[13px] font-medium text-ink-2 hover:text-ink"
  >
    <ChevronLeft className="w-4 h-4" />
    {label}
  </AppLink>
);

export interface Flash {
  tone: 'success' | 'warning';
  text: string;
}

export const FlashNotice: React.FC<{ flash: Flash; onDismiss: () => void; action?: React.ReactNode; className?: string }> = ({ flash, onDismiss, action, className }) => (
  <Notice
    tone={flash.tone === 'warning' ? 'warning' : 'neutral'}
    icon={flash.tone === 'warning' ? <TriangleAlert className="w-4 h-4" /> : <Check className="w-4 h-4 text-success" />}
    className={className ?? 'mb-5'}
    action={
      <IconButton label="Dismiss" size="sm" className="-my-1.5 -mr-2" onClick={onDismiss}>
        <X className="w-4 h-4" />
      </IconButton>
    }
  >
    <span className="break-words">{flash.text}</span>
    {action && <span className="ml-1.5">{action}</span>}
  </Notice>
);

// The note after renaming or merging: how many documents took the new name, and how many Drive refused
export function renameFlash(result: { updated: number; failed: number }, old: string, to: string, merged: boolean): Flash {
  if (!result.updated) {
    return {
      tone: 'warning',
      text: result.failed
        ? `Drive didn't take the new name for any of the ${countLabel(result.failed)}. Try again in a moment.`
        : 'Nothing was renamed: no document has that name anymore.',
    };
  }
  const failed = result.failed
    ? ` ${countLabel(result.failed)} couldn't be changed in Drive (moved out of the Paperwork folder meanwhile?) and still ${result.failed === 1 ? 'shows' : 'show'} “${old}”.`
    : '';
  return {
    tone: result.failed ? 'warning' : 'success',
    text: `${merged ? `Merged into “${to}”` : `Renamed to “${to}”`} in ${countLabel(result.updated)}.${failed}`,
  };
}
