// Ask: questions about the documents, answered from the documents themselves, with the sources linked.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { ArrowUp, FileText, Sparkles } from 'lucide-react';
import type { AskEvent, DocumentInfo } from '../../shared/types';
import { askStream } from '../lib/api';
import { holdReload } from '../lib/iap';
import { citedSources } from '../lib/citations';
import { formatDate } from '../lib/format';
import { ToCheckBadge } from './DocumentCard';
import { Card, PageHeader, Spinner, cx } from './ui';

type Source = Extract<AskEvent, { type: 'sources' }>['documents'][number];

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  sources?: Source[];
  pending?: boolean;
  error?: string;
}

// The answer is written by the AI from the documents' text, and a document can carry instructions meant to
// steer it. So the answer's markdown shows no images (loading one could send what is in its address to someone
// else's server) and keeps only web links, which open in a new tab, and the links to its sources.
const SOURCE_LINK = /^#source-\d+$/;
const safeUrl = (url: string) => (SOURCE_LINK.test(url) || /^https?:\/\//i.test(url) ? url : null);

const SUGGESTIONS = [
  'What do I need to pay or answer in the next weeks?',
  'When does my car insurance renew, and what does it cost?',
  'How much did we pay for electricity last year?',
  'Which contracts can I cancel, and by when?',
];

const AskView: React.FC<{ documents: DocumentInfo[]; onOpen: (id: string) => void }> = ({ documents, onOpen }) => {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const busy = turns.some(t => t.pending);
  const toCheck = useMemo(() => new Set(documents.filter(d => d.needsReview).map(d => d.id)), [documents]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  // A conversation, which a reload would end: an ended Google sign-in shows a notice instead (lib/iap.ts)
  const talking = turns.length > 0;
  useEffect(() => (talking ? holdReload() : undefined), [talking]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const history = turns.filter(t => !t.pending && !t.error).map(t => ({ role: t.role, text: t.text }));
    setInput('');
    setTurns(t => [...t, { role: 'user', text: q }, { role: 'assistant', text: '', pending: true }]);
    const patch = (fn: (t: Turn) => Turn) => setTurns(list => list.map((t, i) => (i === list.length - 1 ? fn(t) : t)));
    try {
      for await (const event of askStream(q, history)) {
        if (event.type === 'sources') patch(t => ({ ...t, sources: event.documents }));
        else if (event.type === 'text') patch(t => ({ ...t, text: t.text + event.text }));
        else if (event.type === 'error') patch(t => ({ ...t, error: event.error }));
      }
    } catch (err) {
      patch(t => ({ ...t, error: (err as Error).message }));
    } finally {
      patch(t => ({ ...t, pending: false }));
    }
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col min-h-[calc(100dvh-9rem)] lg:min-h-[calc(100dvh-5rem)]">
      <PageHeader title="Ask" description="Answers come from your documents, with links to the ones used." />

      <div className="flex-1 space-y-5">
        {turns.length === 0 && (
          <div className="grid sm:grid-cols-2 gap-2">
            {SUGGESTIONS.map(s => (
              <button key={s} onClick={() => ask(s)} disabled={!documents.length} className="text-left p-3 rounded-xl border border-line bg-surface hover:border-line-strong text-sm text-ink-2 hover:text-ink transition-colors disabled:opacity-50">
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary text-primary-fg px-4 py-2.5 text-[15px]">{t.text}</div>
            </div>
          ) : (
            <Answer key={i} turn={t} onOpen={onOpen} toCheck={toCheck} />
          )
        )}
        <div ref={endRef} />
      </div>

      <form
        className="sticky bottom-20 lg:bottom-4 mt-6"
        onSubmit={e => {
          e.preventDefault();
          ask(input);
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border border-line bg-surface shadow-sm p-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={1}
            placeholder={documents.length ? 'Ask about your documents…' : 'Add documents first, then ask about them'}
            className="flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] placeholder:text-ink-3 focus:outline-none max-h-40"
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            aria-label="Ask"
            className="w-9 h-9 shrink-0 rounded-xl bg-primary text-primary-fg flex items-center justify-center disabled:opacity-40"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </form>
    </div>
  );
};

// `toCheck`: the documents not checked yet, marked among the sources
const Answer: React.FC<{ turn: Turn; onOpen: (id: string) => void; toCheck: Set<string> }> = ({ turn, onOpen, toCheck }) => {
  // The documents the answer was written from; only those it cites are listed below it
  const sources = turn.sources ?? [];
  // [1], [2] in the answer become links to the documents
  const { markdown, sources: cited } = useMemo(() => citedSources(turn.text, sources), [turn.text, sources]);
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 shrink-0 rounded-full bg-accent-soft text-accent-ink flex items-center justify-center mt-0.5">
        <Sparkles className="w-3.5 h-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        {turn.pending && !turn.text && (
          <div className="flex items-center gap-2 text-sm text-ink-3 py-1">
            <Spinner />
            {turn.sources ? (sources.length ? `Reading ${sources.length} ${sources.length === 1 ? 'document' : 'documents'}…` : 'Thinking…') : 'Looking through your documents…'}
          </div>
        )}
        {turn.text && (
          <div className="prose-answer text-[15px] leading-relaxed text-ink">
            <Markdown
              disallowedElements={['img']}
              unwrapDisallowed
              urlTransform={safeUrl}
              components={{
                a: ({ href, children }) => {
                  const n = href && SOURCE_LINK.test(href) ? Number(href.slice(8)) : NaN;
                  const source = sources[n - 1];
                  if (source) {
                    return (
                      <button
                        type="button"
                        onClick={() => onOpen(source.id)}
                        title={source.title}
                        className="inline-flex items-center justify-center min-w-5 h-5 px-1 mx-0.5 rounded-md bg-accent-soft text-accent-ink text-xs font-semibold align-text-top hover:brightness-95"
                      >
                        {children}
                      </button>
                    );
                  }
                  // A link whose address was taken out (not a web link) stays as its text
                  if (!href) return <>{children}</>;
                  return (
                    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent-ink underline">
                      {children}
                    </a>
                  );
                },
              }}
            >
              {markdown}
            </Markdown>
          </div>
        )}
        {turn.error && <div className="text-sm text-danger mt-1">{turn.error}</div>}
        {cited.length > 0 && !turn.pending && (
          <div className="mt-3 flex flex-wrap gap-2">
            {cited.map((s, i) => (
              <Card key={s.id} className={cx('px-3 py-2 text-left max-w-full hover:border-line-strong transition-colors')}>
                <button type="button" onClick={() => onOpen(s.id)} className="flex items-center gap-2 text-left">
                  <span className="text-xs font-semibold text-accent-ink">{i + 1}</span>
                  <FileText className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                  <span className="text-sm truncate max-w-[16rem]">{s.title}</span>
                  {s.date && <span className="text-xs text-ink-3">{formatDate(s.date)}</span>}
                  {toCheck.has(s.id) && <ToCheckBadge />}
                </button>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default AskView;
