# Conditional real-estate escrow with contingency settlement

A [Midnight](https://midnight.network) Compact smart contract that holds a buyer's funds in escrow as a **shielded** token (e.g. a EUR e-money token), keeping the price and payout wallets private, and releases them to the seller only after the inspection, financing and title contingencies clear. It refunds the buyer when a contingency fails, the seller withdraws, or a deadline passes.

- Contract: [`contract/conditional-real-estate-escrow-contingency-settlement.compact`](contract/conditional-real-estate-escrow-contingency-settlement.compact)
- Review, circuit reference and state-machine diagram: [`contract/compact.md`](contract/compact.md)
- Delayed initialization: [`contract/delay-init.md`](contract/delay-init.md) · KYC/AML: [`contract/kyc.md`](contract/kyc.md) · Shielded custody: [`contract/shielded-token.md`](contract/shielded-token.md)
- dApp requirements (SRS v2.0): [`dApp-requirements-specification.md`](dApp-requirements-specification.md)

## Roles

Admin (setup only), buyer, seller, inspector, lender, title agent and dispute resolver, plus trusted KYC providers (CASPs) whose attestation the buyer must prove at deposit. Each party role is identified by `roleIdOf(secretKey)`. The attestors must be independent of the seller and the resolver.

### How role ids are derived

Admin, buyer and seller are not accounts or wallet addresses. Each is a **role id** derived from a 32-byte secret key that the party generates and keeps private:

```
secretKey = 32 random bytes                       (generated client-side, never sent on-chain)
roleId    = persistentHash([pad(32, "re-escrow:role:"), secretKey])
```

- The derivation is the contract's exported pure circuit `roleIdOf` (see `contract/conditional-real-estate-escrow-contingency-settlement.compact`). The dApp calls the compiled circuit directly ([`src/infrastructure/crypto/identity.ts`](src/infrastructure/crypto/identity.ts)), so client and chain cannot drift apart.
- The deployer passes the **admin, buyer and seller role ids** (public, 64 hex chars each) to the constructor. They are stored as `adminId`, `buyerId` and `sellerId`. Buyer and seller must be distinct, and the admin must not be the buyer.
- To act, a party supplies its secret key through the `localSecretKey` witness. The circuit recomputes `roleIdOf(secretKey)` and asserts it equals the stored id (`onlyAdmin`, `onlyBuyer`, `onlySeller`). The key itself never appears on-chain.
- Each party generates its own key and shares only the role id with the deployer. The admin should never generate the buyer's or seller's key: whoever holds a secret key can act as that party.
  - **Buyer, seller and other parties:** open the dApp's **My role id** page (`/role-id`, no wallet needed), click *Generate new key*, save the secret key in a password manager, and send only the **role id** to the admin. The page keeps the key in memory only; nothing is stored or sent. It can also derive the role id of an existing key.
  - **Admin:** the admin key is created on the admin console's **Keys** tab, which also checks it against the on-chain `adminId`. Replacing a key that is the live admin of the loaded contract needs an export and a typed confirmation. The same check is available from a terminal: `npm run verify:admin-key`.
  - Before funding anything, each party should compare the on-chain `buyerId` / `sellerId` (Contract tab, or `npm run check:contract -- <address>`) with its own role id.
- Losing a secret key means losing that role, so back it up. The admin console stores the admin key in the browser's localStorage only.
- Optional roles (inspector, lender, title agent, dispute resolver) use the same derivation.

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

## dApp (Phase 1: admin console)

```sh
npm install
npm run compile:contract   # full ZK build -> contract/managed/escrow (compiler 0.31.1)
npm run generate:sdk       # typed client -> sdk/escrow
npm run proof-server:start # local proof server on 127.0.0.1:6300
npm run dev                # http://localhost:3000/admin
npm test                   # tests/ (vitest)
npm run check:contract -- <address>        # read-only chain details
SK=<hex> npm run verify:admin-key -- <address>
```

The admin console deploys in stages (the circuits in `contract.deployCircuits` go in the deploy transaction, the remaining 20 in batches of `contract.maintenanceBatchSize` (default 4) per maintenance transaction, i.e. 5 maintenance transactions, resumable from chain state), shows the contract details, fills in the missing terms and verifies the admin key. The wallet connector (Lace, 1AM) and staged-deploy logic are reused from `fungible-token-workspace`.

## Network

The dApp targets the Midnight **preview** network (`midnight.config.json`): public indexer and RPC, no Blockfrost project token needed. Use a Lace or 1AM wallet set to *preview* and the faucet at https://midnight-tmnight-preview.nethermind.dev/.

## dApp (Phase 2: party pages)

| Page | Role | Main circuits |
| :--- | :--- | :--- |
| `/buyer` | Buyer | acceptConfiguration, depositToEscrow, waiveContingency, cancelAndRefund, openDispute, releaseToSeller, refundBuyer |
| `/seller` | Seller | acceptConfiguration, submitSellerKyc, openContingencyReview, sellerWithdraw, openDispute, releaseToSeller |
| `/inspector`, `/lender`, `/title-agent` | Attestors | submitInspection / submitFinancing / submitTitle (salted document hash) |
| `/resolver` | Dispute resolver | only the circuits valid in the current state |
| `/compliance` | CASP / compliance officer | issuer keys vs whitelist, signed revocations, attestation and Travel Rule status |
| `/verify/[contractAddress]` | Notary / land registry | read-only, no wallet: locked funds, price opening, document and CASP checks, certificate |
| `/admin` → *Terms & KYC* | Admin | private terms package, commitments, encrypted distribution, CASP whitelist, guarded finalize |

Every page runs in **Wallet Mode** (Lace / 1AM, local proof server, preview) or **Simulator Mode** (the compiled contract in the browser, with a block-time slider). Role keys, private terms, attestations and document salts live in an AES-GCM encrypted vault in the browser (IndexedDB); nothing private goes to a server or a URL.

### CASP simulator

Start the eu-counterparty-simulator (`npm run start-server`, port 8787), then create `.env.local` with the officer / notary tokens it prints:

```sh
CASP_SIM_URL=http://127.0.0.1:8787
CASP_OFFICER_TOKEN=<printed by the simulator>
CASP_NOTARY_TOKEN=<printed by the simulator>
# CASP_SIM_ENABLED=1   # only needed for `next start` (production build)
```

Persona attestations and the issuer keys work without tokens; revocation and status lookups need them. The dApp reaches it through its own `/api/casp/*` proxy (allow-listed paths; tokens stay server-side; disabled in production unless `CASP_SIM_ENABLED=1`). Buyer and seller pages request a `KycAttestationV1` for a fixture persona bound to their role id and committed payout key; the admin whitelists the CASP's issuer key from `/.well-known/casp-keys`.

### Still to validate on preview (SRS §8)

- **V-1** payout-coin import: DApp Connector v4 has no import call; the dApp exports the payout coin for now.
- **V-2** vault `mt_index`: derived from the deposit transaction and the indexer's Zswap state (`PartyGateway.indexFromTx`); a manual index entry is available.
- **V-3 / V-4 / V-5**: deposit balancing with a caller-chosen nonce, a shielded test token on preview, proving times.
