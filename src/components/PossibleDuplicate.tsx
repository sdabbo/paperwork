// A document that may be a copy of another one already in Paperwork (the same letter scanned and emailed, say), with
// that one to open and compare, and the owner's three choices: two different documents ("Keep both", never asked
// again for these two), the same one (its file goes to the Duplicates folder), or the same one kept as a file with
// the original. Used in To check and in the document's own view.
import React, { useId } from 'react';
import { ChevronRight, Copy, FolderOutput, Layers, Paperclip, TriangleAlert, X } from 'lucide-react';
import type { DocumentInfo, DuplicateChoice } from '../../shared/types';
import { matchReason, onlyOnCopy, openOf } from '../lib/duplicates';
import { SOURCE, formatAmount, formatDate } from '../lib/format';
import { placeOf } from '../lib/review';
import { Thumbnail } from './DocumentCard';
import { IconButton, Spinner, cx } from './ui';

// What is on its way: Keep both, Move to Duplicates or Keep it with the original
export type DuplicateBusy = null | 'keep' | 'move' | 'attach';

const BUSY: Record<DuplicateChoice, Exclude<DuplicateBusy, null>> = { 'keep-both': 'keep', duplicate: 'move', 'keep-with': 'attach' };

// When and how it came: tells the scan from the emailed PDF when both have the same title
const arrived = (doc: DocumentInfo) => `added ${formatDate(doc.addedAt)}${doc.source ? ` ${SOURCE[doc.source]}` : ''}`;

// What to compare: the sender (which may wrap), the date and the amount (which don't)
const factsOf = (doc: DocumentInfo) =>
  [
    { text: doc.correspondent, whole: false },
    { text: formatDate(doc.date ?? doc.addedAt), whole: true },
    { text: formatAmount(doc.amount, doc.currency), whole: true },
  ].filter(f => f.text);

const Facts: React.FC<{ doc: DocumentInfo }> = ({ doc }) => (
  <>
    {factsOf(doc).map((fact, i) => (
      <React.Fragment key={i}>
        {i > 0 && ' · '}
        <span className={fact.whole ? 'whitespace-nowrap' : undefined}>{fact.text}</span>
      </React.Fragment>
    ))}
  </>
);

const Choice: React.FC<{
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  dataCheck?: string;
}> = ({ icon, title, children, busy, disabled, onClick, dataCheck }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    data-check={dataCheck}
    className="w-full min-h-11 text-left rounded-lg border border-line bg-surface px-3 py-2.5 hover:bg-surface-2 hover:border-line-strong transition-colors disabled:opacity-60 disabled:pointer-events-none"
  >
    <span className="flex items-center gap-2 text-sm font-medium text-ink">
      <span className="shrink-0 text-ink-2">{busy ? <Spinner /> : icon}</span>
      {title}
    </span>
    <span className="block text-xs text-ink-2 mt-0.5 leading-snug">{children}</span>
  </button>
);

export const PossibleDuplicate: React.FC<{
  doc: DocumentInfo;
  original: DocumentInfo;
  busy: DuplicateBusy;
  error: string | null;
  onChoose: (choice: DuplicateChoice) => void;
  onOpenOriginal: (id: string) => void;
  onDismissError?: () => void;
  // Edits not saved yet (in the document's view): Keep both saves them with it, the other two drop them
  dirty?: boolean;
  // Why the edits can't be saved yet (a deadline without its date, say): Keep both waits for them
  incomplete?: string | null;
  // On the first choice, so To check can move the keyboard's focus to the next document's
  firstChoiceData?: string;
  // Its own sender, date and amount too, where they aren't shown next to it (the document's view has them further
  // down, in its fields)
  showFacts?: boolean;
  // Under a heading of that level (To check lists documents under h3s)
  headingLevel?: 3 | 4;
  className?: string;
}> = ({ doc, original, busy, error, onChoose, onOpenOriginal, onDismissError, dirty, incomplete, firstChoiceData, showFacts, headingLevel = 3, className }) => {
  const headingId = useId();
  const open = openOf(doc).length;
  const only = onlyOnCopy(doc, original);
  const Heading = headingLevel === 4 ? 'h4' : 'h3';
  const choice = (c: DuplicateChoice) => ({ busy: busy === BUSY[c], disabled: !!busy, onClick: () => onChoose(c) });
  return (
    <section aria-labelledby={headingId} className={cx('@container rounded-xl border border-warning/35 bg-warning/8 p-3 sm:p-4', className)}>
      <Heading id={headingId} className="flex items-center gap-2 text-[15px] font-semibold text-ink">
        <Copy className="w-4 h-4 shrink-0 text-warning" strokeWidth={2.5} />
        Possible duplicate
      </Heading>
      <p className="text-sm text-ink-2 mt-1">
        This one (
        {showFacts && (
          <>
            <Facts doc={doc} />,{' '}
          </>
        )}
        {arrived(doc)}) may be the same document as:
      </p>
      <button
        type="button"
        onClick={() => onOpenOriginal(original.id)}
        className="mt-2 w-full min-h-11 flex items-center gap-3 rounded-lg border border-line bg-surface px-2.5 py-2 text-left hover:bg-surface-2 hover:border-line-strong transition-colors"
      >
        <Thumbnail doc={original} className="w-8 h-10 rounded border border-line shrink-0" iconClass="w-4 h-4" />
        {/* Its facts are read out too: they are what to compare */}
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-ink leading-snug line-clamp-2 break-words">
            <span className="sr-only">Open to compare: </span>
            {original.title}
          </span>
          {/* Wraps rather than cutting off the amount on a phone */}
          <span className="block text-xs text-ink-2 break-words">
            <Facts doc={original} />
          </span>
          <span className="block text-xs text-ink-3 break-words">
            {placeOf(original)} · {arrived(original)}
          </span>
        </span>
        <ChevronRight className="w-4 h-4 shrink-0 text-ink-3" />
      </button>
      <p className="text-[13px] text-ink-2 mt-2">
        {matchReason(doc, original)}
        {open > 0 && (open === 1 ? ' Its deadline isn’t counted until you choose.' : ` Its ${open} deadlines aren’t counted until you choose.`)}
      </p>
      {/* Before the choices: moving it or keeping it with the original takes these out of Deadlines for good */}
      {only.length > 0 && (
        <p className="text-xs text-ink-2 mt-2">
          {only.length === 1
            ? `“${only[0].what}” (${formatDate(only[0].date)}) is only on this one: it won’t be in Deadlines any more if you move it or keep it with the original. Add it to the original first if you need it.`
            : `${only.length} deadlines are only on this one: they won’t be in Deadlines any more if you move it or keep it with the original. Add them to the original first if you need them.`}
        </p>
      )}
      <div role="group" aria-label="Is it a copy?" className="mt-3 grid gap-2 @2xl:grid-cols-3">
        <Choice icon={<Layers className="w-4 h-4" />} title="Keep both" {...choice('keep-both')} disabled={!!busy || !!incomplete} dataCheck={firstChoiceData}>
          They’re different, e.g. two bills for the same amount. You won’t be asked about these two again.
        </Choice>
        <Choice icon={<FolderOutput className="w-4 h-4" />} title="Move to Duplicates" {...choice('duplicate')}>
          It’s the same document. Its file goes to the Duplicates folder in Drive; nothing is deleted.
        </Choice>
        <Choice icon={<Paperclip className="w-4 h-4" />} title="Keep it with the original" {...choice('keep-with')}>
          It’s the same, but keep its file next to “{original.title}”, e.g. a paper scan next to the emailed PDF.
        </Choice>
      </div>
      {incomplete ? (
        <p className="text-xs text-danger mt-2">{incomplete}</p>
      ) : (
        dirty && <p className="text-xs text-ink-3 mt-2">Keep both saves your changes too. The other two choices drop them.</p>
      )}
      {error && (
        <div role="alert" className="mt-2.5 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[13px] text-ink">
          <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0 text-danger" />
          <span className="flex-1 min-w-0 break-words">{error}</span>
          {onDismissError && (
            <IconButton label="Dismiss" size="sm" className="-my-1.5 -mr-2" onClick={onDismissError}>
              <X className="w-3.5 h-3.5" />
            </IconButton>
          )}
        </div>
      )}
    </section>
  );
};
