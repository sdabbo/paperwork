// Deadlines: every date the documents ask something by. Overdue ones first, then the next twelve months by
// month. Ticking one off is kept in Paperwork's index only; Drive keeps the dates in the file's description.
// A purchase's last day to return it, or the end of its warranty, is a chance rather than something owed: once
// past, it is never overdue and leaves the open lists (with "Show done" it is listed with the earlier ones).
// A possible copy of another document isn't counted until the owner says what it is; the page says so.
import React, { useMemo, useState } from 'react';
import { CalendarCheck, CheckCircle2, Copy, TriangleAlert } from 'lucide-react';
import type { DocumentInfo } from '../../shared/types';
import { DeadlineItem, deadlineItems, deadlineKey, localToday, shiftDate, shiftMonths } from '../../shared/filter';
import { SaveDeadlineDone, lapsed, useDeadlineDone } from '../lib/deadlines';
import { HeldBack, heldBackSummary } from '../lib/duplicates';
import { formatAmount, formatDay, formatMonth, relativeDay } from '../lib/format';
import { DeadlineKindLabel } from './companyParts';
import { ReviewBadge, dueTone } from './DocumentCard';
import { Card, CheckToggle, Chip, EmptyState, Notice, PageHeader, Spinner, cx } from './ui';

// Overdue deadlines older than this were most likely dealt with and just never ticked off (a bill from years
// ago); they wait behind a button instead of filling the page
const RECENT_OVERDUE_DAYS = 90;

const Row: React.FC<{
  item: DeadlineItem;
  busy: boolean;
  onOpen: (id: string) => void;
  onToggle: (item: DeadlineItem, done: boolean) => void;
}> = ({ item, busy, onOpen, onToggle }) => {
  const { doc, deadline } = item;
  const amount = doc.amount !== null ? formatAmount(doc.amount, doc.currency) : '';
  // Red already says overdue (and the section is called that); the words say how long ago
  const when = relativeDay(deadline.date);
  // Done, or a return or warranty date that has passed (it ended): greyed; only a done one is struck through
  const over = deadline.done || lapsed(deadline);
  return (
    <li className={cx('flex items-start gap-3 px-4 py-3', over && 'opacity-60')}>
      <CheckToggle
        className="mt-0.5"
        checked={deadline.done}
        disabled={busy}
        label={deadline.done ? `Mark “${deadline.what}” as not done` : `Mark “${deadline.what}” as done`}
        onChange={done => onToggle(item, done)}
      />
      <div className="hidden sm:block w-32 shrink-0">
        <div className={cx('text-sm font-medium tabular-nums', over ? 'text-ink-3' : 'text-ink')}>{formatDay(deadline.date)}</div>
        <div className={cx('text-xs', dueTone(deadline.date, over))}>{when}</div>
      </div>
      <button type="button" onClick={() => onOpen(doc.id)} className="group min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className={cx('text-sm font-medium', deadline.done ? 'line-through text-ink-3' : over ? 'text-ink-3' : 'text-ink')}>{deadline.what}</span>
          {deadline.kind && <DeadlineKindLabel kind={deadline.kind} />}
        </div>
        <div className={cx('sm:hidden text-xs mt-0.5', dueTone(deadline.date, over))}>
          {formatDay(deadline.date)} · {when}
        </div>
        <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
          <span className="text-xs text-ink-2 truncate">
            <span className="group-hover:underline">{doc.title}</span>
            {doc.correspondent && <span className="text-ink-3"> · {doc.correspondent}</span>}
          </span>
          <ReviewBadge doc={doc} />
        </div>
      </button>
      {amount && <div className={cx('shrink-0 text-sm tabular-nums text-right', over ? 'text-ink-3' : 'text-ink')}>{amount}</div>}
    </li>
  );
};

const Section: React.FC<{ title: React.ReactNode; count?: number; tone?: 'danger'; children: React.ReactNode }> = ({ title, count, tone, children }) => (
  <section className="mb-6">
    <h2 className={cx('flex items-center gap-1.5 text-[15px] font-semibold mb-2', tone === 'danger' ? 'text-danger' : 'text-ink')}>
      {title}
      {count !== undefined && <span className="text-xs font-normal text-ink-3 tabular-nums">{count}</span>}
    </h2>
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line">{children}</ul>
    </Card>
  </section>
);

// The deadlines not listed because their document may be a copy, and where to say what it is
const HeldBackNotice: React.FC<{ held: HeldBack; onOpen: (id: string) => void; onShowInbox: () => void }> = ({ held, onOpen, onShowInbox }) => {
  const [one] = held.copies;
  const link = 'font-medium text-accent-ink hover:underline';
  return (
    <Notice icon={<Copy className="w-4 h-4 text-warning" />} className="mb-4">
      {held.copies.length === 1 ? (
        <>
          {held.count === 1 ? 'One deadline' : `${held.count} deadlines`} from “{one.doc.title}” {held.count === 1 ? 'isn’t' : 'aren’t'} listed while it may be a
          copy of “{one.original.title}”.{' '}
          <button className={link} onClick={() => onOpen(one.doc.id)}>
            Check it
          </button>
        </>
      ) : (
        <>
          {held.count} deadlines from {held.copies.length} possible duplicates aren’t listed.{' '}
          <button className={link} onClick={onShowInbox}>
            Check them
          </button>
        </>
      )}
    </Notice>
  );
};

const DeadlinesView: React.FC<{
  documents: DocumentInfo[];
  loading: boolean;
  onOpen: (id: string) => void;
  onDeadlineDone: SaveDeadlineDone;
  // To check, at the top of the Inbox: where possible copies are decided about
  onShowInbox: () => void;
}> = ({ documents, loading, onOpen, onDeadlineDone, onShowInbox }) => {
  const [showDone, setShowDone] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const { setDone, error, pending } = useDeadlineDone(onDeadlineDone);
  const today = localToday();
  const items = useMemo(() => deadlineItems(documents), [documents]);
  const held = useMemo(() => heldBackSummary(documents), [documents]);

  const lists = useMemo(() => {
    const recentFrom = shiftDate(today, -RECENT_OVERDUE_DAYS);
    // Twelve whole months, starting with this one
    const end = shiftMonths(`${today.slice(0, 7)}-01`, 12);
    // A purchase's return or warranty date that has passed isn't overdue: it lapsed
    const overdue = items.filter(i => !i.deadline.done && i.deadline.date < today && !lapsed(i.deadline, today));
    const ahead = items.filter(i => i.deadline.date >= today && (showDone || !i.deadline.done));
    const months = new Map<string, DeadlineItem[]>();
    for (const i of ahead.filter(i => i.deadline.date < end)) {
      const month = i.deadline.date.slice(0, 7);
      months.set(month, [...(months.get(month) ?? []), i]);
    }
    return {
      // All of them, oldest first like the rest of the page; the older ones lead the list once they are shown
      overdue,
      recent: overdue.filter(i => i.deadline.date >= recentFrom),
      older: overdue.filter(i => i.deadline.date < recentFrom),
      months: [...months.entries()],
      later: ahead.filter(i => i.deadline.date >= end),
      // Most recent first: what was just dealt with is what one looks for. Return and warranty dates that lapsed
      // come back here too.
      doneBefore: showDone ? items.filter(i => (i.deadline.done || lapsed(i.deadline, today)) && i.deadline.date < today).reverse() : [],
    };
  }, [items, today, showDone]);

  const row = (item: DeadlineItem) => (
    <Row key={deadlineKey(item)} item={item} busy={pending.has(deadlineKey(item))} onOpen={onOpen} onToggle={(i, done) => setDone(i.doc, i.deadline, done)} />
  );
  // Only when every deadline is ticked off or lapsed (open ones are always listed somewhere)
  const nothingToShow = !lists.overdue.length && !lists.months.length && !lists.later.length && !lists.doneBefore.length;
  const anyLapsed = items.some(i => lapsed(i.deadline, today));

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="Deadlines"
        description="Payments, replies, cancellations, renewals and expiry dates from your documents."
        actions={
          items.length > 0 && (
            <Chip active={showDone} onClick={() => setShowDone(!showDone)} icon={<CheckCircle2 className="w-3.5 h-3.5" />}>
              Show done
            </Chip>
          )
        }
      />

      {error && (
        <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} className="mb-4">
          {error}
        </Notice>
      )}

      {!loading && held.count > 0 && <HeldBackNotice held={held} onOpen={onOpen} onShowInbox={onShowInbox} />}

      {loading ? (
        <div className="flex justify-center pt-16">
          <Spinner className="w-5 h-5" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarCheck className="w-5 h-5" />}
            title="No deadlines yet"
            description="When a document asks you to pay, reply, cancel or renew something by a certain date, it shows up here. Paperwork picks these dates up as it files your documents, and you can add your own in a document's details."
          />
        </Card>
      ) : nothingToShow ? (
        <Card>
          <EmptyState
            icon={<CalendarCheck className="w-5 h-5" />}
            title="All caught up"
            description={
              anyLapsed
                ? 'Nothing is overdue or coming up: every deadline is ticked off, or was a return or warranty date that has passed. Turn on “Show done” to see them again.'
                : 'Nothing is overdue or coming up: every deadline is ticked off. Turn on “Show done” to see them again.'
            }
          />
        </Card>
      ) : (
        <>
          {lists.overdue.length > 0 && (
            // The count is all of them, also while the older ones wait behind the button
            <Section title={<><TriangleAlert className="w-4 h-4" />Overdue</>} count={lists.overdue.length} tone="danger">
              {/* Where the older ones go when shown: before the recent ones, as they are earlier */}
              {lists.older.length > 0 && !showOlder && (
                <li className="px-4 py-3 text-sm text-ink-2">
                  {lists.older.length === 1 ? 'One deadline from more than three months ago was' : `${lists.older.length} deadlines from more than three months ago were`}{' '}
                  never ticked off.{' '}
                  <button className="font-medium text-accent-ink hover:underline" onClick={() => setShowOlder(true)}>
                    Show {lists.older.length === 1 ? 'it' : 'them'}
                  </button>
                </li>
              )}
              {(showOlder ? lists.overdue : lists.recent).map(row)}
            </Section>
          )}
          {lists.months.map(([month, list]) => (
            <Section key={month} title={formatMonth(month)} count={list.length}>
              {list.map(row)}
            </Section>
          ))}
          {lists.later.length > 0 && (
            <Section title="Later" count={lists.later.length}>
              {lists.later.map(row)}
            </Section>
          )}
          {lists.doneBefore.length > 0 && (
            <Section title={lists.doneBefore.some(i => !i.deadline.done) ? 'Done or ended earlier' : 'Done earlier'} count={lists.doneBefore.length}>
              {lists.doneBefore.map(row)}
            </Section>
          )}
        </>
      )}
    </div>
  );
};

export default DeadlinesView;
