/**
 * Wallet-less, read-only access to an escrow's public ledger (notary portal FR-NOTARY-01, compliance console).
 * Talks only to the configured indexer (midnight.config.json, preview network).
 */
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { AppError } from '@/domain/errors';
import type { EscrowView } from '@/domain/escrowView';
import { indexerHttpUrl, networkConfig } from '../config/network';
import { readContractState } from '../contract/chainState';
import { maintenanceOf, toEscrowView, type LedgerInput } from '../contract/view';

let pdp: ReturnType<typeof indexerPublicDataProvider> | null = null;

function provider() {
  if (!pdp) {
    pdp = indexerPublicDataProvider(indexerHttpUrl(), networkConfig.indexerWS);
  }
  return pdp;
}

export async function readPublicView(contractAddress: string): Promise<EscrowView> {
  const addr = contractAddress.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(addr)) throw new AppError('VALIDATION', 'Contract address must be 64 hex characters.');
  const s = await readContractState(provider(), addr);
  if (!s) throw new AppError('CONTRACT_REJECTED', `No escrow at ${addr.slice(0, 10)}… on ${networkConfig.networkId}.`);
  return toEscrowView(addr, s.data as unknown as LedgerInput, maintenanceOf(s));
}
