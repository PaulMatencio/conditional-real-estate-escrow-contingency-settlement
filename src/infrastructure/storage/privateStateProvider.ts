import type { PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';
import type { KeyValueStore } from '@/application/ports';
import type { SigningKeyStore } from './vaultInstance';

/** Legacy plaintext slot of a contract's authority key (read only by the vault migration). */
export const signingKeyStorageKey = (contractAddress: string) => `sk:${contractAddress}`;

/**
 * Set while a deploy runs: midnight-js then hands us the contract's real maintenance-authority key, which must be
 * persisted (encrypted). Outside a deploy, keys midnight-js invents on findDeployedContract stay in memory only.
 */
export const signingKeyCapture = { on: false };

const unsupported = async (): Promise<never> => {
  throw new Error('Export/import is not supported by this store');
};

/**
 * PrivateStateProvider on our stores (midnight-js 5 shape: per-contract private states via `forContract`). The escrow
 * has no on-chain private state (PS = undefined); the only secret midnight-js keeps here is the contract
 * maintenance-authority (signing) key, which goes to the encrypted vault.
 */
export function persistentPrivateStateProvider(store: KeyValueStore, keys: SigningKeyStore): PrivateStateProvider<string, unknown> {
  const memory = new Map<string, string>();
  const forContract = (address: string) => {
    const sKey = (id: string) => `ps:${address}:${id}`;
    return {
      contractAddress: address,
      set: async (id: string, state: unknown) => store.set(sKey(id), JSON.stringify(state ?? null)),
      get: async (id: string) => {
        const raw = await store.get(sKey(id));
        return raw === null ? null : (JSON.parse(raw) as unknown);
      },
      remove: async (id: string) => store.remove(sKey(id)),
      clear: async () => {
        for (const k of await store.keys(`ps:${address}:`)) await store.remove(k);
      },
      exportPrivateStates: unsupported,
      importPrivateStates: unsupported
    };
  };
  return {
    forContract,
    clearAll: async () => {
      for (const k of await store.keys('ps:')) await store.remove(k);
    },
    setSigningKey: async (a: string, key: unknown) => {
      memory.set(a, key as string);
      if (signingKeyCapture.on) await keys.save(a, key as string);
    },
    getSigningKey: async (a: string) => (await keys.load(a).catch(() => null)) ?? memory.get(a) ?? null,
    removeSigningKey: async (a: string) => {
      memory.delete(a);
      await keys.remove(a).catch(() => {});
    },
    clearSigningKeys: async () => memory.clear(),
    exportSigningKeys: unsupported,
    importSigningKeys: unsupported
  } as unknown as PrivateStateProvider<string, unknown>;
}
