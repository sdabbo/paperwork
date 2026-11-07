// One company: its open deadlines, its topics (the contracts, policies, accounts or cases its documents belong
// to) and a timeline of its documents, newest first, with a line each on what the document says or changes.
// The company can be renamed, or merged into another, in all its documents; a topic in all its documents from
// every company. A topic other companies wrote about too links to its own page, with all of them.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, CalendarClock, ChevronRight, Layers, Pencil, X } from 'lucide-react';
import type { DocumentInfo, RenameResult, ViewFilters } from '../../shared/types';
import { Company, company as findCompany, companies, countLabel, docDay, fold, gistOf, nextDeadline, yearSpan } from '../lib/companies';
import type { SaveDeadlineDone } from '../lib/deadlines';
import { daysUntil, formatDate, formatDay } from '../lib/format';
import { TopicSelection, companyPath, pagePath, selectionPath, topicPath, topicSelection } from '../lib/router';
import { TopicGroup, listNames, topics as allTopics } from '../lib/topics';
import { AppLink, CompanyMark, TopicsPendingNote } from './companyParts';
import { dueTone } from './DocumentCard';
import { RenameDialog, RenameTarget } from './RenameDialog';
import { BackLink, Flash, FlashNotice, OpenDeadlines, Timeline, renameFlash } from './timeline';
import { Button, Card, EmptyState, IconButton, Spinner, cx } from './ui';

const sameSelection = (a: TopicSelection, b: TopicSelection) =>
  a.kind === b.kind && (a.kind !== 'topic' || (b.kind === 'topic' && a.topic === b.topic));

// ---------- Topics ----------

const TopicCard: React.FC<{
  name: string;
  documents: DocumentInfo[];
  selected: boolean;
  muted?: boolean;
  // The other companies with documents in this topic: the card links to the whole topic's page
  alsoFrom?: string[];
  onSelect: () => void;
  onRename?: () => void;
  onNavigate?: (to: string) => void;
}> = ({ name, documents, selected, muted, alsoFrom = [], onSelect, onRename, onNavigate }) => {
  const latest = documents[0];
  const next = useMemo(() => nextDeadline(documents), [documents]);
  return (
    <div
      className={cx(
        'relative w-64 shrink-0 snap-start sm:w-auto flex flex-col rounded-xl border transition-colors',
        selected
          ? 'bg-accent-soft border-accent/50 ring-1 ring-accent/30'
          : cx('bg-surface hover:border-line-strong', muted ? 'border-dashed border-line-strong' : 'border-line')
      )}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cx('flex-1 w-full text-left flex flex-col gap-1 rounded-xl p-3.5', onRename && 'pr-11')}
      >
        <span className={cx('text-sm font-semibold leading-snug line-clamp-2 break-words', selected ? 'text-accent-ink' : 'text-ink')} title={name}>
          {name}
        </span>
        <span className="text-xs text-ink-3">
          {countLabel(documents.length)} · {yearSpan(documents)}
        </span>
        {latest && (
          <span className="text-xs text-ink-2 leading-snug line-clamp-2 break-words mt-1">
            <span className="text-ink-3">{formatDate(docDay(latest))}: </span>
            {gistOf(latest)}
          </span>
        )}
        {next && (
          <span className="flex items-center gap-1 min-w-0 mt-auto pt-1.5 text-xs">
            <CalendarClock className={cx('w-3.5 h-3.5 shrink-0', dueTone(next.deadline.date))} />
            <span className="truncate">
              <span className={cx('font-medium', dueTone(next.deadline.date))}>
                {daysUntil(next.deadline.date) < 0 ? 'Overdue · ' : ''}
                {formatDay(next.deadline.date)}
              </span>
              <span className="text-ink-2"> · {next.deadline.what}</span>
            </span>
          </span>
        )}
      </button>
      {alsoFrom.length > 0 && onNavigate && (
        <AppLink
          to={topicPath(name)}
          onNavigate={onNavigate}
          title={`The whole topic, also from ${listNames(alsoFrom, 4)}`}
          className={cx(
            'group flex items-start gap-1.5 min-w-0 mx-3.5 mb-2.5 -mt-1 pt-2 border-t text-xs leading-snug rounded-sm',
            selected ? 'border-accent/30' : 'border-line'
          )}
        >
          <Layers className="w-3.5 h-3.5 mt-px shrink-0 text-accent-ink" />
          <span className="min-w-0 flex-1 line-clamp-2 break-words">
            <span className="font-medium text-accent-ink group-hover:underline">Whole topic</span>
            <span className="text-ink-2"> · also from {listNames(alsoFrom)}</span>
          </span>
          <ChevronRight className="w-3.5 h-3.5 mt-px shrink-0 text-ink-3 group-hover:text-accent-ink" />
        </AppLink>
      )}
      {onRename && (
        <IconButton label={`Rename or merge “${name}”`} size="sm" className="absolute top-2 right-2" onClick={onRename}>
          <Pencil className="w-3.5 h-3.5" />
        </IconButton>
      )}
    </div>
  );
};

// A topic other companies wrote about too, shown on this company's page: a way to its whole timeline
const WholeTopicLink: React.FC<{ topic: TopicGroup; company: string; onNavigate: (to: string) => void }> = ({ topic, company, onNavigate }) => {
  const others = topic.companies.filter(c => c.name !== company);
  const count = others.reduce((n, c) => n + c.documents.length, 0) + topic.withoutSender;
  return (
    <AppLink
      to={topicPath(topic.name)}
      onNavigate={onNavigate}
      className="group flex items-center gap-3 mb-4 rounded-xl border border-accent/30 bg-accent-soft px-3.5 py-2.5 text-[13px] text-ink hover:border-accent/60 transition-colors"
    >
      <Layers className="w-4 h-4 shrink-0 text-accent-ink" />
      <span className="min-w-0 flex-1 break-words">
        This topic also has {countLabel(count)} from {listNames(others.map(c => c.name), 4)}.{' '}
        <span className="font-medium text-accent-ink group-hover:underline whitespace-nowrap">See the whole topic</span>
      </span>
      <ChevronRight className="w-4 h-4 shrink-0 text-accent-ink" />
    </AppLink>
  );
};

// ---------- The page ----------

const CompanyView: React.FC<{
  name: string;
  params: URLSearchParams;
  documents: DocumentInfo[];
  // How many files are kept with each document
  keptCounts: Map<string, number>;
  loading: boolean;
  topicsPending: number;
  onNavigate: (to: string, options?: { replace?: boolean }) => void;
  onOpen: (id: string) => void;
  onDeadlineDone: SaveDeadlineDone;
  onReload: () => Promise<unknown>;
  onShowLibrary: (filters: ViewFilters) => void;
}> = ({ name, params, documents, keptCounts, loading, topicsPending, onNavigate, onOpen, onDeadlineDone, onReload, onShowLibrary }) => {
  const data: Company | null = useMemo(() => findCompany(documents, name), [documents, name]);
  const otherCompanies = useMemo(
    () => companies(documents).filter(c => c.name !== name).map(c => ({ name: c.name, count: c.documents.length })),
    [documents, name]
  );
  // Topics are shared: each of this company's topics with all its documents, from every company
  const topicGroups = useMemo(() => new Map(allTopics(documents).map(t => [t.name, t])), [documents]);
  const selection = topicSelection(params);
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // A name typed into the address bar in other capitals: the company as it is spelled
  const spelled = useMemo(
    () => (data || loading ? null : (companies(documents).find(c => fold(c.name) === fold(name))?.name ?? null)),
    [data, loading, documents, name]
  );
  useEffect(() => {
    if (spelled) onNavigate(selectionPath(spelled, selection), { replace: true });
  }, [spelled]);

  const select = (next: TopicSelection) => onNavigate(selectionPath(name, sameSelection(next, selection) ? { kind: 'all' } : next), { replace: true });

  // On phones the topics are a row to swipe through: the one shown (from a link) is brought into view
  const selectionKey = selection.kind === 'topic' ? `t:${selection.topic}` : selection.kind;
  useEffect(() => {
    const strip = stripRef.current;
    const card = strip?.querySelector<HTMLElement>('[data-selected]');
    if (!strip || !card || strip.scrollWidth <= strip.clientWidth) return;
    const s = strip.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    if (c.left < s.left || c.right > s.right) strip.scrollLeft += c.left - s.left - 16;
  }, [selectionKey, data !== null]);

  if (!data) {
    return loading || spelled ? (
      <div className="flex justify-center pt-24">
        <Spinner className="w-5 h-5" />
      </div>
    ) : (
      <div className="max-w-4xl">
        <BackLink to={pagePath('companies')} label="Companies" onNavigate={onNavigate} />
        {flash && <FlashNotice flash={flash} onDismiss={() => setFlash(null)} />}
        <Card>
          <EmptyState
            icon={<Building2 className="w-5 h-5" />}
            title={`No documents from “${name}”`}
            description="It may have been renamed or merged into another company."
            action={
              <Button onClick={() => onNavigate(pagePath('companies'))} icon={<Building2 className="w-4 h-4" />}>
                All companies
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const topic = selection.kind === 'topic' ? data.topics.find(t => t.name === selection.topic) : undefined;
  const groups = data.topics.length + (data.other.length ? 1 : 0);
  const shown = selection.kind === 'topic' ? (topic?.documents ?? []) : selection.kind === 'other' ? data.other : data.documents;
  const title = selection.kind === 'topic' ? selection.topic : selection.kind === 'other' ? 'Other documents' : 'All documents';
  const wholeTopic = topic ? topicGroups.get(topic.name) : undefined;
  const alsoFrom = (t: string) => (topicGroups.get(t)?.companies ?? []).filter(c => c.name !== name).map(c => c.name);
  const renameTopic = (t: string) => setRenaming({ topic: t });

  // A topic is renamed in all its documents, from every company, and can be merged into any other topic
  const renamingGroup = renaming?.topic !== undefined ? topicGroups.get(renaming.topic) : undefined;
  const renameCount = renaming?.topic !== undefined ? (renamingGroup?.documents.length ?? 0) : data.documents.length;
  const renameOthers =
    renaming?.topic !== undefined
      ? [...topicGroups.values()].filter(t => t.name !== renaming.topic).map(t => ({ name: t.name, count: t.documents.length }))
      : otherCompanies;

  async function renamed(to: string, result: RenameResult) {
    const target = renaming!;
    const old = target.topic ?? target.correspondent;
    const merged = renameOthers.some(o => o.name === to);
    await onReload();
    setRenaming(null);
    setFlash(renameFlash(result, old, to, merged));
    if (!result.updated) return;
    if (target.topic === undefined) onNavigate(selectionPath(to, selection), { replace: true });
    else if (selection.kind === 'topic' && selection.topic === target.topic) onNavigate(companyPath(name, to), { replace: true });
  }

  return (
    <div className="max-w-4xl">
      <BackLink to={pagePath('companies')} label="Companies" onNavigate={onNavigate} />

      <header className="flex items-start gap-3 sm:gap-4 mb-5">
        <span className="hidden sm:block">
          <CompanyMark name={name} size="lg" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-ink leading-tight line-clamp-3 break-words" title={name}>
            {name}
          </h1>
          <p className="text-sm text-ink-2 mt-1">
            <span className="whitespace-nowrap">{countLabel(data.documents.length)}</span> · <span className="whitespace-nowrap">{yearSpan(data.documents)}</span>
            {data.topics.length > 0 && (
              <>
                {' '}
                · <span className="whitespace-nowrap">{countLabel(data.topics.length, 'topic')}</span>
              </>
            )}
          </p>
        </div>
        <Button className="shrink-0" icon={<Pencil className="w-4 h-4" />} aria-label={`Rename or merge “${name}”`} onClick={() => setRenaming({ correspondent: name })}>
          <span className="hidden sm:inline">Rename</span>
        </Button>
      </header>

      {flash && <FlashNotice flash={flash} onDismiss={() => setFlash(null)} />}
      <TopicsPendingNote count={topicsPending} className="-mt-2 mb-5" />

      <OpenDeadlines documents={data.documents} detail={data.topics.length > 0 ? 'topic' : null} onOpen={onOpen} onNavigate={onNavigate} onDeadlineDone={onDeadlineDone} />

      {data.topics.length > 0 && (
        <section className="mb-8" aria-labelledby="company-topics">
          <h2 id="company-topics" className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-2 mb-2">
            <Layers className="w-4 h-4" />
            Topics
          </h2>
          <div ref={stripRef} className="flex gap-3 overflow-x-auto snap-x pb-1 -mx-4 px-4 scroll-px-4 sm:grid sm:grid-cols-2 lg:grid-cols-3 sm:overflow-visible sm:mx-0 sm:px-0 sm:pb-0">
            {groups > 1 && (
              <TopicCard name="All documents" documents={data.documents} selected={selection.kind === 'all'} onSelect={() => select({ kind: 'all' })} />
            )}
            {data.topics.map(t => (
              <TopicCard
                key={t.name}
                name={t.name}
                documents={t.documents}
                selected={selection.kind === 'topic' && selection.topic === t.name}
                alsoFrom={alsoFrom(t.name)}
                onSelect={() => select({ kind: 'topic', topic: t.name })}
                onRename={() => renameTopic(t.name)}
                onNavigate={onNavigate}
              />
            ))}
            {data.other.length > 0 && (
              <TopicCard
                name="Other documents"
                documents={data.other}
                muted
                selected={selection.kind === 'other'}
                onSelect={() => select({ kind: 'other' })}
              />
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="company-timeline">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2 id="company-timeline" className="text-[15px] font-semibold text-ink break-words">
              {data.topics.length > 0 || selection.kind !== 'all' ? title : 'Timeline'}
            </h2>
            {shown.length > 0 && (
              <p className="text-xs text-ink-3 mt-0.5">
                {countLabel(shown.length)} · {yearSpan(shown)}
                {selection.kind === 'other' && ' · without a topic'}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {topic && (
              <Button size="sm" variant="ghost" icon={<Pencil className="w-3.5 h-3.5" />} aria-label={`Rename or merge topic “${topic.name}”`} onClick={() => renameTopic(topic.name)}>
                <span className="hidden sm:inline">Rename topic</span>
              </Button>
            )}
            {selection.kind !== 'all' && (
              <Button size="sm" variant="ghost" icon={<X className="w-3.5 h-3.5" />} onClick={() => select({ kind: 'all' })}>
                Show all
              </Button>
            )}
          </div>
        </div>

        {wholeTopic && wholeTopic.documents.length > shown.length && <WholeTopicLink topic={wholeTopic} company={name} onNavigate={onNavigate} />}

        {shown.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Layers className="w-5 h-5" />}
              title={selection.kind === 'other' ? 'No other documents' : `No documents under “${title}”`}
              description={
                selection.kind === 'other'
                  ? `Every document from ${name} belongs to a topic.`
                  : `${name} has no topic by that name (anymore). It may have been renamed or merged.`
              }
              action={<Button onClick={() => select({ kind: 'all' })}>Show all documents</Button>}
            />
          </Card>
        ) : (
          <Timeline documents={shown} detail={selection.kind === 'all' && data.topics.length > 0 ? 'topic' : null} kept={keptCounts} onOpen={onOpen} />
        )}

        <p className="mt-6 text-xs text-ink-3">
          <button
            className="inline-flex items-center gap-0.5 font-medium text-accent-ink hover:underline"
            onClick={() => onShowLibrary(selection.kind === 'topic' ? { correspondent: name, topic: selection.topic } : { correspondent: name })}
          >
            {selection.kind === 'topic' ? 'Show these documents in the Library' : 'Show all its documents in the Library'}
            <ChevronRight className="w-3.5 h-3.5" />
          </button>{' '}
          to sort them, see their pages or save a view.
        </p>
      </section>

      <RenameDialog
        target={renaming}
        count={renameCount}
        others={renameOthers}
        companies={renamingGroup?.companies.map(c => c.name)}
        here={name}
        onClose={() => setRenaming(null)}
        onRenamed={renamed}
      />
    </div>
  );
};

export default CompanyView;
