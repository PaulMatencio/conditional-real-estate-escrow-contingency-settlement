/**
 * Supported contract versions (CLAUDE.md "Backward compatibility after a contract upgrade").
 *
 * Every escrow keeps the contract version it was deployed with. The dApp holds each supported version's compiled
 * module and serves its keys under `/zk/<name>`, detects an escrow's version from its on-chain circuits, and then
 * calls, proves and decodes with that version only. New escrows are always deployed with the current version.
 *
 * Adding a version: freeze the previous source in contract/versions/v<N>/, compile it to contract/managed/escrow-v<N>
 * (full ZK build), list it in midnight.config.json `contract.previousVersions` and add its module below.
 */
import type { ContractVersionId } from '@/domain/escrowView';
import { contractConfig } from '../config/network';
import { Contract } from './module';
import currentInfo from '@contract/managed/escrow/compiler/contract-info.json';
import { Contract as ContractV2 } from '@contract/managed/escrow-v2/contract/index.js';
import infoV2 from '@contract/managed/escrow-v2/compiler/contract-info.json';
import { createWitnesses } from './witnesses';

/** The compiled contract class of any supported version (all share the ledger layout and witnesses so far). */
export type ContractClass = typeof Contract;

export interface ContractVersion {
  id: ContractVersionId;
  /** `/zk/<name>` serves its keys and ZKIR; also the compiled-contract tag. */
  name: string;
  current: boolean;
  Contract: ContractClass;
  /** The compiler's contract-info.json of this version (circuits, ledger). */
  info: unknown;
}

export const CURRENT_VERSION: ContractVersion = {
  id: contractConfig.version as ContractVersionId,
  name: contractConfig.name,
  current: true,
  Contract,
  info: currentInfo
};

const V2: ContractVersion = {
  id: 'v2',
  name: contractConfig.previousVersions?.find((p) => p.version === 'v2')?.name ?? 'escrow-v2',
  current: false,
  Contract: ContractV2 as unknown as ContractClass,
  info: infoV2
};

/** Newest first: the current version, then the earlier ones still supported. */
export const SUPPORTED_VERSIONS: readonly ContractVersion[] = [CURRENT_VERSION, V2];

export const versionById = (id: string | undefined | null): ContractVersion | undefined => SUPPORTED_VERSIONS.find((v) => v.id === id);

/** Same-origin base of a version's ZK artefacts. */
export const zkPathOf = (v: ContractVersion) => `/zk/${v.name}`;

const circuitCache = new Map<string, string[]>();

/** Every provable circuit of a version's compiled contract. */
export function circuitsOf(v: ContractVersion = CURRENT_VERSION): string[] {
  let c = circuitCache.get(v.id);
  if (!c) {
    const probe = new v.Contract(createWitnesses({ secretKey: () => new Uint8Array(32) }) as never);
    c = Object.keys((probe as unknown as { provableCircuits: object }).provableCircuits);
    circuitCache.set(v.id, c);
  }
  return c;
}

/**
 * The version of a deployed escrow, from the circuits registered on-chain. An escrow's circuits are always a subset
 * of its version's. When several versions fit (a staged deploy still registering its circuits), `hint` (the version
 * recorded in the vault at deploy) decides, then an exact match, then the current version (the only one deployed
 * now). Null: no supported version has these circuits.
 */
export function detectVersion(onChain: Iterable<string>, hint?: string | null): ContractVersion | null {
  const ops = [...onChain];
  const fits = SUPPORTED_VERSIONS.filter((v) => {
    const all = circuitsOf(v);
    return ops.every((c) => all.includes(c));
  });
  if (fits.length <= 1) return fits[0] ?? null;
  const hinted = fits.find((v) => v.id === hint);
  if (hinted) return hinted;
  const exact = fits.find((v) => circuitsOf(v).length === ops.length);
  return exact ?? fits.find((v) => v.current) ?? fits[0];
}

/** Every circuit name any supported version has (to tell "older supported" from "unknown"). */
export const knownCircuits = (): string[] => [...new Set(SUPPORTED_VERSIONS.flatMap((v) => circuitsOf(v)))];
