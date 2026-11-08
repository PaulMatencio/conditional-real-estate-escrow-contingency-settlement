/**
 * Admin use-cases: staged deploy with resume, circuit registration, delayed initialization.
 * Orchestration only — chain access goes through the AdminGateway adapter, progress through the DeployTracker.
 */
import { AppError } from '@/domain/errors';
import { isHex32 } from '@/domain/hex';
import type { AdminState, ConfigureTerms, DeployParams, TxReceipt } from '@/domain/escrow';
import type { DeployTracker, StepDef } from './deployProgress';
import type { KeyValueStore } from './ports';

export const CONTRACT_SLOT = 'admin:contract';

/** Port: what the use-cases need from the chain adapter (implemented by infrastructure/gateway/adminGateway). */
export interface EscrowAdminGateway {
  readonly contractAddress: string;
  missingCircuits(): Promise<string[]>;
  /** One maintenance transaction inserting the verifier keys of all given circuits. */
  registerCircuits(circuits: string[]): Promise<TxReceipt>;
  configure(terms: ConfigureTerms): Promise<TxReceipt>;
  finalize(): Promise<TxReceipt>;
}

export function validateDeploy(p: DeployParams): string | null {
  for (const [label, v] of [
    ['Admin role id', p.adminRoleId],
    ['Buyer role id', p.buyerRoleId],
    ['Seller role id', p.sellerRoleId],
    ['Token color', p.tokenColor]
  ] as const) {
    if (!isHex32(v)) return `${label} must be 64 hex characters.`;
  }
  const ids = [p.adminRoleId, p.buyerRoleId, p.sellerRoleId].map((s) => s.trim().toLowerCase().replace(/^0x/, ''));
  if (new Set(ids).size !== 3) return 'Admin, buyer and seller must be three distinct roles.';
  if (!p.ticker.trim() || p.ticker.length > 12) return 'Ticker must be 1–12 characters.';
  const t = p.terms;
  if (t?.closingDeadline !== undefined && t.disputeDeadline !== undefined && t.disputeDeadline <= t.closingDeadline) {
    return 'The dispute deadline must be after the closing deadline.';
  }
  return null;
}

/** Splits the circuits into maintenance-transaction batches (the deploy already carried the core ones). */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

const registerStep = (group: string[], i: number, n: number): StepDef => ({
  id: `register:${group.join('+')}`,
  labelKey: 'deploy.step.submit',
  label: `Register ${group.length} circuit${group.length > 1 ? 's' : ''} (batch ${i}/${n}): ${group.join(', ')}`
});

/**
 * Registers the missing circuits in batches of `batchSize` verifier keys per maintenance transaction (default 4).
 * Resumable: it asks the chain what is still missing, so a failed batch is simply retried on the next run.
 */
export async function registerMissing(gw: EscrowAdminGateway, tracker: DeployTracker, batchSize = 4): Promise<void> {
  const missing = await gw.missingCircuits();
  if (missing.length === 0) return;
  const groups = batches(missing, batchSize);
  tracker.extend(groups.map((g, i) => registerStep(g, i + 1, groups.length)));
  for (const [i, g] of groups.entries()) {
    const id = registerStep(g, i + 1, groups.length).id;
    tracker.begin(id);
    await gw.registerCircuits(g);
    tracker.done(id);
  }
}

export interface DeployDeps {
  tracker: DeployTracker;
  store: KeyValueStore;
  /** Verifier keys per maintenance transaction (midnight.config.json `contract.maintenanceBatchSize`). */
  batchSize?: number;
  deploy(p: DeployParams): Promise<{ gateway: EscrowAdminGateway & { contractAddress: string }; receipt: TxReceipt }>;
}

/** Staged deploy: core circuits in the deploy transaction, the rest in batches by maintenance transactions. */
export async function stagedDeploy(deps: DeployDeps, params: DeployParams): Promise<{ gateway: EscrowAdminGateway; receipt: TxReceipt }> {
  const { tracker, store } = deps;
  tracker.start('wallet', undefined, 'Deploy escrow');
  tracker.begin('validate');
  const problem = validateDeploy(params);
  if (problem) {
    tracker.fail(problem, 'validate');
    throw new AppError('VALIDATION', problem);
  }
  tracker.done('validate');
  tracker.begin('build');
  try {
    const out = await deps.deploy(params);
    tracker.done('confirm');
    tracker.begin('save');
    // Saved the moment phase 1 confirms, so a failure in phase 2 loses nothing.
    await store.set(CONTRACT_SLOT, out.gateway.contractAddress);
    tracker.done('save');
    await registerMissing(out.gateway, tracker, deps.batchSize);
    tracker.succeed({ contractAddress: out.gateway.contractAddress, txHash: out.receipt.txHash });
    return out;
  } catch (e) {
    tracker.fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Runs one contract action under its own progress run. */
export async function runAction<T>(tracker: DeployTracker, title: string, fn: () => Promise<T>): Promise<T> {
  tracker.start('wallet', undefined, title);
  tracker.begin('validate');
  tracker.done('validate');
  tracker.begin('build');
  try {
    const r = await fn();
    tracker.succeed({ txHash: (r as { txHash?: string } | undefined)?.txHash });
    return r;
  } catch (e) {
    tracker.fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export const isInitializing = (s: AdminState): boolean => s.status === 0;
