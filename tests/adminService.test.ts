import { describe, expect, it, vi } from 'vitest';
import { DeployTracker } from '@/application/deployProgress';
import { batches, registerMissing, stagedDeploy, validateDeploy, type EscrowAdminGateway } from '@/application/adminService';
import { MemoryStore } from '@/infrastructure/storage/kv';
import type { DeployParams } from '@/domain/escrow';

const h = (n: number) => n.toString(16).padStart(2, '0').repeat(32);
const params: DeployParams = { adminRoleId: h(1), buyerRoleId: h(2), sellerRoleId: h(3), tokenColor: h(4), ticker: 'EURe' };

function fakeGateway(missing: string[]): EscrowAdminGateway & { registered: string[] } {
  const registered: string[] = [];
  return {
    contractAddress: h(9),
    registered,
    missingCircuits: async () => missing.filter((c) => !registered.includes(c)),
    registerCircuits: async (cs) => (registered.push(...cs), { txId: cs.join('+'), txHash: cs.join('+') }),
    configure: async () => ({ txId: '', txHash: '' }),
    finalize: async () => ({ txId: '', txHash: '' })
  };
}

describe('validateDeploy', () => {
  it('accepts a complete, distinct set of roles', () => expect(validateDeploy(params)).toBeNull());
  it('rejects malformed ids', () => expect(validateDeploy({ ...params, buyerRoleId: 'xyz' })).toMatch(/Buyer role id/));
  it('rejects duplicate roles', () => expect(validateDeploy({ ...params, sellerRoleId: params.buyerRoleId })).toMatch(/distinct/));
  it('rejects an empty ticker', () => expect(validateDeploy({ ...params, ticker: ' ' })).toMatch(/Ticker/));
  it('rejects a dispute deadline before the closing deadline', () =>
    expect(validateDeploy({ ...params, terms: { closingDeadline: 100n, disputeDeadline: 50n } })).toMatch(/dispute deadline/));
});

describe('stagedDeploy', () => {
  it('saves the address as soon as the deploy confirms and registers the rest', async () => {
    const tracker = new DeployTracker();
    const store = new MemoryStore();
    const gw = fakeGateway(['a', 'b', 'c']);
    const out = await stagedDeploy({ tracker, store, deploy: async () => ({ gateway: gw, receipt: { txId: '1', txHash: 'h' } }) }, params);
    expect(out.gateway).toBe(gw);
    expect(await store.get('admin:contract')).toBe(h(9));
    expect(gw.registered).toEqual(['a', 'b', 'c']);
    expect(tracker.snapshot?.status).toBe('success');
    expect(tracker.snapshot?.steps.filter((s) => s.id.startsWith('register:'))).toHaveLength(1);
  });

  it('fails validation without touching the chain', async () => {
    const tracker = new DeployTracker();
    const deploy = vi.fn();
    await expect(stagedDeploy({ tracker, store: new MemoryStore(), deploy }, { ...params, ticker: '' })).rejects.toThrow(/Ticker/);
    expect(deploy).not.toHaveBeenCalled();
    expect(tracker.snapshot?.status).toBe('failed');
  });

  it('keeps the address when a registration fails, and resumes with only the missing circuits', async () => {
    const tracker = new DeployTracker();
    const store = new MemoryStore();
    const gw = fakeGateway(['a', 'b']);
    const real = gw.registerCircuits;
    gw.registerCircuits = vi.fn(async (cs: string[]) => {
      if (cs.includes('b')) throw new Error('refused by wallet');
      return real(cs);
    });
    await expect(stagedDeploy({ tracker, store, deploy: async () => ({ gateway: gw, receipt: { txId: '1', txHash: 'h' } }) }, params)).rejects.toThrow('refused');
    expect(await store.get('admin:contract')).toBe(h(9)); // nothing lost
    expect(gw.registered).toEqual([]); // the whole batch failed: nothing half-registered

    gw.registerCircuits = real;
    const t2 = new DeployTracker();
    t2.start('wallet', []);
    await registerMissing(gw, t2);
    expect(gw.registered).toEqual(['a', 'b']);
  });
});

describe('batched registration (5 circuits at deploy, then batches of 4)', () => {
  it('splits the 20 remaining circuits into 5 maintenance transactions of 4', () => {
    const rest = Array.from({ length: 20 }, (_, i) => `c${i}`);
    expect(batches(rest, 4).map((b) => b.length)).toEqual([4, 4, 4, 4, 4]);
    expect(batches(['a', 'b', 'c', 'd', 'e'], 4)).toEqual([['a', 'b', 'c', 'd'], ['e']]);
  });

  it('sends one registerCircuits call per batch and tracks one step per batch', async () => {
    const tracker = new DeployTracker();
    tracker.start('wallet', []);
    const missing = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const gw = fakeGateway(missing);
    const spy = vi.spyOn(gw, 'registerCircuits');
    await registerMissing(gw, tracker, 4);
    expect(spy.mock.calls.map(([cs]) => cs)).toEqual([['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h'], ['i']]);
    expect(tracker.snapshot?.steps.filter((s) => s.id.startsWith('register:'))).toHaveLength(3);
    expect(gw.registered).toEqual(missing);
  });
});
