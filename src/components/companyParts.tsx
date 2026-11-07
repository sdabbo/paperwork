// Pieces the company and topic pages share with the rest of the app: links to them, a company's or topic's mark,
// deadline badges, the switch between the index pages on phones.
import React from 'react';
import { Building2, CalendarClock, Check, FileSignature, Hourglass, Landmark, Layers, LucideIcon, ShieldCheck, ShoppingBag, Undo2 } from 'lucide-react';
import type { Deadline, DeadlineKind } from '../../shared/types';
import { RECENT_OVERDUE_DAYS, countLabel } from '../lib/companies';
import { lapsed } from '../lib/deadlines';
import { daysUntil, folderColor, formatDay } from '../lib/format';
import { isPlainClick, pagePath } from '../lib/router';
import { cx } from './ui';

// A link to one of the app's pages: a real link (opens in a new tab with a modifier key), routed in the app otherwise
export const AppLink: React.FC<
  Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string; onNavigate: (to: string) => void; ref?: React.Ref<HTMLAnchorElement> }
> = ({
  to,
  onNavigate,
  onClick,
  ...rest
}) => (
  <a
    href={to}
    onClick={e => {
      onClick?.(e);
      if (e.defaultPrevented || !isPlainClick(e)) return;
      e.preventDefault();
      onNavigate(to);
    }}
    {...rest}
  />
);

// Academic titles at the start of a name, each with its period ("Prof. Dr.", "Dr. med.", "Dipl.-Ing.")
const TITLES = /^(?:(?:prof|dr|med|dent|vet|jur|rer|nat|phil|dipl|ing|mag|univ|h\.\s?c)\.[\s-]*)+/iu;

const MARK_SIZES = {
  sm: 'w-[22px] h-[22px] text-[9.5px] rounded-md',
  md: 'w-9 h-9 text-[13px] rounded-xl',
  lg: 'w-12 h-12 text-base rounded-xl',
};

// One or two letters of the name ("SM" for Stadtwerke Musterstadt), in the name's own color
export const CompanyMark: React.FC<{ name: string; size?: 'sm' | 'md' | 'lg'; className?: string }> = ({ name, size = 'md', className }) => {
  // "EM" for Dr. Erika Mustermann: the titles in front are left out, unless the name is nothing else
  const split = (text: string) => text.split(/[\s\-–/&+.,]+/).filter(w => /^\p{L}/u.test(w));
  const named = split(name.replace(TITLES, ''));
  const words = named.length ? named : split(name);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? name).slice(0, 1)).toLocaleUpperCase();
  const color = folderColor(name);
  return (
    <span
      aria-hidden
      className={cx('shrink-0 inline-flex items-center justify-center font-semibold tracking-tight', MARK_SIZES[size], className)}
      style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}
    >
      {letters}
    </span>
  );
};

// A topic's mark: the topics icon in the topic's own color
export const TopicMark: React.FC<{ name: string; size?: 'sm' | 'md' | 'lg'; className?: string }> = ({ name, size = 'md', className }) => {
  const color = folderColor(name);
  return (
    <span
      aria-hidden
      className={cx('shrink-0 inline-flex items-center justify-center', MARK_SIZES[size], className)}
      style={{ color, background: `color-mix(in srgb, ${color} 13%, transparent)` }}
    >
      <Layers className={size === 'lg' ? 'w-5 h-5' : size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'} />
    </span>
  );
};

// Phones have no sidebar and no room for another tab: the Library's header leads to Companies, and this switch at
// the top of the index pages goes between Companies, Topics, Purchases, Contracts and Taxes. It scrolls sideways
// when it is wider than the screen, the current page brought into view.
export const IndexSwitch: React.FC<{ current: 'companies' | 'topics' | 'purchases' | 'contracts' | 'taxes'; onNavigate: (to: string) => void }> = ({
  current,
  onNavigate,
}) => {
  const currentRef = React.useRef<HTMLAnchorElement>(null);
  React.useEffect(() => {
    currentRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);
  return (
    <nav aria-label="Companies, topics, purchases, contracts or taxes" className="lg:hidden mb-4 -mx-4 sm:-mx-6 px-4 sm:px-6 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="inline-flex p-0.5 rounded-lg bg-surface-2 border border-line">
        {(
          [
            ['companies', 'Companies', <Building2 key="i" className="w-3.5 h-3.5" />],
            ['topics', 'Topics', <Layers key="i" className="w-3.5 h-3.5" />],
            ['purchases', 'Purchases', <ShoppingBag key="i" className="w-3.5 h-3.5" />],
            ['contracts', 'Contracts', <FileSignature key="i" className="w-3.5 h-3.5" />],
            ['taxes', 'Taxes', <Landmark key="i" className="w-3.5 h-3.5" />],
          ] as const
        ).map(([page, label, icon]) => (
          <AppLink
            key={page}
            ref={current === page ? currentRef : undefined}
            to={pagePath(page)}
            onNavigate={onNavigate}
            aria-current={current === page ? 'page' : undefined}
            className={cx(
              'inline-flex items-center gap-1.5 h-8 px-3.5 rounded-md text-[13px] font-medium whitespace-nowrap scroll-mx-4 transition-colors',
              current === page ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink'
            )}
          >
            {icon}
            {label}
          </AppLink>
        ))}
      </div>
    </nav>
  );
};

// Older documents still waiting for their topic and timeline line (the server gives them out a batch per run)
export const TopicsPendingNote: React.FC<{ count: number; className?: string }> = ({ count, className }) =>
  count > 0 ? (
    <p className={cx('flex items-start gap-2 text-xs text-ink-3', className)}>
      <Hourglass className="w-3.5 h-3.5 mt-px shrink-0" />
      <span>Paperwork is still sorting {countLabel(count, 'older document')} into topics; this page fills in over the next runs.</span>
    </p>
  ) : null;

const KIND_ICONS: Record<DeadlineKind, LucideIcon> = { return: Undo2, warranty: ShieldCheck };
const KIND_LABELS: Record<DeadlineKind, string> = { return: 'Return', warranty: 'Warranty' };

// What a purchase's deadline is about, next to it: the last day to return it, or the end of its warranty
export const DeadlineKindLabel: React.FC<{ kind: DeadlineKind; className?: string }> = ({ kind, className }) => {
  const Icon = KIND_ICONS[kind];
  return (
    <span className={cx('inline-flex items-center gap-1 shrink-0 h-5 px-1.5 rounded-md bg-surface-2 text-[11px] font-medium text-ink-2 whitespace-nowrap', className)}>
      <Icon className="w-3 h-3 shrink-0" aria-hidden />
      {KIND_LABELS[kind]}
    </span>
  );
};

// A document's deadline on a timeline: done ones greyed and struck through; overdue in red, unless long past (most
// likely dealt with and never ticked off); within a week in amber. A purchase's return or warranty date that has
// passed is greyed too: it ended, it isn't overdue.
export const DeadlineBadge: React.FC<{ deadline: Deadline }> = ({ deadline }) => {
  const days = daysUntil(deadline.date);
  const ended = lapsed(deadline);
  const tone =
    deadline.done || ended
      ? 'bg-surface-2 text-ink-3'
      : days < -RECENT_OVERDUE_DAYS
        ? 'bg-surface-2 text-ink-2'
        : days < 0
          ? 'bg-danger/10 text-danger'
          : days <= 7
            ? 'bg-warning/12 text-warning'
            : 'bg-surface-2 text-ink-2';
  const state = deadline.done ? 'done' : ended ? 'ended' : days < 0 ? 'overdue' : 'open';
  const Icon = deadline.done ? Check : deadline.kind ? KIND_ICONS[deadline.kind] : CalendarClock;
  return (
    <span
      title={`${deadline.what} · ${formatDay(deadline.date)} (${state})`}
      className={cx('inline-flex items-center gap-1 min-w-0 max-w-full h-6 px-2 rounded-md text-xs font-medium', tone)}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" />
      <span className={cx('truncate', deadline.done && 'line-through')}>
        {formatDay(deadline.date)} · {deadline.what}
      </span>
      <span className="sr-only">({state})</span>
    </span>
  );
};
