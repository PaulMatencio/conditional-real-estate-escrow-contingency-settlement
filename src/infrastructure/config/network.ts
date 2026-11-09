import raw from '../../../midnight.config.json';

export interface NetworkConfig {
  networkId: string;
  indexer: string;
  indexerWS: string;
  nodeRpc: string;
  proofServer: string;
  faucet: string;
  explorer: string;
}

/** Contract build settings (`contract` block of midnight.config.json). */
export interface ContractConfig {
  source: string;
  name: string;
  managedDir: string;
  sdkDir: string;
  testsDir: string;
  /** compactc toolchain; must emit the runtime midnight-js expects (0.36.x ↔ runtime 0.21.0 ↔ ledger 9, midnight-js 5). */
  compilerVersion: string;
  /**
   * Circuits whose verifier keys go into the deploy transaction itself. The rest are registered in follow-up
   * maintenance transactions (staged deploy): a deploy carrying every key risks "exhaust the block limits".
   */
  deployCircuits: string[];
  /** Circuits registered per maintenance transaction after the deploy (default 4). */
  maintenanceBatchSize?: number;
}

export const networkConfig: NetworkConfig = raw as NetworkConfig;
export const contractConfig: ContractConfig = (raw as { contract: ContractConfig }).contract;

/** Verifier keys per maintenance transaction (staged deploy, phase 2). Clamped to 1..10. */
export const MAINTENANCE_BATCH_SIZE = Math.min(10, Math.max(1, Math.floor(contractConfig.maintenanceBatchSize ?? 4)));

export const explorerTxUrl = (hash: string) => `${networkConfig.explorer}/tx/${hash}`;
export const explorerContractUrl = (addr: string) => `${networkConfig.explorer}/contract/${addr}`;
