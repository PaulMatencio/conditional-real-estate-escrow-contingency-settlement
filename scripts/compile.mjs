#!/usr/bin/env node
/**
 * Full compilation (ZK keys included) of the escrow contract with the compiler pinned in
 * midnight.config.json (`contract.compilerVersion`). midnight-js 4.1.1 / compact-js 2.5.x only run
 * contracts built for compact-runtime 0.16.0, i.e. compiler 0.31.x.
 *
 *   node scripts/compile.mjs [--skip-zk]
 *
 * Output: contract.managedDir (keys/, zkir/, contract/). Run `npm run generate:sdk` afterwards.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cfg = JSON.parse(readFileSync(path.join(root, 'midnight.config.json'), 'utf8'));
const c = cfg.contract;
const skipZk = process.argv.includes('--skip-zk');

// Resolve from the contract's own directory so `import "KycAttestationV1"` finds its sibling module.
const srcDir = path.dirname(c.source);
const args = ['compile', `+${c.compilerVersion}`, ...(skipZk ? ['--skip-zk'] : []), path.basename(c.source), path.relative(srcDir, c.managedDir)];
console.log(`$ (cd ${srcDir} && compact ${args.join(' ')})`);
const r = spawnSync('compact', args, { cwd: path.join(root, srcDir), stdio: 'inherit' });
process.exit(r.status ?? 1);
