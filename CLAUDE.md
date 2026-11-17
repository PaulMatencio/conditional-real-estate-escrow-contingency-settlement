# CLAUDE.md — real-estate escrow (Midnight, Compact v2 + Next.js dApp)

Conditional real-estate escrow with contingency settlement on Midnight, **preview** network. The Compact contract
lives in `contract/`; the dApp (Next.js, TypeScript, clean architecture) in `src/`. Branch `feature/v2-dapp`: the dApp
deploys **contract v3** (cash deal cleared by the deposit) and keeps escrows deployed with **contract v2** working (v1 dApp is tagged `v1.0-dapp`).

## Architecture & Tech Stack

### Tech stack

| Area | Technology |
|---|---|
| Contract versions | current **v3** (`contract/managed/escrow`); supported earlier: **v2** (`contract/versions/v2`, `contract/managed/escrow-v2`). See *Backward compatibility after a contract upgrade* |
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

# earlier supported contract versions (frozen sources in contract/versions/v<N>/), full ZK build each
cd contract
compact compile +0.36.0 versions/v2/conditional-real-estate-escrow-contingency-settlement.compact managed/escrow-v2
npm run compile:v2               # --skip-zk build of v2 (JS only)
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
- Any contract change ⇒ a new **contract version** (new circuits, keys and ledger layout). Escrows already deployed
  keep the version they were deployed with and must stay usable (see *Backward compatibility after a contract
  upgrade*). Rebuild/restart the dApp before deploying.

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

## Contract updates must not break the dApp

Design the dApp so that updating the contract (adding, removing or renaming a circuit, changing the ledger layout)
never breaks it. Escrows deployed by an older build stay in the vault and the switcher; they must not crash a page.

- **Check compatibility before touching an escrow.** Every path that opens or reads an escrow (admin, party pages,
  notary portal, compliance console, escrow switcher, public reads) first compares the on-chain circuits with the
  build's (`foreignCircuits` / `allCircuitIds`) and checks that the ledger decodes. On a mismatch it stops with one
  clear `CONTRACT_VERSION` error (i18n), before any midnight-js call, proof or ZK artefact fetch.
- **Never request a ZK artefact the build does not have.** Only circuits in `allCircuitIds()` reach the
  `FetchZkConfigProvider` or `findDeployedContract`; a bare `/zk/... 404` in the console is a bug.
- **Degrade, don't fail.** An incompatible escrow shows its address, an "older contract version" badge and the
  actions that still make sense (archive, export vault backup, open in the explorer); the rest of the app, and the
  other escrows, keep working.
- **Record the build.** At deploy, store the contract build fingerprint (hash of `compiler/contract-info.json`) in
  `VaultRecord.meta`, so the dApp can tell "older version" apart from "wrong network / not an escrow".
- **Keep the user's data.** A contract update never deletes or rewrites vault records, terms packages or KYC bundles
  of older escrows; archiving is the user's choice.
- **Test it.** Each contract change adds or keeps an application test that opens an escrow with an unknown circuit
  and a changed ledger, and expects the clean `CONTRACT_VERSION` error, not a crash.

## Backward compatibility after a contract upgrade

After a contract upgrade the dApp stays **backward compatible**: escrows deployed with any supported earlier
version keep working (read, every action still available in that version, payouts, notary certificate, compliance)
with the new dApp. The "older contract version" refusal above is only for versions outside the supported list.

- **Keep every supported version's build.** The current version compiles to `contract/managed/escrow/`. Each earlier
  supported version keeps its frozen source in `contract/versions/v<N>/` (contract + its own `KycAttestationV1`
  copy) and its compiler output in `contract/managed/escrow-v<N>/` (full ZK build), listed in `midnight.config.json`
  `contract.previousVersions` and registered in `src/infrastructure/contract/versions.ts`. The `/zk` route serves
  keys per version (`/zk/escrow-v<N>/...`). Freeze the source **before** changing the contract.
- **Detect the version from the chain.** Identify a deployed escrow's version from its on-chain verifier keys /
  circuit set (and `VaultRecord.meta.build` when present), then load that version's module, keys, ledger decoder,
  witnesses and `callArgs`. Never decode or call an escrow with another version's layout.
- **One adapter per version.** Infrastructure maps each version's ledger to the shared `EscrowView` and each
  `PartyCircuit` to that version's circuit (or marks it unavailable with a clear reason). Domain, application and UI
  code stay version-agnostic; `lifecycle.ts` mirrors the asserts of the escrow's own version.
- **Rules follow the escrow's version.** An escrow keeps the rules it was deployed with (e.g. v2 escrows keep
  `submitFinancing`; cash-deal auto-clearing applies only to versions that have it). The UI shows the version and
  only offers actions that version supports.
- **Terms packages stay readable.** Packages, lender packages, custodian copies and assignment notices of every
  supported version import and verify; a format change adds a new reader, it never drops an old one.
- **Dropping a version is a decision.** Removing a version from the supported list is explicit (noted in the user
  guide and `CLAUDE.md`), only once none of its escrows can still hold funds, and those escrows then fall back to
  the clean "older contract version" handling.
- **Test every supported version.** The contract simulator suite and the application tests (Simulator Mode) run the
  main flows against each supported version's compiled module, plus a mixed directory (escrows of several versions
  in one vault).

## Testing and delivery

- Before handing back: `npm run typecheck`, `npm test` (only `compiled.test.ts` may fail without the ZK build),
  `npm run build`, and for contract changes `cd contract && npm test`.
- Add simulator tests (contract) and application-level tests (`tests/*.test.ts`, Simulator Mode) for every new rule.
- Test cases and presets: `src/domain/testCases.ts` (T01–T12); keep expected outcomes in whole tokens.
- Commit only when asked; give the user the git commands.

## Docs

- User guide and design docs are Claude Docs (project artifacts), updated with each feature; `plan.md` and
  `dApp-requirements-specification.md` are the requirement sources (FR-*/NFR-* ids are referenced in code comments).
