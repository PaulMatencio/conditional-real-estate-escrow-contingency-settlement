# CLAUDE.md — real-estate escrow (Midnight, Compact v2 + Next.js dApp)

Conditional real-estate escrow with contingency settlement on Midnight, **preview** network. The Compact contract
lives in `contract/`; the dApp (Next.js, TypeScript, clean architecture) in `src/`. Branch `feature/v2-dapp`: the dApp
supports **contract v2 only** (v1 dApp is tagged `v1.0-dapp`).

## Architecture & Tech Stack

### Tech stack

| Area | Technology |
|---|---|
| Smart contract | Compact **0.36.0** (`pragma language_version >= 0.23`), compact-runtime **0.21** (async circuits), ledger **v9** (`@midnightntwrk/ledger-v9`), onchain-runtime v4 |
| Chain access | midnight-js **5.0.0** (contracts, indexer public data provider, http-client proof provider, fetch-zk-config provider, dapp-connector proof provider) |
| Wallets | DApp Connector API **4.1.0** (`@midnightntwrk/dapp-connector-api`, Lace and 1AM browser wallets), shielded tokens (sEUR / EURe, 6 decimals), fees in DUST |
| Midnight wallet SDK | `@midnightntwrk/wallet-sdk-address-format` **4.0.0** only: Bech32m encoding/decoding of shielded coin and encryption public keys and unshielded addresses (`infrastructure/wallet/address.ts`, `providers.ts`). The full wallet SDK (wallet facade, shielded/unshielded wallets) is **not** used: keys, balances, balancing and submission come from the browser wallet through the DApp Connector |
| Proving | Local proof server `midnightntwrk/proof-server:9.0.1` (docker compose, loopback `127.0.0.1:6300` only) |
| Network | Midnight **preview** (`midnight.config.json`: indexer v4 GraphQL + WS, node RPC, faucet, explorer) |
| Front end | Next.js **15** (App Router), React **19**, TypeScript 5.7, Tailwind CSS 3, lucide-react icons |
| Crypto (browser) | WebCrypto: AES-256-GCM, PBKDF2-SHA-256 (310 000 it.), X25519 + HKDF sealed envelopes; Jubjub Schnorr (KYC) via the compiled pure circuits |
| Storage | Encrypted vault in IndexedDB (one AES-GCM record per contract, plus identity / admin-key / tx-log records) |
| Tests | vitest 3 (application tests run the compiled contract in Simulator Mode); contract simulator suite `contract/test/escrow.sim.mjs` (node) |
| Test counterparty | `eu-counterparty-simulator` (MiCA CASP simulator: KYC attestations, revocations, Travel Rule), port 8787 |

### Repository layout

```
contract/                         Compact source, KYC module (KycAttestationV1, vendored), managed/escrow (compiler output),
                                  test/escrow.sim.mjs, docs (compact.md, kyc.md, shielded-token.md, delay-init.md)
sdk/escrow/                       generated typed client (scripts/generate-sdk.mjs)
src/domain/                       pure rules: escrowView (decoded ledger), lifecycle (circuit preconditions = contract asserts),
                                  terms (packages, openings, validation), amount, escrowMeta, testCases, roles, hex, errors
src/application/                  use-cases + ports: partyService (pre-flight → call → record), adminService (staged deploy),
                                  termsService, notaryService (certificate), escrowDirectory, vaultBackup, txLog, chainHistory
src/infrastructure/               adapters: contract/ (compiled module, view decoder, call args, witnesses), gateway/
                                  (Wallet Mode admin + party, public reader), simulator/ (in-browser contract), crypto/,
                                  storage/ (encrypted vault, tx log, authority key), wallet/, indexer/, casp/, config/
src/presentation/                 React: providers (AppProvider = admin/wallet, EscrowProvider = parties/vault/directory),
                                  components/{admin,party,notary,compliance,vault}, Header + EscrowSwitcher, i18n (en/fr/es)
src/app/                          routes: /admin, /buyer, /seller, /lender, /inspector, /title-agent, /resolver, /compliance,
                                  /verify (notary), /role-id; api/casp (CASP proxy, server-side tokens), api/indexer
                                  (same-origin GraphQL proxy), zk/[...path] (serves prover/verifier keys and ZKIR)
tests/                            vitest suites + helpers/fixtures.ts (configuredEscrow / configuredLoanEscrow)
```

### How it fits together

- **Clean architecture**: `domain` ← `application` ← `infrastructure` / `presentation`. Domain and application never
  import midnight-js or React; crypto and chain access come in through ports (`TermsCrypto`, `EscrowPartyGateway`,
  `Vault`, `CaspGateway`).
- **One gateway port, two modes**: `PartyGateway` (Wallet Mode: midnight-js + wallet + local proof server) and
  `EscrowSimulator.gateway()` (Simulator Mode: compiled contract in the browser, settable clock, no proofs). Both use
  `contractArgs` / `witnessInputs` from `infrastructure/contract/callArgs.ts`, so inputs are identical.
- **Private data flow**: the admin builds the terms package (`createTermsPackage`), commits only the 8 salted
  commitments (`configure` + `configureFinancing`), and distributes the package sealed to each party's X25519 envelope
  key (lender: a reduced lender package; notary: a custodian copy). Each party keeps it in its vault; witnesses are
  built from it per call and dropped afterwards.
- **Shielded custody**: each deposit is one deterministic coin (`vaultNonceOf`, `lenderNonceOf`, `topUpNonceOf`)
  owned by the contract; payouts spend it with `sendShielded` to the committed key. The coin's Merkle index is read
  from its deposit transaction (`locateCoinIndex`), the cooling-off penalty from the withdrawal-refund transaction.
- **Deploy**: staged (`stagedDeploy`): the deploy transaction carries the init circuits (`midnight.config.json`
  `deployCircuits`), the rest are registered in maintenance batches of 4; then the authority is renounced.
- **Escrow directory**: the vault is the registry (`VaultRecord.meta`: name, test case, decimals, archived); the
  header `EscrowSwitcher` switches the current escrow for every page. Names travel inside the encrypted packages.
- **Public reads**: `readPublicView` (indexer, no wallet) decodes the ledger into `EscrowView`; the notary portal,
  the compliance console and the switcher use it.

## Security rules (non-negotiable)

- Secrets live **only in the encrypted vault** (role keys, admin key, maintenance-authority key, terms packages, KYC
  bundles). Nothing secret in plain `localStorage`, URLs, query strings, logs or server requests (NFR-07: never log an
  error object from a circuit call, it can carry witnesses).
- The **maintenance-authority key is never sent over the network**. The strongest option is kept: renounce the
  authority once every circuit is registered (contract immutable); deposits are blocked while it is active.
- **Proofs only from the local proof server** (`http://127.0.0.1:6300`, `npm run proof-server:start`).
- CASP officer / notary tokens stay **server-side** in `.env.local` (read by `src/app/api/casp/[...path]/route.ts`).
  **`.env.local` is never committed** (ignored by `.env.*` in `.gitignore`).
- Private terms are **never on-chain**: the ledger holds salted commitments only. New private values get their own
  commitment and are checked in-circuit; never `disclose()` a private value to make a check pass.
- Escrow names, test cases and token decimals are local metadata (vault + encrypted packages), never committed.

## Commands

```bash
npm run dev                      # dev server (CASP proxy on)
npm run build && npm start       # production; the CASP proxy needs CASP_SIM_ENABLED=1 in .env.local
npm run typecheck                # tsc --noEmit
npm test                         # vitest (tests/compiled.test.ts needs the full ZK build)
npm run proof-server:start       # local proof server (docker compose)

# contract (Compact 0.36.0, compact-runtime 0.21)
cd contract
compact compile +0.36.0 conditional-real-estate-escrow-contingency-settlement.compact managed/escrow   # full ZK build
npm run compile                  # --skip-zk build (JS only, fast)
npm test                         # contract simulator suite (test/escrow.sim.mjs) + KYC module check
cd .. && npm run generate:sdk    # regenerate sdk/escrow after any circuit change
```

CASP simulator (test only): `npm run start-server` in `../../eu-counterparty-simulator`, port 8787.

## Contract rules

- Every state-changing circuit asserts its exact source status(es); keep that when adding circuits.
- **One shielded payout per circuit** where possible: each payout costs ~17k rows. Refund/claim circuits must stay at
  **k ≤ 16**; `releaseToSeller` is deliberately one transaction at **k = 17** (decision, do not split). After any
  circuit change, run the full compile and report each changed circuit's `k` and `rows`.
- `InitAttribute` count must match `isFullyConfigured()`; a new attribute updates both, `INIT_ATTRIBUTES` in
  `src/domain/escrowView.ts`, the admin forms and the test fixtures.
- Time inside circuits: a caller-supplied `now` checked as `blockTimeGte(now) && blockTimeLt(now + 600)`; the dApp
  sends wall clock − 120 s (`TIME_MARGIN`).
- Ledger reads inside `&&`/ternaries after a witness comparison trigger disclosure errors: read into a `const` first.
- Any contract change ⇒ the ledger layout changes ⇒ **existing deployments become unreadable** by the new dApp;
  redeploy test escrows. Rebuild/restart the dApp before deploying.

## dApp conventions

- Layers: `domain` (pure rules, mirrors of contract asserts in `lifecycle.ts`) → `application` (use-cases, ports) →
  `infrastructure` (midnight-js, crypto, simulator, storage) → `presentation` (React). Keep `lifecycle.ts` checks
  identical to the contract asserts (same messages).
- Wallet Mode and Simulator Mode share the `EscrowPartyGateway` port; every new circuit needs `CircuitArgs`,
  `callArgs.ts` (args + witnesses), the simulator witness, `ACTIONS`, i18n `circuit.*` and tests.
- **Amounts**: terms, contract and wallet count **base units**; people type and read **whole tokens**. Use
  `src/domain/amount.ts` (`formatAmount`, `parseAmount`, `toBase`) or the `useAmount()` hook; never print a raw
  base-unit number with a ticker. Decimals: `escrowDecimals` in packages, `meta.decimals` in the vault, default 6.
- React: all hooks before any early return.
- i18n: every user-facing string in `src/presentation/i18n/{en,fr,es}.ts` (same keys in all three).
- Terms packages: format `EscrowTermsV2` with 8 commitments (incl. cooling-off); older packages are refused with a
  clear message, never silently accepted.

## Testing and delivery

- Before handing back: `npm run typecheck`, `npm test` (only `compiled.test.ts` may fail without the ZK build),
  `npm run build`, and for contract changes `cd contract && npm test`.
- Add simulator tests (contract) and application-level tests (`tests/*.test.ts`, Simulator Mode) for every new rule.
- Test cases and presets: `src/domain/testCases.ts` (T01–T12); keep expected outcomes in whole tokens.
- Commit only when asked; give the user the git commands.

## Docs

- User guide and design docs are Claude Docs (project artifacts), updated with each feature; `plan.md` and
  `dApp-requirements-specification.md` are the requirement sources (FR-*/NFR-* ids are referenced in code comments).
