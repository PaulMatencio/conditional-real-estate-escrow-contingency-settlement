# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Midnight Network dApp and Compact smart contract for **conditional real-estate escrow with contingency settlement**. Buyer and lender funds are held in escrow as a shielded token, keeping prices and payout wallets private, and released to the seller once inspection, financing, and title contingencies clear (or refunded on failure, withdrawal, or deadline expiry).

- **Network**: Midnight `preview` (`midnight.config.json`)
- **Toolchain**: Node `>= 22`, Compact compiler `0.36.0` (language `0.28`, `@midnight-ntwrk/compact-runtime` `0.21.0`, ledger `9` / `@midnightntwrk/ledger-v9` `1.0.0`, ZKIR `v3`), `midnight-js` `5.0.0`, Midnight Wallet SDK `2.0.0`, `proof-server:9.0.1`
- **Frontend**: Next.js 15 (App Router), React 19, Tailwind CSS, Vitest 3

## Common Commands

```sh
# Development & checks
npm run dev                  # Clears .next and starts Next.js dev server (http://localhost:3000)
npm run build                # Production Next.js build
npm run typecheck            # tsc --noEmit
npm test                     # Run Vitest suite in tests/ (node environment, 60s timeout)

# Contract & SDK
npm run compile:contract     # Full ZK compile with compact +0.36.0 -> contract/managed/escrow
npm run generate:sdk         # Regenerate typed client in sdk/escrow from contract-info.json
cd contract && npm run compile  # Fast --skip-zk compile for simulator tests
cd contract && npm test         # Verify KycAttestationV1.sha256 and run contract/test/escrow.sim.mjs

# Local proof server (Wallet Mode, bound to 127.0.0.1:6300)
npm run proof-server:start   # docker compose up -d (midnightntwrk/proof-server:9.0.1)
npm run proof-server:stop    # docker compose down

# Chain utilities (read-only)
npm run check:contract -- <address>
SK=<hex> npm run verify:admin-key -- <address>
```

After modifying `contract/conditional-real-estate-escrow-contingency-settlement.compact`, always run `npm run compile:contract` and then `npm run generate:sdk`.

## Architecture

### Top-Level Layout

- `contract/`: Compact smart contract (`conditional-real-estate-escrow-contingency-settlement.compact`), vendored `KycAttestationV1.compact` (pinned by `KycAttestationV1.sha256`), compiled artifacts in `contract/managed/escrow/`, and off-chain simulator tests + `casp-signer.mjs` in `contract/test/`. Has its own `package.json`.
- `sdk/escrow/`: Generated typed wrapper (`EscrowClient`, `types.ts`, `index.ts`) over `midnight-js` `callTx`. **Do not edit manually**—always regenerate via `npm run generate:sdk`.
- `src/`: Next.js application organized in clean hexagonal layers:
  - `src/domain/`: Pure domain types and logic (`escrow.ts`, `lifecycle.ts`, `roles.ts`, `terms.ts`, `amount.ts`, `signingKey.ts`, `contractErrors.ts`, `escrowView.ts`, `hex.ts`, etc.).
  - `src/application/`: Use-case services (`adminService.ts`, `partyService.ts`, `termsService.ts`, `notaryService.ts`, `escrowDirectory.ts`, `vaultBackup.ts`, `txLog.ts`, `chainHistory.ts`, `deployProgress.ts`) and port interfaces (`ports.ts`, `partyPorts.ts`).
  - `src/infrastructure/`: External adapters:
    - `contract/`: Compiled contract loading, `callArgs.ts`, `financingArgs.ts`, `chainState.ts`, `witnesses.ts`, `view.ts`.
    - `crypto/`: `identity.ts` (calls the contract's `roleIdOf` pure circuit), `aead.ts`, `escrowCrypto.ts`, `termsCrypto.ts`.
    - `wallet/`: Lace / 1AM DApp connector, Midnight providers, address & DUST helpers.
    - `gateway/`: `adminGateway.ts`, `partyGateway.ts`, `publicReader.ts`.
    - `simulator/`: In-browser `escrowSimulator.ts` with block-time slider.
    - `storage/`: AES-GCM encrypted IndexedDB vault (`encryptedVault.ts`, `vaultInstance.ts`), `privateStateProvider.ts`, `kv.ts`, `txLogStore.ts`.
    - `casp/` & `indexer/`: HTTP CASP proxy client and GraphQL indexer history source.
  - `src/presentation/`: Shared React UI components, i18n (`en`, `fr`, `es`), and context providers (`AppProvider`, `EscrowProvider`, `Providers`).
  - `src/app/`: App Router pages (`/admin`, `/buyer`, `/seller`, `/inspector`, `/lender`, `/title-agent`, `/resolver`, `/compliance`, `/verify`, `/role-id`, `/api/*`, `/zk/*`).
- `tests/`: Vitest tests covering domain logic, compiled contract, custody, cooling-off, loan flow, authority, CASP gateway, vault backup, and admin service.

## Key Technical Conventions & Gotchas

- **Midnight Wallet SDK `2.0.0` (Enforced)**: All wallet integration, wallet building, and wallet-SDK package usage must use **Midnight Wallet SDK `2.0.0`**. Do not introduce or downgrade to `1.x` wallet SDK packages or legacy wallet APIs; keep `src/infrastructure/wallet/` aligned with Wallet SDK `2.0.0` patterns.
- **Single WASM / `compact-runtime` instance**: `contract/` has its own `package.json` and `node_modules`. Both `next.config.mjs` (via `config.resolve.modules`) and `vitest.config.ts` (via `resolve.alias`) force bare imports and `@midnight-ntwrk/compact-runtime` to resolve from the root `node_modules` first. Loading two copies of the WASM runtime causes class mismatch errors (e.g., `"expected instance of ContractMaintenanceAuthority"`).
- **Staged Deployment**: Controlled by `midnight.config.json`. Initial deployment includes `contract.deployCircuits` (6 circuits); the remaining circuits are added in batches of `contract.maintenanceBatchSize` (default `4`) via resumable maintenance transactions.
- **Role Identity & Client-Side Vault**: Parties are identified by `roleId = roleIdOf(secretKey)` (32-byte client-side secret hashed via `persistentHash`). Secret keys, private terms, attestations, and document salts live exclusively in the browser's AES-GCM encrypted IndexedDB vault—never send secrets to servers or URLs.
- **Dual Modes**: Party pages support **Wallet Mode** (Lace/1AM + local proof server on `127.0.0.1:6300` + `preview` network) and **Simulator Mode** (in-browser compiled contract). For multi-party testing in one browser, use `http://<party>.localhost:3000` (`allowedDevOrigins: ['*.localhost']` in `next.config.mjs`) so each party gets an isolated origin and vault.
- **CSP & Proof Server Version**: `next.config.mjs` enforces a strict Content-Security-Policy allowing `'wasm-unsafe-eval'`, loopback proof server (`127.0.0.1:6300`), and Midnight/1AM/Blockfrost indexer endpoints. The proof server image **must** stay at `9.0.1` to match Compact `0.36.0` / ZKIR `v3`.
- **CASP Simulator Proxy**: Optional `eu-counterparty-simulator` on port `8787` is accessed through `/api/casp/*` using server-side env vars in `.env.local` (`CASP_SIM_URL`, `CASP_OFFICER_TOKEN`, `CASP_NOTARY_TOKEN`, and `CASP_SIM_ENABLED=1` for `next start`).

