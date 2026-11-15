import type { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type { IndexerBreaker } from './indexerBreaker';

export type Pdp = ReturnType<typeof indexerPublicDataProvider>;

type AnyFn = (...x: never[]) => Promise<unknown>;
const call = (p: Pdp, name: string, args: never[]) => ((p as unknown as Record<string, AnyFn>)[name])(...args);

const LOOKUPS = ['queryContractState', 'queryZSwapAndContractState', 'queryUnshieldedBalances', 'queryDeployContractState'] as const;
const WATCHES = ['watchForTxData', 'watchForDeployTxData'] as const;

/**
 * Indexer reads with a fallback. Wallets report their own indexer, and not all of them index the same data (Lace in
 * Brave reports Blockfrost's Midnight service; 1AM reports its own): contract state and history can be missing there
 * even though the contract exists. The configured indexer (`midnight.config.json`) is tried first; the wallet's is the
 * fallback. Lookups return the first non-empty answer; "watch" promises resolve with whichever indexer sees the data first.
 *
 * With a `breaker`, a failing configured indexer is skipped for a cooldown (lookups and watches use the wallet's
 * indexer directly) instead of being retried — and failing — on every query.
 */
export function withFallback(primary: Pdp, fallback: Pdp, breaker?: IndexerBreaker): Pdp {
  const usePrimary = () => !breaker || breaker.shouldTry();

  const lookup = async (name: string, args: never[]): Promise<unknown> => {
    if (usePrimary()) {
      try {
        const r = await call(primary, name, args);
        breaker?.succeeded();
        if (r !== null && r !== undefined) return r;
      } catch (e) {
        breaker?.failed(e);
        /* fall through to the wallet's indexer */
      }
    }
    return call(fallback, name, args);
  };

  const watch = (name: string, args: never[]): Promise<unknown> => {
    if (!usePrimary()) return call(fallback, name, args);
    const fromPrimary = call(primary, name, args).catch((e) => {
      breaker?.failed(e);
      throw e;
    });
    return Promise.any([fromPrimary, call(fallback, name, args)]);
  };

  const overrides: Record<string, (...args: never[]) => unknown> = {};
  for (const n of LOOKUPS) overrides[n] = (...a: never[]) => lookup(n, a);
  for (const n of WATCHES) overrides[n] = (...a: never[]) => watch(n, a);

  return new Proxy(primary, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
}
