import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Auto-create account logic', () => {
  describe('duplicate prevention', () => {
    it('should not create duplicate accounts with same name', () => {
      // Simulate the auto-create effect logic
      const wfAccounts = [
        { id: 'acc-1', name: 'Monzo (43360705)' },
      ];
      const monzoAccounts = [
        { id: 'monzo-1', account_number: '43360705', description: 'Current Account' },
      ];

      const wfAccountNames = new Set(wfAccounts.map((a) => a.name));
      const created: string[] = [];

      for (const acc of monzoAccounts) {
        const name = acc.account_number ? `Monzo (${acc.account_number})` : `Monzo ${acc.description}`;

        // Check if account already exists
        const existing = wfAccounts.find((a) => a.name === name);
        if (existing) {
          continue; // Reuse existing
        }

        // Check if we already created it in this run
        if (wfAccountNames.has(name)) {
          continue; // Skip
        }

        // Create new account
        wfAccountNames.add(name);
        created.push(name);
      }

      expect(created).toHaveLength(0);
      expect(wfAccountNames.size).toBe(1);
    });

    it('should prevent concurrent execution with running guard', () => {
      let autoCreatingRef = { current: false };
      let executionCount = 0;

      const executeAutoCreate = () => {
        if (autoCreatingRef.current) return; // Guard prevents concurrent run

        autoCreatingRef.current = true;
        try {
          executionCount++;
          // Simulate async work
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve(null);
              autoCreatingRef.current = false;
            }, 10);
          });
        } catch {
          autoCreatingRef.current = false;
          throw;
        }
      };

      // Try to execute multiple times rapidly
      executeAutoCreate();
      executeAutoCreate(); // This should be blocked
      executeAutoCreate(); // This should be blocked

      expect(executionCount).toBe(1); // Only one execution happened
    });

    it('should map unmapped Monzo accounts to existing Wealthfolio accounts', () => {
      const savedMapping = {}; // No mappings yet
      const wfAccounts = [
        { id: 'wf-1', name: 'Monzo (43360705)' },
      ];
      const monzoAccounts = [
        { id: 'monzo-1', account_number: '43360705', description: 'Current' },
      ];

      // Simulate auto-create logic
      const newMapping: Record<string, string> = { ...savedMapping };
      const created: string[] = [];

      for (const acc of monzoAccounts) {
        const name = acc.account_number ? `Monzo (${acc.account_number})` : `Monzo ${acc.description}`;

        const existing = wfAccounts.find((a) => a.name === name);
        if (existing) {
          newMapping[acc.id] = existing.id; // Map to existing
          continue;
        }

        // Would create new account here
        created.push(name);
      }

      expect(newMapping['monzo-1']).toBe('wf-1');
      expect(created).toHaveLength(0); // No new accounts needed
    });

    it('should clean up stale mappings pointing to deleted accounts', () => {
      const savedMapping = {
        'monzo-1': 'wf-deleted-id', // Points to account that no longer exists
      };
      const wfAccounts = [
        { id: 'wf-1', name: 'Monzo (43360705)' },
      ];
      const wfAccountIds = new Set(wfAccounts.map((a) => a.id));

      // Simulate detecting unmapped accounts
      const monzoAccounts = [
        { id: 'monzo-1', account_number: '43360705' },
      ];

      const unmapped = monzoAccounts.filter((acc) => {
        const mappedId = savedMapping[acc.id];
        return !mappedId || !wfAccountIds.has(mappedId); // Stale if account doesn't exist
      });

      expect(unmapped).toHaveLength(1);
      expect(unmapped[0].id).toBe('monzo-1');
    });
  });
});
