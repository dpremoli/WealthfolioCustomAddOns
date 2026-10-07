import { describe, it, expect } from 'vitest';

describe('Auto-create account logic', () => {
  describe('duplicate prevention', () => {
    it('should not create duplicate accounts with same name', () => {
      const wfAccounts = [{ id: 'acc-1', name: 'Monzo (12345678)' }];
      const monzoAccounts = [
        { id: 'monzo-1', account_number: '12345678', description: 'Current Account' },
      ];

      const wfAccountNames = new Set(wfAccounts.map((a) => a.name));
      const created: string[] = [];

      for (const acc of monzoAccounts) {
        const name = acc.account_number
          ? `Monzo (${acc.account_number})`
          : `Monzo ${acc.description}`;

        if (wfAccounts.find((a) => a.name === name)) continue;
        if (wfAccountNames.has(name)) continue;

        wfAccountNames.add(name);
        created.push(name);
      }

      expect(created).toHaveLength(0);
      expect(wfAccountNames.size).toBe(1);
    });

    it('should prevent concurrent execution with running guard', () => {
      const autoCreatingRef = { current: false };
      let executionCount = 0;

      const executeAutoCreate = () => {
        if (autoCreatingRef.current) return;
        autoCreatingRef.current = true;
        executionCount++;
        autoCreatingRef.current = false;
      };

      executeAutoCreate();
      autoCreatingRef.current = true; // Simulate still running
      executeAutoCreate(); // Blocked
      executeAutoCreate(); // Blocked
      autoCreatingRef.current = false;

      expect(executionCount).toBe(1);
    });

    it('should map unmapped Monzo accounts to existing Wealthfolio accounts', () => {
      const savedMapping: Record<string, string> = {};
      const wfAccounts = [{ id: 'wf-1', name: 'Monzo (12345678)' }];
      const monzoAccounts = [
        { id: 'monzo-1', account_number: '12345678', description: 'Current' },
      ];

      const newMapping: Record<string, string> = { ...savedMapping };
      const created: string[] = [];

      for (const acc of monzoAccounts) {
        const name = acc.account_number
          ? `Monzo (${acc.account_number})`
          : `Monzo ${acc.description}`;
        const existing = wfAccounts.find((a) => a.name === name);
        if (existing) {
          newMapping[acc.id] = existing.id;
          continue;
        }
        created.push(name);
      }

      expect(newMapping['monzo-1']).toBe('wf-1');
      expect(created).toHaveLength(0);
    });

    it('should detect stale mappings pointing to deleted accounts', () => {
      const savedMapping: Record<string, string> = { 'monzo-1': 'wf-deleted-id' };
      const wfAccounts = [{ id: 'wf-1', name: 'Monzo (12345678)' }];
      const wfAccountIds = new Set(wfAccounts.map((a) => a.id));
      const monzoAccounts = [{ id: 'monzo-1', account_number: '12345678' }];

      const unmapped = monzoAccounts.filter((acc) => {
        const mappedId = savedMapping[acc.id];
        return !mappedId || !wfAccountIds.has(mappedId);
      });

      expect(unmapped).toHaveLength(1);
      expect(unmapped[0].id).toBe('monzo-1');
    });
  });
});
