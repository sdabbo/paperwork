// The library: search, filters, saved views, deadlines coming up, and the documents as cards or rows.
import React, { useEffect, useMemo, useState } from 'react';
import { BookmarkPlus, Building2, CalendarClock, Check, ChevronRight, CircleDashed, Copy, Files, Info, Layers, LayoutGrid, List, Plus, Search, Settings, Star, TriangleAlert, X } from 'lucide-react';
import { DOCUMENT_TYPES, DocumentType, LibraryResponse, SavedView, SearchResponse, SortKey, ViewFilters } from '../../shared/types';
import { DeadlineItem, activeFilters, applyFilters, deadlineKey, defaultOrder, facets, localToday, shiftDate, upcoming } from '../../shared/filter';
import { api } from '../lib/api';
import { SaveDeadlineDone, useDeadlineDone } from '../lib/deadlines';
import { heldBackSummary } from '../lib/duplicates';
import { chosenPlace, folderChoices } from '../lib/folders';
import { daysUntil, formatAmount } from '../lib/format';
import { isPossibleCopy, toCheckWithin } from '../lib/review';
import { companyPath, isPlainClick, pagePath, topicPath } from '../lib/router';
import { AppLink, DeadlineKindLabel } from './companyParts';
import { DeadlineWhen, DocumentCard, DocumentRow, ReviewBadge } from './DocumentCard';
import { Button, Card, Chip, ChipSelect, EmptyState, IconButton, Notice, Select, Spinner, cx } from './ui';

const LAYOUT_KEY = 'paperwork:layout';

const SORTS: { value: SortKey; label: string }[] = [
  { value: 'date', label: 'Document date' },
  { value: 'added', label: 'Recently added' },
  { value: 'title', label: 'Title' },
  { value: 'amount', label: 'Amount' },
  { value: 'due', label: 'Due date' },
];

// The server's search (by meaning, and Drive's full-text search inside the files), a moment after typing stops
function useContentSearch(query: string) {
  const [result, setResult] = useState<SearchResponse | undefined>();
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    setResult(undefined);
    // The spinner shows from the first keystroke, so "Nothing matches" doesn't flash up before the server answers
    setSearching(q.length >= 3);
    if (q.length < 3) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const body = await api<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`);
        if (!cancelled) setResult(body);
      } catch {
        // Searching inside files is a bonus; the list still filters on what Paperwork knows
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);
  return { result, searching };
}

// A deadline coming up: opens its document, with a button below to tick it off (on its own row, so a long
// date like "Overdue · Mon, Dec 28, 2025" keeps the card's full width)
const DeadlineCard: React.FC<{ item: DeadlineItem; busy: boolean; onOpen: (id: string) => void; onDone: (item: DeadlineItem) => void }> = ({
  item,
  busy,
  onOpen,
  onDone,
}) => {
  const { doc, deadline } = item;
  const overdue = daysUntil(deadline.date) < 0;
  return (
    <div
      className={cx(
        'shrink-0 w-64 flex flex-col rounded-xl border transition-colors',
        overdue ? 'border-danger/40 bg-danger/5 hover:border-danger/60' : 'bg-surface border-line hover:border-line-strong'
      )}
    >
      <button type="button" onClick={() => onOpen(doc.id)} className="flex-1 min-w-0 flex flex-col justify-start text-left px-3 pt-3 pb-2 rounded-t-xl">
        <div className="h-5 flex items-center gap-1.5 min-w-0 max-w-full">
          <DeadlineWhen date={deadline.date} className="min-w-0 max-w-full" />
          {deadline.kind && <DeadlineKindLabel kind={deadline.kind} />}
        </div>
        <div className="text-sm font-medium text-ink mt-1 line-clamp-2">{deadline.what}</div>
        <div className="flex items-center gap-1.5 min-w-0 max-w-full mt-0.5">
          <span className="text-xs text-ink-2 truncate">{doc.title}</span>
          <ReviewBadge doc={doc} />
        </div>
        <div className="text-xs text-ink-3 mt-0.5 truncate max-w-full">
          {[doc.correspondent, doc.amount !== null ? formatAmount(doc.amount, doc.currency) : null].filter(Boolean).join(' · ') || '\u00a0'}
        </div>
      </button>
      <div className="px-3 pb-3">
        <Button
          size="sm"
          className="h-7 px-2.5"
          icon={<Check className="w-3.5 h-3.5" />}
          disabled={busy}
          onClick={() => onDone(item)}
          aria-label={`Mark “${deadline.what}” as done`}
        >
          Done
        </Button>
      </div>
    </div>
  );
};

export const LibraryView: React.FC<{
  library: LibraryResponse | null;
  // How many files are kept with each document
  keptCounts: Map<string, number>;
  filters: ViewFilters;
  onFiltersChange: (f: ViewFilters) => void;
  activeView: SavedView | null;
  views: SavedView[];
  onSaveViews: (views: SavedView[]) => Promise<void>;
  onSelectView: (view: SavedView) => void;
  onOpen: (id: string) => void;
  onAdd: () => void;
  onGoToInbox: () => void;
  onShowDeadlines: () => void;
  onShowSettings: () => void;
  onShowCompanies: () => void;
  onNavigate: (to: string) => void;
  onDeadlineDone: SaveDeadlineDone;
  syncing: boolean;
}> = ({
  library,
  keptCounts,
  filters,
  onFiltersChange,
  activeView,
  views,
  onSaveViews,
  onSelectView,
  onOpen,
  onAdd,
  onGoToInbox,
  onShowDeadlines,
  onShowSettings,
  onShowCompanies,
  onNavigate,
  onDeadlineDone,
  syncing,
}) => {
  const [layout, setLayout] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const [naming, setNaming] = useState<string | null>(null);
  const documents = library?.documents ?? [];
  const { result: search, searching } = useContentSearch(filters.query ?? '');
  // Documents with the words searched for lead the results; those only related by meaning come after, apart
  const found = useMemo(() => search?.hits.filter(h => h.match !== 'meaning').map(h => h.id), [search]);
  const snippets = useMemo(() => new Map(search?.hits.filter(h => h.snippet).map(h => [h.id, h.snippet!])), [search]);
  const results = useMemo(() => applyFilters(documents, filters, found), [documents, filters, found]);
  const related = useMemo(() => {
    const rank = new Map(search?.hits.filter(h => h.match === 'meaning').map((h, i) => [h.id, i]));
    if (!rank.size) return [];
    const shown = new Set(results.map(d => d.id));
    // Within the other filters (folder, year, …), best first
    return applyFilters(
      documents.filter(d => rank.has(d.id) && !shown.has(d.id)),
      { ...filters, query: undefined }
    ).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  }, [documents, filters, results, search]);
  const f = useMemo(() => facets(documents), [documents]);
  // The categories, each followed by its folders for a matter ("Example UG / Eröffnungsbilanz")
  const folders = useMemo(() => folderChoices(library?.categories ?? [], documents), [library, documents]);
  const due = useMemo(() => upcoming(documents), [documents]);
  // A possible copy's deadlines in the same two months, not counted until the owner decides
  const held = useMemo(() => {
    const today = localToday();
    const [from, to] = [shiftDate(today, -14), shiftDate(today, 60)];
    return heldBackSummary(documents, i => i.deadline.date >= from && i.deadline.date <= to);
  }, [documents]);
  const hasDeadlines = useMemo(() => documents.some(d => d.deadlines.length > 0), [documents]);
  const { setDone, error: doneError, pending } = useDeadlineDone(onDeadlineDone);
  // The deadline just ticked off, for a moment, so a mistaken tap can be taken back
  const [justDone, setJustDone] = useState<DeadlineItem | null>(null);
  useEffect(() => {
    if (!justDone) return;
    const timer = setTimeout(() => setJustDone(null), 8000);
    return () => clearTimeout(timer);
  }, [justDone]);
  // To check within the other filters (a folder, a year, a search): what the chip lists when tapped
  const reviewCount = useMemo(() => toCheckWithin(documents, filters, found), [documents, filters, found]);
  // Possible copies of other documents among them, also those filed (review mode automatic)
  const copies = documents.filter(isPossibleCopy).length;
  // Read and described, waiting in the Inbox for the owner's check (review mode manual)
  const inInbox = documents.filter(d => d.needsReview && d.inInbox).length;
  // The documents those two are, each once (a possible copy may wait in the Inbox too)
  const flagged = documents.filter(d => (d.needsReview && d.inInbox) || isPossibleCopy(d)).length;
  // A topic counts as a filter, shown alone (from its page) or with a company (from the company page)
  const filtered = activeFilters(filters) > 0 || !!filters.query;
  // Filtered by a folder alone: the page is named after it
  const folder = library?.categories.find(c => c.id === filters.categoryId) ?? (filters.folderId ? chosenPlace(library?.categories ?? [], filters.folderId)?.folder : null);
  const title = activeView?.name ?? (activeFilters(filters) === 1 && folder ? folder.name : 'Library');
  const waiting = library?.inbox.filter(i => i.state === 'waiting').length ?? 0;
  const stuck = library?.inbox.filter(i => i.state !== 'waiting').length ?? 0;

  const set = (patch: Partial<ViewFilters>) => onFiltersChange({ ...filters, ...patch });
  const changeLayout = (l: 'grid' | 'list') => {
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      // Not remembered
    }
  };

  if (!library) {
    return (
      <div className="flex justify-center pt-24">
        <Spinner className="w-5 h-5" />
      </div>
    );
  }

  const documentList = (docs: typeof results) =>
    layout === 'grid' ? (
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
        {docs.map(d => (
          <DocumentCard key={d.id} doc={d} onOpen={onOpen} snippet={snippets.get(d.id)} query={filters.query} kept={keptCounts.get(d.id)} />
        ))}
      </div>
    ) : (
      <Card className="divide-y divide-line overflow-hidden">
        {docs.map(d => (
          <DocumentRow key={d.id} doc={d} onOpen={onOpen} snippet={snippets.get(d.id)} query={filters.query} onNavigate={onNavigate} kept={keptCounts.get(d.id)} />
        ))}
      </Card>
    );

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0 flex items-center gap-2.5">
          <img src="/icons/icon.svg" alt="" className="w-7 h-7 lg:hidden" />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight truncate">{title}</h1>
            <p className="text-sm text-ink-2">
              {filtered ? `${results.length} of ${documents.length} documents` : `${documents.length} ${documents.length === 1 ? 'document' : 'documents'}`}
              {syncing && <span className="text-ink-3"> · checking for changes…</span>}
            </p>
          </div>
        </div>
        {/* Phones have the + in the tab bar, wide screens the sidebar's button and its Companies and Settings
            links; the tab bar has no room for those two, so they are up here */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 lg:hidden">
          <div className="hidden sm:block">
            <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={onAdd}>
              Add
            </Button>
          </div>
          <a
            href={pagePath('companies')}
            onClick={e => {
              if (!isPlainClick(e)) return;
              e.preventDefault();
              onShowCompanies();
            }}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line bg-surface text-sm font-medium text-ink hover:bg-surface-2 hover:border-line-strong transition-colors"
          >
            <Building2 className="w-4 h-4 text-ink-2" />
            Companies
          </a>
          <IconButton label="Settings" onClick={onShowSettings}>
            <Settings className="w-5 h-5" />
          </IconButton>
        </div>
      </div>

      <div className="relative mb-3">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
        <input
          type="search"
          value={filters.query ?? ''}
          onChange={e => set({ query: e.target.value || undefined })}
          placeholder="Search titles, senders, amounts, and inside documents"
          // The browser's own clear button is hidden: the app shows its own (and a spinner while searching) there
          className={cx(
            'w-full h-11 pl-10 rounded-xl bg-surface border border-line text-[15px] placeholder:text-ink-3 hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 [&::-webkit-search-cancel-button]:appearance-none',
            searching ? 'pr-16' : 'pr-10'
          )}
        />
        {/* The clear button stays while the server searches, so a search can be dropped without waiting for it */}
        {filters.query && (
          <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {searching && <Spinner />}
            <IconButton label="Clear search" size="sm" onClick={() => set({ query: undefined })}>
              <X className="w-4 h-4" />
            </IconButton>
          </div>
        )}
      </div>
      {search && !search.semantic && filters.query && (
        <p className="-mt-1 mb-3 flex items-start gap-1.5 text-xs text-ink-3">
          <Info className="w-3.5 h-3.5 mt-px shrink-0" />
          Searching by meaning isn't available right now, so only documents containing your words are found.
        </p>
      )}

      <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap">
        {/* A category with all its documents, or a folder for a matter inside one with just those in it */}
        <ChipSelect
          label="Folder"
          value={filters.folderId ?? filters.categoryId}
          options={folders}
          onChange={v => {
            const category = !v || library.categories.some(c => c.id === v);
            set({ categoryId: category ? v : undefined, folderId: category ? undefined : v });
          }}
        />
        <ChipSelect<DocumentType>
          label="Type"
          value={filters.type}
          options={f.types.map(t => ({ value: t.value as DocumentType, label: DOCUMENT_TYPES[t.value as DocumentType], count: t.count }))}
          onChange={v => set({ type: v })}
        />
        <ChipSelect label="Year" value={filters.year} options={f.years.map(y => ({ value: y.value, label: y.value, count: y.count }))} onChange={v => set({ year: v })} />
        <ChipSelect
          label="From"
          value={filters.correspondent}
          options={f.correspondents.map(c => ({ value: c.value, label: c.value, count: c.count }))}
          // Topics are shared by companies: another company keeps the topic, narrowing it to that company's documents
          onChange={v => set({ correspondent: v })}
        />
        {filters.topic && (
          <Chip active onClick={() => set({ topic: undefined })} icon={<Layers className="w-3.5 h-3.5" />} title="Show all topics">
            <span className="max-w-[11rem] truncate">{filters.topic}</span>
            <X className="w-3.5 h-3.5 -mr-1" />
          </Chip>
        )}
        {filters.topic ? (
          <AppLink
            to={topicPath(filters.topic, filters.correspondent)}
            onNavigate={onNavigate}
            className="inline-flex items-center gap-1 h-8 px-2 rounded-lg text-[13px] font-medium text-accent-ink hover:underline whitespace-nowrap"
          >
            <Layers className="w-3.5 h-3.5" />
            Open topic page
          </AppLink>
        ) : (
          filters.correspondent && (
            <AppLink
              to={companyPath(filters.correspondent)}
              onNavigate={onNavigate}
              className="inline-flex items-center gap-1 h-8 px-2 rounded-lg text-[13px] font-medium text-accent-ink hover:underline whitespace-nowrap"
            >
              <Building2 className="w-3.5 h-3.5" />
              Open company page
            </AppLink>
          )
        )}
        {f.tags.length > 0 && (
          <ChipSelect
            label="Tag"
            value={filters.tags?.[0]}
            options={f.tags.map(t => ({ value: t.value, label: `#${t.value}`, count: t.count }))}
            onChange={v => set({ tags: v ? [v] : undefined })}
          />
        )}
        <Chip active={!!filters.starred} onClick={() => set({ starred: filters.starred ? undefined : true })} icon={<Star className={cx('w-3.5 h-3.5', filters.starred && 'fill-current')} />}>
          Starred
        </Chip>
        {(reviewCount > 0 || filters.review) && (
          <Chip active={!!filters.review} onClick={() => set({ review: filters.review ? undefined : true })} icon={<CircleDashed className="w-3.5 h-3.5" strokeWidth={2.5} />}>
            To check ({reviewCount})
          </Chip>
        )}
        {filtered && (
          <button className="h-8 px-2 text-[13px] text-ink-2 hover:text-ink whitespace-nowrap" onClick={() => onFiltersChange({})}>
            Clear all
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 mt-3 mb-4">
        <div className="flex items-center gap-2">
          <Select
            aria-label="Sort by"
            value={filters.sort ?? 'date'}
            onChange={e => {
              const sort = e.target.value as SortKey;
              set({ sort, order: defaultOrder(sort) });
            }}
            className="w-44"
          >
            {SORTS.map(s => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          {filtered && !activeView && (
            <Button size="md" icon={<BookmarkPlus className="w-4 h-4" />} onClick={() => setNaming('')}>
              <span className="hidden sm:inline">Save view</span>
            </Button>
          )}
        </div>
        <div className="inline-flex p-0.5 rounded-lg bg-surface-2 border border-line">
          <IconButton label="Cards" size="sm" onClick={() => changeLayout('grid')} className={cx(layout === 'grid' && 'bg-surface text-ink shadow-sm')}>
            <LayoutGrid className="w-4 h-4" />
          </IconButton>
          <IconButton label="List" size="sm" onClick={() => changeLayout('list')} className={cx(layout === 'list' && 'bg-surface text-ink shadow-sm')}>
            <List className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      {naming !== null && (
        <Card className="p-3 mb-4 flex flex-col sm:flex-row gap-2">
          <input
            autoFocus
            value={naming}
            onChange={e => setNaming(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && setNaming(null)}
            placeholder="Name of this view, e.g. Tax 2025"
            className="flex-1 h-9 px-3 rounded-lg bg-surface border border-line text-sm focus:border-accent focus:outline-none"
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={!naming.trim()}
              onClick={async () => {
                const view: SavedView = { id: crypto.randomUUID(), name: naming.trim(), filters };
                await onSaveViews([...views, view]);
                setNaming(null);
                onSelectView(view);
              }}
            >
              Save
            </Button>
            <Button onClick={() => setNaming(null)}>Cancel</Button>
          </div>
        </Card>
      )}

      {!filtered && (stuck > 0 || waiting > 0 || inInbox > 0 || copies > 0) && (
        <Notice
          tone={stuck ? 'warning' : 'neutral'}
          icon={
            stuck ? (
              <TriangleAlert className="w-4 h-4" />
            ) : waiting ? (
              <Spinner />
            ) : inInbox ? (
              <CircleDashed className="w-4 h-4 text-warning" strokeWidth={2.5} />
            ) : (
              <Copy className="w-4 h-4 text-warning" strokeWidth={2.5} />
            )
          }
          className="mb-4"
          action={
            <button className="text-sm font-medium text-accent-ink hover:underline" onClick={onGoToInbox}>
              {stuck || waiting ? 'Open Inbox' : flagged === 1 ? 'Check it' : 'Check them'}
            </button>
          }
        >
          {stuck > 0
            ? `${stuck} ${stuck === 1 ? 'file' : 'files'} in the Inbox need${stuck === 1 ? 's' : ''} your attention.`
            : waiting > 0
              ? `${waiting} new ${waiting === 1 ? 'file is' : 'files are'} being read.`
              : inInbox > 0
                ? `${inInbox} new ${inInbox === 1 ? 'document is' : 'documents are'} waiting in the Inbox for your check${copies ? `; ${copies} may be ${copies === 1 ? 'a duplicate' : 'duplicates'}` : ''}.`
                : `${copies} ${copies === 1 ? 'document may be a duplicate' : 'documents may be duplicates'}.`}
        </Notice>
      )}

      {!filtered && (due.length > 0 || hasDeadlines) && (
        <section className="mb-6">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 className="text-[13px] font-semibold text-ink-2 flex items-center gap-1.5">
              <CalendarClock className="w-4 h-4" />
              Coming up
            </h2>
            <a
              href={pagePath('deadlines')}
              onClick={e => {
                if (!isPlainClick(e)) return;
                e.preventDefault();
                onShowDeadlines();
              }}
              className="inline-flex items-center gap-0.5 text-[13px] font-medium text-accent-ink hover:underline"
            >
              All deadlines
              <ChevronRight className="w-3.5 h-3.5" />
            </a>
          </div>
          {doneError && (
            <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} className="mb-2">
              {doneError}
            </Notice>
          )}
          {justDone && !doneError && (
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
          {due.length > 0 ? (
            <div className="flex gap-3 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0">
              {due.slice(0, 10).map(item => (
                <DeadlineCard
                  key={deadlineKey(item)}
                  item={item}
                  busy={pending.has(deadlineKey(item))}
                  onOpen={onOpen}
                  onDone={async i => {
                    setJustDone(null);
                    if (await setDone(i.doc, i.deadline, true)) setJustDone(i);
                  }}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-3">Nothing is due in the next two months.</p>
          )}
          {held.count > 0 && (
            <p className="text-xs text-ink-2 mt-2">
              Not counted: {held.count === 1 ? '1 deadline' : `${held.count} deadlines`} from{' '}
              {held.copies.length === 1 ? 'a possible duplicate' : `${held.copies.length} possible duplicates`}.{' '}
              <button className="font-medium text-accent-ink hover:underline" onClick={() => (held.copies.length === 1 ? onOpen(held.copies[0].doc.id) : onGoToInbox())}>
                {held.copies.length === 1 ? 'Check it' : 'Check them'}
              </button>
            </p>
          )}
        </section>
      )}

      {documents.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Files className="w-5 h-5" />}
            title="No documents yet"
            description="Add a few to get started: upload or scan them here, save scans into the Inbox folder with the Google Drive app, or forward emails with attachments."
            action={
              <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={onAdd}>
                Add documents
              </Button>
            }
          />
        </Card>
      ) : results.length === 0 && related.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Search className="w-5 h-5" />}
            title="Nothing matches"
            description={searching ? 'Still searching inside your documents…' : 'Try fewer words or other filters.'}
            action={<Button onClick={() => onFiltersChange({})}>Clear filters</Button>}
          />
        </Card>
      ) : (
        <>
          {results.length > 0 && documentList(results)}
          {related.length > 0 && (
            <section className={results.length ? 'mt-6' : ''}>
              <h2 className="text-sm font-medium text-ink">{results.length ? 'Related by meaning' : 'No document contains these words'}</h2>
              <p className="text-sm text-ink-3 mt-0.5 mb-3">
                {results.length ? 'These don’t contain your words, but are about something similar.' : 'These are about something similar.'}
              </p>
              {documentList(related)}
            </section>
          )}
        </>
      )}
    </div>
  );
};
