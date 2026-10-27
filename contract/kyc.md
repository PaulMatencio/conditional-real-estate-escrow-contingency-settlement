## Update the contact

Add an Escrow ticker symbol attribute to the constructor
The EscrowColor (Byte<32>) and Escrow ticker symbol ( Opaque<"string">) must be given at the deployment time and not later . Previously the EscrowColor attribute may be populated after the deployment.

## For Institutional Compliance Officer,

- Consider the utilisation of Midnight passport v1 sdk available on https://github.com/midnightntwrk/midnight-passport-sdk and mn-passort-skills https://github.com/midnightntwrk/midnight-passport-sdk/tree/main/mn-passport-skills ( 10 skills)
- Enforce KYC before accepting funds. Enables compliant Know-Your-Customer (KYC) and Anti-Money Laundering (AML) verification using zero-knowledge proofs (ZKPs) so users can prove regulatory compliance without exposing their raw personal documents or wallet.

---

# Implementation and analysis

> **Update 2026-10-27 (shared format + CASP simulator):** the attestation format now lives in the shared module `contract/KycAttestationV1.compact`: the `KycAttestation` and `SchnorrSignature` structs, the signed messages and `verifySchnorr`. The escrow contract imports it with `import "KycAttestationV1";`. The canonical copy is in the separate **eu-counterparty-simulator** project, a test-only CASP that issues, revokes and audits these attestations. Both repos pin the same sha256 (`contract/KycAttestationV1.sha256`, checked by `npm test`). Never edit the module here: a format change is a new `KycAttestationV2`.

> **Update 2026-10-24 (shielded custody, `shielded-token.md`):** `KycAttestation.wallet` is now the party's **shielded coin public key** (`ZswapCoinPublicKey`). It is compared privately with the committed payout key, so neither appears on-chain. The off-chain source-of-funds check in 5.1, which read the deposit's unshielded inputs, **no longer applies**: shielded inputs cannot be traced. Source-of-funds assurance moves to the CASP attestation (see `shielded-token.md` R-6).

*2026-10-23. Implemented in `conditional-real-estate-escrow-contingency-settlement.compact`. It compiles with `compactc` 0.31.1, the version pinned for this project's midnight-js 4.1.1 / ledger 8 stack. After the section 5 recommendations were added, `contract/test/escrow.sim.mjs` passes 129 of 129 checks, 35 of them for seller KYC, revocation and the Travel Rule anchor.*

## 1. Token color and ticker fixed at deployment

- The constructor is now `constructor(admin, buyer, seller, color: Bytes<32>, ticker: Opaque<"string">, ...10 Maybe terms)`.
- `escrowColor` is the unshielded token type, for example `nativeToken()` for NIGHT, or `rawTokenType(domainSep, tokenContract)` for a contract-issued token. It is written once in the constructor. No circuit can change it, and it was removed from `InitAttribute`, `applyConfig` and `configure`.
- `escrowTicker: Opaque<"string">` (e.g. `"EMT"`) is also written once. An `Opaque` value cannot be inspected inside a circuit, so the contract cannot check it against the token. The dApp should check that the ticker matches the token's metadata before the buyer calls `acceptConfiguration`.

## 2. Midnight Passport SDK: can it provide KYC today?

**Not yet.** I reviewed the public repository (`README`, `docs/beta-scope.md`, `docs/architecture.md`, `docs/sdk-requirements.md`). The `mn-passport-skills` folder could not be fetched (robots-blocked), so I could not review the 10 skills.

- The Passport SDK is in a planning/spec stage. Its **v1 beta** covers creating the Account Custody Contract (ACC), claiming a name such as `alice.passport.night`, and **Sign-In-with-Passport** with a profile read for dApps.
- **KYC, AML, credentials, issuers and selective disclosure are not in v1.** The requirements say verifiable credentials over DIDs will be delivered by a separate project (`midnight-verifiable-credentials`). The architecture document has no pattern for a third-party contract to verify a Passport credential, and no Compact interface is published.
- So the contract cannot call a "Passport KYC check" today.
- **What Passport can do now:** in the dApp, use Sign-In-with-Passport to authenticate the buyer, and keep the KYC attestation as the buyer's private data. When Passport and Midnight verifiable credentials ship, only the issuer-key and attestation format need to change. The circuit pattern below stays the same.

## 3. Design used: ZK KYC attestation from a trusted CASP

This is the pattern from Midnight's own *zk-loan* example (an attestation from a registered provider, verified with a Schnorr signature in-circuit).

1. **Off-chain:** a whitelisted CASP / KYC provider verifies the buyer's identity documents and wallet ownership. It then signs a `KycAttestation` with its Jubjub key:
   `{ subject, wallet, kycLevel, amlRiskScore, validUntil, travelRuleRef, salt }`.
   `subject` and `wallet` are the buyer's role id and payout address (or the seller's, see 5.3). `travelRuleRef` commits to the CASP's Travel Rule record (see 5.4).
   The raw documents never leave the CASP.
2. **Configuration:** during `Initializing`, the admin registers the trusted CASP keys (`addKycIssuer` / `removeKycIssuer`, the *trusted CASP whitelist*) and the `KycPolicy` (`minKycLevel`, `maxAmlRiskScore`). Buyer and seller accept these with the rest of the configuration, and they are frozen at finalization.
3. **`depositToEscrow()`:** before any funds move, the buyer's wallet supplies the attestation and signature through the private witness `kycAttestation()`. The circuit proves:
   - the issuer is on the whitelist, otherwise `ERROR_NOT_WHITELISTED: issuer is not a trusted CASP`;
   - the CASP signature is valid over all the claims (any change to a claim breaks it), otherwise `ERROR_NOT_WHITELISTED: invalid KYC attestation signature`;
   - the attestation is for **this buyer** (`subject == buyerId`) and **this wallet** (`wallet == buyerAddress`, the refund wallet), otherwise `ERROR_NOT_WHITELISTED`;
   - it has not expired, otherwise `ERROR_KYC_EXPIRED`;
   - `kycLevel >= minKycLevel`, otherwise `ERROR_KYC_LEVEL_INSUFFICIENT`;
   - `amlRiskScore <= maxAmlRiskScore`, otherwise `ERROR_AML_RISK_TOO_HIGH`;
   - its CASP has not revoked it, otherwise `ERROR_KYC_REVOKED` (see 5.2).
4. **Recorded on success:** `buyerKycVerified = true`, the issuer id, `buyerTravelRuleRef`, and `buyerKycRef`, a **salted** hash of the attestation. An auditor or notary who is given the attestation off-chain can check it against `buyerKycRef`. The salt stops anyone from guessing the private scores from the hash.

### What stays private and what is public

| Private (never on-chain) | Public |
|---|---|
| Identity documents, name, address | Which CASP attested (`buyerKycIssuer`) |
| Exact `kycLevel` and `amlRiskScore` (only "meets policy" is proven) | Pass/fail, and `buyerKycRef` (hiding hash) |
| The salt, the signature, the full attestation | `validUntil` (needed for the time check) |
| | The buyer's payout wallet (see below) |

**About "without exposing the wallet":** with **unshielded** custody, refunds go to a public `UserAddress`, so the payout wallet is on the ledger whatever we do. The attestation only binds that wallet to a verified customer. Hiding the wallet would need shielded custody, which is out of scope.

### Signature scheme (compiler 0.31.1)

- The standard library in 0.31.1 has no Schnorr verifier, so the contract contains `verifySchnorr`.
- It checks `s·G == R + c·pk` with `c = transientHash(Rx, Ry, pkx, pky, kycMessage(att))`.
- The 255-bit challenge is split by the witness `schnorrReduction(c)` into `q·2^248 + r`, and the circuit checks the split. `q < 116` is enforced so the prover cannot choose a different challenge. `r` is used as the Jubjub scalar.
- **The CASP signs** with `s = k + (c mod 2^248)·sk  (mod Jubjub order)`. `contract/test/casp-signer.mjs` implements this for attestations and both kinds of revocation.
- **When you move to compiler ≥ 0.34** (ledger 9), replace `verifySchnorr` with the standard library `jubjubSchnorrVerify`. On 0.35 the current file does not compile, because `ecMul` and `ecMulGenerator` now take `JubjubScalar`.
- 0.35 also adds `kernel.caller()`, but it does not yet work reliably for a deposit sent directly from a wallet (see 5.1).

## 4. Mapping to the SRS acceptance criteria (Compliance Officer story)

| Criterion | Status |
|---|---|
| Registry check on `deposit()` against a trusted CASP whitelist | ✅ `depositToEscrow` → `verifyBuyerKyc` against `kycIssuers` |
| Not whitelisted → revert with `ERROR_NOT_WHITELISTED` | ✅ The whole transaction reverts and no funds move. More specific `ERROR_KYC_*` codes cover expiry, level and risk score |
| Funds locked and a "funded" event emitted | ✅ Funds are locked and `status = Funded`. Midnight has no event logs, so indexers and dApps watch the `status` and `lifecycleRound` ledger fields instead |

## 5. Recommendations: implementation status

*Updated 2026-10-23. Items 5.2–5.4 are implemented on compiler 0.31.1. Item 5.1 stays open, with an off-chain control in the meantime.*

| # | Recommendation | Status |
|---|---|---|
| 5.1 | Funds must come from the KYC'd wallet | ⏳ Not enforceable in-circuit yet. Off-chain check below |
| 5.2 | Revocation | ✅ CASP-signed attestation revocation and CASP self-revocation of its key |
| 5.3 | Seller KYC (EU AMLD) | ✅ `submitSellerKyc()`, required by `releaseToSeller`, with an expiry fallback |
| 5.4 | Travel Rule / MiCA anchor | ✅ `travelRuleRef` in the attestation, recorded as `buyerTravelRuleRef` and `sellerTravelRuleRef` |

### 5.1 Funding wallet versus attested wallet (open)

- **On 0.31.1:** a circuit cannot see which wallet supplied a transaction's unshielded inputs.
- **On 0.35 (checked against its release notes):** `kernel.caller()` returns `right(userAddress)` only after the wallet balances the transaction, which happens after proving. The proof records `none`, so a direct deposit from a wallet would fail on-chain with a read mismatch. The release notes say to read `kernel.caller()` only where the call is known to come from a contract.
- **So this can't be enforced in-circuit today on either compiler.** The project stays on 0.31.1.
- **What the contract does guarantee:** every refund goes only to the attested `buyerAddress`, and every payout only to the attested `sellerAddress`.
- **Off-chain control (use now):** unshielded inputs are public. After a deposit, the dApp or compliance officer reads the deposit transaction from the indexer and checks that every unshielded input belongs to `buyerAddress`. If one doesn't, the buyer or seller opens a dispute and the resolver refunds through `resolveDisputeRefund`. The refund goes to the attested wallet.
- **When the toolchain allows it** (an intent that can set its top-level caller explicitly), add this inside `depositToEscrow`. It compiles on 0.35:

  ```compact
  const caller = kernel.caller();
  assert(caller.is_some && !caller.value.is_left && caller.value.right == buyerAddress,
         "ERROR_NOT_WHITELISTED: funds must come from the verified buyer wallet");
  ```

### 5.2 Revocation (implemented)

There is no new trusted role. Revocations must be signed by the CASP that issued the attestation, and **anyone can submit them** (the CASP, the dApp, a compliance officer).

| Circuit | Signed message | Effect |
|---|---|---|
| `revokeKycAttestation(issuerId, ref, sig)` | `kycRevocationMessage(ref)`. `ref` = `kycReference(att)`, which the CASP can compute | Adds `ref` to `revokedKycRefs`. That attestation fails every later check with `ERROR_KYC_REVOKED`, at deposit, at `submitSellerKyc` and at `releaseToSeller` |
| `revokeKycIssuer(issuerId, sig)` | `issuerRevocationMessage(issuerId)` | Removes the CASP key from `kycIssuers`. Every attestation it signed stops passing, and a seller payout that relied on it is blocked |

- **Each message has its own domain tag** (`re-escrow:kyc-revoke:v1`, `re-escrow:issuer-revoke:v1`, `re-escrow:kyc:v1`). A signature for one kind of message can't be replayed as another. The tests check this.
- **Revocation can only block, never admit or move funds.** That is why it is allowed after finalization, even though the rest of the configuration is frozen.
- **A buyer attestation revoked after the deposit** doesn't move the locked funds. The revocation is visible on-chain through `revokedKycRefs` and `buyerKycRef`. If it matters, the parties escalate through a dispute.
- **Signer helper:** `casp.revokeAttestation(ref)` and `casp.revokeIssuer(issuerId)` in `casp-signer.mjs`.

### 5.3 Seller KYC (implemented)

- **`submitSellerKyc()`:** the seller proves an attestation with the same checks as the buyer, bound to `subject = sellerId` and `wallet = sellerAddress`. It can be submitted any time from `Created` to `Settled`. Re-submitting replaces the record, for example with a renewed attestation after expiry or revocation.
- **`releaseToSeller()`** now requires:
  - `sellerKycVerified`, otherwise `ERROR_SELLER_KYC_REQUIRED`;
  - the issuer is still whitelisted, otherwise `ERROR_NOT_WHITELISTED: seller KYC issuer was revoked`;
  - the attestation is not revoked, otherwise `ERROR_KYC_REVOKED`;
  - it has not expired, otherwise `ERROR_KYC_EXPIRED`.
- **Liveness:** if the escrow is `ReadyToClose` or `Settled` but the seller has no usable KYC by `disputeDeadline`, anyone can call `expireEscrow()` and the buyer is refunded. A seller with valid KYC can't be expired this way.
- **Refunds to the buyer** need no new KYC check. Returning funds to the verified wallet they came from is the AML-safe direction.

### 5.4 Travel Rule / MiCA anchor (implemented)

- `KycAttestation` has a new field, `travelRuleRef`: a hash, salted by the CASP, of its off-chain Travel Rule record (originator or beneficiary data, e.g. IVMS101).
- Because it is inside the signed attestation, the CASP vouches for it. On success it is recorded as `buyerTravelRuleRef` (originator) or `sellerTravelRuleRef` (beneficiary).
- Personal data stays with the CASPs. A regulator or notary given the record off-chain can check it against the on-chain anchor.
- **Breaking change:** `KycAttestation` gained a field, so attestations signed before this change no longer verify. The signer helper is generic and needs no change.

## Sources

- [midnight-passport-sdk](https://github.com/midnightntwrk/midnight-passport-sdk): `docs/beta-scope.md`, `docs/architecture.md`, `docs/sdk-requirements.md`
- [Midnight zk-loan tutorial, smart contract](https://docs.midnight.network/tutorials/zk-loan/smart-contract) and [example](https://docs.midnight.network/examples/dapps/zkloan)
- [compact-runtime `jubjubSchnorrVerify`](https://docs.midnight.network/api-reference/compact-runtime/functions/jubjubSchnorrVerify)
- Compact toolchain 0.35.0 release notes (`kernel.caller()`, `jubjubSchnorrVerify`)
