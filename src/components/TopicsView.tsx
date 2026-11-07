// Topics: the matters the documents are about (contracts, cases, tax years), each with everyone who wrote about
// it, the most recent first, each leading to its page with a timeline across companies. On top, topics Gemini
// thinks are the same matter ("Example UG commercial register" from the court, "Example UG formation" from the
// notary), to merge into one or to set aside.
import React, { useEffect, useId, useMemo, useState } from 'react';
import { ChevronRight, GitMerge, Info, Layers, Search, Sparkles, TriangleAlert, X } from 'lucide-react';
import type { DocumentInfo, RenameResult, TopicMerge, TopicSuggestion, TopicSuggestions } from '../../shared/types';
import { ApiError, api } from '../lib/api';
import { countLabel, docDay, existingName, fold, gistOf, yearSpan } from '../lib/companies';
import { formatDate } from '../lib/format';
import { topicPath } from '../lib/router';
import { TopicGroup, listNames, topics as allTopics } from '../lib/topics';
import { AppLink, IndexSwitch, TopicMark, TopicsPendingNote } from './companyParts';
import { Flash, FlashNotice, renameFlash } from './timeline';
import { Button, Card, EmptyState, Field, IconButton, Notice, PageHeader, SegmentedControl, Spinner, cx, inputClass } from './ui';

type Sort = 'recent' | 'name';

const SORT_KEY = 'paperwork:topics-sort';

// As long as the server keeps a topic's name
const MAX_TOPIC = 100;

// The companies a topic's documents come from: up to three names, or two and "+N"
const CompanyNames: React.FC<{ topic: TopicGroup; className?: string }> = ({ topic, className }) => {
  const names = topic.companies.map(c => c.name);
  if (!names.length) return <span className={cx('text-ink-3', className)}>No sender</span>;
  const shown = names.length > 3 ? names.slice(0, 2) : names;
  return (
    <span className={cx('flex min-w-0', className)} title={names.join(', ')}>
      <span className="truncate">{shown.join(', ')}</span>
      {names.length > shown.length && <span className="shrink-0 text-ink-3">&nbsp;+{names.length - shown.length}</span>}
    </span>
  );
};

// ---------- Suggestions ----------

// The last suggestions, shown at once when the page is opened again while fresh ones are asked for
let remembered: TopicSuggestion[] | null = null;

type Loaded = { state: 'loading' } | { state: 'done'; suggestions: TopicSuggestion[] } | { state: 'limit' } | { state: 'failed'; error: string };

const groupKey = (s: TopicSuggestion) => JSON.stringify([...s.topics].sort());

const SuggestionItem: React.FC<{
  suggestion: TopicSuggestion;
  byName: Map<string, TopicGroup>;
  names: string[];
  listId: string;
  // Another suggestion is being merged: one at a time
  blocked: boolean;
  onNavigate: (to: string) => void;
  onMerge: (suggestion: TopicSuggestion, to: string) => Promise<void>;
  onDismiss: (suggestion: TopicSuggestion) => Promise<void>;
}> = ({ suggestion, byName, names, listId, blocked, onNavigate, onMerge, onDismiss }) => {
  const [to, setTo] = useState(suggestion.to);
  const [busy, setBusy] = useState<null | 'merge' | 'dismiss'>(null);
  const [error, setError] = useState<string | null>(null);
  const descId = useId();
  const groups = suggestion.topics.map(t => byName.get(t)).filter((t): t is TopicGroup => !!t);
  const count = groups.reduce((n, t) => n + t.documents.length, 0);
  const name = to.replace(/\s+/g, ' ').trim();
  // The documents whose topic changes: those under the chosen name keep it
  const changing = groups.filter(t => t.name !== name).reduce((n, t) => n + t.documents.length, 0);
  // A name outside the group that is already a topic: its documents join in
  const outside = names.filter(n => !suggestion.topics.includes(n));
  const { exact, similar } = existingName(outside, '', name);
  const joining = exact ? byName.get(exact) : undefined;

  async function merge(e: React.FormEvent) {
    e.preventDefault();
    if (!name || busy || blocked) return;
    setBusy('merge');
    setError(null);
    try {
      await onMerge(suggestion, name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      // Merged: the suggestion is gone by now; nothing merged: it stays, to try again
      setBusy(null);
    }
  }

  async function dismiss() {
    setBusy('dismiss');
    setError(null);
    try {
      await onDismiss(suggestion);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  return (
    <li className="px-4 py-4">
      <ul className="grid gap-2 sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]" aria-label="Topics">
        {groups.map(t => (
          <li key={t.name} className="flex items-start gap-2.5 min-w-0 rounded-lg border border-line bg-surface-2/50 px-3 py-2">
            <TopicMark name={t.name} size="sm" className="mt-px" />
            <div className="min-w-0">
              <AppLink to={topicPath(t.name)} onNavigate={onNavigate} className="text-sm font-medium text-ink hover:underline break-words">
                {t.name}
              </AppLink>
              <div className="flex gap-1 text-xs text-ink-2 min-w-0">
                <span className="shrink-0">{countLabel(t.documents.length)} ·</span>
                <CompanyNames topic={t} />
              </div>
            </div>
          </li>
        ))}
      </ul>
      {suggestion.why && (
        <p className="flex items-start gap-1.5 mt-2.5 text-[13px] text-ink-2">
          <Sparkles className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-3" />
          <span className="break-words">{suggestion.why}</span>
        </p>
      )}
      <form onSubmit={merge} className="mt-3 flex flex-col sm:flex-row sm:items-end gap-2">
        <Field label="Name for all of them" className="flex-1 min-w-0">
          <input
            className={inputClass}
            list={listId}
            maxLength={MAX_TOPIC}
            value={to}
            disabled={!!busy}
            autoComplete="off"
            onChange={e => setTo(e.target.value)}
          />
        </Field>
        <div className="flex items-center justify-end gap-2">
          <Button onClick={dismiss} loading={busy === 'dismiss'} disabled={!!busy}>
            Not the same
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={busy === 'merge'}
            disabled={!name || !!busy || blocked}
            icon={<GitMerge className="w-4 h-4" />}
            aria-describedby={descId}
          >
            Merge
          </Button>
        </div>
      </form>
      <p id={descId} className="sr-only">
        Gives all {countLabel(count)} the topic {name}
      </p>
      {busy === 'merge' ? (
        <Notice icon={<Spinner />} className="mt-3">
          Merging {countLabel(changing)} in Drive… This takes a moment for each document; keep this page open.
        </Notice>
      ) : joining ? (
        <Notice tone="accent" icon={<GitMerge className="w-4 h-4" />} className="mt-3">
          <b className="font-medium break-words">{joining.name}</b> is a topic already, with {countLabel(joining.documents.length)}. They join in too.
        </Notice>
      ) : similar ? (
        <Notice
          tone="warning"
          icon={<TriangleAlert className="w-4 h-4" />}
          className="mt-3"
          action={
            <button type="button" className="text-sm font-medium text-accent-ink hover:underline" onClick={() => setTo(similar)}>
              Use it
            </button>
          }
        >
          There is a topic called <b className="font-medium break-words">{similar}</b>. Names that differ in capitals stay apart.
        </Notice>
      ) : null}
      {error && (
        <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} className="mt-3">
          {error}
        </Notice>
      )}
    </li>
  );
};

const Suggestions: React.FC<{
  loaded: Loaded;
  byName: Map<string, TopicGroup>;
  names: string[];
  onRetry: () => void;
  onNavigate: (to: string) => void;
  onMerge: (suggestion: TopicSuggestion, to: string) => Promise<void>;
  onDismiss: (suggestion: TopicSuggestion) => Promise<void>;
}> = ({ loaded, byName, names, onRetry, onNavigate, onMerge, onDismiss }) => {
  const headingId = useId();
  const listId = useId();
  const [merging, setMerging] = useState<string | null>(null);

  if (loaded.state === 'loading') {
    return (
      <p className="flex items-center gap-2 mb-5 text-xs text-ink-3" role="status">
        <Spinner className="w-3.5 h-3.5" />
        Looking for topics that may belong together…
      </p>
    );
  }
  if (loaded.state === 'limit') {
    return (
      <p className="flex items-start gap-1.5 mb-5 text-xs text-ink-3">
        <Info className="w-3.5 h-3.5 mt-px shrink-0" />
        Suggestions for topics that belong together are back tomorrow: today's AI budget is used up.
      </p>
    );
  }
  if (loaded.state === 'failed') {
    return (
      <p className="flex items-start gap-1.5 mb-5 text-xs text-ink-3">
        <Info className="w-3.5 h-3.5 mt-px shrink-0" />
        <span>
          Paperwork couldn't look for topics that belong together just now.{' '}
          <button className="font-medium text-accent-ink hover:underline" onClick={onRetry}>
            Try again
          </button>
        </span>
      </p>
    );
  }
  // Only what still applies: topics renamed or merged meanwhile drop out, and a group needs two topics left
  const shown = loaded.suggestions
    .map(s => ({ ...s, topics: s.topics.filter(t => byName.has(t)) }))
    .filter(s => s.topics.length > 1);
  if (!shown.length) return null;

  return (
    <section aria-labelledby={headingId} className="mb-6">
      <Card className="overflow-hidden border-accent/30">
        <div className="flex items-start gap-3 px-4 py-3 border-b border-line bg-accent-soft/60">
          <GitMerge className="w-4 h-4 mt-0.5 shrink-0 text-accent-ink" />
          <div className="min-w-0">
            <h2 id={headingId} className="text-sm font-semibold text-ink">
              Topics that may belong together
              {shown.length > 1 && <span className="ml-1.5 font-normal text-ink-3 tabular-nums">{shown.length}</span>}
            </h2>
            <p className="text-xs text-ink-2 mt-0.5">
              They look like the same matter, from different senders. Merging gives all their documents one topic, in Drive too.
            </p>
          </div>
        </div>
        <ul className="divide-y divide-line">
          {shown.map(s => (
            <SuggestionItem
              key={groupKey(s)}
              suggestion={s}
              byName={byName}
              names={names}
              listId={listId}
              blocked={merging !== null && merging !== groupKey(s)}
              onNavigate={onNavigate}
              onMerge={async (suggestion, to) => {
                setMerging(groupKey(suggestion));
                try {
                  await onMerge(suggestion, to);
                } finally {
                  setMerging(null);
                }
              }}
              onDismiss={onDismiss}
            />
          ))}
        </ul>
      </Card>
      <datalist id={listId}>
        {names.map(n => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </section>
  );
};

// ---------- The page ----------

const TopicsView: React.FC<{
  documents: DocumentInfo[];
  loading: boolean;
  topicsPending: number;
  onNavigate: (to: string) => void;
  onReload: () => Promise<unknown>;
}> = ({ documents, loading, topicsPending, onNavigate, onReload }) => {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(() => {
    try {
      return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'recent';
    } catch {
      return 'recent';
    }
  });
  const all = useMemo(() => allTopics(documents), [documents]);
  const byName = useMemo(() => new Map(all.map(t => [t.name, t])), [all]);
  const names = useMemo(() => all.map(t => t.name).sort((a, b) => a.localeCompare(b)), [all]);
  const withoutTopic = useMemo(() => documents.filter(d => !d.topic?.trim()).length, [documents]);
  const [loaded, setLoaded] = useState<Loaded>(() => (remembered ? { state: 'done', suggestions: remembered } : { state: 'loading' }));
  const [attempt, setAttempt] = useState(0);
  const [flash, setFlash] = useState<(Flash & { topic: string | null }) | null>(null);

  // Asked for once the page is open, without holding it up: the first time after topics changed takes a while
  useEffect(() => {
    let cancelled = false;
    api<TopicSuggestions>('/api/topics/suggestions')
      .then(result => {
        if (cancelled) return;
        remembered = result.suggestions ?? [];
        setLoaded({ state: 'done', suggestions: remembered });
      })
      .catch(err => {
        if (cancelled) return;
        // What was shown stays when only the refresh failed
        if (remembered) return;
        setLoaded(err instanceof ApiError && err.status === 429 ? { state: 'limit' } : { state: 'failed', error: (err as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const drop = (suggestion: TopicSuggestion) => {
    const gone = new Set(suggestion.topics);
    // Suggestions sharing a topic with this one were about the topics as they were
    remembered = (remembered ?? []).filter(s => !s.topics.some(t => gone.has(t)));
    setLoaded({ state: 'done', suggestions: remembered });
  };

  async function merge(suggestion: TopicSuggestion, to: string) {
    const from = suggestion.topics.filter(t => byName.has(t));
    const body: TopicMerge = { from, to };
    const result = await api<RenameResult>('/api/topics/merge', { method: 'POST', body });
    await onReload();
    if (result.updated) drop(suggestion);
    const f = renameFlash(result, listNames(from.filter(t => t !== to)), to, true);
    setFlash({ ...f, topic: result.updated ? to : null });
  }

  async function dismiss(suggestion: TopicSuggestion) {
    await api<void>('/api/topics/suggestions/dismiss', { method: 'POST', body: { topics: suggestion.topics } });
    // Kept apart from now on: not suggested again
    remembered = (remembered ?? []).filter(s => groupKey(s) !== groupKey(suggestion));
    setLoaded({ state: 'done', suggestions: remembered });
  }

  const list = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    const matching = terms.length
      ? all.filter(t => {
          const text = fold([t.name, ...t.companies.map(c => c.name)].join(' '));
          return terms.every(term => text.includes(term));
        })
      : all;
    return [...matching].sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : docDay(b.latest).localeCompare(docDay(a.latest)) || a.name.localeCompare(b.name)
    );
  }, [all, query, sort]);

  const changeSort = (s: Sort) => {
    setSort(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      // Not remembered
    }
  };

  return (
    <div className="max-w-4xl">
      <IndexSwitch current="topics" onNavigate={onNavigate} />
      <PageHeader title="Topics" description="What your documents are about: contracts, cases and tax years, with everyone who wrote about them." />
      <TopicsPendingNote count={topicsPending} className="-mt-3 mb-5" />

      {flash && (
        <FlashNotice
          flash={flash}
          onDismiss={() => setFlash(null)}
          action={
            flash.topic && (
              <AppLink to={topicPath(flash.topic)} onNavigate={onNavigate} className="inline-flex items-center font-medium text-accent-ink hover:underline whitespace-nowrap">
                Open the topic
                <ChevronRight className="w-3.5 h-3.5" />
              </AppLink>
            )
          }
        />
      )}

      {loading ? (
        <div className="flex justify-center pt-16">
          <Spinner className="w-5 h-5" />
        </div>
      ) : all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Layers className="w-5 h-5" />}
            title="No topics yet"
            description="As Paperwork files your documents, it puts those about the same matter (a contract, a case, a tax year) under one topic, whoever sent them. They are listed here, each with a timeline."
          />
        </Card>
      ) : (
        <>
          <Suggestions
            loaded={loaded}
            byName={byName}
            names={names}
            onRetry={() => {
              setLoaded({ state: 'loading' });
              setAttempt(a => a + 1);
            }}
            onNavigate={onNavigate}
            onMerge={merge}
            onDismiss={dismiss}
          />

          <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Find a topic or company"
                aria-label="Find a topic or company"
                className="w-full h-10 pl-9 pr-10 rounded-xl bg-surface border border-line text-sm placeholder:text-ink-3 hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 [&::-webkit-search-cancel-button]:appearance-none"
              />
              {query && (
                <IconButton label="Clear search" size="sm" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => setQuery('')}>
                  <X className="w-4 h-4" />
                </IconButton>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-ink-3 sm:hidden">{query ? `${list.length} of ${all.length}` : countLabel(all.length, 'topic')}</span>
              <SegmentedControl<Sort>
                ariaLabel="Sort topics"
                value={sort}
                onChange={changeSort}
                options={[
                  { value: 'recent', label: 'Recent' },
                  { value: 'name', label: 'A–Z' },
                ]}
              />
            </div>
          </div>
          <p className="hidden sm:block text-xs text-ink-3 mb-2">
            {query ? `${list.length} of ${countLabel(all.length, 'topic')}` : countLabel(all.length, 'topic')}
            {sort === 'recent' ? ', the most recent first' : ''}
          </p>

          {list.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Search className="w-5 h-5" />}
                title="No topic matches"
                description={`Nothing found for “${query.trim()}”. Try part of the topic's name, or a company it is from.`}
              />
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {list.map(t => {
                  const latestDay = docDay(t.latest);
                  return (
                    <li key={t.name}>
                      <AppLink
                        to={topicPath(t.name)}
                        onNavigate={onNavigate}
                        className="group flex items-start gap-3 px-4 py-3 hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
                      >
                        <TopicMark name={t.name} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-sm font-semibold text-ink truncate" title={t.name}>
                              {t.name}
                            </span>
                            <time dateTime={latestDay} className="shrink-0 text-xs text-ink-3 tabular-nums">
                              {formatDate(latestDay)}
                            </time>
                          </div>
                          <div className="text-xs text-ink-2 sm:flex sm:items-baseline sm:gap-1.5 min-w-0">
                            <span className="shrink-0 whitespace-nowrap">
                              {countLabel(t.documents.length)} · {yearSpan(t.documents)}
                            </span>
                            <span aria-hidden className="hidden sm:inline text-ink-3">
                              ·
                            </span>
                            <CompanyNames topic={t} />
                          </div>
                          <p className="text-[13px] text-ink-2 mt-1 line-clamp-2 sm:line-clamp-1 break-words">
                            <span className="text-ink-3">Latest: </span>
                            {gistOf(t.latest)}
                          </p>
                        </div>
                        <ChevronRight className="hidden sm:block w-4 h-4 mt-2.5 shrink-0 text-ink-3 group-hover:text-ink-2" />
                      </AppLink>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
          {withoutTopic > 0 && (
            <p className="text-xs text-ink-3 mt-3">
              {withoutTopic === 1 ? 'One document belongs' : `${withoutTopic} documents belong`} to no topic (one-off letters) and{' '}
              {withoutTopic === 1 ? "isn't" : "aren't"} listed.
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default TopicsView;
