import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@contract': path.resolve(__dirname, 'contract'),
      '@': path.resolve(__dirname, 'src'),
      // The compiled contract (contract/managed/escrow) would otherwise resolve compact-runtime from contract/node_modules,
      // which can hold another version (that folder has its own package.json). Like next.config.mjs, always load the
      // root copy: one runtime, matching the compiler (0.36.0 ↔ compact-runtime 0.21.0).
      '@midnight-ntwrk/compact-runtime': path.resolve(__dirname, 'node_modules/@midnight-ntwrk/compact-runtime')
    }
  },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 60_000 }
});
