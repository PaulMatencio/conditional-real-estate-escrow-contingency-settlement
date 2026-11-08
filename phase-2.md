# Phase 2 — Functional requirements (implementation report)

Scope: `plan.md` → *Phase 2 — Build the functional requirements*, implementing `dApp-requirements-specification.md` §3 on top of the Phase 1 admin console and generated SDK.
Date: 2026-11-03 · Network: **Midnight preview** (`midnight.config.json`) · Stack unchanged (Next.js 15, React 19, TypeScript, Tailwind, vitest, Compact 0.31.1 / compact-runtime 0.16.0 / midnight-js 4.1.1).

---

## 1. Context changes

| Change | Detail |
| :--- | :--- |
| Network switched to **preview** | No Blockfrost project token needed. `midnight.config.json` already targets preview; the page metadata was updated. Use a Lace / 1AM wallet set to *preview*. |
| **CASP simulator connected** | `eu-counterparty-simulator` REST server on `http://127.0.0.1:8787`, reached through the dApp's own same-origin proxy `/api/casp/*` (see §4). |

---

## 2. Pages

| Route | Audience | Content |
| :--- | :--- | :--- |
| `/buyer` | Buyer | Terms vault, buyer KYC (originator), funding & vault tracking, actions, settlement |
| `/seller` | Seller | Terms vault, seller KYC (beneficiary) with expiry countdown, actions, settlement |
| `/inspector`, `/lender`, `/title-agent` | Attestors | Local document hashing + `submitInspection` / `submitFinancing` / `submitTitle` |
| `/resolver` | Dispute resolver | Terms vault, **only the circuits valid in the current state** (§3.1.6 AC-1), settlement |
| `/compliance` | CASP / compliance officer | CASP connection, issuer keys vs escrow whitelist, revocation broadcaster, attestation / Travel Rule status |
| `/verify`, `/verify/[contractAddress]` | Notary / land registry | Read-only, no wallet: locked-funds proof, local verifiers, certificate export |
| `/admin` → **Terms & KYC** tab (new) | Admin | Private terms package, commitments, encrypted distribution, CASP whitelist, guarded finalize |

Every party page shares one shell: mode switch (Wallet / Simulator), vault unlock, role key card, status overview, actions, timeline. Home page and sticky header link every page (Parties menu, Compliance, Notary).

---

## 3. Requirements coverage

### FR-WALLET
| Req | Implementation |
| :--- | :--- |
| 01 Lace / 1AM | Phase 1 connector reused; party calls go through `PartyGateway` with the same wallet providers. |
| 02 Role secret | Per-contract role keys stored AES-GCM encrypted in the vault; role id derived with the contract's `roleIdOf`. |
| 03 Role-aware UI | `rolesOf()` matches the key against the 7 ledger role ids; multi-role switcher when one key holds several roles. |
| 04 Wallet / Simulator Mode | `EscrowSimulator` runs the compiled contract in the browser (block-time slider, simulated shielded inputs/outputs, one-click demo escrow with every role key). |
| 05 Payout key | Connected wallet's shielded coin key shown (to send to the admin); warning if it differs from the committed key. |
| 06 Balance check | `getShieldedBalances()` vs amount before deposit; shortfall shown. |

### FR-DEPLOY
| Req | Implementation |
| :--- | :--- |
| 02 11-attribute checklist | Status overview; commitments shown as "commitment set", never values. |
| 03 configure + CASP whitelist | Commitments filled from the package (no hand typing); `addKycIssuer` / `removeKycIssuer` from the CASP's `/.well-known/casp-keys`; version-reset warning. |
| 04 Accept / finalize | Accept blocked unless the local commitment check passes; finalize blocked by `finalizeBlockers()` (both acceptances, backup, separation of duties, deadlines). |

### FR-TERMS
| Req | Implementation |
| :--- | :--- |
| 01 Package | `createTermsPackage()`: amount + party keys, 3 fresh CSPRNG salts, commitments via `pureCircuits`. |
| 02 Party-supplied keys | Admin form takes the keys the parties copied from their pages. |
| 03 Local verification | `checkTermsAgainstLedger()`; mismatch → `TERMS_COMMITMENT_MISMATCH`, acceptance and payouts blocked. |
| 04 Encrypted distribution / backup | X25519 + HKDF + AES-GCM envelopes per recipient (buyer, seller, resolver, custodian); passphrase-sealed backup file; backups recorded and required before finalize. |
| 05 Selective openings | Export amount-only or single payout-key opening. |
| 06 Witness provider | `privateTerms` / `vaultCoin` / `kycAttestation` witnesses read only from the local vault, per call. |

### FR-ATTEST
| Req | Implementation |
| :--- | :--- |
| 01 Submission cards | Inspector, lender, title agent panels with pass/fail and confirmation. |
| 02 Salted document hash | `persistentHash([pad(32,"re-escrow:document:v1"), SHA-256(document), salt])`, computed locally; encrypted bundle (document + salt) export. |
| 03 Voided history | `voidedReportHistory` + `correctionCount` in the status overview. |
| 04 Buyer waiver | `waiveContingency(which)` with irreversible-action confirmation. |

### FR-FUND
| Req | Implementation |
| :--- | :--- |
| 01 Vault coin | `vaultCoinOf(contract, color, terms)` = `{vaultNonceOf(self, buyerSalt, sellerSalt), escrowColor, amount}`. |
| 02 Deposit | `depositToEscrow(coin)` with `localSecretKey`, `privateTerms`, `kycAttestation`, `schnorrReduction`. |
| 03 Vault tracking | `PartyGateway.indexFromTx()` derives `mt_index` from the deposit tx offers and the indexer Zswap state; any party can run it from the deposit tx hash; manual entry fallback. **To validate (V-2).** |
| 04 Pre-flight | `preflight()`: phase/role/deadline table, local material, terms match, KYC pre-check, balance — before any proof. midnight-js also runs the circuit locally before proving. |

### FR-KYC
| Req | Implementation |
| :--- | :--- |
| 01 Import + pre-check | Request from a CASP simulator persona (bound to role id + committed payout key) or import a file; `precheckAttestation()` mirrors the circuit: whitelist, Schnorr signature, subject, wallet, expiry, level, AML score, revocation. |
| 02 Seller KYC | `submitSellerKyc()` with on-chain expiry countdown and renewal prompt. |
| 03 Revocation broadcaster | CASP-signed revocation (requested via proxy or imported), verified against the whitelisted key, broadcast with `revokeKycAttestation` / `revokeKycIssuer`. |
| 04 CASP integration | `HttpCaspGateway` against the eu-counterparty-simulator API. |
| 05 Source of funds | CASP attestation / Travel Rule record shown in the compliance console; no on-chain auditing. |

### FR-DISPUTE · FR-SETTLE · FR-NOTARY · FR-AUDIT
| Req | Implementation |
| :--- | :--- |
| DISPUTE-01 | `openDispute()` with optional encrypted evidence note. |
| DISPUTE-02 | Resolver sees only enabled circuits; `resolveDisputeSettlement` disabled unless `allCleared`. |
| DISPUTE-03 | Countdown to `disputeDeadline`; `expireEscrow` offered to anyone when due. |
| SETTLE-01/02 | `releaseToSeller` (seller KYC pre-flight) and `refundBuyer`, `expireEscrow`. |
| SETTLE-03 | Payout coin `{payoutNonceOf(vaultNonce), color, amount}` computed and exported. **Wallet import pending (V-1).** |
| SETTLE-04 | Public settlement receipt and private receipt with amount. |
| NOTARY-01..03 | `/verify/[contractAddress]`: live state, locked-funds statement, amount / payout-key opening verifier, document verifier (file + salt), CASP bundle verifier, JSON certificate + print page. Openings never leave the browser and are not in the certificate. |
| AUDIT-01..03 | Lifecycle timeline, deadline alerts, encrypted local tx history with explorer links. |

### §3.3 error catalogue · NFRs
- `classifyContractError()` maps every contract assertion to a code and user guidance; `friendlyMessage()` appends it.
- NFR-01: proofs only to the local proof server (unchanged). NFR-03: all new screens in **en / fr / es**. NFR-04: ARIA live regions, keyboard-operable dialogs (Esc), labelled controls. NFR-06/07: private data encrypted at rest (AES-GCM, PBKDF2), only the contract address ever in URLs, witnesses never logged; "erase locally".

---

## 4. CASP simulator integration

- **Proxy** `src/app/api/casp/[...path]/route.ts`: allow-listed paths only; officer / notary bearer tokens attached server-side from `.env.local`; disabled in production builds unless `CASP_SIM_ENABLED=1`.
- **Configuration** (`.env.local`):
  ```sh
  CASP_SIM_URL=http://127.0.0.1:8787
  CASP_OFFICER_TOKEN=<printed by the simulator>
  CASP_NOTARY_TOKEN=<printed by the simulator>
  ```
- **Verified live**: an attestation issued by the running simulator (`buyer-clean`) verifies with the escrow contract's `kycMessage` / `kycReference` and the in-circuit Schnorr scheme (fixture `tests/fixtures/casp-sim-buyer-clean.json`).

---

## 5. Code map (clean architecture)

```
src/domain/          escrowView.ts  lifecycle.ts  roles.ts  terms.ts  contractErrors.ts  (errors.ts updated)
src/application/     partyPorts.ts  partyService.ts  termsService.ts  notaryService.ts
src/infrastructure/
  contract/          view.ts  callArgs.ts  (module.ts updated)
  crypto/            escrowCrypto.ts  termsCrypto.ts  aead.ts
  gateway/           partyGateway.ts  publicReader.ts  (adminGateway.ts: addKycIssuer / removeKycIssuer)
  simulator/         escrowSimulator.ts
  storage/           encryptedVault.ts (EncryptedVault + IdbStore)
  casp/              httpCaspGateway.ts
src/presentation/
  providers/         EscrowProvider.tsx  (AppProvider.tsx, Providers.tsx updated)
  components/party/  PartyWorkspace  PartySetup  StatusOverview  ActionsPanel  TermsPanel  KycPanel
                     CustodyPanel  AttestorPanel  TimelinePanel  helpers
  components/        admin/TermsKycTab  compliance/ComplianceConsole  notary/NotaryPortal
                     (AdminApp, Header, Home updated)
  i18n/              en.ts  fr.ts  es.ts (Phase 2 keys)
src/app/             buyer  seller  inspector  lender  title-agent  resolver  compliance
                     verify  verify/[contractAddress]  api/casp/[...path]
tests/               partyFlow  domain  termsVault  caspGateway  helpers/fixtures  fixtures/
```

---

## 6. Verification

| Check | Result |
| :--- | :--- |
| `npm run typecheck` | clean |
| `npm test` | 51 / 52 pass — the one failure is `compiled.test.ts` (prover keys were not copied to the build machine; passes locally with the full ZK build) |
| `next build` | succeeds; 15 routes |
| Browser smoke test (Playwright) | Buyer page: create vault → Simulator Mode → simulated escrow → accept configuration, no console errors. Found and fixed an AES-GCM `additionalData` bug in Chrome. |

Simulator-mode tests (`tests/partyFlow.test.ts`) run through the application layer: happy path to `releaseToSeller` (shielded output to the committed seller key, payout nonce = `payoutNonceOf`), failed contingency → refund, deadline expiry → refund, dispute → void → re-attest, and pre-flight rejections (tampered terms, wrong wallet, untrusted issuer, low KYC level, forged signature).

---

## 7. Open items (SRS §8, to validate on preview)

| Item | Status in Phase 2 |
| :--- | :--- |
| **V-1** payout coin import | DApp Connector v4 has no import call; payout coin exported as JSON. |
| **V-2** vault `mt_index` | Derived from the deposit tx + indexer Zswap state; assumes no later same-block insertion; manual entry available. |
| **V-3** deposit balancing with caller-chosen nonce | Untested on chain. |
| **V-4** shielded test token on preview | Needed for a real deposit. |
| **V-5** proving times | Not measured. |

Other limits: simulated escrows live in memory only (lost on reload); the X25519 envelope needs a browser with WebCrypto X25519 (passphrase files work everywhere).

**Next:** Phase 3 — `end-to-end-testing.md` (per-role test guide with ZK authentication, wallets, the contract and the CASP simulator).
