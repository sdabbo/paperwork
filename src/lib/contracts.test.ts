import { describe, expect, it } from 'vitest';
import type { Contract } from '../../shared/types';
import { anyMonth, byKind, cancelSoon, ended, monthly, summary, yearlyTotals } from './contracts';

const today = '2026-10-20';

const contract = (name: string, fields: Partial<Contract> = {}): Contract => ({
  topic: name,
  name,
  kind: 'other',
  provider: null,
  reference: null,
  amount: null,
  currency: 'EUR',
  interval: null,
  yearly: null,
  since: null,
  renewal: 'year',
  renews: null,
  notice: null,
  noticePeriod: null,
  cancelBy: null,
  status: 'active',
  endsOn: null,
  latest: null,
  documentIds: [],
  documents: 1,
  ...fields,
});

describe('what the contracts cost', () => {
  it('sums the active ones per currency, the largest first, and counts those without a price', () => {
    const list = [
      contract('Car insurance', { yearly: 642.24 }),
      contract('Electricity', { yearly: 1104.6 }),
      contract('Gym', { yearly: 359.4 }),
      contract('Swiss account', { yearly: 120, currency: 'CHF' }),
      contract('Bank card', { yearly: null, currency: null }),
      contract('Old phone plan', { yearly: 240, status: 'cancelled' }),
      contract('Old electricity', { yearly: 900, status: 'ended' }),
    ];
    expect(summary(list)).toEqual({
      totals: [
        { currency: 'EUR', yearly: 2106.24 },
        { currency: 'CHF', yearly: 120 },
      ],
      count: 5,
      unpriced: 1,
    });
  });

  it('rounds to cents, a month too', () => {
    const [total] = yearlyTotals([contract('A', { yearly: 0.1 }), contract('B', { yearly: 0.2 })]);
    expect(total).toEqual({ currency: 'EUR', yearly: 0.3 });
    expect(monthly({ currency: 'EUR', yearly: 1000 })).toEqual({ currency: 'EUR', yearly: 83.33 });
  });

  it('has no totals when nothing has a price', () => {
    expect(summary([contract('A')])).toEqual({ totals: [], count: 1, unpriced: 1 });
  });
});

describe('contracts to cancel soon', () => {
  it('lists active ones whose last day to cancel is within 60 days, soonest first', () => {
    const list = [
      contract('Liability', { cancelBy: '2026-12-01' }),
      contract('Car', { cancelBy: '2026-11-10' }),
      contract('Household', { cancelBy: '2026-12-20' }),
      contract('Today', { cancelBy: today }),
      contract('Cancelled already', { cancelBy: '2026-11-01', status: 'cancelled' }),
      contract('No date'),
    ];
    expect(cancelSoon(list, today).map(c => c.name)).toEqual(['Today', 'Car', 'Liability']);
  });

  it('leaves out those that can be cancelled any month, but not one still in its minimum term', () => {
    const list = [
      contract('Streaming', { renewal: 'month', cancelBy: '2026-10-31' }),
      contract('Gym', { renewal: 'month', cancelBy: '2026-12-15', renews: '2027-01-01' }),
    ];
    expect(cancelSoon(list, today).map(c => c.name)).toEqual(['Gym']);
  });

  it('tells month-by-month contracts apart from those in a minimum term', () => {
    expect(anyMonth(contract('A', { renewal: 'month' }), today)).toBe(true);
    expect(anyMonth(contract('B', { renewal: 'month', cancelBy: '2026-11-19' }), today)).toBe(true);
    expect(anyMonth(contract('C', { renewal: 'month', cancelBy: '2027-02-28' }), today)).toBe(false);
    expect(anyMonth(contract('D', { renewal: 'year' }), today)).toBe(false);
  });
});

describe('contracts by kind', () => {
  it('groups active and cancelled ones in the order of the kinds, active first, the dearest first', () => {
    const list = [
      contract('Netflix', { kind: 'subscription', yearly: 167.88 }),
      contract('Old liability', { kind: 'insurance', yearly: 80, status: 'cancelled' }),
      contract('Liability', { kind: 'insurance', yearly: 61.2 }),
      contract('Car', { kind: 'insurance', yearly: 642.24 }),
      contract('Old electricity', { kind: 'energy', yearly: 900, status: 'ended' }),
      contract('Electricity', { kind: 'energy', yearly: 1104.6 }),
    ];
    const groups = byKind(list);
    expect(groups.map(g => [g.label, g.contracts.map(c => c.name)])).toEqual([
      ['Insurance', ['Car', 'Liability', 'Old liability']],
      ['Energy and water', ['Electricity']],
      ['Subscriptions', ['Netflix']],
    ]);
    // What the active ones cost: the cancelled one is on its way out
    expect(groups[0].totals).toEqual([{ currency: 'EUR', yearly: 703.44 }]);
  });

  it('keeps a contract just hidden in its place, without counting it', () => {
    const list = [contract('Car', { kind: 'insurance', yearly: 642.24 }), contract('Liability', { kind: 'insurance', yearly: 61.2 })];
    const [group] = byKind(list, new Set(['Liability']));
    expect(group.contracts.map(c => c.name)).toEqual(['Car', 'Liability']);
    expect(group.totals).toEqual([{ currency: 'EUR', yearly: 642.24 }]);
  });

  it('lists ended ones apart, the most recently ended first', () => {
    const list = [
      contract('A', { status: 'ended', endsOn: '2025-12-31' }),
      contract('B', { status: 'ended', endsOn: '2026-06-30' }),
      contract('C', { status: 'ended' }),
      contract('D'),
    ];
    expect(ended(list).map(c => c.name)).toEqual(['B', 'A', 'C']);
  });
});
