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
 * PrivateStateProvider on our stores. The escrow has no on-chain private state (PS = undefined); the only secret
 * midnight-js keeps here is the contract maintenance-authority (signing) key, which goes to the encrypted vault.
 */
export function persistentPrivateStateProvider(store: KeyValueStore, keys: SigningKeyStore): PrivateStateProvider<string, unknown> {
  let address = 'default';
  const sKey = (id: string) => `ps:${address}:${id}`;
  const memory = new Map<string, string>();
  return {
    setContractAddress: (a: string) => {
      address = a;
    },
    set: async (id, state) => store.set(sKey(id), JSON.stringify(state ?? null)),
    get: async (id) => {
      const raw = await store.get(sKey(id));
      return raw === null ? null : (JSON.parse(raw) as unknown);
    },
    remove: async (id) => store.remove(sKey(id)),
    clear: async () => {
      for (const k of await store.keys(`ps:${address}:`)) await store.remove(k);
    },
    setSigningKey: async (a, key) => {
      memory.set(a, key as string);
      if (signingKeyCapture.on) await keys.save(a, key as string);
    },
    getSigningKey: async (a) => (await keys.load(a).catch(() => null)) ?? memory.get(a) ?? null,
    removeSigningKey: async (a) => {
      memory.delete(a);
      await keys.remove(a).catch(() => {});
    },
    clearSigningKeys: async () => memory.clear(),
    exportPrivateStates: unsupported,
    importPrivateStates: unsupported,
    exportSigningKeys: unsupported,
    importSigningKeys: unsupported
  } as PrivateStateProvider<string, unknown>;
}
