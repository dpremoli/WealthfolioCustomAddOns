import { describe, it, expect } from 'vitest';
import { mapTransactionToActivity, isFlexRepayment, tallyByCategory } from './mapper';
import type { MonzoTransaction } from '../types';

function catTx(amount: number, category: string): MonzoTransaction {
  return {
    id: `t_${Math.random()}`,
    created: '2026-05-01T00:00:00.000Z',
    settled: '2026-05-01T00:00:00.000Z',
    amount,
    currency: 'GBP',
    description: '',
    notes: '',
    category,
    is_load: false,
    metadata: {},
  };
}

describe('tallyByCategory', () => {
  it('counts spending (debits) by resolved label and ignores credits', () => {
    const out = tallyByCategory([
      catTx(-500, 'eating_out'),
      catTx(-300, 'eating_out'),
      catTx(-1200, 'groceries'),
      catTx(2000, 'income'), // credit — ignored
    ]);
    expect(out).toEqual({ 'Eating Out': 2, Groceries: 1 });
  });

  it('applies user category-label overrides', () => {
    const out = tallyByCategory([catTx(-500, 'eating_out')], { eating_out: 'Dining' });
    expect(out).toEqual({ Dining: 1 });
  });

  it('returns an empty object when there is no spending', () => {
    expect(tallyByCategory([catTx(1000, 'income')])).toEqual({});
  });
});

describe('mapTransactionToActivity', () => {
  it('should map a withdrawal transaction correctly', () => {
    const tx: MonzoTransaction = {
      id: 'tx_001',
      created: '2026-05-01T14:30:00.000Z',
      settled: '2026-05-01T14:30:00.000Z',
      amount: -2500,
      currency: 'GBP',
      description: 'Coffee Shop',
      notes: '',
      category: 'eating_out',
      is_load: false,
      metadata: {},
    };

    const activity = mapTransactionToActivity(tx, 'acc-123');

    expect(activity.id).toBe('tx_001');
    expect(activity.accountId).toBe('acc-123');
    expect(activity.activityType).toBe('WITHDRAWAL');
    expect(activity.amount).toBe(25.0);
    expect(activity.currency).toBe('GBP');
    expect(activity.symbol).toBe('GBP');
    expect(activity.isValid).toBe(true);
    expect(activity.isDraft).toBe(false);
    // Must be full ISO timestamp, not just a date (fixes 1am display bug)
    expect(activity.date).toBe('2026-05-01T14:30:00.000Z');
  });

  it('should map a deposit transaction correctly', () => {
    const tx: MonzoTransaction = {
      id: 'tx_002',
      created: '2026-05-02T09:15:00.000Z',
      settled: '2026-05-02T09:15:00.000Z',
      amount: 100000,
      currency: 'GBP',
      description: 'Salary',
      notes: '',
      category: 'income',
      is_load: false,
      metadata: {},
    };

    const activity = mapTransactionToActivity(tx, 'acc-123');

    expect(activity.activityType).toBe('DEPOSIT');
    expect(activity.amount).toBe(1000.0);
  });

  it('should include merchant name and category in comment', () => {
    const tx: MonzoTransaction = {
      id: 'tx_003',
      created: '2026-05-03T12:00:00.000Z',
      settled: '2026-05-03T12:00:00.000Z',
      amount: -1599,
      currency: 'GBP',
      description: 'Restaurant',
      notes: '',
      category: 'eating_out', // Formatted as "Eating Out" in the comment
      is_load: false,
      metadata: {},
      merchant: {
        name: "Mario's Pizza",
        category: 'restaurant',
        address: {
          city: 'London',
          country: 'GB',
        },
      },
    };

    const activity = mapTransactionToActivity(tx, 'acc-123');

    expect(activity.comment).toContain("Mario's Pizza");
    expect(activity.comment).toContain('Eating Out'); // tx.category formatted, not merchant.category
    expect(activity.comment).toContain('London');
  });

  it('should include foreign currency info in comment', () => {
    const tx: MonzoTransaction = {
      id: 'tx_004',
      created: '2026-05-04T15:30:00.000Z',
      settled: '2026-05-04T15:30:00.000Z',
      amount: -5000,
      currency: 'GBP',
      local_amount: -4500,
      local_currency: 'EUR',
      description: 'Foreign transaction',
      notes: '',
      category: 'shopping',
      is_load: false,
      metadata: {},
    };

    const activity = mapTransactionToActivity(tx, 'acc-123');

    expect(activity.comment).toContain('EUR 45.00');
  });

  it('should default to GBP when currency is missing', () => {
    const tx: MonzoTransaction = {
      id: 'tx_005',
      created: '2026-05-05T10:00:00.000Z',
      settled: '2026-05-05T10:00:00.000Z',
      amount: -1000,
      currency: '',
      description: 'Unknown currency',
      notes: '',
      category: 'general',
      is_load: false,
      metadata: {},
    };

    const activity = mapTransactionToActivity(tx, 'acc-123');

    expect(activity.currency).toBe('GBP');
    expect(activity.symbol).toBe('GBP');
  });
});

describe('isFlexRepayment', () => {
  const base: MonzoTransaction = {
    id: 'tx_flex',
    created: '2026-05-06T10:00:00.000Z',
    settled: '2026-05-06T10:00:00.000Z',
    amount: -5000,
    currency: 'GBP',
    description: 'Flex',
    notes: '',
    category: 'transfers',
    is_load: false,
    metadata: {},
  };

  it('flags the monthly Flex repayment on the current account', () => {
    expect(isFlexRepayment(base)).toBe(true);
  });

  it('matches when the name comes from the merchant field', () => {
    const tx: MonzoTransaction = {
      ...base,
      description: '',
      merchant: { name: 'Monzo Flex' },
    };
    expect(isFlexRepayment(tx)).toBe(true);
  });

  it('does not flag a normal transfer', () => {
    const tx: MonzoTransaction = { ...base, description: 'Bank transfer' };
    expect(isFlexRepayment(tx)).toBe(false);
  });

  it('does not flag a Flex purchase (real merchant, not a transfer)', () => {
    const tx: MonzoTransaction = {
      ...base,
      category: 'groceries',
      description: 'Tesco',
      merchant: { name: 'Tesco' },
    };
    expect(isFlexRepayment(tx)).toBe(false);
  });
});
