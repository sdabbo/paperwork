// Contracts: the household's insurance policies, energy, phone and internet contracts, rent, loans, subscriptions
// and memberships, as Paperwork's AI read them from the documents' topics (server/contracts.ts, one topic is one
// contract). On top, what the active ones cost together and those that can be cancelled soon; then all of them by
// kind, each with its price, when it renews and by when it can be cancelled, leading to its topic's page. Topics
// not read yet are read a batch at a time while the page is open.
import React, { useEffect, useId, useMemo, useState } from 'react';
import { Ban, CalendarClock, ChevronRight, EyeOff, FileSignature, FileText, RefreshCw, Repeat, Sparkles, TriangleAlert } from 'lucide-react';
import type { Contract, ContractsResponse, DocumentInfo } from '../../shared/types';
import { localToday } from '../../shared/filter';
import { api } from '../lib/api';
import { countLabel } from '../lib/companies';
import { INTERVAL_LABELS, Total, anyMonth, byKind, cancelIsSoon, cancelSoon, ended, monthly, summary } from '../lib/contracts';
import { formatAmount, formatDate, formatDay, formatShortDate, relativeDay } from '../lib/format';
import { topicPath } from '../lib/router';
import { AppLink, IndexSwitch } from './companyParts';
import { dueTone } from './DocumentCard';
import { Badge, Button, Card, EmptyState, IconButton, Notice, PageHeader, SectionTitle, Spinner, Stat, cx } from './ui';

// What was read last, shown at once when the page is opened again while it is asked for anew
let remembered: ContractsResponse | null = null;

// "642.24 € + 120.00 CHF"
const amounts = (totals: Total[]) => totals.map(t => formatAmount(t.yearly, t.currency)).join(' + ');

const Price: React.FC<{ contract: Contract }> = ({ contract: c }) =>
  c.amount === null ? (
    <div className="shrink-0 text-xs text-ink-3 pt-0.5">No price</div>
  ) : (
    <div className="shrink-0 max-w-[50%] text-right">
      <div className="text-sm text-ink tabular-nums">
        <span className="font-medium">{formatAmount(c.amount, c.currency)}</span>
        {c.interval && <span className="text-ink-2"> {INTERVAL_LABELS[c.interval]}</span>}
      </div>
      {c.interval !== 'year' && c.yearly !== null && (
        <div className="text-xs text-ink-3 tabular-nums">
          {formatAmount(c.yearly, c.currency)} {INTERVAL_LABELS.year}
        </div>
      )}
    </div>
  );

// Where it stands: cancelled or ended, or by when it can be cancelled and when it renews
const Terms: React.FC<{ contract: Contract; today: string }> = ({ contract: c, today }) => {
  const parts: React.ReactNode[] = [];
  if (c.status === 'cancelled') {
    parts.push(
      <Badge key="status">
        <Ban className="w-3 h-3 shrink-0" aria-hidden />
        {c.endsOn ? `Cancelled, ends ${formatDate(c.endsOn)}` : 'Cancelled'}
      </Badge>
    );
  } else if (c.status === 'ended') {
    parts.push(<Badge key="status">{c.endsOn ? `Ended ${formatDate(c.endsOn)}` : 'Ended'}</Badge>);
  } else if (anyMonth(c, today)) {
    parts.push(
      <Badge key="month">
        <Repeat className="w-3 h-3 shrink-0" aria-hidden />
        Cancel any month
      </Badge>
    );
  } else {
    if (c.cancelBy) {
      parts.push(
        <Badge key="cancel" tone={cancelIsSoon(c, today) ? 'warning' : 'neutral'}>
          <CalendarClock className="w-3 h-3 shrink-0" aria-hidden />
          Cancel by {formatShortDate(c.cancelBy)}
        </Badge>
      );
    }
    if (c.renews) {
      parts.push(
        <Badge key="renews">
          <RefreshCw className="w-3 h-3 shrink-0" aria-hidden />
          {/* Past its minimum term it goes on month by month */}
          {c.renewal === 'month' ? `Monthly from ${formatShortDate(c.renews)}` : `Renews ${formatShortDate(c.renews)}`}
        </Badge>
      );
    }
  }
  // The notice period, where no date says it already
  if (c.status === 'active' && c.notice && (anyMonth(c, today) || !c.cancelBy)) {
    parts.push(
      <span key="notice" className="text-xs text-ink-3 break-words">
        Notice: {c.notice}
      </span>
    );
  }
  return parts.length ? <div className="flex flex-wrap items-center gap-1.5 mt-1.5">{parts}</div> : null;
};

const ContractRow: React.FC<{
  contract: Contract;
  today: string;
  source: DocumentInfo | undefined;
  busy: boolean;
  error: string | null;
  onHide: () => void;
  onOpen: (id: string) => void;
  onNavigate: (to: string) => void;
}> = ({ contract: c, today, source, busy, error, onHide, onOpen, onNavigate }) => {
  const by = [c.provider, c.reference].filter(Boolean).join(' · ');
  return (
    // The whole row lights up while the pointer is on its link
    <li className="has-[>a:hover]:bg-surface-2 transition-colors">
      <AppLink to={topicPath(c.topic)} onNavigate={onNavigate} className="block px-4 pt-3 pb-1.5 focus-visible:-outline-offset-2">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink break-words">{c.name}</div>
            {by && <div className="text-xs text-ink-3 mt-0.5 break-words">{by}</div>}
          </div>
          <Price contract={c} />
        </div>
        <Terms contract={c} today={today} />
        {c.latest && (
          <p className="text-[13px] text-ink-2 mt-1.5 break-words">
            <span className="text-ink-3">Latest: </span>
            {c.latest}
          </p>
        )}
      </AppLink>
      <div className="flex items-center gap-2 pl-4 pr-2 pb-1.5">
        {source && (
          <button
            type="button"
            onClick={() => onOpen(source.id)}
            title={`Open ${source.title}`}
            className="inline-flex items-center gap-1 min-w-0 h-8 text-xs font-medium text-accent-ink hover:underline"
          >
            <FileText className="w-3.5 h-3.5 shrink-0" aria-hidden />
            <span className="truncate">{source.title}</span>
          </button>
        )}
        <IconButton label="Not a contract" size="sm" className="ml-auto shrink-0" disabled={busy} onClick={onHide}>
          {busy ? <Spinner /> : <EyeOff className="w-4 h-4" />}
        </IconButton>
      </div>
      {error && <p className="px-4 pb-3 text-xs text-danger break-words">Couldn’t hide it: {error}</p>}
    </li>
  );
};

// A contract hidden on this visit, in its place until the page is left, to take it back
const HiddenRow: React.FC<{ contract: Contract; busy: boolean; error: string | null; onUndo: () => void }> = ({ contract, busy, error, onUndo }) => (
  <li className="px-4 py-2.5">
    <div className="flex items-center gap-3">
      <EyeOff className="w-4 h-4 shrink-0 text-ink-3" aria-hidden />
      <p className="min-w-0 flex-1 text-[13px] text-ink-2 break-words">
        <span className="font-medium text-ink">{contract.name}</span> is hidden as not a contract.
      </p>
      <Button size="sm" variant="ghost" loading={busy} onClick={onUndo}>
        Undo
      </Button>
    </div>
    {error && <p className="mt-1 text-xs text-danger break-words">Couldn’t show it again: {error}</p>}
  </li>
);

// A heading that shows or hides what follows it
const Disclosure: React.FC<{ open: boolean; onToggle: () => void; controls: string; className?: string; children: React.ReactNode }> = ({
  open,
  onToggle,
  controls,
  className,
  children,
}) => (
  <button type="button" aria-expanded={open} aria-controls={controls} onClick={onToggle} className={cx('inline-flex items-center gap-1.5 -ml-1 pl-1 pr-2 h-8 rounded-md hover:bg-surface-2 transition-colors', className)}>
    <ChevronRight className={cx('w-4 h-4 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} aria-hidden />
    {children}
  </button>
);

type Failure = { topic: string; message: string };

const ContractsView: React.FC<{ documents: DocumentInfo[]; onOpen: (id: string) => void; onNavigate: (to: string) => void }> = ({
  documents,
  onOpen,
  onNavigate,
}) => {
  const [data, setData] = useState<ContractsResponse | null>(remembered);
  // Asking for the contracts, and reading topics while some are pending
  const [running, setRunning] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by Try again to ask once more
  const [attempt, setAttempt] = useState(0);
  // Contracts hidden on this visit: they keep their place, to undo
  const [hiding, setHiding] = useState<ReadonlyMap<string, Contract>>(() => new Map());
  // Topics on their way to being hidden or shown again
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [failed, setFailed] = useState<Failure | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const ids = useId();
  const today = localToday();

  const show = (response: ContractsResponse) => {
    remembered = response;
    setData(response);
  };

  // What has been read so far, then the topics still pending, a batch per request, until none are left, reading
  // stops (a problem, or nothing more could be read) or the page is left
  useEffect(() => {
    let cancelled = false;
    setRunning(true);
    setError(null);
    (async () => {
      let step = 'load';
      try {
        let current = await api<ContractsResponse>('/api/contracts');
        if (cancelled) return;
        show(current);
        step = 'read';
        while (current.pending > 0 && !current.problem) {
          const next = await api<ContractsResponse>('/api/contracts/refresh', { method: 'POST' });
          if (cancelled) return;
          show(next);
          if (next.pending >= current.pending) break;
          current = next;
        }
      } catch (err) {
        if (cancelled) return;
        const message = (err as Error).message;
        setError(step === 'load' ? `Your contracts couldn’t be loaded: ${message}` : `Reading your topics stopped: ${message}`);
      } finally {
        if (!cancelled) setRunning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = () => setAttempt(n => n + 1);

  async function setHidden(topic: string, hidden: boolean, contract?: Contract) {
    setBusy(b => new Set(b).add(topic));
    setFailed(null);
    try {
      const response = await api<ContractsResponse>('/api/contracts/hidden', { method: 'POST', body: { topic, hidden } });
      setHiding(h => {
        const next = new Map(h);
        if (hidden && contract) next.set(topic, contract);
        else next.delete(topic);
        return next;
      });
      show(response);
      // A topic hidden before it was read is read now
      if (!hidden && response.pending > 0) retry();
    } catch (err) {
      setFailed({ topic, message: (err as Error).message });
    } finally {
      setBusy(b => {
        const next = new Set(b);
        next.delete(topic);
        return next;
      });
    }
  }

  const byId = useMemo(() => new Map(documents.map(d => [d.id, d])), [documents]);
  const lists = useMemo(() => {
    const shown = (data?.contracts ?? []).filter(c => !hiding.has(c.topic));
    // Those hidden on this visit stay in their place (they aren't counted)
    const all = [...shown, ...hiding.values()];
    return {
      all,
      summary: summary(shown),
      soon: cancelSoon(shown, today),
      groups: byKind(all, new Set(hiding.keys())),
      ended: ended(all),
    };
  }, [data, hiding, today]);

  const errorFor = (topic: string) => (failed?.topic === topic ? failed.message : null);
  const row = (c: Contract) =>
    hiding.has(c.topic) ? (
      <HiddenRow key={c.topic} contract={c} busy={busy.has(c.topic)} error={errorFor(c.topic)} onUndo={() => setHidden(c.topic, false)} />
    ) : (
      <ContractRow
        key={c.topic}
        contract={c}
        today={today}
        source={byId.get(c.documentIds[0])}
        busy={busy.has(c.topic)}
        error={errorFor(c.topic)}
        onHide={() => setHidden(c.topic, true, c)}
        onOpen={onOpen}
        onNavigate={onNavigate}
      />
    );

  const pending = data?.pending ?? 0;
  // Nothing found so far, while topics wait to be read (the first visit)
  const looking = !!data && lists.all.length === 0 && pending > 0;
  const tryAgain = (
    <button className="text-sm font-medium underline" onClick={retry}>
      Try again
    </button>
  );

  return (
    <div className="max-w-4xl">
      <IndexSwitch current="contracts" onNavigate={onNavigate} />
      <PageHeader title="Contracts" description="Insurance, energy, phone, rent and subscriptions: what each costs, when it renews and by when you can cancel it." />

      {/* Always there while the page is, so that its changes are read out */}
      <div aria-live="polite">
        {data && !looking && pending > 0 && running ? (
          <p className="flex items-center gap-2 -mt-3 mb-5 text-xs text-ink-3">
            <Spinner className="w-3.5 h-3.5" />
            Reading your topics… {pending} to go
          </p>
        ) : data && !looking && pending > 0 && !data.problem && !error ? (
          <p className="-mt-3 mb-5 text-xs text-ink-3">
            {countLabel(pending, 'topic')} not read yet.{' '}
            <button className="font-medium text-accent-ink hover:underline" onClick={retry}>
              Read {pending === 1 ? 'it' : 'them'}
            </button>
          </p>
        ) : null}
      </div>

      {error && (
        <Notice tone="danger" icon={<TriangleAlert className="w-4 h-4" />} action={!running && tryAgain} className="mb-5">
          <span className="break-words">{error}</span>
        </Notice>
      )}
      {data?.problem && (
        <Notice tone="warning" icon={<TriangleAlert className="w-4 h-4" />} action={!running && tryAgain} className="mb-5">
          <span className="break-words">{data.problem}</span>
        </Notice>
      )}

      {!data ? (
        running && (
          <div className="flex justify-center pt-16">
            <Spinner className="w-5 h-5" />
          </div>
        )
      ) : looking ? (
        <Card>
          <EmptyState
            icon={running ? <Spinner className="w-5 h-5" /> : <FileSignature className="w-5 h-5" />}
            title={running ? 'Looking for your contracts' : 'No contracts found yet'}
            description={
              <>
                {running
                  ? 'Paperwork is reading the topics of your documents to find your contracts. The first time, this takes a minute.'
                  : 'Paperwork finds your contracts by reading the topics of your documents.'}
                <span className="block mt-2 text-xs text-ink-3" aria-live="polite">
                  {running ? `${pending} ${pending === 1 ? 'topic' : 'topics'} to go` : `${countLabel(pending, 'topic')} not read yet.`}
                </span>
              </>
            }
            action={
              !running &&
              !data.problem &&
              !error && (
                <Button icon={<RefreshCw className="w-4 h-4" />} onClick={retry}>
                  Read {pending === 1 ? 'it' : 'them'}
                </Button>
              )
            }
          />
        </Card>
      ) : lists.all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileSignature className="w-5 h-5" />}
            title="No contracts found"
            description="Paperwork finds contracts among the topics of your documents: insurance policies, energy and phone contracts, rent, loans, subscriptions and memberships. Add the policy or a recent letter about one, and it appears here."
          />
        </Card>
      ) : (
        <>
          {lists.summary.count > 0 && (
            <section aria-label="What your active contracts cost">
              <Card className="grid grid-cols-3 gap-3 px-4 py-3.5 mb-6">
                <Stat
                  label="A year"
                  value={lists.summary.totals.length ? lists.summary.totals.map(t => <div key={t.currency ?? ''}>{formatAmount(t.yearly, t.currency)}</div>) : '–'}
                />
                <Stat
                  label="A month"
                  value={lists.summary.totals.length ? lists.summary.totals.map(t => <div key={t.currency ?? ''}>{formatAmount(monthly(t).yearly, t.currency)}</div>) : '–'}
                />
                <Stat
                  label="Active contracts"
                  value={lists.summary.count}
                  // Kept together when it wraps on a phone
                  hint={lists.summary.unpriced > 0 && `${lists.summary.unpriced} without a\u00a0price`}
                />
              </Card>
            </section>
          )}

          {lists.soon.length > 0 && (
            <section className="mb-6" aria-labelledby={`${ids}-soon`}>
              <h2 id={`${ids}-soon`} className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
                <CalendarClock className="w-4 h-4 text-warning" aria-hidden />
                Cancel soon
                <span className="text-xs font-normal text-ink-3 tabular-nums">{lists.soon.length}</span>
              </h2>
              <p className="text-xs text-ink-3 mt-0.5 mb-2">The last days to cancel before these run on: a chance to compare and switch.</p>
              <Card className="overflow-hidden">
                <ul className="divide-y divide-line">
                  {lists.soon.map(c => (
                    <li key={c.topic}>
                      <AppLink
                        to={topicPath(c.topic)}
                        onNavigate={onNavigate}
                        className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-ink break-words">
                            {c.name}
                            {c.provider && <span className="font-normal text-ink-3"> · {c.provider}</span>}
                          </div>
                          <div className={cx('text-xs font-medium mt-0.5', dueTone(c.cancelBy!))}>
                            Cancel by {formatDay(c.cancelBy!)} · {relativeDay(c.cancelBy!)}
                          </div>
                        </div>
                        {c.yearly !== null && (
                          <div className="shrink-0 text-right">
                            <div className="text-sm font-medium text-ink tabular-nums">{formatAmount(c.yearly, c.currency)}</div>
                            <div className="text-xs text-ink-3">{INTERVAL_LABELS.year}</div>
                          </div>
                        )}
                      </AppLink>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}

          {lists.groups.map(g => (
            <section key={g.kind} className="mb-6" aria-labelledby={`${ids}-${g.kind}`}>
              <SectionTitle className="mb-2" aside={g.totals.length > 0 && <span className="text-xs tabular-nums">{amounts(g.totals)} {INTERVAL_LABELS.year}</span>}>
                <span id={`${ids}-${g.kind}`} className="flex items-center gap-1.5">
                  {g.label}
                  <span className="text-xs font-normal text-ink-3 tabular-nums">{g.contracts.filter(c => !hiding.has(c.topic)).length}</span>
                </span>
              </SectionTitle>
              <Card className="overflow-hidden">
                <ul className="divide-y divide-line">{g.contracts.map(row)}</ul>
              </Card>
            </section>
          ))}

          {lists.ended.length > 0 && (
            <section className="mb-6">
              <h2 className="text-[15px] font-semibold text-ink mb-2">
                <Disclosure open={showEnded} onToggle={() => setShowEnded(!showEnded)} controls={`${ids}-ended`}>
                  Ended
                  <span className="text-xs font-normal text-ink-3 tabular-nums">{lists.ended.length}</span>
                </Disclosure>
              </h2>
              <div id={`${ids}-ended`} hidden={!showEnded}>
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-line">{lists.ended.map(row)}</ul>
                </Card>
              </div>
            </section>
          )}
        </>
      )}

      {data && data.hidden.length > 0 && (
        <section className="mt-6">
          <Disclosure open={showHidden} onToggle={() => setShowHidden(!showHidden)} controls={`${ids}-hidden`} className="text-[13px] font-medium text-ink-2">
            <EyeOff className="w-3.5 h-3.5 shrink-0" aria-hidden />
            {data.hidden.length === 1 ? '1 topic hidden as not a contract' : `${data.hidden.length} topics hidden as not contracts`}
          </Disclosure>
          <div id={`${ids}-hidden`} hidden={!showHidden} className="mt-2">
            <Card className="overflow-hidden">
              <ul className="divide-y divide-line">
                {data.hidden.map(topic => (
                  <li key={topic} className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <AppLink to={topicPath(topic)} onNavigate={onNavigate} className="min-w-0 flex-1 text-sm text-ink break-words hover:underline">
                        {topic}
                      </AppLink>
                      <Button size="sm" loading={busy.has(topic)} onClick={() => setHidden(topic, false)}>
                        It is a contract
                      </Button>
                    </div>
                    {errorFor(topic) && <p className="mt-1 text-xs text-danger break-words">Couldn’t show it again: {errorFor(topic)}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </section>
      )}

      {data && lists.all.length > 0 && (
        <p className="flex items-start gap-2 text-xs text-ink-3 mt-6">
          <Sparkles className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
          <span>Paperwork’s AI read these from your documents. Open a contract to see all its documents.</span>
        </p>
      )}
    </div>
  );
};

export default ContractsView;
