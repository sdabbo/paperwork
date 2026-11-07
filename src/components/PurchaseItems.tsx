// The items bought, in a document's details: listed as on the Purchases page, each opening into fields to change it
// when selected. They are edited with the rest of the document's details and saved with them, all at once.
import React, { useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import type { PurchaseItem } from '../../shared/types';
import { formatAmount } from '../lib/format';
import { Button, Field, IconButton, cx, inputClass } from './ui';

// An item as it is being edited, its numbers as typed; the key keeps each row's inputs in place while rows come and go
export interface ItemDraft {
  key: number;
  name: string;
  details: string;
  quantity: string;
  price: string;
  code: string;
}

let nextItemKey = 0;

// As many as the server keeps per document, and as long as it keeps each text
export const MAX_ITEMS = 25;
const MAX_NAME = 120;
const MAX_DETAILS = 120;
const MAX_CODE = 40;
const MAX_QUANTITY = 999;

export const toItemDrafts = (items: PurchaseItem[]): ItemDraft[] =>
  items.map(i => ({
    key: nextItemKey++,
    name: i.name,
    details: i.details ?? '',
    quantity: String(i.quantity),
    price: i.price !== null ? String(i.price) : '',
    code: i.code ?? '',
  }));

// A whole number from 1 to 999; empty is one
function parseQuantity(text: string): number | null {
  const t = text.trim();
  if (!t) return 1;
  const n = Number(t);
  return /^\d+$/.test(t) && n >= 1 && n <= MAX_QUANTITY ? n : null;
}

// A price as people write it: "679,99", "679.99", "1.234,56", "1,234.56", "€ 39". Null when empty, NaN when it
// isn't a number. A point or comma before exactly three digits separates thousands; the other one is the decimal.
function parsePrice(text: string): number | null {
  const t = text.replace(/[\s€$£]/g, '');
  if (!t) return null;
  const plain = t.replace(/[.,](?=\d{3}(?:[.,]|$))/g, '').replace(',', '.');
  return /^-?\d+(?:\.\d+)?$/.test(plain) ? Math.round(Number(plain) * 100) / 100 : NaN;
}

// A row with nothing typed in (the quantity alone doesn't count)
const emptyItem = (r: ItemDraft) => !r.name.trim() && !r.details.trim() && !r.price.trim() && !r.code.trim();

// What keeps an item from being saved, in a sentence; null when it can be saved, or is left empty
export function itemProblem(r: ItemDraft): string | null {
  if (emptyItem(r)) return null;
  if (!r.name.trim()) return 'Say what the item is.';
  if (parseQuantity(r.quantity) === null) return `The quantity is a whole number from 1 to ${MAX_QUANTITY}.`;
  if (Number.isNaN(parsePrice(r.price))) return 'Write the price as a number, e.g. 679,99.';
  return null;
}

// The items as they would be saved: rows left empty don't count
export const editedItems = (rows: ItemDraft[]): PurchaseItem[] =>
  rows
    .filter(r => !emptyItem(r))
    .map(r => ({
      name: r.name.trim(),
      details: r.details.trim() || null,
      quantity: parseQuantity(r.quantity) ?? 1,
      price: parsePrice(r.price),
      code: r.code.trim() || null,
    }));

const itemFields = ({ name, details, quantity, price, code }: PurchaseItem) => [name, details, quantity, price, code];

// Items compared as the server keeps them
export const sameItems = (a: PurchaseItem[], b: PurchaseItem[]) => JSON.stringify(a.map(itemFields)) === JSON.stringify(b.map(itemFields));

// Rows compared as typed (without their keys)
export const sameItemRows = (a: ItemDraft[], b: ItemDraft[]) =>
  JSON.stringify(a.map(({ key: _, ...r }) => r)) === JSON.stringify(b.map(({ key: _, ...r }) => r));

// An item as listed: its name (with how many, when more than one), details, code and price
const ItemLine: React.FC<{ row: ItemDraft; currency: string | null; autoFocus: boolean; onEdit: () => void }> = ({ row, currency, autoFocus, onEdit }) => {
  const quantity = parseQuantity(row.quantity) ?? 1;
  const price = parsePrice(row.price);
  return (
    <button
      type="button"
      onClick={onEdit}
      autoFocus={autoFocus}
      className="group w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2 transition-colors focus-visible:-outline-offset-2"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink break-words">
          <span className="sr-only">Change </span>
          {quantity > 1 && <span className="tabular-nums">{quantity} × </span>}
          {row.name.trim()}
        </div>
        {row.details.trim() && <div className="text-[13px] text-ink-2 break-words">{row.details.trim()}</div>}
        {row.code.trim() && <div className="text-xs text-ink-3 tabular-nums break-all">{row.code.trim()}</div>}
      </div>
      {price !== null && !Number.isNaN(price) && <div className="shrink-0 text-sm font-medium text-ink tabular-nums text-right">{formatAmount(price, currency)}</div>}
      <Pencil className="w-3.5 h-3.5 mt-[3px] shrink-0 text-ink-3 group-hover:text-ink-2" aria-hidden />
    </button>
  );
};

// An item opened to change it
const ItemEditor: React.FC<{
  row: ItemDraft;
  currency: string | null;
  autoFocus: boolean;
  onChange: (patch: Partial<ItemDraft>) => void;
  onRemove: () => void;
  onDone: () => void;
}> = ({ row, currency, autoFocus, onChange, onRemove, onDone }) => {
  const problem = itemProblem(row);
  const quantity = parseQuantity(row.quantity);
  // Screen readers hear which item the remove button belongs to
  const name = row.name.trim() ? `“${row.name.trim()}”` : 'the new item';
  return (
    <div
      className="px-3 py-3 space-y-3 bg-surface-2/50"
      // Enter in a field closes the item, like Done
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.target instanceof HTMLInputElement) {
          e.preventDefault();
          onDone();
        }
      }}
    >
      <div className="flex items-end gap-2">
        <Field label="Item" className="flex-1 min-w-0">
          <input
            className={inputClass}
            maxLength={MAX_NAME}
            placeholder="e.g. Arc’teryx Beta SV Jacket"
            autoFocus={autoFocus}
            value={row.name}
            onChange={e => onChange({ name: e.target.value })}
          />
        </Field>
        <IconButton label={`Remove ${name}`} className="-mr-1.5" onClick={onRemove}>
          <X className="w-4 h-4" />
        </IconButton>
      </div>
      <Field label="Details">
        <input
          className={inputClass}
          maxLength={MAX_DETAILS}
          placeholder="Size, colour or model, e.g. Size M, black"
          value={row.details}
          onChange={e => onChange({ details: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-[4.75rem_minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <Field label="Quantity">
          <input inputMode="numeric" className={cx(inputClass, 'tabular-nums')} maxLength={3} value={row.quantity} onChange={e => onChange({ quantity: e.target.value })} />
        </Field>
        <Field label={currency ? `Price (${currency})` : 'Price'} hint={quantity !== null && quantity > 1 ? `For all ${quantity}` : undefined}>
          <input inputMode="decimal" className={cx(inputClass, 'tabular-nums')} placeholder="0,00" value={row.price} onChange={e => onChange({ price: e.target.value })} />
        </Field>
        <Field label="Code">
          <input className={cx(inputClass, 'tabular-nums')} maxLength={MAX_CODE} placeholder="Art. no., EAN" value={row.code} onChange={e => onChange({ code: e.target.value })} />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-danger">{problem}</p>
        <Button size="sm" className="shrink-0" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
};

export const PurchaseItems: React.FC<{
  rows: ItemDraft[];
  // The document's currency, as edited
  currency: string | null;
  onChange: (change: (rows: ItemDraft[]) => ItemDraft[]) => void;
}> = ({ rows, currency, onChange }) => {
  // Rows opened to change them (an item that can't be saved stays open, to show why)
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  // The field or row to focus once it is shown: the new item's name, or the row of an item just closed
  const [focus, setFocus] = useState<number | null>(null);

  const edit = (key: number) => {
    setFocus(key);
    setOpen(o => new Set(o).add(key));
  };
  const close = (key: number) => {
    setOpen(o => {
      const next = new Set(o);
      next.delete(key);
      return next;
    });
    // A new item closed without anything typed in goes again (and has no row to focus)
    const row = rows.find(r => r.key === key);
    setFocus(row && !emptyItem(row) ? key : null);
    onChange(list => list.filter(r => r.key !== key || !emptyItem(r)));
  };
  const add = () => {
    const key = nextItemKey++;
    onChange(list => (list.length < MAX_ITEMS ? [...list, { key, name: '', details: '', quantity: '1', price: '', code: '' }] : list));
    edit(key);
  };
  const update = (key: number, patch: Partial<ItemDraft>) => onChange(list => list.map(r => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: number) => onChange(list => list.filter(r => r.key !== key));

  return (
    <div>
      <div className="flex items-center justify-between gap-2 min-h-8 mb-1.5">
        <span className="text-[13px] font-medium text-ink">Items</span>
        {rows.length < MAX_ITEMS && (
          <Button variant="ghost" size="sm" className="-mr-2" icon={<Plus className="w-4 h-4" />} onClick={add}>
            Add item
          </Button>
        )}
      </div>
      {rows.length > 0 && (
        <ul className="rounded-lg border border-line divide-y divide-line overflow-hidden">
          {rows.map(row => (
            <li key={row.key}>
              {open.has(row.key) || itemProblem(row) ? (
                <ItemEditor
                  row={row}
                  currency={currency}
                  autoFocus={row.key === focus}
                  onChange={patch => update(row.key, patch)}
                  onRemove={() => remove(row.key)}
                  onDone={() => close(row.key)}
                />
              ) : (
                <ItemLine row={row} currency={currency} autoFocus={row.key === focus} onEdit={() => edit(row.key)} />
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-3 mt-1.5">
        {rows.length >= MAX_ITEMS
          ? `A document can have up to ${MAX_ITEMS} items. Remove one to add another.`
          : rows.length
            ? 'What was bought, as listed on the document. Select an item to change it.'
            : 'None yet. Add what was bought, to find it later on the Purchases page.'}
      </p>
    </div>
  );
};
