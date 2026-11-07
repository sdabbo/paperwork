// Taxes: what the household's income tax return for one year needs, for filing it by hand in ELSTER. Paperwork's
// AI picks the year's documents that matter (server/taxes.ts), sorts them by the ELSTER form they go into and reads
// the figures to type in, each with a copy button; it also lists documents that are probably missing. A year is
// read the first time it is opened, and can be read again when its documents change.
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Copy, FileQuestionMark, FileSearch, FileText, Info, Landmark, RefreshCw, TriangleAlert } from 'lucide-react';
import type { DocumentInfo, TaxEntry, TaxFigure, TaxResponse, TaxSection, TaxYear } from '../../shared/types';
import { ApiError, api } from '../lib/api';
import { countLabel, docDay } from '../lib/companies';
import { formatDate } from '../lib/format';
import { pagePath } from '../lib/router';
import { defaultYear, formAbout, typedValue, yearParam } from '../lib/taxes';
import { IndexSwitch } from './companyParts';
import { Badge, Button, Card, EmptyState, IconButton, Notice, PageHeader, SegmentedControl, Spinner } from './ui';

const PREFILLED = 'ELSTER’s pre-filled return (Belegabruf) has these figures already: you only check them.';

const PrefilledBadge: React.FC = () => (
  <span title={PREFILLED} className="inline-flex">
    <Badge tone="accent">
      <Landmark className="w-3 h-3 shrink-0" aria-hidden />
      ELSTER fills this in
    </Badge>
  </span>
);

// One figure to type in: its label as printed on the document, its value, and a button that copies the value as
// ELSTER takes it (an amount without its currency)
const FigureRow: React.FC<{ figure: TaxFigure }> = ({ figure }) => {
  const typed = typedValue(figure.value);
  const [copied, setCopied] = useState<null | 'done' | 'failed'>(null);
  const valueRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), copied === 'done' ? 1500 : 4000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(typed);
      setCopied('done');
    } catch {
      // No clipboard here, or it was refused: the value is selected so it can be copied by hand
      if (valueRef.current) window.getSelection()?.selectAllChildren(valueRef.current);
      setCopied('failed');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 py-1">
      <dt className="flex-1 basis-40 min-w-0 py-1 text-[13px] text-ink-2 break-words">{figure.label}</dt>
      <dd className="ml-auto flex items-center gap-1 min-w-0 max-w-full -mr-1.5">
        <span ref={valueRef} className="min-w-0 text-sm font-medium text-ink tabular-nums text-right break-words">
          {figure.value}
        </span>
        <span className="relative shrink-0">
          <IconButton label={`${copied === 'done' ? 'Copied' : 'Copy'} ${typed}`} size="sm" onClick={copy}>
            {copied === 'done' ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
          </IconButton>
          <span aria-live="polite" className="absolute bottom-full right-0 mb-1 z-10 pointer-events-none">
            {copied && (
              <span className="block px-1.5 py-0.5 rounded-md bg-primary text-primary-fg text-[11px] font-medium whitespace-nowrap shadow-sm">
                {copied === 'done' ? 'Copied' : 'Selected: copy it by hand'}
              </span>
            )}
          </span>
        </span>
      </dd>
    </div>
  );
};

// A document for the return: what it is for, the document itself (opens it), and the figures to enter from it.
// From a tablet's width up the figures stand beside the rest, like the form they go into.
const EntryItem: React.FC<{ entry: TaxEntry; doc: DocumentInfo | undefined; onOpen: (id: string) => void }> = ({ entry, doc, onOpen }) => (
  <li className="px-4 py-3.5 md:grid md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] md:gap-x-8">
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-sm font-medium text-ink break-words">{entry.what || doc?.title || 'Document'}</h3>
        {entry.prefilled && <PrefilledBadge />}
      </div>
      <button
        type="button"
        onClick={() => onOpen(entry.documentId)}
        className="inline-flex items-start gap-1.5 max-w-full py-1 text-left text-[13px] text-accent-ink hover:underline"
      >
        <FileText className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">
          {doc ? doc.title : 'Open the document'}
          {doc && (
            <>
              {' · '}
              <span className="text-ink-3 whitespace-nowrap">{formatDate(docDay(doc))}</span>
            </>
          )}
        </span>
      </button>
      {entry.note && (
        <p className="flex items-start gap-1.5 mt-1 text-xs text-ink-3">
          <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
          <span className="min-w-0">{entry.note}</span>
        </p>
      )}
    </div>
    {entry.figures.length > 0 && (
      <dl className="mt-2 md:-mt-1 divide-y divide-line">
        {entry.figures.map((f, i) => (
          <FigureRow key={i} figure={f} />
        ))}
      </dl>
    )}
  </li>
);

// One ELSTER form, with what it is for and the documents that go into it
const SectionCard: React.FC<{ section: TaxSection; byId: Map<string, DocumentInfo>; onOpen: (id: string) => void }> = ({ section, byId, onOpen }) => {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mb-4">
      <Card>
        <div className="px-4 pt-3.5 pb-3 border-b border-line">
          <h2 id={headingId} className="text-[15px] font-semibold text-ink">
            {section.form}
          </h2>
          <p className="text-[13px] text-ink-2 mt-0.5">{formAbout(section.form)}</p>
        </div>
        <ul className="divide-y divide-line">
          {section.entries.map(entry => (
            <EntryItem key={entry.documentId} entry={entry} doc={byId.get(entry.documentId)} onOpen={onOpen} />
          ))}
        </ul>
      </Card>
    </section>
  );
};

// The years as a row of choices, the newest first; on a phone it scrolls sideways when they don't fit, the year
// shown brought into view
const YearPicker: React.FC<{ years: number[]; year: number; onPick: (year: number) => void }> = ({ years, year, onPick }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [year]);
  return (
    <div ref={ref} className="mb-5 -mx-4 sm:-mx-6 px-4 sm:px-6 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <SegmentedControl
        ariaLabel="Tax year"
        options={years.map(y => ({ value: String(y), label: <span className="tabular-nums">{y}</span> }))}
        value={String(year)}
        onChange={value => onPick(Number(value))}
      />
    </div>
  );
};

interface Failure {
  message: string;
  // While reading the documents (else while loading what was read)
  reading: boolean;
  // The AI's budget for today is used up: trying again won't help before tomorrow
  limit: boolean;
}

// What the page knows about the year it shows
interface YearState {
  year: number;
  // undefined: asked for; null: not read yet
  result: TaxYear | null | undefined;
  reading: boolean;
  failure: Failure | null;
}

const blank = (year: number): YearState => ({ year, result: undefined, reading: false, failure: null });

const failureOf = (err: unknown, reading: boolean): Failure => ({
  message: (err as Error).message,
  reading,
  limit: err instanceof ApiError && err.status === 429,
});

const TaxView: React.FC<{ params: URLSearchParams; documents: DocumentInfo[]; onOpen: (id: string) => void; onNavigate: (to: string) => void }> = ({
  params,
  documents,
  onOpen,
  onNavigate,
}) => {
  // Years there are documents for, from the server's last answer
  const [years, setYears] = useState<number[] | null>(null);
  const year = yearParam(params) ?? defaultYear(years);
  const [state, setState] = useState<YearState | null>(null);
  const shown = state?.year === year ? state : blank(year);
  const [attempt, setAttempt] = useState(0);
  // Each request's answer is used only while it is the latest one for the year shown: switching years or leaving
  // the page drops the answers still to come (reading goes on on the server, and is there when the year is back)
  const run = useRef(0);
  const byId = useMemo(() => new Map(documents.map(d => [d.id, d])), [documents]);

  const update = (y: number, change: Partial<YearState>) => setState(s => ({ ...(s?.year === y ? s : blank(y)), ...change }));

  async function read(y: number, token: number) {
    update(y, { reading: true, failure: null });
    try {
      const response = await api<TaxResponse>(`/api/tax/${y}/refresh`, { method: 'POST' });
      if (run.current !== token) return;
      setYears(response.years);
      update(y, { result: response.result, reading: false });
    } catch (err) {
      if (run.current === token) update(y, { reading: false, failure: failureOf(err, true) });
    }
  }

  useEffect(() => {
    const token = ++run.current;
    (async () => {
      try {
        const response = await api<TaxResponse>(`/api/tax/${year}`);
        if (run.current !== token) return;
        // Without a year in the address this may change the year shown, which then is asked for in turn
        setYears(response.years);
        update(year, { result: response.result });
        // Read the first time the year is opened; a year without documents has nothing to read
        if (!response.result && response.years.includes(year)) await read(year, token);
      } catch (err) {
        if (run.current === token) update(year, { failure: failureOf(err, false) });
      }
    })();
    return () => {
      run.current++;
    };
  }, [year, attempt]);

  const readAgain = () => read(year, ++run.current);
  const retry = () => {
    if (shown.failure?.reading) return readAgain();
    update(year, { failure: null });
    setAttempt(a => a + 1);
  };
  const pick = (y: number) => onNavigate(`${pagePath('taxes')}?year=${y}`);

  const result = shown.result;
  const entries = result ? result.sections.reduce((n, s) => n + s.entries.length, 0) : 0;
  const prefilled = !!result?.sections.some(s => s.entries.some(e => e.prefilled));

  // Told to screen readers as it changes
  const status = shown.reading
    ? `Reading your ${year} documents… This takes up to a minute.`
    : result
      ? `${year}: ${countLabel(entries)} for your return${result.sections.length ? `, in ${countLabel(result.sections.length, 'form')}` : ''}.`
      : '';

  let body: React.ReactNode = null;
  if (result) {
    body = (
      <>
        {shown.reading ? (
          <Notice icon={<Spinner />} className="mb-4">
            Reading your {year} documents again… This takes up to a minute.
          </Notice>
        ) : (
          result.stale && (
            <Notice
              tone="accent"
              icon={<RefreshCw className="w-4 h-4" />}
              className="mb-4"
              action={
                <button type="button" className="text-sm font-medium text-accent-ink hover:underline whitespace-nowrap" onClick={readAgain}>
                  Read again
                </button>
              }
            >
              Documents from {year} were added or changed since Paperwork read them on {formatDate(result.readAt)}.
            </Notice>
          )
        )}

        {result.missing.length > 0 && (
          <Notice tone="warning" icon={<FileQuestionMark className="w-4 h-4" />} className="mb-4">
            <h2 className="font-semibold">Probably missing</h2>
            <ul className="mt-1.5 space-y-1.5">
              {result.missing.map((m, i) => (
                <li key={i}>
                  <span className="font-medium">{m.what}</span>
                  {m.why && <span className="block text-[13px] text-ink-2">{m.why}</span>}
                </li>
              ))}
            </ul>
          </Notice>
        )}

        {prefilled && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-4 text-xs text-ink-3">
            <PrefilledBadge />
            <span>{PREFILLED}</span>
          </p>
        )}

        {result.sections.length > 0 ? (
          result.sections.map(section => <SectionCard key={section.form} section={section} byId={byId} onOpen={onOpen} />)
        ) : (
          <Card>
            <EmptyState
              icon={<FileSearch className="w-5 h-5" />}
              title={`Nothing found for your ${year} return`}
              description={`Paperwork found no documents of ${year} that go into the return. What usually belongs: the Lohnsteuerbescheinigung from your employer, your insurers’ certificates of contributions, invoices of tradespeople, donation receipts and your banks’ annual tax certificates. Once they are in Paperwork, read the year again.`}
            />
          </Card>
        )}

        <div className="mt-6 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <p className="flex items-start gap-1.5 text-xs text-ink-3">
            <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
            <span>
              Read by Paperwork’s AI from your documents on {formatDate(result.readAt, 'long')}. Check each figure against the document before you
              submit.
            </span>
          </p>
          <Button size="sm" icon={<RefreshCw className="w-3.5 h-3.5" />} loading={shown.reading} onClick={readAgain} className="self-start shrink-0">
            Read again
          </Button>
        </div>
      </>
    );
  } else if (shown.reading) {
    body = (
      <Card>
        <EmptyState
          icon={<Spinner className="w-5 h-5" />}
          title={`Reading your ${year} documents…`}
          description="This takes up to a minute. Paperwork picks the documents your return needs, sorts them by ELSTER form and reads the figures to enter."
        />
      </Card>
    );
  } else if (result === null && years?.length === 0) {
    body = (
      <Card>
        <EmptyState
          icon={<Landmark className="w-5 h-5" />}
          title="No documents yet"
          description="Once your documents are in Paperwork, this page gathers what each year’s tax return needs: your Lohnsteuerbescheinigung, insurance certificates, invoices of tradespeople and more, by ELSTER form, with the figures to enter."
        />
      </Card>
    );
  } else if (result === null && years && !years.includes(year)) {
    body = (
      <Card>
        <EmptyState icon={<FileSearch className="w-5 h-5" />} title={`No documents from ${year}`} description="Pick one of the years above." />
      </Card>
    );
  } else if (!shown.failure) {
    body = (
      <div className="flex justify-center pt-16">
        <Spinner className="w-5 h-5" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      <IndexSwitch current="taxes" onNavigate={onNavigate} />
      <PageHeader title="Taxes" description="What your tax return needs, from your documents: by ELSTER form, with the figures to enter." />
      <p className="sr-only" role="status">
        {status}
      </p>

      {years && years.length > 0 && <YearPicker years={years} year={year} onPick={pick} />}

      {shown.failure && (
        <Notice
          tone={shown.failure.limit ? 'warning' : 'danger'}
          icon={<TriangleAlert className="w-4 h-4" />}
          className="mb-4"
          action={
            !shown.failure.limit && (
              <button type="button" className="text-sm font-medium underline whitespace-nowrap" onClick={retry}>
                Try again
              </button>
            )
          }
        >
          {shown.failure.reading ? `Your ${year} documents couldn’t be read: ` : `Your ${year} return couldn’t be loaded: `}
          {shown.failure.message}
        </Notice>
      )}

      {body}
    </div>
  );
};

export default TaxView;
