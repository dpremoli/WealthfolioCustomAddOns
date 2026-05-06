import { describe, it, expect } from 'vitest';
import { mapTransactionToActivity } from './mapper';
import type { MonzoTransaction } from '../types';

describe('mapTransactionToActivity', () => {
  it('should map a withdrawal transaction correctly', () => {
    const tx: MonzoTransaction = {
      id: 'tx_001',
      created: '2026-05-01T14:30:00.000Z',
      settled: '2026-05-01T14:30:00.000Z',
      amount: -2500, // GBP cents
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
    expect(activity.amount).toBe(25.0); // Converted to GBP
    expect(activity.currency).toBe('GBP');
    expect(activity.symbol).toBe('GBP');
    expect(activity.isValid).toBe(true);
    expect(activity.isDraft).toBe(false);
    // Date should be ISO timestamp, not just date
    expect(activity.date).toBe('2026-05-01T14:30:00.000Z');
  });

  it('should map a deposit transaction correctly', () => {
    const tx: MonzoTransaction = {
      id: 'tx_002',
      created: '2026-05-02T09:15:00.000Z',
      settled: '2026-05-02T09:15:00.000Z',
      amount: 100000, // GBP cents (£1000)
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

  it('should include merchant details in comment', () => {
    const tx: MonzoTransaction = {
      id: 'tx_003',
      created: '2026-05-03T12:00:00.000Z',
      settled: '2026-05-03T12:00:00.000Z',
      amount: -1599,
      currency: 'GBP',
      description: 'Restaurant',
      notes: '',
      category: 'eating_out',
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
    expect(activity.comment).toContain('London');
    expect(activity.comment).toContain('Restaurant'); // Category formatted
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

  it('should handle missing currency gracefully', () => {
    const tx: MonzoTransaction = {
      id: 'tx_005',
      created: '2026-05-05T10:00:00.000Z',
      settled: '2026-05-05T10:00:00.000Z',
      amount: -1000,
      currency: '', // Empty currency
      description: 'Unknown currency',
      notes: '',
      category: 'general',
      is_load: false,
      metadata: {},
    };

    const activity = mapTransactionToActivity(tx, 'acc-123');

    expect(activity.currency).toBe('GBP'); // Defaults to GBP
    expect(activity.symbol).toBe('GBP');
  });
});
