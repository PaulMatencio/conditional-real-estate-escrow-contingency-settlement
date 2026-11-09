# Compact compiler 0.36.0 upgrade

*2026-11-09. The escrow now compiles with `compactc` **0.36.0 (b5d9e4dfc 2026-11-03)**. Compact language is 0.28.0, compact-runtime 0.21.0, ledger 9, and ZKIR v3.*

The preview network now runs ledger 9. A contract compiled with 0.36 only runs with compact-runtime 0.21, and midnight-js 5.0.0 is the version that loads it. So the compiler upgrade also upgrades the whole dApp stack.

## Versions

| Component | Before | Now |
|---|---|---|
| Compact compiler | 0.31.1 (language 0.23) | **0.36.0** (language 0.28) |
| compact-runtime | 0.16.0 | **0.21.0** |
| compact-js | 2.5.1 | **3.0.0** |
| midnight-js (contracts, types, utils, indexer, fetch-zk-config, http proof provider) | 4.1.1 | **5.0.0** |
| Ledger | `@midnight-ntwrk/ledger-v8` 8.1.2 | **`@midnightntwrk/ledger-v9` 1.0.0** |
| On-chain runtime | `onchain-runtime-v3` 3.0.0 | **`@midnightntwrk/onchain-runtime-v4` 4.0.0** |
| DApp connector API | `@midnight-ntwrk/dapp-connector-api` ^4.0.1 | **`@midnightntwrk/dapp-connector-api` 4.1.0** |
| Address format | `@midnight-ntwrk/wallet-sdk-address-format` ^3.1.2 | **`@midnightntwrk/wallet-sdk-address-format` 4.0.0** |
| New dependency | — | **`@midnight-ntwrk/midnight-js-dapp-connector-proof-provider` 5.0.0** (wallet providers) |
| Removed | `midnight-js-network-id` | The network id now comes from the providers' `config` |
| Proof server (docker) | `midnightntwrk/proof-server:8.1.0` | **`midnightntwrk/proof-server:9.0.1`** |

## Contract changes

- **`KycAttestationV1.compact`:** two casts. Since 0.36, `ecMulGenerator` and `ecMul` take a `JubjubScalar`, no longer a `Field`. The module now writes `ecMulGenerator(sig.response as JubjubScalar)` and `ecMul(pk, c as JubjubScalar)`.
  - The signed messages, the structs and the challenge are unchanged, so signatures issued by the CASP still verify.
  - The stdlib `jubjubSchnorrVerify` is not used, because its challenge hash differs from this format.
  - The pinned hash `KycAttestationV1.sha256` is updated to `d42b2676…`.
- **The main contract needed no change.** It uses no `pure` circuits in contract types, no cross-contract calls, and no non-`Field` to `Boolean` casts.
- **Same 25 circuits.**
- **Test results:**
  - `contract/test/escrow.sim.mjs`: **149 of 149** checks pass on runtime 0.21. It is now async, because the constructor and circuits return promises.
  - App tests: 73 of 74 pass. The one remaining test needs the ZK keys from the full build.

## dApp changes

- **Simulator Mode:** build it with `await EscrowSimulator.create(...)`. Circuit runs are async and serialized. The runtime 0.21 context is an options object and returns per-contract `queryContexts` / `zswapLocalStates`.
- **Wallet providers (`wallet/providers.ts`):**
  - The wallet and submission providers come from midnight-js `dappConnectorWalletProviders`, which use one handler per ledger era.
  - Our wrapper keeps:
    - the step progress;
    - the DUST diagnosis when a fee fails;
    - the wallet's recent history when a submit fails;
    - hex shielded keys.
  - `config: { networkId, ttlSeconds: 3600 }` replaces `setNetworkId`.
- **Proving:** proofs still go only to the **local** proof server (version 9). Wallet-side proving is not used, for two reasons:
  - the private witnesses must stay on this machine;
  - the wallet SDK's in-browser prover cannot prove ZKIR v3 circuits yet (midnight-wallet issue #914).
- **Contract state:** the indexer returns era-tagged bytes. `contract/chainState.ts` decodes them with the runtime's own `ContractState`. A contract from the ledger 8 era is refused with a clear message ("deploy a new escrow").
- **Maintenance updates (circuit batches, renounce):**
  - built with ledger 9 classes;
  - verifier keys use operation version **`v4`**;
  - sealed with `LedgerTransaction.seal('v9', 'Unproven', …)`.
- **Private state provider:** the midnight-js 5 interface (`forContract`, `clearAll`). The authority key still goes only to the encrypted vault.
- **`/zk` route:** also serves `compiler/contract-manifest.json` and `contract-info.json`. midnight-js 5 checks every key and ZKIR file against this integrity manifest and reads the runtime version from it.

## What to do on your machine

```sh
compact update 0.36.0                 # install the compiler
npm install                           # midnight-js 5 / runtime 0.21 / ledger 9
npm run compile:contract              # full ZK build (keys) with 0.36.0 — regenerates contract/managed/escrow
npm run generate:sdk
npm test                              # all 74 should pass once the keys exist
cd contract && npm install && npm test && cd ..   # check-kyc-module + 149 simulator checks
npm run proof-server:stop && docker compose pull && npm run proof-server:start   # proof-server 9.0.1
```

The full ZK build must run on your machine: key generation downloads the SRS parameters from `srs.midnight.network`.

## Consequences

- **Old contracts:** contracts deployed with the 0.31.1 build can't be used with this build (ledger 8 artifacts, different verifier keys). Deploy a new escrow on preview. This probably also explains the earlier "Contract state not found on this network".
- **eu-counterparty-simulator:** the shared `KycAttestationV1.compact` changed (the casts plus its header comment). Copy the same file into the eu-counterparty-simulator project and pin the same sha256 (`d42b26760261aed13b1a6eb6cdb461151e160bb980858e1f5944628386016be8`). Otherwise its own check fails, or it keeps compiling the old version with 0.31.
- **Wallets:** Lace / 1AM must support ledger 9 on preview (DApp Connector 4.1). Balancing and fees are still done by the wallet.
