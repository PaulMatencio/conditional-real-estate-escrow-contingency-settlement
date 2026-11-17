#!/usr/bin/env node
// The vendored KycAttestationV1.compact must be byte-identical to the canonical copy in
// eu-counterparty-simulator (compact/KycAttestationV1.compact). Both repos pin the same sha256.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../KycAttestationV1.compact', import.meta.url));
const pinned = readFileSync(new URL('../KycAttestationV1.sha256', import.meta.url), 'utf8').trim();
const actual = createHash('sha256').update(src).digest('hex');
if (actual !== pinned) {
  console.error(`KycAttestationV1.compact differs from the pinned format: ${actual} != ${pinned}`);
  console.error('Do not edit the shared module here; update it in eu-counterparty-simulator (as a new version) and vendor it again.');
  process.exit(1);
}
console.log(`KycAttestationV1.compact sha256 ok (${pinned.slice(0, 12)}…)`);

// Frozen earlier contract versions (contract/versions/v<N>/) carry their own copy: it must stay the same module.
for (const v of ['v2']) {
  const copy = readFileSync(new URL(`../versions/${v}/KycAttestationV1.compact`, import.meta.url));
  const h = createHash('sha256').update(copy).digest('hex');
  if (h !== pinned) {
    console.error(`versions/${v}/KycAttestationV1.compact differs from the pinned format: ${h} != ${pinned}`);
    process.exit(1);
  }
}
console.log('frozen versions use the same KycAttestationV1 module');
