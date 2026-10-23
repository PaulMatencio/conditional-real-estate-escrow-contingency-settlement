## Primary goal

Maintain a **React 19 / Next.js 15 (App Router)** DApp in this directory that compiles, tests, deploys and operates
`contracts/conditional-real-estate-escrow-contingency-settlement.compact` on **Midnight preprod**: a **conditional real estate escrow contigency and settlement** .

## Stack

- React 19, Next.js 15 (App Router), TypeScript, Tailwind (midnight theme), vitest
- Compact compiler **0.31.1** ↔ compact-runtime 0.16.0 ↔ midnight-js 4.1.1 / compact-js 2.5.x (see design.md §7)
- Midnight DApp Connector v4 — Lace and 1AM wallets (Chrome / Brave)
- Local proof server `midnightntwrk/proof-server:8.1.0` (loopback only, `docker compose up -d`)

## Clean architecture (kept)

`src/domain` (types) · `src/application` (use-cases, ports) · `src/infrastructure` (midnight-js, wallet, indexer,
storage, crypto, tooling) · `src/presentation` (UI, hooks, providers, i18n). Dependencies point inward.

## Roles

- ** Admin ** - The account equal to the ledger `owner` (the deployer):

- **Buyer** — the account equal to the buyer

- **Seller** — the account equal to the seller

- **Inspector** - The account

- **Lender**

- **title agent**

- **Dispute Resolver**

## Constraints (unchanged)

Performance, security, accessibility, SEO, i18n (en/fr/es), testing, clean architecture, TypeScript; transactions requests are **persistent**.

## Network configuration (`midnight.config.json`)

|                   |                                                                               |
| ----------------- | ----------------------------------------------------------------------------- |
| Network ID        | `preprod`                                                                     |
| Indexer           | `https://indexer.preprod.midnight.network/api/v4/graphql` (WS `…/graphql/ws`) |
| Node RPC          | `https://rpc.preprod.midnight.network`                                        |
| Proof server      | `http://127.0.0.1:6300`                                                       |
| Faucet / Explorer | `https://faucet.preprod.midnight.network` · `https://explorer.1am.xyz`        |

## Relevant files

`contract/conditional-real-estate-escrow-contingency-settlement.compact` ·
`midnight.config.json` · `docker-compose.yml` . `compact.md`.
`delay-init.md` .

---

## Implementation roadmap

### Phase 1 — Wallet connection and contract deployment ✅

- Reusable wallet connector for **Lace and 1AM** (detect, connect with timeouts, status, **disconnect**)
- Build & Deploy tab driven by `midnight.config.json`: compile → generate SDK → generate tests → run tests → deploy
- Toolchain pin (0.31.1) with `scripts/compile.mjs` scripts/deploy
- To deploy a contract while retaining the ability to fill in missing attributes at a later time to complete the initalisation
- **Staged deploy** (4 circuits in the deploy tx, the rest by maintenance transactions) with resume from chain state
- Deploy/registration progress panel; authority key export/import
- Midnight theme, responsive layout

### Phase 2 — Contract operations and roles ✅

- [x] Role resolution and role-specific UI. Refer to the
- [x] All circuits: Refer to the ## 5. Circuit reference of the contact/compact
- [x] **Test Mode** (simulator, mock identities, replayed persistence) and **Wallet Mode**
- [x] Step-by-step progress for every action
- [x] Persistent transaction history and **history backfill** from the indexer

### Phase 3 — Hardening ✅

- [x] `check-contract` and `verify-manager-key` scripts

### Phase 4 — Publication ✅

- [x] Repositories on GitHub: `real-estate-escrow-contigency-settlement`
- [x] LICENSE, SECURITY.md, README quick start, pinned `docker-compose.yml`, CI (type-check + tests)
- [x] `design.md`, this plan, `staged_deployment.md` (rewritten for v3)

### Phase 5 — Remaining work (next steps)
