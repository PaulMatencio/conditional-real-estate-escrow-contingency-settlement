import { describe, expect, it } from 'vitest';
import { contractConfig } from '@/infrastructure/config/network';
import { allCircuitIds, makeCompiledContract } from '@/infrastructure/contract/compiled';

describe('staged deploy contract definition', () => {
  it('builds the full and the core-only compiled contract', () => {
    expect(allCircuitIds().length).toBeGreaterThan(contractConfig.deployCircuits.length);
    expect(() => makeCompiledContract(() => new Uint8Array(32))).not.toThrow();
    expect(() => makeCompiledContract(() => new Uint8Array(32), contractConfig.deployCircuits)).not.toThrow();
  });
});
