1. Check the contract conditional-real-estate-escrow-contingency-settlement.compact,
2. The contract should operate as a state machine that transitions through strict phases
3. Identify and fix potential flaws. How to prevent a resolver to overwrite a contingency result while review is pending, including changing a failed result to a passing one
4. Sugesst potential improvement as for instance
   4.1 Authorize correction paths ? When , what and who ?
   4.2 What if refundBuyer failed due to unsufficient escrow balance? do we need a arbiter role or who can handle this exceptional case ?
   4.3 What happen if buyer or seller back out
   4.4 How and where the documents should be stored

5. Document clearly each circuit and explain its use case
6. Finally draw a graph of the state machine that transitions through strict phases of this smart contact
7. Display the graph in this markdown

---

# Review report — `conditional-real-estate-escrow-contingency-settlement.compact`

> **Update 2026-10-24: shielded custody.** The escrow now holds one **shielded** coin (`receiveShielded` / `sendShielded`). `escrowAmount`, `buyerAddress` and `sellerAddress` were replaced by salted commitments, which circuits open through the `privateTerms` witness. Anything below that refers to unshielded custody, `unshieldedBalanceGte` or public payout addresses describes the earlier version. See `shielded-token.md`.

_Reviewed 2026-10-22. The fixed contract compiles with `compactc` 0.31.1 (language 0.23, the version pinned by this project) and 0.35.0. A JS simulator run with `compact-runtime` 0.16.0 passed 55 of 55 scenario checks. The two most serious flaws below were reproduced on the original contract before fixing._

## 1. Check of the original contract

The skeleton was sound: custody is atomic (`receiveUnshielded`/`sendUnshielded`), roles are hashed secrets, not `ownPublicKey()`, each attestor can submit only once, and a `disbursed` flag guards every payout. But the phases were **not strict**. Several transitions could be skipped or triggered by the wrong party.

## 2. Strict-phase rules applied

- Every exported circuit first asserts the exact source phase(s) it may run from. No circuit is valid in "any" state.
- Each transition has exactly one authorized role, or is an explicitly permissionless keeper call that is time-gated.
- `Closed` and `Cancelled` are terminal. No circuit accepts them as a source.
- Only `releaseToSeller` and `refundBuyer` move funds, and only from the approval states (`ReadyToClose`/`Settled` → seller, `Refunded`/`Expired` → buyer).
- `lifecycleRound` is incremented on **every** status change, including the automatic move to `ReadyToClose`, so off-chain clients can detect any transition.

## 3. Flaws found and fixed

| #   | Severity     | Flaw (original)                                                                                                                                                                                                                                                                                   | Fix                                                                                                                                                                                                                                                |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Critical** | `expireEscrow` had no deadline check and no caller check (the time check was a TODO). **Anyone** could move a funded escrow to `Expired` at once and kill the deal. _Reproduced._                                                                                                                 | `assert(blockTimeGte(closingDeadline))`. It stays permissionless (keeper call) but is time-gated.                                                                                                                                                  |
| F2  | **Critical** | **Resolver overwrite of a contingency result.** The seller opens a dispute after a _failed_ inspection, then `resolveDisputeSettlement` → `Settled` → seller is paid. The resolver turned a failed result into a pass, and could also bypass contingencies that were still pending. _Reproduced._ | `resolveDisputeSettlement` now requires `allCleared()`. The resolver can never write a contingency value. Its only correction power is `voidContingencyResult`, which erases an attested result so the **original attestor** re-attests (see 4.1). |
| F3  | High         | A `Disputed` escrow with an absent resolver locked the funds forever.                                                                                                                                                                                                                             | New `disputeDeadline` (constructor, must be later than `closingDeadline`). After it, `expireEscrow` also works from `Disputed` and defaults to a refund.                                                                                           |
| F4  | High         | The seller could be named as inspector, lender or title agent and pass their own contingencies.                                                                                                                                                                                                   | Constructor asserts that all attestors ≠ seller, and also buyer ≠ seller, buyer/seller ≠ resolver, `amount > 0`, `disputeDeadline > closingDeadline`.                                                                                              |
| F5  | Medium       | The buyer could fund after `closingDeadline`, which leads to an immediate expiry and a wasted round trip.                                                                                                                                                                                         | `depositToEscrow` asserts `blockTimeLt(closingDeadline)`.                                                                                                                                                                                          |
| F6  | Medium       | `openDispute` had no time limit. A party could dispute at the last moment to stall.                                                                                                                                                                                                               | Disputes must be opened before `disputeDeadline`.                                                                                                                                                                                                  |
| F7  | Low          | `refundBuyer` was callable by anyone. Funds still went to `buyerAddress`, but any third party could trigger it.                                                                                                                                                                                   | Limited to buyer, seller or resolver (`onlyParty`).                                                                                                                                                                                                |
| F8  | Low          | There was no exit before funding. The contract sat in `Created` forever.                                                                                                                                                                                                                          | `cancelBeforeFunding` → `Cancelled` (terminal, no funds involved).                                                                                                                                                                                 |
| F9  | Low          | The automatic move to `ReadyToClose` did not bump `lifecycleRound`.                                                                                                                                                                                                                               | Fixed inside `advanceIfAllCleared`.                                                                                                                                                                                                                |

### How the resolver is prevented from overwriting a result (item 3)

1. **No write access.** No resolver circuit assigns `*Passed`, `*Approved` or `*Cleared`. Only `submitInspection`, `submitFinancing` and `submitTitle` (each restricted to its attestor) and `waiveContingency` (buyer) write results.
2. **Write-once.** `assert(!xxxSubmitted)` blocks every in-place overwrite, including by the attestor itself.
3. **Frozen during a dispute.** Attestors can submit only in `ContingenciesPending`, so nothing changes while `Disputed`.
4. **No payout bypass.** The resolver can award the seller only when the on-chain record is already fully cleared. A failed or pending result can never become a seller payout through the resolver.
5. **Fail → pass is possible in only two ways:** the buyer, who is the protected party, waives the contingency; or the resolver voids the result and the _original_ attestor re-attests it as passed.

## 4. Improvements

### 4.1 Correction paths: when, what and who

| Path                                                           | Who                                          | When (phase)           | What it can do                                                                                                                  | What it cannot do                                                   |
| -------------------------------------------------------------- | -------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Waiver (`waiveContingency`) — **implemented**                  | Buyer only (contingencies protect the buyer) | `ContingenciesPending` | Mark a pending **or failed** contingency as satisfied (`waived = true`, irreversible)                                           | Make anything stricter; the seller cannot waive                     |
| Void and re-attest (`voidContingencyResult`) — **implemented** | Resolver, then the original attestor         | Only in `Disputed`     | Erase one _attested_ result → back to `ContingenciesPending` → the attestor re-submits. `correctionCount` keeps the audit trail | Choose the value; void a buyer waiver; act outside a dispute        |
| Dismiss (`dismissDispute`) — **implemented**                   | Resolver                                     | `Disputed`             | Return to `ReadyToClose` or `ContingenciesPending`, based on the record                                                         | Change any result                                                   |
| _Suggested:_ attestor self-correction with a cool-down         | Attestor + buyer consent                     | `ContingenciesPending` | Fix a clerical error                                                                                                            | — needs two-step consent (`proposeCorrection` / `acceptCorrection`) |
| _Suggested:_ cap on corrections                                | —                                            | —                      | `assert(correctionCount < N)` to stop endless void loops (already bounded in time by `disputeDeadline`)                         | —                                                                   |

### 4.2 `refundBuyer` with an insufficient escrow balance

- **Why it should not happen:** the contract receives exactly `escrowAmount`, and only `releaseToSeller`/`refundBuyer` can spend it, once (`disbursed`). The balance can only fall short if a future circuit spends funds, or the token or ledger behaves unexpectedly.
- **What happens if it does:** the `unshieldedBalanceGte` assert reverts the **whole transaction**. State stays `Refunded`/`Expired`, nothing is lost, and the call can be retried. Funds are not "half-sent".
- **Who handles it:** a new arbiter role is not needed; the **resolver** is the exceptional-case authority. Suggested additions:
  - `topUpEscrow(amount)`: any party (seller, resolver or insurer) deposits the shortfall. Allow it only when `!disbursed` and `unshieldedBalanceLt(color, escrowAmount)`.
  - `refundAvailable()`: resolver only, after a grace period. Sends whatever balance exists and records the shortfall on the ledger for off-chain recovery. Use it as a last resort, because it breaks the "all or nothing" invariant.
  - Keep the resolver separate from all attestors and both principals, as the constructor already enforces.

### 4.3 Buyer or seller backs out

| Who / when                        | Behaviour (fixed contract)                                                                                                                                       | Suggested next step                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Either side, before funding       | `cancelBeforeFunding` → `Cancelled`                                                                                                                              | —                                                                                                                                                            |
| Seller, after funding             | `sellerWithdraw` → `Refunded` → buyer is refunded                                                                                                                | Add a seller penalty or deposit so withdrawal is not free                                                                                                    |
| Buyer, after a failed contingency | `cancelAndRefund` → `Refunded`                                                                                                                                   | —                                                                                                                                                            |
| Buyer, no failed contingency      | No unilateral exit. They can `openDispute`; the resolver can refund, but can award the seller only if everything is cleared. Otherwise the deal expires → refund | **Earnest-money / liquidated-damages split:** add `forfeitAmount` and a `Forfeited` state that sends `forfeitAmount` to the seller and the rest to the buyer |
| Either side goes silent           | `expireEscrow` after `closingDeadline` (or `disputeDeadline` when disputed) → refund                                                                             | —                                                                                                                                                            |
| Buyer silent in `ReadyToClose`    | The seller can call `releaseToSeller`                                                                                                                            | Optional dispute window: allow release only after `readySince + N` so the buyer can raise final walk-through issues                                          |

### 4.4 Document storage

- **Never on-chain in clear text.** The ledger is public. Store only a **commitment**: `persistentHash(documentBytes ‖ salt)`.
- **Where:** encrypted off-chain storage, either IPFS/Arweave for permanence or the title company's or escrow agent's document management system. Encrypt with a per-deal key shared only with the roles involved.
- **On-chain anchor (implemented):** each submit circuit takes `reportHash: Bytes<32>` and stores `inspectionReport`, `financingLetter` and `titleCommitment` (rejecting empty 32-byte hashes). Anyone holding the document can prove it matches. `voidContingencyResult` preserves the old hash in `voidedReportHistory` (keyed by `correctionCount`) before clearing it for re-attestation.
- **Selective disclosure:** use witnesses so an attestor can prove "report hash H says _passed_" without revealing the report.
- **Retention:** follow the jurisdiction's escrow and record-keeping rules. Deleting the off-chain copy leaves the commitment unverifiable, but nothing sensitive is left on-chain.

Buyer, seller, inspector, lender, title agent and dispute resolver

### Helpers (not exported)

| Circuit                                                                                                                                    | Purpose                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `roleIdOf(sk)` _(exported, pure)_                                                                                                          | `persistentHash("re-escrow:role:", sk)`. Clients use it to derive the role ids passed to the constructor. |
| `roleId()`                                                                                                                                 | The caller's role id from the `localSecretKey` witness (the secret never leaves the prover).              |
| `onlyAdmin` / `onlyBuyer` / `onlySeller` / `onlyBuyerOrSeller` / `onlyParty` / `onlyDisputeResolver` / `onlyInspector` / `onlyLender` / `onlyTitleAgent` | Role guards. Only the boolean match is disclosed, never the key.                                          |
| `isFullyConfigured()` / `applyConfig(...)` / `configChanged()` | All 11 `InitAttribute`s are in `configured` / writes each `some(v)` term and records it in `configured` / resets acceptances and bumps `configVersion`. |
| `verifySchnorr(pk, msg, sig)` / `verifyBuyerKyc()` | Jubjub Schnorr verification of the CASP signature / the KYC gate used by `depositToEscrow`. |
| `kycMessage(att)` / `kycReference(att)` _(exported, pure)_ | The message the CASP signs / the salted on-chain reference stored in `buyerKycRef`. |
| `allCleared()`                                                                                                                             | All three contingencies are submitted and favourable (or waived).                                         |
| `anyFailed()`                                                                                                                              | At least one submitted contingency is unfavourable.                                                       |
| `advanceIfAllCleared()`                                                                                                                    | Automatic `ContingenciesPending → ReadyToClose`.                                                          |

### Exported circuits

| Circuit                        | Caller                                                        | From → To                                                                                                             | Use case                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `constructor(admin, buyer, seller, color, ticker, ...Maybe terms)` | Deployer | — → `Initializing` | Sets admin, buyer, seller, the **shielded** token's color and its ticker (mandatory, immutable). The amount and both payout keys are passed as `Maybe` **commitments**, alongside the other `Maybe` terms. See `delay-init.md` and `shielded-token.md`. |
| `addKycIssuer(id, key)` / `removeKycIssuer(id)` | Admin | `Initializing` → same | Maintains the trusted CASP whitelist (Jubjub public keys). Resets acceptances. See `kyc.md`. |
| `configure(...Maybe terms)` | Admin | `Initializing` → same | Populates or corrects any subset of the terms. Resets buyer/seller acceptance and bumps `configVersion`. |
| `acceptConfiguration(expectedVersion)` | Buyer, seller | `Initializing` → same | Each party signs off on the complete configuration at the version it read. |
| `finalizeInitialization()` | Admin | `Initializing` → `Created` | Requires all terms present and valid, plus both acceptances. Freezes the configuration and ends the admin's powers. |
| `cancelBeforeFunding()`        | Buyer or seller (admin too while `Initializing`)              | `Initializing` / `Created` → `Cancelled`                                                                                               | The deal falls through before any money is locked.                                                                                |
| `depositToEscrow(coin)` | Buyer | `Created` → `Funded` | Opens the private terms, proves buyer KYC/AML in zero knowledge (bound to the committed shielded payout key), and claims exactly one shielded coin `{vaultNonceOf(...), escrowColor, amount}` with `receiveShielded`. Errors: `ERROR_TERMS_MISMATCH`, `ERROR_DEPOSIT_COIN_MISMATCH`, `ERROR_NOT_WHITELISTED`, `ERROR_KYC_*`. |
| `submitSellerKyc()` | Seller | `Created` … `Settled` → same | Seller proves a KYC/AML attestation bound to `sellerId` and `sellerAddress`. Required before any payout to the seller. See `kyc.md` 5.3. |
| `revokeKycAttestation(issuerId, ref, sig)` | Anyone (CASP-signed) | any → same | Revokes one attestation; it fails all later KYC checks with `ERROR_KYC_REVOKED`. |
| `revokeKycIssuer(issuerId, sig)` | Anyone (CASP-signed) | any → same | The CASP withdraws its own key from the whitelist. |
| `openContingencyReview()`      | Buyer or seller                                               | `Funded` → `ContingenciesPending`                                                                                     | Starts the inspection, financing and title period.                                                                                |
| `submitInspection(passed, reportHash)` | Inspector                                                     | `ContingenciesPending` → same / `ReadyToClose`                                                                        | Inspector records the outcome once and anchors `inspectionReport` (`Bytes<32>`).                                                  |
| `submitFinancing(approved, reportHash)` | Lender                                                        | `ContingenciesPending` → same / `ReadyToClose`                                                                        | Lender records the loan decision once and anchors `financingLetter` (`Bytes<32>`).                                                |
| `submitTitle(cleared, reportHash)`     | Title agent                                                   | `ContingenciesPending` → same / `ReadyToClose`                                                                        | Title agent records the title search once and anchors `titleCommitment` (`Bytes<32>`).                                            |
| `waiveContingency(which)`      | Buyer                                                         | `ContingenciesPending` → same / `ReadyToClose`                                                                        | Buyer accepts the property despite a pending or failed contingency (e.g. cash purchase, accepts defects).                         |
| `cancelAndRefund()`            | Buyer                                                         | `ContingenciesPending` → `Refunded`                                                                                   | Buyer exits because a contingency failed.                                                                                         |
| `sellerWithdraw()`             | Seller                                                        | `Funded` / `ContingenciesPending` / `ReadyToClose` → `Refunded`                                                       | Seller backs out; the buyer gets the money back.                                                                                  |
| `openDispute()`                | Buyer or seller                                               | `ContingenciesPending` / `ReadyToClose` → `Disputed`                                                                  | Contest a result or the closing; freezes the escrow.                                                                              |
| `resolveDisputeRefund()`       | Resolver                                                      | `Disputed` → `Refunded`                                                                                               | Resolver rules for the buyer.                                                                                                     |
| `resolveDisputeSettlement()`   | Resolver                                                      | `Disputed` → `Settled`                                                                                                | Resolver rules for the seller; **only when all contingencies are cleared**.                                                       |
| `voidContingencyResult(which)` | Resolver                                                      | `Disputed` → `ContingenciesPending`                                                                                   | Erases one contested attestation so its original attestor re-attests.                                                             |
| `dismissDispute()`             | Resolver                                                      | `Disputed` → `ReadyToClose` / `ContingenciesPending`                                                                  | Dispute rejected; resume where the record says.                                                                                   |
| `expireEscrow()` | Anyone (keeper) | `Funded` / `ContingenciesPending` → `Expired` after `closingDeadline`; `Disputed` → `Expired` after `disputeDeadline`; `ReadyToClose` / `Settled` → `Expired` after `disputeDeadline` if the seller has no usable KYC | Guarantees the funds are never stuck. |
| `releaseToSeller()` | Buyer/seller (from `ReadyToClose`), resolver (from `Settled`) | → `Closed` | Requires valid seller KYC, opens the private terms and spends the vault coin in full to the committed seller payout key (`sendShielded`). |
| `refundBuyer()` | Buyer, seller or resolver | `Refunded` / `Expired` → `Closed` | Opens the private terms and spends the vault coin in full to the committed buyer payout key (`sendShielded`). |

## 6–7. State machine

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Initializing : constructor<br/>(admin, buyer, seller, color, ticker + Maybe terms)
    Initializing --> Initializing : configure / addKycIssuer / removeKycIssuer (admin)<br/>acceptConfiguration (buyer, seller)
    Initializing --> Created : finalizeInitialization<br/>(admin, complete + valid + accepted)
    Initializing --> Cancelled : cancelBeforeFunding<br/>(admin | buyer | seller)

    Created --> Cancelled : cancelBeforeFunding<br/>(buyer | seller)
    Created --> Funded : depositToEscrow<br/>(buyer + valid KYC, before closingDeadline)

    Funded --> ContingenciesPending : openContingencyReview<br/>(buyer | seller)
    Funded --> Refunded : sellerWithdraw (seller)
    Funded --> Expired : expireEscrow<br/>(anyone, after closingDeadline)

    ContingenciesPending --> ContingenciesPending : submitInspection / submitFinancing /<br/>submitTitle (attestor, once)<br/>waiveContingency (buyer)
    ContingenciesPending --> ReadyToClose : all three cleared or waived<br/>(automatic)
    ContingenciesPending --> Refunded : cancelAndRefund (buyer, a result failed)<br/>sellerWithdraw (seller)
    ContingenciesPending --> Disputed : openDispute<br/>(buyer | seller, before disputeDeadline)
    ContingenciesPending --> Expired : expireEscrow<br/>(anyone, after closingDeadline)

    ReadyToClose --> Disputed : openDispute (buyer | seller)
    ReadyToClose --> Refunded : sellerWithdraw (seller)
    ReadyToClose --> Closed : releaseToSeller<br/>(buyer | seller, seller KYC valid) - pays seller

    Disputed --> Refunded : resolveDisputeRefund (resolver)
    Disputed --> Settled : resolveDisputeSettlement<br/>(resolver, only if allCleared)
    Disputed --> ContingenciesPending : voidContingencyResult (resolver)<br/>dismissDispute (resolver, not cleared)
    Disputed --> ReadyToClose : dismissDispute (resolver, all cleared)
    Disputed --> Expired : expireEscrow<br/>(anyone, after disputeDeadline)

    ReadyToClose --> Expired : expireEscrow (anyone, after disputeDeadline,<br/>seller has no usable KYC)
    Settled --> Expired : expireEscrow (same rule)
    Settled --> Closed : releaseToSeller (resolver, seller KYC valid) - pays seller
    Refunded --> Closed : refundBuyer (party) - pays buyer
    Expired --> Closed : refundBuyer (party) - pays buyer

    Closed --> [*]
    Cancelled --> [*]
```

**Phases at a glance:** _Initialization_ (`Initializing`) → _Setup_ (`Created`) → _Custody_ (`Funded`) → _Review_ (`ContingenciesPending`, with optional `Disputed`) → _Decision_ (`ReadyToClose` / `Settled` / `Refunded` / `Expired`) → _Payout_ (`Closed`). Funds move only on the last arrow.

## Remaining notes

- `blockTimeLt`/`blockTimeGte` use the block timestamp in seconds, so pass the deadlines as unix seconds. Validators can skew block time slightly, so leave a margin of hours, not seconds.
- `roleIdOf` uses a fixed domain tag. Reusing one secret across deals makes the deals linkable. Consider adding the contract address or a per-deal salt to the hash.
- All-or-nothing payouts: a partial split (earnest money, repair credits) needs an extra state and two `sendUnshielded` calls (see 4.3).
