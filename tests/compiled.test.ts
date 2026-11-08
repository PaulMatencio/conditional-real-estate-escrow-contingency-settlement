import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CIRCUITS } from '../sdk/escrow/types';
import { EscrowClient } from '../sdk/escrow/client';
import { contractConfig } from '@/infrastructure/config/network';
import { allCircuitIds } from '@/infrastructure/contract/compiled';
import { pureCircuits } from '@/infrastructure/contract/module';
import { roleIdHex } from '@/infrastructure/crypto/identity';

const managed = path.resolve(contractConfig.managedDir);

describe('compiled contract (full ZK build)', () => {
  it('has a prover and verifier key for every circuit', () => {
    const keys = readdirSync(path.join(managed, 'keys'));
    for (const c of allCircuitIds()) {
      expect(keys, c).toContain(`${c}.prover`);
      expect(keys, c).toContain(`${c}.verifier`);
    }
    expect(existsSync(path.join(managed, 'zkir', 'configure.bzkir'))).toBe(true);
  });

  it('exposes the same circuits to the app, the SDK and the compiler', () => {
    const info = JSON.parse(readFileSync(path.join(managed, 'compiler/contract-info.json'), 'utf8'));
    const provable = info.circuits.filter((c: { pure: boolean; proof: boolean }) => !c.pure && c.proof !== false).map((c: { name: string }) => c.name);
    expect([...allCircuitIds()].sort()).toEqual([...provable].sort());
    expect([...CIRCUITS].sort()).toEqual([...provable].sort());
  });

  it('keeps the staged-deploy core circuits inside the contract', () => {
    const all = allCircuitIds();
    expect(contractConfig.deployCircuits.length).toBeGreaterThan(0);
    for (const c of contractConfig.deployCircuits) expect(all, c).toContain(c);
    expect(contractConfig.deployCircuits.length).toBeLessThan(all.length);
  });
});

describe('generated SDK', () => {
  it('has one method per circuit', () => {
    const proto = Object.getOwnPropertyNames(EscrowClient.prototype);
    for (const c of CIRCUITS) expect(proto, c).toContain(c);
  });
});

describe('role ids', () => {
  it('roleIdHex is the contract\'s own roleIdOf', () => {
    const sk = new Uint8Array(32).fill(7);
    expect(roleIdHex(sk)).toBe(Buffer.from(pureCircuits.roleIdOf(sk)).toString('hex'));
    expect(roleIdHex(sk)).toHaveLength(64);
  });

  it('different keys give different ids', () => {
    expect(roleIdHex(new Uint8Array(32).fill(1))).not.toBe(roleIdHex(new Uint8Array(32).fill(2)));
  });
});
