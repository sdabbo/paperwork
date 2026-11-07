// Purchases: everything bought, as Paperwork read it from till receipts and shops' invoices, the newest first and
// grouped by year: what it was, where and when it was bought and what it cost, and whether it can still go back or
// is under warranty (the document's return and warranty dates). Each item opens its receipt.
import React, { useMemo, useState } from 'react';
import { Plus, Search, ShieldCheck, ShoppingBag, Undo2, X } from 'lucide-react';
import type { DocumentInfo } from '../../shared/types';
import { localToday } from '../../shared/filter';
import { countLabel, docDay } from '../lib/companies';
import { formatAmount, formatDate, formatShortDate } from '../lib/format';
import { Purchase, findPurchases, purchases, returnBy, warrantyUntil } from '../lib/purchases';
import { IndexSwitch } from './companyParts';
import { ReviewBadge } from './DocumentCard';
import { Badge, Button, Card, EmptyState, IconButton, PageHeader, Spinner } from './ui';

const PurchaseRow: React.FC<{ purchase: Purchase; today: string; onOpen: (id: string) => void }> = ({ purchase, today, onOpen }) => {
  const { doc, item } = purchase;
  const returnDate = returnBy(doc, today);
  const warranty = warrantyUntil(doc, today);
  // Where and when: the shop and the receipt's date (the day it was added when it has none)
  const where = [doc.correspondent?.trim(), doc.date ? formatDate(doc.date) : `Added ${formatDate(doc.addedAt)}`].filter(Boolean).join(' · ');
  return (
    <li>
      <button type="button" onClick={() => onOpen(doc.id)} className="w-full px-4 py-3 text-left hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink break-words">
              {item.quantity > 1 && <span className="tabular-nums">{item.quantity} × </span>}
              {item.name}
            </div>
            {item.details && <div className="text-[13px] text-ink-2 break-words">{item.details}</div>}
            <div className="text-xs text-ink-3 mt-0.5 break-words">{where}</div>
          </div>
          {item.price !== null && <div className="shrink-0 text-sm font-medium text-ink tabular-nums text-right">{formatAmount(item.price, doc.currency)}</div>}
        </div>
        {/* Below the price too, so on a phone they share a line instead of taking one each */}
        {(returnDate || warranty || doc.needsReview || doc.possibleDuplicateOf) && (
          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
            {returnDate && (
              <Badge tone="accent">
                <Undo2 className="w-3 h-3 shrink-0" aria-hidden />
                Return by {formatShortDate(returnDate.date)}
              </Badge>
            )}
            {warranty && (
              <Badge>
                <ShieldCheck className="w-3 h-3 shrink-0" aria-hidden />
                Warranty until {formatDate(warranty.date)}
              </Badge>
            )}
            <ReviewBadge doc={doc} />
          </div>
        )}
      </button>
    </li>
  );
};

const PurchasesView: React.FC<{
  documents: DocumentInfo[];
  loading: boolean;
  onOpen: (id: string) => void;
  onNavigate: (to: string) => void;
  onAdd: () => void;
}> = ({ documents, loading, onOpen, onNavigate, onAdd }) => {
  const [query, setQuery] = useState('');
  const today = localToday();
  const all = useMemo(() => purchases(documents), [documents]);
  const list = useMemo(() => findPurchases(all, query), [all, query]);

  // Newest first already; grouped by year in that order
  const years = useMemo(() => {
    const groups = new Map<string, Purchase[]>();
    for (const p of list) {
      const year = docDay(p.doc).slice(0, 4);
      if (groups.has(year)) groups.get(year)!.push(p);
      else groups.set(year, [p]);
    }
    return [...groups.entries()];
  }, [list]);

  return (
    <div className="max-w-4xl">
      <IndexSwitch current="purchases" onNavigate={onNavigate} />
      <PageHeader title="Purchases" description="What you bought, from your till receipts and shops’ invoices: where, when and for how much, and until when it can go back." />

      {loading ? (
        <div className="flex justify-center pt-16">
          <Spinner className="w-5 h-5" />
        </div>
      ) : all.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShoppingBag className="w-5 h-5" />}
            title="No purchases yet"
            description={
              <>
                Paperwork reads what was bought from till receipts and shops’ invoices. Scan a receipt with <b>Add documents › Scan with camera</b> (or the
                Google Drive app) and its items appear here, with the last day to return them and the end of the warranty.
              </>
            }
            action={
              <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={onAdd}>
                Add documents
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3" />
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Find an item, a brand or a shop"
              aria-label="Find an item, a brand or a shop"
              className="w-full h-10 pl-9 pr-10 rounded-xl bg-surface border border-line text-sm placeholder:text-ink-3 hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {query && (
              <IconButton label="Clear search" size="sm" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => setQuery('')}>
                <X className="w-4 h-4" />
              </IconButton>
            )}
          </div>
          <p className="text-xs text-ink-3 mb-2" aria-live="polite">
            {query.trim() ? `${list.length} of ${countLabel(all.length, 'item')}` : `${countLabel(all.length, 'item')}, the newest first`}
          </p>

          {list.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Search className="w-5 h-5" />}
                title={`Nothing bought matches “${query.trim()}”`}
                description="Try part of the name, the brand or the shop."
              />
            </Card>
          ) : (
            years.map(([year, items]) => (
              <section key={year} className="mb-6" aria-label={`${year}, ${countLabel(items.length, 'item')}`}>
                <h2 className="flex items-center gap-1.5 text-[15px] font-semibold text-ink mb-2">
                  {year}
                  <span className="text-xs font-normal text-ink-3 tabular-nums">{items.length}</span>
                </h2>
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-line">
                    {items.map(p => (
                      <PurchaseRow key={`${p.doc.id}|${p.line}`} purchase={p} today={today} onOpen={onOpen} />
                    ))}
                  </ul>
                </Card>
              </section>
            ))
          )}
        </>
      )}
    </div>
  );
};

export default PurchasesView;
