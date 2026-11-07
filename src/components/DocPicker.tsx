// Picking one of the library's documents, searched in the browser: the document to keep this one with, or one to
// move into a folder. Those of the same topic come first, then those in the same folder.
import React, { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { DocumentInfo } from '../../shared/types';
import { applyFilters } from '../../shared/filter';
import { formatDate } from '../lib/format';
import { placeOf } from '../lib/review';
import { ReviewBadge, Thumbnail } from './DocumentCard';
import { Modal, Notice, Spinner, cx, inputClass } from './ui';

// Enough to find one by scrolling; a search narrows the rest down
const SHOWN = 40;

export const DocPicker: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  description: React.ReactNode;
  // The documents to choose from
  documents: DocumentInfo[];
  // Suggested first: the documents of this topic, then those in this folder
  topic: string | null;
  folderId: string | null;
  onPick: (doc: DocumentInfo) => void;
  // The document being saved, and what went wrong
  busy: string | null;
  error: string | null;
  // Shown instead of the list when nothing can be picked, in a sentence
  blocked?: string | null;
}> = ({ open, onClose, title, description, documents, topic, folderId, onPick, busy, error, blocked }) => {
  const [query, setQuery] = useState('');
  // Each time it opens, without the last search
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);
  const shown = useMemo(() => {
    const rank = (d: DocumentInfo) => (topic && d.topic === topic ? 0 : folderId && d.folderId === folderId ? 1 : 2);
    // Newest first within each group (the sort keeps the order applyFilters gave)
    return applyFilters(documents, { query })
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, SHOWN);
  }, [documents, query, topic, folderId]);

  return (
    <Modal open={open} onClose={onClose} title={title} description={description}>
      {blocked ? (
        <Notice tone="warning">{blocked}</Notice>
      ) : (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
            <input
              data-autofocus
              type="search"
              aria-label="Search documents"
              placeholder="Search by title, sender, topic…"
              className={cx(inputClass, 'pl-9')}
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          {shown.length ? (
            <ul className="divide-y divide-line border border-line rounded-xl overflow-hidden">
              {shown.map(d => (
                <li key={d.id}>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => onPick(d)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2 transition-colors disabled:opacity-60"
                  >
                    <Thumbnail doc={d} className="w-8 h-10 rounded-md border border-line shrink-0" iconClass="w-4 h-4" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-ink truncate">{d.title}</span>
                        <ReviewBadge doc={d} />
                      </span>
                      <span className="block text-xs text-ink-2 truncate">
                        {[d.correspondent, formatDate(d.date ?? d.addedAt)].filter(Boolean).join(' · ')}
                      </span>
                      <span className="block text-xs text-ink-3 truncate">{placeOf(d)}</span>
                    </span>
                    {busy === d.id && <Spinner />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-2 py-6 text-center">{query.trim() ? 'No document matches that.' : 'There are no other documents yet.'}</p>
          )}
        </div>
      )}
    </Modal>
  );
};
