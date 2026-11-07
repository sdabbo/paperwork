// The Contracts page's sums and lists, worked out in the browser from what the server read (server/contracts.ts):
// what the active contracts cost together, which can be cancelled soon, and the contracts by kind.
import { CONTRACT_KINDS, Contract, ContractInterval, ContractKind } from '../../shared/types';
import { localToday, shiftDate } from '../../shared/filter';

// "53.52 € a month"
export const INTERVAL_LABELS: Record<ContractInterval, string> = {
  month: 'a month',
  quarter: 'a quarter',
  'half-year': 'every six months',
  year: 'a year',
};

// A last day to cancel this close counts as soon: time enough to compare offers and switch
export const CANCEL_SOON_DAYS = 60;

export interface Total {
  // null: the documents gave a price without one
  currency: string | null;
  yearly: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;

// What the contracts cost together a year, per currency, the largest first
export function yearlyTotals(contracts: Contract[]): Total[] {
  const sums = new Map<string | null, number>();
  for (const c of contracts) if (c.yearly !== null) sums.set(c.currency, (sums.get(c.currency) ?? 0) + c.yearly);
  return [...sums.entries()].map(([currency, yearly]) => ({ currency, yearly: cents(yearly) })).sort((a, b) => b.yearly - a.yearly);
}

export const monthly = (total: Total): Total => ({ currency: total.currency, yearly: cents(total.yearly / 12) });

export interface Summary {
  totals: Total[];
  count: number;
  // Counted, but the documents don't say what they cost
  unpriced: number;
}

// The active contracts: what they cost together, and how many there are
export function summary(contracts: Contract[]): Summary {
  const active = contracts.filter(c => c.status === 'active');
  return { totals: yearlyTotals(active), count: active.length, unpriced: active.filter(c => c.yearly === null).length };
}

// Can be cancelled any month now: it goes on month by month, and no last day to cancel more than a month off says
// a minimum term still runs
export const anyMonth = (c: Contract, today = localToday()) => c.renewal === 'month' && !(c.cancelBy && c.cancelBy > shiftDate(today, 31));

// The last day to cancel is close (today included)
export const cancelIsSoon = (c: Contract, today = localToday()) =>
  !!c.cancelBy && c.cancelBy >= today && c.cancelBy <= shiftDate(today, CANCEL_SOON_DAYS);

// Active contracts whose last day to cancel is close, soonest first: the chances to switch. Those that can be
// cancelled any month are left out, as there is another chance next month.
export function cancelSoon(contracts: Contract[], today = localToday()): Contract[] {
  return contracts
    .filter(c => c.status === 'active' && !anyMonth(c, today) && cancelIsSoon(c, today))
    .sort((a, b) => a.cancelBy!.localeCompare(b.cancelBy!) || a.name.localeCompare(b.name));
}

export interface KindGroup {
  kind: ContractKind;
  label: string;
  // Active ones first, then those cancelled; the dearest first
  contracts: Contract[];
  // What the active ones cost a year
  totals: Total[];
}

const KINDS = Object.keys(CONTRACT_KINDS) as ContractKind[];

const byStatusAndPrice = (a: Contract, b: Contract) =>
  (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || (b.yearly ?? 0) - (a.yearly ?? 0) || a.name.localeCompare(b.name);

// The active and cancelled contracts by kind, in the order of CONTRACT_KINDS (ended ones are listed apart).
// `hidden`: topics just hidden as not contracts, listed in their place (to undo) but not counted.
export function byKind(contracts: Contract[], hidden: ReadonlySet<string> = new Set()): KindGroup[] {
  return KINDS.map(kind => {
    const list = contracts.filter(c => c.kind === kind && c.status !== 'ended').sort(byStatusAndPrice);
    const counted = list.filter(c => c.status === 'active' && !hidden.has(c.topic));
    return { kind, label: CONTRACT_KINDS[kind], contracts: list, totals: yearlyTotals(counted) };
  }).filter(g => g.contracts.length > 0);
}

// Ended contracts, the most recently ended first
export const ended = (contracts: Contract[]): Contract[] =>
  contracts.filter(c => c.status === 'ended').sort((a, b) => (b.endsOn ?? '').localeCompare(a.endsOn ?? '') || a.name.localeCompare(b.name));
