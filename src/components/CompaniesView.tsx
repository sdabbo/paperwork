// Companies: everyone the documents come from, the most recently heard from first, each leading to its page
// with its topics (contracts, policies, accounts) and a timeline of its documents.
import React, { useMemo, useState } from 'react';
import { Building2, ChevronRight, Search, X } from 'lucide-react';
import type { DocumentInfo } from '../../shared/types';
import { companies, countLabel, docDay, fold, gistOf } from '../lib/companies';
import { formatDate } from '../lib/format';
import { companyPath } from '../lib/router';
import { AppLink, CompanyMark, IndexSwitch, TopicsPendingNote } from './companyParts';
import { Card, EmptyState, IconButton, PageHeader, SegmentedControl, Spinner, cx } from './ui';

type Sort = 'recent' | 'name';

const SORT_KEY = 'paperwork:companies-sort';

const CompaniesView: React.FC<{
  documents: DocumentInfo[];
  loading: boolean;
  topicsPending: number;
  onNavigate: (to: string) => void;
}> = ({ documents, loading, topicsPending, onNavigate }) => {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(() => {
    try {
      return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'recent';
    } catch {
      return 'recent';
    }
  });
  const all = useMemo(() => companies(documents), [documents]);
  const withoutSender = useMemo(() => documents.filter(d => !d.correspondent?.trim()).length, [documents]);

  const list = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    const matching = terms.length
      ? all.filter(c => {
          const text = fold([c.name, ...c.topics.map(t => t.name)].join(' '));
          return terms.every(t => text.includes(t));
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
      <IndexSwitch current="companies" onNavigate={onNavigate} />
      <PageHeader title="Companies" description="Who your documents come from, with their contracts, policies and accounts." />
      <TopicsPendingNote count={topicsPending} className="-mt-3 mb-5" />

      {loading ? (
        <div className="flex justify-center pt-16">
          <Spinner className="w-5 h-5" />
        </div>
      ) : all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Building2 className="w-5 h-5" />}
            title="No companies yet"
            description="As Paperwork files your documents, it notes who sent each one. They are listed here, with their contracts, policies and a timeline of their letters."
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
              <input
                type="search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Find a company or topic"
                aria-label="Find a company or topic"
                className="w-full h-10 pl-9 pr-10 rounded-xl bg-surface border border-line text-sm placeholder:text-ink-3 hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 [&::-webkit-search-cancel-button]:appearance-none"
              />
              {query && (
                <IconButton label="Clear search" size="sm" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => setQuery('')}>
                  <X className="w-4 h-4" />
                </IconButton>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-ink-3 sm:hidden">
                {query ? `${list.length} of ${all.length}` : countLabel(all.length, 'company', 'companies')}
              </span>
              <SegmentedControl<Sort>
                ariaLabel="Sort companies"
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
            {query ? `${list.length} of ${countLabel(all.length, 'company', 'companies')}` : countLabel(all.length, 'company', 'companies')}
            {sort === 'recent' ? ', the most recent first' : ''}
          </p>

          {list.length === 0 ? (
            <Card>
              <EmptyState icon={<Search className="w-5 h-5" />} title="No company matches" description={`Nothing found for “${query.trim()}”. Try part of the name.`} />
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {list.map(c => {
                  const latestDay = docDay(c.latest);
                  return (
                    <li key={c.name}>
                      <AppLink
                        to={companyPath(c.name)}
                        onNavigate={onNavigate}
                        className="group flex items-start gap-3 px-4 py-3 hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
                      >
                        <CompanyMark name={c.name} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-sm font-semibold text-ink truncate" title={c.name}>
                              {c.name}
                            </span>
                            <time dateTime={latestDay} className="shrink-0 text-xs text-ink-3 tabular-nums">
                              {formatDate(latestDay)}
                            </time>
                          </div>
                          <div className="text-xs text-ink-2 truncate">
                            {countLabel(c.documents.length)}
                            {c.topics.length > 0 && (
                              <span title={c.topics.map(t => t.name).join(', ')}> · {countLabel(c.topics.length, 'topic')}</span>
                            )}
                          </div>
                          <p className="text-[13px] text-ink-2 mt-1 line-clamp-2 sm:line-clamp-1 break-words">
                            <span className="text-ink-3">Latest: </span>
                            {gistOf(c.latest)}
                          </p>
                        </div>
                        <ChevronRight className={cx('hidden sm:block w-4 h-4 mt-2.5 shrink-0 text-ink-3 group-hover:text-ink-2')} />
                      </AppLink>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
          {withoutSender > 0 && (
            <p className="text-xs text-ink-3 mt-3">
              {withoutSender === 1 ? 'One document has' : `${withoutSender} documents have`} no sender and {withoutSender === 1 ? "isn't" : "aren't"} listed.
            </p>
          )}
        </>
      )}
    </div>
  );
};

export default CompaniesView;
