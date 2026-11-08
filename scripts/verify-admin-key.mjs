#!/usr/bin/env node
/**
 * Read-only: checks that a secret key IS the admin of a deployed escrow contract, with no wallet and no transaction.
 *   SK=<64-hex secret key> node scripts/verify-admin-key.mjs <64-hex contract address>
 *   node scripts/verify-admin-key.mjs <contract address>      (prompts for the key, hidden)
 * Derives roleIdOf(sk) with the contract's own pure circuit and compares it with the on-chain `adminId`.
 * The key never leaves this process.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import readline from 'node:readline';
import { ContractState } from '@midnight-ntwrk/compact-runtime';

const cfg = JSON.parse(readFileSync('midnight.config.json', 'utf8'));
const address = (process.argv[2] ?? '').replace(/^0x/, '').toLowerCase();
if (!/^[0-9a-f]{64}$/.test(address)) {
  console.error('usage: node scripts/verify-admin-key.mjs <64-hex contract address>   (key via SK=… or prompt)');
  process.exit(2);
}

async function readKey() {
  if (process.env.SK) return process.env.SK.trim();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes('\n') || s.startsWith('Secret key')) rl.output.write(s); };
  return new Promise((ok) => rl.question('Secret key (64 hex, hidden): ', (a) => { rl.close(); console.log(); ok(a.trim()); }));
}
const skHex = (await readKey()).replace(/^0x/, '').toLowerCase();
if (!/^[0-9a-f]{64}$/.test(skHex)) { console.error('The secret key must be 64 hex characters'); process.exit(2); }

const { ledger, pureCircuits } = await import(pathToFileURL(resolve(cfg.contract.managedDir, 'contract/index.js')).href);

const res = await fetch(cfg.nodeRpc, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'midnight_contractState', params: [address] })
});
const j = await res.json();
if (!j.result) { console.error(`Contract not found on ${cfg.networkId}: ${JSON.stringify(j.error ?? j).slice(0, 200)}`); process.exit(1); }

const l = ledger(ContractState.deserialize(Buffer.from(j.result.replace(/^0x/, ''), 'hex')).data);
const toHex = (b) => Buffer.from(b).toString('hex');
const sk = Uint8Array.from(skHex.match(/../g).map((h) => parseInt(h, 16)));
const derived = toHex(pureCircuits.roleIdOf(sk));
const admin = toHex(l.adminId);
const short = (h) => `${h.slice(0, 8)}…${h.slice(-6)}`;

console.log(`Contract            : ${address}`);
console.log(`On-chain adminId    : ${short(admin)}`);
console.log(`Derived from the key: ${short(derived)}`);
console.log(derived === admin ? 'MATCH — this secret key IS the admin of the contract.' : 'NO MATCH — this key is not the admin of this contract.');
process.exit(derived === admin ? 0 : 1);
