# Conditional real-estate escrow with contingency settlement

A [Midnight](https://midnight.network) Compact smart contract that holds a buyer's funds in escrow as a **shielded** token (e.g. a EUR e-money token), keeping the price and payout wallets private, and releases them to the seller only after the inspection, financing and title contingencies clear. It refunds the buyer when a contingency fails, the seller withdraws, or a deadline passes.

- Contract: [`contract/conditional-real-estate-escrow-contingency-settlement.compact`](contract/conditional-real-estate-escrow-contingency-settlement.compact)
- Review, circuit reference and state-machine diagram: [`contract/compact.md`](contract/compact.md)
- Delayed initialization: [`contract/delay-init.md`](contract/delay-init.md) · KYC/AML: [`contract/kyc.md`](contract/kyc.md) · Shielded custody: [`contract/shielded-token.md`](contract/shielded-token.md)
- dApp requirements (SRS v2.0): [`dApp-requirements-specification.md`](dApp-requirements-specification.md)

## Roles

Admin (setup only), buyer, seller, inspector, lender, title agent and dispute resolver, plus trusted KYC providers (CASPs) whose attestation the buyer must prove at deposit. Each party role is identified by `roleIdOf(secretKey)`. The attestors must be independent of the seller and the resolver.

## Compile

```sh
compact compile +0.31.1 --skip-zk \
  contract/conditional-real-estate-escrow-contingency-settlement.compact \
  contract/managed/escrow
```

Language version 0.23 (compiler 0.31.1). Compiler 0.34 and later would need the stdlib `jubjubSchnorrVerify` (see `contract/kyc.md`).

## Test

The simulator tests run every circuit off-chain with `@midnight-ntwrk/compact-runtime` 0.16.0, without a node or proofs:

```sh
cd contract
npm install
npm run compile   # -> contract/managed/escrow
npm test
```

`contract/KycAttestationV1.compact` is the shared KYC attestation format, vendored byte-for-byte from the **eu-counterparty-simulator** project (a test-only MiCA CASP simulator used for end-to-end tests); `npm test` checks its pinned sha256. `contract/test/casp-signer.mjs` is the lightweight in-repo signing helper. It issues the KYC attestation that the buyer proves at deposit, and it also gives the dApp a `schnorrReduction` witness and an off-chain signature check.
