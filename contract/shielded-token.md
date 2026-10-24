### Update the contract to use a shielded token custody ( for instance stablecoin shieldUSD)

1. Analyse the `dApp-requirements-specification.md`. Do not start the development of the front end dApp !
2. Anaylse https://dev.to/tosin_akinbowa_0f25bbbd6f/accepting-token-deposits-into-a-contract-receiveshielded-and-escrow-patterns-2g20
3. Update the `conditional-real-estate-escrow-contigenc Do not start the development of the front end dAppy-settlement.compact contract to use a shielded token custody.
4. Consequently the escrowAmount, buyerAddress and sellerAddress states become private ( witness)
5. Recommend what could be added or updated for the European institution Market context

## Update the front.end dApp requirements specification

1. Update the `dApp-requirements-specification.md` to reflect the migration to a shielded token custody
2. Write here your observations and recommendations about the contract before we could start the development of the front end


---

# Implementation, analysis and recommendations

*2026-10-24. The contract compiles with `compactc` 0.31.1 (language 0.23, the project pin). `contract/test/escrow.sim.mjs` passes **149 of 149** checks. Among them: 12 new checks for shielded custody and private terms, and real shielded payouts on every release/refund path, which replace the old "stops at the balance check" placeholders.*

## 1. What the SRS needed from shielded custody

Reading `dApp-requirements-specification.md` (v1.0) against a shielded design:

- **Amount and payout addresses** appeared in the notary portal (§3.1.4), the data model, the persona table and the wallet interface. They must disappear from every public surface. The notary instead verifies an **opening** handed over by a party.
- **The Source-of-Funds UTXO Auditor** (§3.1.1.5) cannot exist with shielded inputs. Source-of-funds assurance has to come from the CASP.
- **The wallet interface** must handle **shielded** balancing, the parties' shielded coin public keys, and importing coins that the contract creates.
- **New concerns:** distributing and backing up the **private terms**, and tracking the vault coin's Merkle index.

All of this is now in **SRS v2.0** (new modules FR-TERMS, FR-FUND, FR-KYC, FR-DISPUTE, FR-SETTLE, FR-NOTARY, FR-AUDIT, an error catalogue, a traceability table and the validation gate in §8).

## 2. The `receiveShielded` escrow article, and how this contract differs

The article's pattern:
- `deposit` calls `receiveShielded(disclose(coin))`, then `writeCoin` stores the coin in a ledger cell (`QualifiedShieldedCoinInfo`).
- `addFunds` follows read → receive → `mergeCoinImmediate`.
- Payout is `sendShielded(pot, left(pk), pot.value)` of the full balance, so there is no change.

The article's own caveats: tests only check flags; it does not check the coin's color; its key comparisons are not production-grade access control.

| Topic | Article | This contract |
| :--- | :--- | :--- |
| Where the coin lives | `writeCoin` into a **public** ledger cell | **Not stored.** Contract ledger state is public, so a stored `QualifiedShieldedCoinInfo` would publish the **value** and nonce, which defeats item 4. The coin is rebuilt from the private terms, and its `mt_index` comes from the `vaultCoin()` witness. |
| Coin nonce | Chosen by the depositor | **Deterministic:** `vaultNonceOf(contract, buyerSalt, sellerSalt)`. Any party holding the terms can rebuild the coin and pay out without the depositor. It is bound to this contract, and a notary given only the amount opening cannot compute it. |
| Color / value check | None | `ERROR_DEPOSIT_COIN_MISMATCH` unless the coin is exactly `{vaultNonce, escrowColor, amount}`. |
| Multiple deposits | `addFunds` + `mergeCoinImmediate` | One exact coin (v1.0). Merging is listed as a future option. |
| Payout | Full balance to `left(pk)` | Full coin to the **committed** payout key. The circuit asserts there is no change. |
| Access control | Compares a passed key | Role secrets (`roleIdOf`), phases, KYC gates, plus `openTerms()`. |

I checked the compiled output (`managed/escrow/contract/index.js`): `receiveShielded` and `sendShielded` record only the **coin commitment**, the **nullifier** and the **output commitment** in the public transcript. No plaintext value or recipient is written.

## 3. Contract changes

1. **Custody:** `receiveUnshielded` / `sendUnshielded` / `unshieldedBalanceGte` are replaced by `receiveShielded` in `depositToEscrow(coin: ShieldedCoinInfo)` and `sendShielded` in `payOutVault`, used by `releaseToSeller` and `refundBuyer`.
2. **Private state (item 4):** `escrowAmount`, `buyerAddress` and `sellerAddress` are **removed** from the ledger. In their place:
   - `amountCommitment = amountCommitmentOf(amount, amountSalt)`;
   - `buyerPayoutCommitment` and `sellerPayoutCommitment` = `payoutCommitmentOf(key, salt)`, where the keys are `ZswapCoinPublicKey` (shielded wallet keys).
   - New witnesses: `privateTerms(): PrivateTerms` (all three openings) and `vaultCoin(): QualifiedShieldedCoinInfo`.
   - `openTerms()` checks the openings and fails with `ERROR_TERMS_MISMATCH: amount | buyer payout key | seller payout key`. Only the pass/fail result is disclosed.
3. **Delayed initialization:** `InitAttribute.BuyerPayout`, `SellerPayout` and `EscrowAmount` now hold **commitments**. They are configured with `Maybe<Bytes<32>>` and must not be empty. The `amount > 0` check moved to the deposit.
4. **KYC:** `KycAttestation.wallet` is now a `ZswapCoinPublicKey`. It is compared privately with the committed payout key, so the attested wallet is never disclosed.
5. **Exported pure helpers for the dApp:** `amountCommitmentOf`, `payoutCommitmentOf`, `vaultNonceOf` and `payoutNonceOf`. The last one reproduces the kernel's nonce evolution, so a recipient can rebuild its payout coin. The simulator tests verify it against the actual output.
6. **Unchanged:** state machine, roles, contingencies, document commitments, disputes, deadlines, KYC revocation and Travel Rule anchors.

### Privacy after the change

- **Hidden:** amount, payout keys, the attested wallet, who funded the deposit and where the payout went.
- **Still public:**
  - role IDs, `escrowColor` / `escrowTicker`, phases and their timing, deadlines;
  - KYC issuer IDs, `sellerKycValidUntil`, the commitments and document hashes;
  - *that* a deposit and a payout happened (a Zswap commitment and nullifier).
- **Residual linkability:** anyone holding the terms (buyer, seller, admin, resolver) can compute the vault coin and therefore its nullifier. Openings must be shared only with those parties.

## 4. Recommendations for the European institutional market (item 5)

- **R-1, settlement asset.** Use a **EUR-denominated EMT** from an authorized credit institution or e-money institution (MiCA Title IV), issued as a shielded Midnight token, rather than a USD token such as "shieldUSD". MiCA puts supervisory limits on large-scale use of non-EUR-currency EMTs as a means of exchange, and EU real-estate prices, taxes and notary fees are in euro. Confirm with the issuer that shielded issuance, redemption and its own regulatory disclosures are supported.
- **R-2, auditor and regulator disclosure.** Shielded custody hides amounts from everyone, including supervisors.
  - Add an optional **`auditorCommitment`**: an encrypted terms package for a designated auditor or supervisor, whose hash is anchored on-chain at configuration and accepted by both parties.
  - Alternatively, use the EMT issuer's own view or disclosure keys if the token offers them.
- **R-3, Travel Rule with self-hosted wallets.** Under the Transfer of Funds Regulation, CASPs must check that a self-hosted wallet is under the customer's control for transfers above €1,000. The attestation's `wallet` (now the shielded payout key) is that proof. CASP onboarding should include a signed challenge from that key.
- **R-4, eIDAS 2.0.**
  - CASPs should accept **EUDI Wallet** PIDs as KYC evidence.
  - The notarial certificate should carry a **qualified electronic seal or signature** and a **qualified timestamp**.
  - Longer term, replace the Schnorr attestation with a verifiable credential once Midnight verifiable credentials ship.
- **R-5, GDPR.** Salted hashes of personal data can still be personal (pseudonymous) data. Keep only salted commitments on-chain. Keep salts off-chain, so erasing them makes the commitments unlinkable. Name the controller and processors (CASP, escrow company, notary) in a DPIA.
- **R-6, source of funds.** Add a `sourceOfFundsVerified` (or level) claim to `KycAttestation` and enforce it at deposit. On-chain UTXO auditing is impossible with shielded inputs. This is a struct and signer change and invalidates existing attestations.
- **R-7, AMLR / sanctions at payout.** Seller KYC is already re-checked at payout. Ask CASPs to keep `validUntil` short (days) so sanctions changes take effect, and to use `revokeKycAttestation` for urgent hits.
- **R-8, settlement mechanics.** Real closings pay several parties from one escrow (notary fees, transfer taxes such as *droits de mutation* / ITP / *Grunderwerbsteuer*, agent commission, mortgage redemption). Plan a v1.1 **split payout**: one vault coin, several `sendShielded` outputs to committed payees, with a committed split schedule. Earnest-money forfeiture needs the same mechanism.
- **R-9, lender funding.** EU mortgages are often paid by the lender directly to the notary account. Support a second, lender-funded vault coin (`mergeCoinImmediate`) or a lender-as-depositor role.
- **R-10, tokenized and fractional property.** If the property itself is tokenized and fractionalized, it may be a financial instrument (MiFID II / Prospectus Regulation). Keep this escrow limited to the purchase payment.

## 5. Observations before front-end development (Part 2, item 2)

**Validate on preprod first.** These are SRS §8 V-1 to V-5.

- **O-1, payout coin discovery (V-1, blocker).** The contract creates the payout coin. The recipient's wallet must learn `{payoutNonceOf(vaultNonce), color, amount}` to show and spend it. Confirm that Lace or 1AM can track or import such a coin through the connector. If not, the payout must go through a flow the wallet supports, which may require a contract change.
- **O-2, vault `mt_index` (V-2, blocker).** Payouts need the vault coin's Merkle index. Confirm that it can be read from the indexer or Zswap state given the coin commitment. If not, use the article's `writeCoin` pattern with a **commitment-only** ledger cell (not possible in 0.31.1 without exposing the value), or keep the depositor's dApp as the index source.
- **O-3, deposit with a deterministic nonce (V-3).** Confirm that midnight-js 4.1.1 and the wallet will balance a `receiveShielded` whose coin nonce is chosen by the dApp. If wallets insist on random nonces, switch to "store a commitment to the deposited coin" and share the coin info off-chain.
- **O-4, liveness depends on the terms package.** Without the terms nobody can pay out, not even the resolver. FR-TERMS-04 therefore requires an encrypted backup (notary or escrow company) before finalization. Consider an on-chain hash of the encrypted backup so parties can prove it exists.
- **O-5, proving cost (V-5).** `depositToEscrow` now combines terms opening, Schnorr verification, KYC checks and `receiveShielded`. Compile without `--skip-zk`, measure proving time and key size, and re-run `deploy-cost` for staged deployment.
- **O-6, fees.** Shielded transactions pay fees in DUST. Parties need DUST (from NIGHT holdings or a sponsor) even though the escrow asset is the EMT.
- **O-7, KYC wallet is now private.** CASPs must attest the **shielded coin public key**, not an unshielded address. Tell CASP integrators about this format change (`casp-signer.mjs` is unchanged because it is generic).
- **O-8, test realism.** The simulator checks circuit logic and shielded effects (inputs, outputs, nonces, recipients) but not real Zswap balancing or Merkle proofs. Before the UI, run a scripted preprod end-to-end flow: deploy → configure → accept → finalize → deposit → attest → release, and the refund variant.
- **O-9, contract-side follow-ups (optional before UI):** R-6 (source-of-funds claim), R-2 (`auditorCommitment`), and an on-chain backup hash (O-4). Each changes the ABI, so decide on them before the front end binds to it.

## 6. Documents updated

- `contract/conditional-real-estate-escrow-contingency-settlement.compact`: shielded custody and private terms.
- `contract/test/escrow.sim.mjs`: shielded scenarios and real payout assertions (149 checks).
- `dApp-requirements-specification.md`: **v2.0, complete; no front-end code written**.
- `contract/compact.md`, `contract/kyc.md`, `README.md`: custody notes updated.
