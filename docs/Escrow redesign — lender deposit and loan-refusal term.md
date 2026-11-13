# Escrow redesign — lender deposit and loan-refusal term

Nov 12, 2026 · @Paul Matencio · Revision 3, all your answers applied; contract v2 implemented and simulator-tested (dApp not yet)

## Summary

The lender becomes a second depositor: the escrow pays the seller only when the buyer's share **and** the lender's exact share are both locked in it. A new optional term decides what happens to the buyer's deposit when the loan is refused.

- **Three committed amounts** in the private terms: total price, buyer share, lender share. The contract proves price = buyer share + lender share without revealing any of them.
- **Funding the loan is the approval.** The lender approves financing by depositing exactly its committed share; it can no longer say "approved" without paying. Refusing is a separate, explicit action.
- **The release pays the full price** to the seller: both coins, in one transaction, or in two steps if one proof is too large.
- **Optional term "Loan refusal refund"** (on by default): on, a refused or withdrawn loan opens a short **top-up window** for the buyer, then the escrow goes to *Refunded*; off, the buyer must replace the loan before the closing deadline or the seller keeps the deposit (*Forfeited*).
- **Buyer top-up:** while no loan money is held, the buyer can deposit the lender share itself (its KYC is checked again) and keep the deal alive.
- **Lender withdrawal:** after a **loan offer expiry** date fixed in the configuration, the lender can take its deposit back while the escrow is still *ContingenciesPending*. A withdrawal counts as a refusal. Nobody can move that date after finalize, the lender included.
- **No lender KYC in the contract:** the admin's whitelisting of the lender's role id, accepted by buyer and seller, is enough.
- **Cash deals are unchanged:** with no loan, the lender keeps today's attest-only role.

This is a new contract version: it needs a recompile, a new deploy and new terms packages. Escrows already deployed keep the current rules.

## Today's behaviour and the gap

Today the escrow holds one coin, the buyer's, and the lender only signs a yes or no. Nothing on-chain ties that yes to the loan money.

| Today | Consequence |
| --- | --- |
| `PrivateTerms` holds one `amount`; `depositToEscrow` accepts one coin of exactly that value | With a loan, `amount` can only be the buyer's share; the price is nowhere |
| `submitFinancing(approved, letterHash)` by the lender | "Approved" moves no money; the escrow can reach *ReadyToClose* with the lender never paying |
| `releaseToSeller` pays the single vault coin | The seller receives the down payment; the rest depends on an off-chain closing |
| Financing refused → buyer **may** call `cancelAndRefund` | Refund is already possible, but it is the buyer's choice and the seller cannot rely on any rule |
| Notary portal: "Price verified" on the `amount` opening | Misleading when `amount` is only a down payment |

The redesign closes these gaps inside the contract instead of relying on the notary to check the loan funds by hand.

## New private terms

The terms package (format `EscrowTermsV2`) commits seven values instead of three; the ledger stores only salted commitments, as today.

| Term | Type | Ledger holds | Who needs the opening |
| --- | --- | --- | --- |
| Total price | `Uint<128>` | `priceCommitment` | everyone in the deal; the notary for the certificate |
| Buyer share (deposit) | `Uint<128>` | `amountCommitment` (renamed `buyerShareCommitment`) | buyer, seller, resolver |
| Lender share (loan) | `Uint<128>` | `lenderShareCommitment` | lender, buyer, seller, resolver |
| Buyer payout key | `ZswapCoinPublicKey` | `buyerPayoutCommitment` | buyer, seller, resolver |
| Seller payout key | `ZswapCoinPublicKey` | `sellerPayoutCommitment` | buyer, seller, resolver |
| Lender payout key | `ZswapCoinPublicKey` | `lenderPayoutCommitment` | lender, buyer, seller, resolver |
| Loan refusal refund | `Boolean` | `loanTermsCommitment` | everyone in the deal |

**Rules the contract checks** (in zero knowledge, only pass or fail is public):

- price = buyer share + lender share, checked in every circuit that opens the terms (deposits, release, refunds). An inconsistent package cannot fund anything.
- buyer share > 0. Lender share may be 0 only in a cash deal.
- Each deposited coin has exactly its committed value, the escrow's token colour and its own nonce: the buyer's coin is bound to the buyer and seller salts (as today), the lender's coin to a new lender salt, and a buyer **top-up** coin (worth the lender share) to the buyer salt under its own label, so it can never be confused with the loan coin.

**Financing mode** (public, set by the admin while *Initializing*): `Attested` for a cash deal (lender signs a yes or no, as today) or `Deposited` for a loan. It must be public because circuits branch on it, and the lender's deposit transaction would reveal it anyway. Amounts stay private.

**Loan refusal refund** (new optional term, ticked by default in the admin's form): when on, a refused or withdrawn loan returns the buyer's deposit, unless the buyer tops up within the top-up window. It sits in the committed terms, so buyer and seller accept it with the rest of the configuration and nobody can change it afterwards.

**Loan offer expiry** (public date, loan mode only, set by the admin with the other deadlines): the date after which the lender may withdraw a deposit that is still waiting in *ContingenciesPending*. It must not be later than the closing deadline. Buyer and seller accept it with the configuration; after finalize no circuit can change it, so neither the lender nor the admin can extend it. It is public because the contract compares it with the block time, like the closing deadline.

**Top-up window** (public duration, loan mode only, default 7 days, set by the admin and accepted with the configuration): how long the buyer has to top up after a refusal or a withdrawal when the refund term is on. The window ends at that duration or at the closing deadline, whichever comes first. With the term off it does not apply: the buyer can top up until the closing deadline.

## Lifecycle

The statuses stay the same plus one, *Forfeited*, used only when the refund term is off; what changes is what each exit pays.

&#91;embedded content: escrow lifecycle with a lender deposit · v2\]

Everything new happens inside *ContingenciesPending*: the lender funds, refuses or (after the offer expiry) withdraws, and the buyer may deposit the loan share itself. *ReadyToClose* needs a second coin, the loan or the top-up. Every other exit sends each coin back to whoever deposited it, except *Forfeited*.

## Circuits

Seven circuits are new, one is limited to cash deals and eight change; the rest (KYC, dispute opening, dismissal) keep their rules.

| Circuit | Who | Allowed from | What it does |
| --- | --- | --- | --- |
| `depositLoan(coin, letterHash)` **new** | lender | *ContingenciesPending*, mode `Deposited`, before the loan offer expiry, no loan or top-up held, loan not lost | Checks the coin = lender share, escrow colour, lender nonce; receives it; records financing as approved with the commitment-letter hash. May move the escrow to *ReadyToClose* |
| `declineLoan(letterHash)` **new** | lender | *ContingenciesPending*, mode `Deposited`, no loan or top-up held | Records the loan as **lost** (refused). Term on: opens the top-up window. Term off: the buyer may top up until the closing deadline |
| `withdrawLoan()` **new** | lender | *ContingenciesPending*, loan held, block time ≥ loan offer expiry | Pays the lender coin back to the lender payout key and records the loan as lost, exactly like a refusal (window with the term on, forfeit risk with the term off). Refused in *ReadyToClose*, *Disputed* and later |
| `depositTopUp(coin)` **new** | buyer | *ContingenciesPending*, mode `Deposited`, no loan or top-up held; term on and loan lost: inside the window; otherwise before the closing deadline | Checks the coin = lender share, colour, top-up nonce; checks the buyer's KYC attestation again; receives it; records financing as covered by the buyer. May move the escrow to *ReadyToClose* |
| `endTopUpWindow()` **new** | anyone | *ContingenciesPending*, term on, loan lost, window over, no top-up | Status → *Refunded* |
| `refundLender()` **new** | lender, buyer, seller, resolver | *Refunded* or *Expired*, loan held | Pays the lender coin back to the lender payout key, in full |
| `claimForfeit()` **new** | seller | *Forfeited* | Pays the buyer coin to the seller (seller KYC required, as for a release) |
| `submitFinancing` | lender | mode `Attested` only | Unchanged for cash deals; refused in mode `Deposited` |
| `depositToEscrow` | buyer | *Created* | Coin = **buyer share** (was `amount`); also checks price = buyer share + lender share |
| `releaseToSeller` | buyer or seller; resolver after *Settled* | *ReadyToClose*, *Settled* | Pays both coins (buyer share + loan or top-up = price) to the seller. Two steps if the proof is too large (below) |
| `refundBuyer` | buyer, seller, resolver | *Refunded*, *Expired* | Pays the buyer coin and, if any, the top-up coin back to the buyer; the escrow closes when every held coin is paid |
| `waiveContingency(Financing)` | buyer | *ContingenciesPending* | Refused in mode `Deposited`: the seller cannot be paid without the second coin (the top-up is the buyer's way out) |
| `cancelAndRefund` | buyer | *ContingenciesPending* | Inspection or title failed: as today. Loan lost, term on: the buyer may give up the window early → *Refunded*. Loan lost, term off: refused |
| `expireEscrow` | anyone | as today | Term off, loan lost, no top-up → *Forfeited*; otherwise → *Expired* |
| `configure` / constructor | admin | *Initializing* | `configure` and the constructor are unchanged; a new `configureFinancing` sets the four new commitments (price, lender share, lender payout, loan terms), the financing mode, the loan offer expiry and the top-up window, cash deals included; `isFullyConfigured` counts 18 attributes |
| `finalizeInitialization` | admin | *Initializing* | Mode `Deposited`: lender differs from the buyer; loan offer expiry ≤ closing deadline; top-up window > 0 |

**Starting the window:** a circuit cannot read the clock, only compare it with a value. `declineLoan` and `withdrawLoan` take the caller's current time `t`, check that the block time lies between `t` and `t` + 10 minutes, and store `topUpWindowEnd` = min(`t` + top-up window, closing deadline) on the ledger. `depositTopUp` and `endTopUpWindow` then compare the block time with that stored date.

**The refund term becomes public only when used:** the lender's refusal or withdrawal opens the lender package and writes the term to the ledger (`loanLostRefund`). That lets `expireEscrow` and `endTopUpWindow`, which anyone may call without the terms, choose between refund and forfeit.

`voidContingencyResult(Financing)` stays for both modes, but in mode `Deposited` it can only void a **refusal** (term off): an approval is backed by a coin and cannot be erased, only refunded, and a withdrawal is final.

**Release in one or two steps (decided):** a release that spends two coins roughly doubles that circuit's proof. We first try one transaction. If the proof server cannot prove it, the release becomes `releaseBuyerShare` and `releaseSecondShare`: each pays one coin to the seller, both are allowed only from *ReadyToClose* or *Settled*, the first one locks the escrow (no refund, dispute or withdrawal afterwards), and the second closes it. The same split applies to `refundBuyer` when a top-up coin is held.

## Who gets paid in every outcome

Each coin goes back to whoever deposited it unless the deal closes; the only exception is the forfeit, when the refund term is off and the buyer did not replace the loan.

| Outcome | Buyer coin goes to | Second coin (loan or buyer top-up) goes to |
| --- | --- | --- |
| All contingencies cleared, loan deposited → release | seller | seller |
| All contingencies cleared, buyer topped up → release | seller | seller |
| Inspection or title failed → buyer cancels and refunds | buyer | its depositor |
| Seller withdraws | buyer | its depositor |
| Dispute → resolver refunds | buyer | its depositor |
| Dispute → resolver settles (all cleared, second coin held) | seller | seller |
| Closing deadline passes, no forfeit case → expired | buyer | its depositor |
| Loan refused or withdrawn, either term, buyer tops up in time | seller at release (deal continues) | seller at release |
| **Loan refused or withdrawn, term on, no top-up in the window** | **buyer**, when the window ends (or earlier if the buyer gives up) | lender: at the withdrawal, or nothing deposited |
| **Loan refused or withdrawn, term off, no top-up by the closing deadline** | **seller** (forfeit) | lender: at the withdrawal, or nothing deposited |
| Lender silent at the closing deadline, either term | buyer | — |

**Forfeit rule (decided):** with the term off, a buyer who loses the loan and does not replace it is in breach, and the seller keeps the deposit as compensation, as with earnest money in a sale without a financing clause. Silence is different: a lender that never answers is not a refusal, and the buyer is refunded at the closing deadline.

**The buyer's way out is the top-up (decided):** as long as no loan or top-up coin is held, the buyer can deposit the lender share itself, before the lender decides or after it loses the loan. With the term on, a refusal or a withdrawal gives the buyer the top-up window (default 7 days) before the refund; with the term off, it has until the closing deadline, and a top-up ends any forfeit risk. A refusal sent by mistake can still be voided by the resolver in a dispute, after which the lender decides again.

## Deadlines, expiry and disputes

Two fixed dates govern the lender: the loan offer expiry opens its right to withdraw, and the closing deadline ends every deposit. Neither can be moved after finalize.

- **Lender deposit window:** from *ContingenciesPending* (opened after the buyer's deposit) until the loan offer expiry. The lender chooses when to fund inside the window, typically after inspection and title are in.
- **Lender withdrawal:** from the loan offer expiry on, while the escrow is still *ContingenciesPending*, the lender may call `withdrawLoan`. It counts as a refusal. Once the escrow is *ReadyToClose*, *Disputed* or later, the deposit is locked to the deal's outcome.
- **No extension:** the loan offer expiry, the top-up window and the closing deadline are part of the accepted configuration; no circuit writes them after finalize. A lender that wants more time can simply not withdraw; it cannot push any date.
- **Buyer top-up window:** with the term on and the loan lost, from the refusal or withdrawal for the configured duration (default 7 days), cut at the closing deadline; then anyone can call `endTopUpWindow` and the escrow is *Refunded*. Otherwise any time in *ContingenciesPending* while no second coin is held, until the closing deadline.
- **`expireEscrow` after the closing deadline** (anyone may call it), from *Funded* or *ContingenciesPending*:
  - term off, loan lost, no top-up → *Forfeited* (the seller claims the buyer coin);
  - otherwise → *Expired*: the buyer coin (and any top-up) returns to the buyer, the lender coin (if still held) to the lender.
- **Disputes:** same window (until the dispute deadline) and the same resolver powers. `resolveDisputeSettlement` additionally requires the second coin in mode `Deposited`; `resolveDisputeRefund` refunds every held coin to its depositor. A dispute that outlives the dispute deadline expires to *Expired*, never to *Forfeited*. The top-up window keeps running during a dispute; it never restarts.
- **Closing:** the escrow becomes *Closed* once every held coin is paid. Separate `buyerCoinPaid`, `secondCoinPaid` flags replace today's single `disbursed`.

## Privacy: who sees what

The lender receives only what it needs to fund and to be refunded; the public still sees no amount and no payout key.

| Reader | Receives | Can verify against the ledger | Never sees |
| --- | --- | --- | --- |
| Public | statuses, financing mode, loan offer expiry, which circuits ran (a loan, a top-up or a withdrawal is visible, never its amount), report and letter hashes | — | any amount, any payout key, the refund term |
| Lender | **lender package**: price, lender share, its own payout key, the refund term (each with its salt) | all four commitments | buyer share, buyer and seller payout keys |
| Buyer, seller, resolver | full terms package | all seven commitments | — |
| Notary (custodian) | full terms package, sealed to its envelope key | all seven | — |
| Notary (verifier only) | selective openings handed over by a party | price, buyer share, lender share separately | whatever it is not handed |

- The lender package is sealed to the lender's **envelope key**, like the buyer's terms today. The lender page gets a *Lender terms* card: import, check against the commitments, then deposit.
- The price and buyer share open separately, so the notary certificate can state "Total price verified" and "Buyer deposit verified" as two lines, and "Loan amount verified" when the lender share is opened.
- `depositLoan` is a visible contract call: anyone can tell the loan was funded and when, not how much.
- The lender's coin is a shielded coin like the buyer's. Its value appears nowhere on the ledger.

## dApp changes per page

Every page that shows or uses the amount changes; the lender page changes most.

| Page | Changes |
| --- | --- |
| Admin → Initialize | Financing mode (cash deal / loan). Loan: **loan offer expiry** date (checked ≤ closing deadline), **top-up window** in days (default 7), lender payout key and lender envelope key requested from the lender |
| Admin → Terms & KYC | Total price, buyer deposit, loan amount (third computed from the other two, must add up); **Refund the buyer if the loan is refused** checkbox, ticked by default; four new commitments; a sealed *lender package* next to the party envelopes |
| Buyer | Deposit card shows the buyer share and the price; **Top up the loan share** card (shown while no second coin is held; after a refusal or withdrawal it shows the window's countdown with the term on, or the forfeit warning with the term off; **Give up and get refunded** with the term on); terms check lists all seven commitments; settlement card shows which coin goes where |
| Seller | Terms check; release card shows "you receive the full price (two coins)" and the step count; *Forfeited* status and **Claim forfeited deposit** button (term off only) |
| Lender | *Lender terms* card (envelope key, import, check); **Fund the loan** (builds the exact coin, deposits it, attaches the letter hash) until the offer expiry; **Refuse the loan**; **Withdraw the deposit** from the offer expiry while *ContingenciesPending* (countdown before); **Claim refund** when the escrow unwinds |
| Resolver | Settlement card shows both coins; void allowed only on a refusal |
| Every party page | **End the top-up window** button once it is over (anyone may trigger the refund) |
| Notary | Separate verifications: total price, buyer deposit, loan amount, refund term; certificate states whether the second coin is the loan or a buyer top-up; "Price verified" now means the total price |
| Compliance | Unchanged |
| Transaction log, chain import | New actions: `depositLoan`, `declineLoan`, `withdrawLoan`, `depositTopUp`, `endTopUpWindow`, `refundLender`, `claimForfeit` (and the two release steps if used) |

The user guide gets a lender section rewritten around funding, a memo on the refund term, and updated notary wording.

## Migration, tests and decisions

Nothing changes for escrows already deployed: the dApp keeps reading version 1 contracts and opens version 2 only for new deploys.

**Migration**

- Contract v2 next to v1 (`contract/` keeps both sources); the dApp picks the version from the deployed contract's circuit list.
- Terms package `EscrowTermsV2`; a v1 package is refused on a v2 escrow with a clear message, and the reverse.
- Vault records gain a `lenderTerms` field; backups carry it (party scope included).
- Staged deploy: six more verifier keys to register (eight if the release and refund split in two); renouncing still requires every circuit, the new ones included.

**Tests to add** (simulator and `escrow.sim.mjs`)

- Loan path: buyer deposit → review → lender deposit → release pays both coins; a wrong lender coin (value, colour, nonce) is refused.
- Top-up path: before the lender acts, inside the window after a refusal or withdrawal (term on), until the closing deadline (term off); a loan deposit after a top-up is refused, and the reverse; a top-up with an expired or revoked KYC attestation is refused.
- Top-up window: refused after it ends; `endTopUpWindow` refused before it ends, refused with a top-up held; the buyer can give up early; the window is cut at the closing deadline; a `t` more than 10 minutes from the block time is refused.
- price ≠ buyer share + lender share: every deposit and release refused.
- Term off: refusal or withdrawal → *Forfeited* at the closing deadline unless the buyer topped up; a silent lender → *Expired*.
- Withdrawal refused before the offer expiry, in *ReadyToClose*, *Disputed* and after; no circuit changes the offer expiry, the top-up window or the closing deadline after finalize.
- Every unwind path refunds each coin to its depositor exactly once; *Closed* only when all held coins are paid; the two-step release cannot be mixed with a refund.
- Waiving financing refused in loan mode; cash mode unchanged (all existing tests still pass).

**Your decisions** (applied in this revision)

- [x] Term off: forfeit to the seller (as designed)
- [x] Lender silent at the closing deadline with the term off: refund (as designed)
- [x] The buyer should be able to replace a refused loan with a top-up deposit of the lender share before the closing deadline?
- [x] The admin's whitelisting of its role id enough?
- [x] The lender should be able to withdraw its deposit if the escrow is still *ContingenciesPending* after a date of its own (loan offer expiry)?
- [x] Two steps to release if the proof is too large?

**Follow-up decisions**

- [x] Term on: the buyer gets a short top-up window (default 7 days) after a refusal or withdrawal, then the refund.
- [x] A lender withdrawal is treated as a refusal, including the forfeit risk with the term off.
- [x] The top-up re-checks the buyer's KYC attestation.

## Addendum: cooling-off period (design, not implemented)

This addendum adds an optional **cooling-off period** to the v2 terms. During a set number of days after the buyer's initial deposit, the buyer can withdraw for any reason. The buyer gets the deposit back minus a penalty, which can be zero, paid to the seller. After the period, a voluntary withdrawal by the buyer forfeits the deposit to the seller. The term is **off by default**.

It applies to both cash and loan deals, and it changes nothing else: a failed contingency (inspection, title, or a lost loan with the refund term on) still refunds the buyer in full, before or after the period.

### New terms

- **Cooling-off days** (public, set by the admin while *Initializing*, default **0 = off**). It sits next to the financing settings, so any change bumps the configuration version and both parties accept it again. It has to be public because the contract compares it with the block time, and the seller needs it to know when release becomes possible.
- **Penalty** (private, an 8th commitment `coolingOffCommitment`): a rate in basis points of the total price (0 to 10,000, so 1.5 % = 150) and the resulting amount. The contract checks, without revealing either value:
  - `penalty × 10,000 ≤ price × rate < (penalty + 1) × 10,000`, so the penalty is the rate applied to the price, rounded down
  - `penalty < buyer deposit`: the penalty is strictly lower than the initial deposit
  - with the term off, rate and penalty are committed as 0
- **Start and end**: `depositToEscrow` takes the current time `t`, checked against the block time as for `declineLoan`, and sets the public `coolingOffEnd = min(t + days, closing deadline)`. With the term off, `coolingOffEnd = t`, so the period is already over.

### Rules

1. **Inside the period**, the buyer may withdraw while the escrow is *Funded*, *ContingenciesPending* or *ReadyToClose*. The status becomes the new **Withdrawn**.
2. **After the period** (or with the term off), the same withdrawal makes the status **Forfeited**, and the buyer deposit is payable only to the seller, as with an unreplaced lost loan.
3. **No release before the period ends**: `releaseToSeller` also requires block time ≥ `coolingOffEnd`. Otherwise the parties could close the deal before the buyer's right expires.
4. **Second coin**: a loan held when the buyer withdraws goes back to the lender (`refundLender`), and a top-up goes back to the buyer (`refundTopUp`). Both circuits now also accept *Withdrawn* and *Forfeited*. Only the initial deposit carries the penalty or the forfeit.
5. **Contingency failures** keep today's rules: `cancelAndRefund` with a refundable failure refunds the full deposit, with no penalty.
6. The escrow closes once every coin it holds has been paid: deposit (or deposit minus penalty), penalty, and second coin.

### Circuits

One payout per circuit keeps each proof at about k=16.

| Circuit | Who | What | Estimated size |
| --- | --- | --- | --- |
| `buyerWithdraw(now)` (new) | buyer | Checks the status, then chooses *Withdrawn* (inside the period) or *Forfeited* (after). No terms opened. | small, about k=13 |
| `refundWithdrawal` (new) | buyer, seller, resolver | *Withdrawn* only: opens the terms and the penalty, and pays deposit − penalty to the buyer key. The penalty stays in the contract as the change coin. With a zero penalty it pays the whole coin. | about 54k rows, k=16 |
| `claimPenalty` (new) | seller, with usable KYC | *Withdrawn* only, penalty > 0: pays the change coin, whose nonce the contract derives from the vault coin, to the seller key. | about 55k rows, k=16 |
| `claimForfeit` | seller | Unchanged. It now also covers a withdrawal after the period. | unchanged |
| `refundLender`, `refundTopUp` | as today | Also allowed in *Withdrawn* and *Forfeited*. | unchanged |
| `releaseToSeller` | as today | Adds the block-time check against `coolingOffEnd`. | about 76k rows, k=17 (unchanged) |
| `depositToEscrow(coin, now)` | buyer | Takes `now` and sets `coolingOffEnd`. | small increase |
| `configureFinancing` | admin | Adds `coolingOffDays`. | small increase |

Splitting the deposit uses the change output of `sendShielded`. The buyer is paid deposit − penalty, and the change coin (exactly the penalty) stays with the contract until `claimPenalty`. The dApp finds that coin's index the same way it finds the second coin.

### Privacy

The rate and the penalty amount stay private. Only the bare fact that a penalty is due is public: the dApp has to know whether `claimPenalty` is needed, and the escrow must not close before the penalty is paid. The cooling-off days and `coolingOffEnd` are public, like the other deadlines. The notary verifies the penalty with a new opening kind, `coolingOff` ("Cooling-off penalty verified: 1.5 % of the price = 3,750 EURe"). The certificate gains a cooling-off section: days, end date, whether the buyer withdrew, and whether the penalty has been paid.

### dApp changes

- **Admin** → *Financing* card: a *Cooling-off days* field (0 = off). *Terms & KYC*: a *Cooling-off penalty (%)* field shown only when the days are above 0, with a live check that the penalty is lower than the buyer deposit.
- **Buyer**: a *Withdraw from the purchase* card. Inside the period it shows a countdown, the penalty and the refund. After the period it shows a red warning that withdrawing forfeits the deposit. Then a *Refund* button for deposit − penalty.
- **Seller**: a *Claim the penalty* card (KYC check, as for the forfeit), plus a note that release opens when the period ends.
- **Lender**: *Refund the lender* also appears after a withdrawal.
- **Notary**: the `coolingOff` opening and the certificate section.
- **User guide**: a cooling-off section, and new rows in the status and troubleshooting tables.

### Tests to add

- Term off: an immediate withdrawal forfeits; release is not blocked.
- Term on: a withdrawal inside the period gives *Withdrawn*; the refund pays deposit − penalty; the seller claims the penalty (refused without KYC); the escrow closes.
- A withdrawal one second after the end forfeits.
- Release refused before the end and allowed at the end.
- A zero penalty: the full deposit back and no claim needed.
- Penalty openings: a wrong rounding, a penalty equal to the deposit, or a rate above 100 % are refused.
- With the loan held, a withdrawal leads to `refundLender`; with a top-up held, to `refundTopUp`.
- A failed inspection after the period still refunds in full.

### Open questions

- [ ] **Dispute during the period**: a seller could open a dispute to run out the clock. Proposal: inside the period, the buyer may also withdraw from *Disputed*, and the cooling-off right ends the dispute.
- [ ] **Days public, penalty private**: OK? The alternative of keeping the days private hides little, because the release time reveals them anyway.
- [ ] **Withdrawal before the contingency review opens** (*Funded*): allowed, as proposed?
- [ ] **Terms package**: old v2 packages without the 8th commitment are refused, since nothing is in production yet. OK?
