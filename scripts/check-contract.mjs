#!/usr/bin/env node
/**
 * Read-only: asks the public node for a contract's state and prints its details and which circuits are registered.
 *   node scripts/check-contract.mjs <64-hex contract address>
 * Uses only the node's `midnight_contractState` RPC (no wallet, no secrets, nothing is sent on-chain).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ContractState as RtContractState } from '@midnight-ntwrk/compact-runtime';

const cfg = JSON.parse(readFileSync('midnight.config.json', 'utf8'));
const address = (process.argv[2] ?? '').replace(/^0x/, '').toLowerCase();
if (!/^[0-9a-f]{64}$/.test(address)) {
  console.error('usage: node scripts/check-contract.mjs <64-hex contract address>');
  process.exit(2);
}

const res = await fetch(cfg.nodeRpc, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'midnight_contractState', params: [address] })
});
const j = await res.json();
if (j.error || !j.result) {
  console.log(`NOT FOUND on ${cfg.networkId} (${cfg.nodeRpc}): ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
  process.exit(1);
}
const raw = Buffer.from(j.result.replace(/^0x/, ''), 'hex');

// compact-runtime 0.21 (Compact 0.36) decodes ledger 9 contract states; a ledger 8 contract fails here.
const state = RtContractState.deserialize(raw);
const registered = new Set(state.operations().map((o) => (typeof o === 'string' ? o : new TextDecoder().decode(o))));
const dir = cfg.contract.managedDir;
const expected = readdirSync(`${dir}/keys`).filter((f) => f.endsWith('.verifier')).map((f) => f.replace('.verifier', '')).sort();
const missing = expected.filter((c) => !registered.has(c));

console.log(`Contract   ${address}`);
console.log(`Network    ${cfg.networkId} via ${cfg.nodeRpc}`);
console.log(`State      found (${raw.length} bytes)`);
console.log(`Registered (${registered.size}/${expected.length}): ${[...registered].sort().join(', ') || '—'}`);
console.log(missing.length ? `Missing    (${missing.length}): ${missing.join(', ')}` : 'All circuits registered.');

const hex = (b) => Buffer.from(b).toString('hex');
const STATUS = ['Initializing', 'AwaitingDeposit', 'Funded', 'InContingencyReview', 'ReadyToSettle', 'Settled', 'Refunded', 'Disputed', 'Cancelled', 'Expired'];
try {
  const { ledger, EscrowStatus } = await import(pathToFileURL(resolve(dir, 'contract/index.js')).href);
  const L = ledger(RtContractState.deserialize(raw).data);
  const name = EscrowStatus ? Object.keys(EscrowStatus).find((k) => EscrowStatus[k] === L.status) : STATUS[L.status];
  console.log('\n--- Escrow ---');
  console.log(`Status               : ${name ?? L.status}`);
  console.log(`Ticker               : ${L.escrowTicker}`);
  console.log(`Escrow color         : ${hex(L.escrowColor)}`);
  console.log(`Config version       : ${L.configVersion}`);
  console.log(`Accepted (buyer/sell): ${L.buyerAccepted} / ${L.sellerAccepted}`);
  console.log(`Configured attrs     : ${[...L.configured].map((a) => (EscrowStatus ? a : a)).join(', ') || '—'}`);
  console.log(`Closing deadline     : ${L.closingDeadline}   Dispute deadline: ${L.disputeDeadline}`);
  console.log('\n--- Roles (hashed ids) ---');
  for (const r of ['adminId', 'buyerId', 'sellerId', 'inspectorId', 'lenderId', 'titleAgentId', 'resolverId']) {
    try { console.log(`${r.padEnd(13)}: ${hex(L[r])}`); } catch { console.log(`${r.padEnd(13)}: (not set)`); }
  }
} catch (e) {
  console.log(`\n(details unavailable: ${e.message} — is the contract compiled? run npm run compile:contract)`);
}
