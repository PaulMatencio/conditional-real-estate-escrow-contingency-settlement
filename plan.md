## Primary goal

- Maintain a **React 19 / Next.js 15 (App Router)** dApp in this directory that compiles, generate the sdk, the tests, tests, deploys the contract
  `contracts/conditional-real-estate-escrow-contingency-settlement.compact` on **Midnight preprod**: a **conditional real estate escrow contigency and settlement** .
- Implement the dApp requiremenmt specifications ( `dApp-requirenents-specification.md`)

## Stack

- React 19, Next.js 15 (App Router), TypeScript, Tailwind (midnight theme), vitest
- Compact compiler **0.31.1** ↔ compact-runtime 0.16.0 ↔ midnight-js 4.1.1 / compact-js 2.5.x
- Midnight DApp Connector v4 — Lace and 1AM wallets (Chrome / Brave)
- Local proof server `midnightntwrk/proof-server:8.1.0` (loopback only, `docker compose up -d`)

## Clean architecture (kept)

`src/domain` (types) · `src/application` (use-cases, ports) · `src/infrastructure` (midnight-js, wallet, indexer,
storage, crypto, tooling) · `src/presentation` (UI, hooks, providers, i18n). Dependencies point inward.

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

`contract/conditional-real-estate-escrow-contingency-settlement.compact` · `dApp-requirements-specifiction.md`
`midnight.config.json` · `docker-compose.yml` . `compact.md`. `kyc.md`
`delay-init.md` .

---

## Implementation roadmap

### Phase 1 — Wallet connection and contract deployment

- Reusable wallet connector for **Lace and 1AM** (detect, connect with timeouts, status, **disconnect**)
- Build & Deploy tab driven by `midnight.config.json`: compile → generate SDK → generate tests → run tests → deploy
- Toolchain pin (0.31.1) with `scripts/compile.mjs` scripts/deploy
- To deploy a contract while retaining the ability to fill in missing attributes at a later time to complete the initalisation
- **Staged deploy** ( 5 circuits in the deploy tx, the rest by maintenance transactions) with resume from chain state
- Deploy/registration progress panel; authority key export/import
- Midnight theme, responsive layout

### Phase 2 — Build the front-end dApp interfacing with the

file : `dApp-requirements-specification-md`

### Phase 3 — Hardening

- `check-contract` and `verify-manager-key` scripts

### Phase 4 — Publication

- Repositories on GitHub: `real-estate-escrow-contigency-settlement`
- LICENSE, SECURITY.md, README quick start, pinned `docker-compose.yml`, CI (type-check + tests)
- `design.md`, this plan, `staged_deployment.md`

### Phase 5 - Simulate a KYC provider

### Phase 5 — Remaining work (next steps)

- Next steps recommendations
