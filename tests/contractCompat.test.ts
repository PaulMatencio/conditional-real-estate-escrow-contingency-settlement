/**
 * CLAUDE.md "Contract updates must not break the dApp": an escrow deployed by another build, or a page built against
 * another compile, ends in one clear CONTRACT_VERSION error, never a bare 404 or a misread ledger.
 */
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import { allCircuitIds } from '@/infrastructure/contract/compiled';
import {
  assertCompatible,
  buildFingerprint,
  bundleDrift,
  decodeCompatible,
  foreignCircuitsOf,
  isContractVersionError,
  proofCircuitsOf
} from '@/infrastructure/contract/compat';
import { GuardedZkConfigProvider } from '@/infrastructure/contract/guardedZkConfig';
import { createHealthProbes } from '@/infrastructure/health/probes';
import contractInfo from '@contract/managed/escrow/compiler/contract-info.json';

const ADDR = 'ab'.repeat(32);
const build = allCircuitIds();
const olderOnChain = [...build.filter((c) => c !== 'depositToEscrow'), 'submitFinancing'];

describe('escrow deployed with another contract version', () => {
  it('names the circuits this build does not know', () => {
    expect(foreignCircuitsOf(olderOnChain)).toEqual(['submitFinancing']);
    expect(foreignCircuitsOf(build)).toEqual([]);
  });

  it('is refused with CONTRACT_VERSION before anything else', () => {
    expect(() => assertCompatible(ADDR, olderOnChain)).toThrowError(/older contract version.*submitFinancing/);
    try {
      assertCompatible(ADDR, olderOnChain);
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('CONTRACT_VERSION');
      expect(isContractVersionError(e)).toBe(true);
      expect(isContractVersionError(new Error('wrapped', { cause: e }))).toBe(true);
    }
    expect(() => assertCompatible(ADDR, build)).not.toThrow();
  });

  it('a staged deploy (circuits not registered yet) is not an older version', () => {
    expect(() => assertCompatible(ADDR, build.slice(0, 3))).not.toThrow();
  });

  it('a ledger that does not decode with this layout is an older version, not a crash', () => {
    const decode = vi.fn((): EscrowView => {
      throw new TypeError("Cannot read properties of undefined (reading 'asArray')");
    });
    expect(() => decodeCompatible(ADDR, build, decode)).toThrowError(/older contract version.*ledger layout/);
    try {
      decodeCompatible(ADDR, build, decode);
    } catch (e) {
      expect(isContractVersionError(e)).toBe(true);
    }
  });

  it('unknown circuits stop it before the ledger is even decoded', () => {
    const decode = vi.fn((): EscrowView => ({}) as EscrowView);
    expect(() => decodeCompatible(ADDR, olderOnChain, decode)).toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it('an AppError from the decoder (e.g. a ledger-8 contract) passes through unchanged', () => {
    const own = new AppError('CONTRACT_REJECTED', 'no escrow here');
    expect(() =>
      decodeCompatible(ADDR, build, () => {
        throw own;
      })
    ).toThrow(own);
  });
});

describe('ZK artefacts', () => {
  const okFetch = () => vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

  it('a circuit this build lacks is refused without any request', async () => {
    const fetchFunc = okFetch();
    const zk = new GuardedZkConfigProvider('http://localhost:3000/zk/escrow', { fetchFunc: fetchFunc as never });
    await expect(zk.getVerifierKey('submitFinancing')).rejects.toMatchObject({ code: 'CONTRACT_VERSION' });
    await expect(zk.getProverKey('submitFinancing')).rejects.toMatchObject({ code: 'CONTRACT_VERSION' });
    await expect(zk.getZKIR('submitFinancing')).rejects.toMatchObject({ code: 'CONTRACT_VERSION' });
    expect(fetchFunc).not.toHaveBeenCalled();
  });

  it('a 404 for a circuit this build has means page and server differ: clear restart message', async () => {
    const fetchFunc = vi.fn(async () => new Response('Not found', { status: 404, statusText: 'Not Found' }));
    const zk = new GuardedZkConfigProvider('http://localhost:3000/zk/escrow', { fetchFunc: fetchFunc as never }, () => ['configure']);
    await expect(zk.getVerifierKey('configure')).rejects.toThrowError(/Restart the dApp/);
    expect(fetchFunc).toHaveBeenCalled();
  });
});

describe('page built against another compile', () => {
  it('reads the server circuits from contract-info.json and reports the drift', () => {
    const server = proofCircuitsOf(contractInfo)!;
    expect(server).toEqual([...build].sort());
    expect(bundleDrift(server)).toEqual({ added: [], removed: [] });
    expect(bundleDrift([...server, 'newCircuit'], [...build, 'submitFinancing'])).toEqual({ added: ['newCircuit'], removed: ['submitFinancing'] });
    expect(proofCircuitsOf({})).toBeNull();
  });

  it('the Health window flags it', async () => {
    const cfg = { indexer: 'i', indexerHttp: 'i', indexerWS: 'w', proofServer: 'p', nodeRpc: 'n', networkId: 'preview', zkBase: '/zk/escrow', keyCircuit: 'configure', caspBase: '/api/casp' };
    const env = {
      fetch: (async (u: string) =>
        String(u).endsWith('contract-info.json') ? new Response(JSON.stringify(contractInfo), { status: 200 }) : new Response('{}', { status: 200 })) as typeof fetch
    };
    const connector = { getState: () => ({ status: 'idle' }) } as never;
    const zk = (buildCircuits: readonly string[]) => createHealthProbes({ ...cfg, buildCircuits }, connector, env).find((p) => p.id === 'zk-artifacts')!.run(new AbortController().signal);
    expect(await zk(build)).toEqual({ status: 'ok' });
    expect(await zk([...build, 'submitFinancing'])).toEqual({ status: 'degraded', detail: { code: 'stale-bundle', info: '−submitFinancing' } });
  });
});

describe('build fingerprint', () => {
  it('is stable for this build', async () => {
    const a = await buildFingerprint();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(await buildFingerprint()).toBe(a);
  });
});
