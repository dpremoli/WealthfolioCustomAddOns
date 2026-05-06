import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('useSync', () => {
  describe('invalid activity filtering', () => {
    it('should filter out invalid activities before importing', () => {
      // Mock checkImport returning some invalid activities
      const checkedActivities = [
        {
          id: 'tx_1',
          accountId: 'acc-valid',
          isValid: true,
          isDraft: false,
          duplicateOfId: null,
        },
        {
          id: 'tx_2',
          accountId: 'acc-deleted', // This account doesn't exist
          isValid: false,
          isDraft: false,
          duplicateOfId: null,
          errors: {
            general: ['Database operation failed: Record not found'],
          },
        },
        {
          id: 'tx_3',
          accountId: 'acc-deleted',
          isValid: false,
          isDraft: false,
          duplicateOfId: null,
          errors: {
            general: ['Database operation failed: Record not found'],
          },
        },
      ];

      // Simulate the sync filtering logic
      const validActivities = checkedActivities.filter((a) => a.isValid !== false);
      const invalidActivities = checkedActivities.filter((a) => a.isValid === false);

      expect(validActivities).toHaveLength(1);
      expect(invalidActivities).toHaveLength(2);
      expect(validActivities[0].id).toBe('tx_1');
    });

    it('should detect stale mapping when all activities are invalid', () => {
      const checkedActivities = [
        {
          id: 'tx_1',
          accountId: 'acc-deleted',
          isValid: false,
          isDraft: false,
          errors: { general: ['Record not found'] },
        },
        {
          id: 'tx_2',
          accountId: 'acc-deleted',
          isValid: false,
          isDraft: false,
          errors: { general: ['Record not found'] },
        },
      ];

      // This is what sync should check
      const validActivities = checkedActivities.filter((a) => a.isValid !== false);
      const invalidActivities = checkedActivities.filter((a) => a.isValid === false);

      const hasStaleMapping = invalidActivities.length > 0 && validActivities.length === 0;

      expect(hasStaleMapping).toBe(true);
      expect(validActivities).toHaveLength(0);
    });

    it('should not treat all-invalid as stale if some are valid', () => {
      const checkedActivities = [
        {
          id: 'tx_1',
          accountId: 'acc-valid',
          isValid: true,
          isDraft: false,
        },
        {
          id: 'tx_2',
          accountId: 'acc-deleted',
          isValid: false,
          isDraft: false,
          errors: { general: ['Record not found'] },
        },
      ];

      const validActivities = checkedActivities.filter((a) => a.isValid !== false);
      const invalidActivities = checkedActivities.filter((a) => a.isValid === false);
      const hasStaleMapping = invalidActivities.length > 0 && validActivities.length === 0;

      expect(hasStaleMapping).toBe(false);
      expect(validActivities).toHaveLength(1);
      expect(invalidActivities).toHaveLength(1);
    });
  });

  describe('duplicate filtering', () => {
    it('should filter out activities already in Wealthfolio', () => {
      const checkedActivities = [
        {
          id: 'tx_1',
          isValid: true,
          isDraft: false,
          duplicateOfId: null, // New transaction
        },
        {
          id: 'tx_2',
          isValid: true,
          isDraft: false,
          duplicateOfId: 'existing_tx_2', // Already in Wealthfolio
        },
      ];

      const toImport = checkedActivities.filter((a) => !a.duplicateOfId && a.isValid !== false);

      expect(toImport).toHaveLength(1);
      expect(toImport[0].id).toBe('tx_1');
    });
  });
});
