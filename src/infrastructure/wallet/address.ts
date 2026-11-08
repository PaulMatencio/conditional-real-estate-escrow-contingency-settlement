/**
 * Midnight unshielded wallet addresses: Bech32m (`mn_addr_<network>1…`) ⇄ the 32 raw bytes the contract takes.
 * Loaded lazily — it pulls in the ledger WASM, which only wallet flows need.
 */
const HEX64 = /^[0-9a-fA-F]{64}$/;

/** Accepts `mn_addr_…` (Bech32m) or 64 hex characters; returns lowercase 64-hex UserAddress bytes. */
export async function walletAddressToHex(input: string, networkId: string): Promise<string> {
  const raw = input.trim();
  const noPrefix = raw.replace(/^0x/, '');
  if (HEX64.test(noPrefix)) return noPrefix.toLowerCase();
  if (!/^mn_addr_/i.test(raw)) {
    throw new Error('Expected a Midnight unshielded address (mn_addr_…) or 64 hex characters. Shielded (mn_shield-addr_…) and DUST addresses cannot receive this token.');
  }
  const { MidnightBech32m, UnshieldedAddress } = await import('@midnight-ntwrk/wallet-sdk-address-format');
  try {
    const a = UnshieldedAddress.codec.decode(networkId, MidnightBech32m.parse(raw));
    return Buffer.from(a.data).toString('hex');
  } catch (e) {
    throw new Error(`Not a valid ${networkId} unshielded address: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 64-hex UserAddress bytes → `mn_addr_<network>1…`. */
export async function hexToWalletAddress(hex: string, networkId: string): Promise<string> {
  const { UnshieldedAddress } = await import('@midnight-ntwrk/wallet-sdk-address-format');
  return UnshieldedAddress.codec.encode(networkId, new UnshieldedAddress(Buffer.from(hex, 'hex'))).asString();
}
