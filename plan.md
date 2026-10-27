## Context

- I have read the Observations before front-end development (Part 2, item 2) of the shielded-token.md. I understand that the full implementation need to be validated on preprod first. Please continue reading this plan.

## Primary goal

1.  `contracts/conditional-real-estate-escrow-contingency-settlement.compact` on **Midnight preprod**: a **conditional real estate escrow contigency and settlement** .
2.  Desgin a Complete User experience with following requirements:
    • User flows to cover the roles and the functional requirements
    • Design separate page per role
    • Enforce Role Security (Zero-knowledge role authentication)
    • The visual style should be clean, minimalist,vibrant access, dark and light mode
    • Key UI components: sticky top nav, card-based feeds, responsive and mobile friendly design.

3.  Implementation of the requiremenmt specifications ( `dApp-requirenents-specification.md`)

## Techinical Stack

- React 19, Next.js 15 (App Router), TypeScript, Tailwind (midnight theme), vitest
- Compact compiler **0.31.1** ↔ compact-runtime 0.16.0 ↔ midnight-js 4.1.1 / compact-js 2.5.x
- Midnight DApp Connector v4 — Lace and 1AM wallets (Chrome / Brave)
- Midnight expert skills ( plugins)
- Local proof server `midnightntwrk/proof-server:8.1.0` (loopback only, `docker compose up -d`)

## Clean architecture

The application architecture must be organized in layers as recommended by the clean Architecture principles:
`src/domain` (types) · `src/application` (use-cases, ports) · `src/infrastructure` (midnight-js, wallet, indexer,
storage, crypto, tooling) · `src/presentation` (UI, hooks, providers, i18n). Dependencies point inward.

## Constraints

Performance, security, accessibility, SEO, i18n (en/fr/es), testing, clean architecture, TypeScript;
transactions requests are **persistent**.

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

## Implementation of the front end roadmap phase by phase

- Break this project down into distinct, sequential phases. For each phase, list the specific tasks, target files to touch, acceptance criteria (‘done when’ conditions), and any prerequisite steps. Do not write any code yet

### Phase 1 — Wallet connection and contract deployment

Instructions:

- Reuse the wallet connector for **Lace and 1AM** built for the `fungible-token-workspace` project
- Full Compilation with zk of the contract - reuse the project `fungible-token-workspace/scripts/compile.mjs`
- Generate the sdk ( ./sdk)
- Generate the tests ( ./tests)
-
- Build a separate admin user interface
  - deploy a contract while retaining the ability to fill in missing attributes at a later time to complete the initalisation
  - **Staged deploy** ( 5 circuits in the deploy tx, the rest by maintenance transactions) with resume from chain state
  - Deploy/registration progress panel; authority key export/import
  - Display the contract details ( reuse the project `fungible-token-workspace/scripts/check-contract.mjs`)
  - Verify the owner of the contract key ( reuse the project `fungible-token-workspace/scripts/verify-manager-key.mjs`)
- Midnight theme, responsive layout

### Phase 2 - Simulate a CASP Crypto-asset service provider (MiCA)

- Build a CASP signer simulator using React 19, Next.js 15 (App Router), TypeScript, Tailwind (midnight theme), vitest
  To build a Crypto-Asset Service Provider (CASP) Signer Simulator in Next.js/React, you need to simulate both the cryptographic signing layer (custody/key management) and the regulatory compliance engine mandated by MiCA (Regulation EU 2023/1114) and the EU Transfer of Funds Regulation (TFR / Travel Rule, Regulation EU 2023/1113)

### Phase 3 - Simulate an escrow service provider ()

### Phase 3 — Build the functional requirements

- Use the generated Sdk of the phase 1
- Implement the functional requirements specified in the `dApp-requirements-specification.md`[## 3. Functional Requirements]
  -Reminder:
  - The complete user experience design constraints are specified in the
    ## primary goal ot this `plan.md`
  - The techinical stack is spcified in
    ## Techinical Stack of this `plan.md`
  - The "in scope" is specified in
    ## `dApp-requirements-specification.md`[## 1.3. In scope]

### Phase 4 — Test the font-end dApp

    - Write  a markdown `end-to-end-testing.md` on  how to test the front end dApp for every role   using their Zero knowledged proof ( authentication) , their wallet,  the midnight contract  and the CASP simulator  for the users ( KYC attestations binding to  the users’s shielded wallet)

### Phase 5 — Remaining work (next steps)
