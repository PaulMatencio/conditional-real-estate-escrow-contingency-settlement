# Real-estate escrow dApp — User guide

Nov 11, 2026 · @Paul Matencio

## Before you start

The dApp runs one real-estate escrow on the Midnight preview network: the buyer locks the agreed price in a shielded coin, the contingencies (inspection, financing, title) are attested, and the funds go either to the seller or back to the buyer. The price and payout keys stay private: only salted commitments are on-chain.

### Who does what

| Role | Page | Main job |
| --- | --- | --- |
| Admin | `/admin` | Deploys and initializes the escrow, prepares and distributes the private terms, whitelists the KYC provider (CASP), finalizes |
| Buyer | `/buyer` | Accepts the terms, proves KYC, deposits the price, waives or disputes contingencies |
| Seller | `/seller` | Accepts the terms, proves KYC, receives the payout |
| Inspector | `/inspector` | Attests the inspection result |
| Lender | `/lender` | Attests the financing result |
| Title agent | `/title-agent` | Attests the title result |
| Dispute resolver | `/resolver` | Settles disputes, voids wrong attestations, executes a settled payout |
| Notary (custodian) | `/verify/<contract address>` | Verifies the escrow, issues the notarial certificate, keeps the custodian copy of the terms |
| Compliance officer | `/compliance` | Checks KYC status and handles CASP revocations |

### What each person needs

- **A Chromium browser or Firefox** with the dApp open on a secure address: `http://localhost:3000` or a `*.localhost` name such as `http://buyer.localhost:3000`. A LAN address such as `http://192.168.x.x:3000` does not work: the browser disables the encryption the vault needs.
- **Their own address per person.** The vault is stored per address. In tests on one computer, give each role its own name (`admin.localhost`, `buyer.localhost`, `seller.localhost`, …) so each role has its own vault.
- **A vault passphrase** (8+ characters). The vault keeps the keys, terms and attestations encrypted in the browser.
- **A secret role key** (see *Keys, vault and backups*). Every role except the notary and the compliance officer has one.
- **A Midnight wallet** (Lace or 1AM) on the preview network, with DUST for fees, for every role that sends transactions. The buyer and seller each use their own wallet account, because the payout goes to that account's shielded key.
- **The local proof server** (`npm run proof-server:start`, image `midnightntwrk/proof-server:9.0.1`) on the computer that sends transactions. Proofs are made locally so private inputs never leave the computer.

### Wallet Mode and Simulator Mode

- **Wallet Mode** = the real escrow on the preview network: real transactions, fees in DUST, proofs from the local proof server.
- **Simulator Mode** = the compiled contract running inside the browser, with no wallet, no fees and a movable clock. Use it to rehearse a whole escrow in minutes: **Create simulated escrow** on any party page sets up every role in one vault.

Every action button checks its preconditions first. A disabled button shows why underneath it (wrong phase, deadline passed, missing key or terms).

## The escrow at a glance

The escrow moves through the statuses the app shows on every page; each arrow is one transaction, and its label says who sends it.

&#91;embedded content: escrow statuses · who moves the escrow from one to the next\]

A dismissed dispute returns the escrow to where it was. Cancelling before funding is also possible while *Initializing*.

### Who acts at each stage

| Stage | Admin | Buyer | Seller | Attestors | Resolver | Notary |
| --- | --- | --- | --- | --- | --- | --- |
| Before the deploy | collects role ids, payout keys, envelope keys | sends role id, payout key, envelope key | sends role id, payout key, envelope key | send role ids | sends role id, envelope key | sends custodian envelope key |
| Initializing | deploys, registers circuits, renounces authority, configures, generates and distributes the terms, whitelists the CASP | imports the terms, accepts | imports the terms, accepts | — | imports the terms | imports the custodian copy |
| Finalization | **Finalize initialization** | — | — | — | — | — |
| Created | — | requests KYC, **deposits** before the closing deadline | requests KYC, **submits seller KYC** | — | — | can verify locked funds |
| Funded → ReadyToClose | — | opens review, waives or cancels and refunds, may dispute | may open review, withdraw or dispute | **submit results** with report hashes | decides disputes | verifies openings and reports |
| Closing | — | releases or claims the refund | releases, receives the price | — | executes a settled payout | issues the certificate |

## Admin guide

The admin sets the escrow up and then steps away: once **Finalize initialization** succeeds, the admin has no power over the funds. Work through the admin console's tabs in this order.

### 1. Prepare (once)

1. Open `http://admin.localhost:3000/admin` and **create the vault** (or restore it from a vault backup, see *Keys, vault and backups*).
2. **Keys** tab → **Generate new key** (or import yours). This is the admin secret key; only its role id goes on-chain. Click **Reveal / export** and keep a copy offline.
3. Connect the wallet (**Connect wallet**, top right) on the preview network and check the DUST card shows enough DUST.
4. Start the local proof server.
5. Collect from the parties, by any channel:
   - the **role ids** of the buyer and seller (each generates its key on the *My role id* page and sends only the id);
   - the role ids of the inspector, lender, title agent and dispute resolver (can come later, before configuring);
   - the buyer's and seller's **shielded payout keys** (each party's *My shielded payout key* card);
   - the **envelope public keys** of buyer, seller, resolver and custodian (for distributing the terms).

### 2. Deploy

**Deploy** tab:

1. Fill in the buyer and seller role ids, the **escrowed token color** (the on-chain id of the shielded token, e.g. a EUR stablecoin) and its **ticker**. The admin role id is filled from your key.
2. Click **Deploy (staged)**. The progress panel shows build → prove → balance → submit → confirm. The deploy carries the 5 initialization circuits; the new address is loaded automatically.
3. The contract's **maintenance authority key** is created by the deploy and stored only in your encrypted vault.

### 3. Register the other circuits, then renounce the authority

**Contract** tab:

1. **Register remaining circuits**. They go in batches of 4 per maintenance transaction; repeat until *Missing circuits* is empty.
2. **Renounce authority (make immutable)**, then type RENOUNCE to confirm. The contract becomes immutable: nobody, not even you, can change its rules. Parties see the authority status, and the **buyer's deposit is blocked until it is renounced**.

### 4. Fill in the initialization terms

**Initialize** tab: the role ids of the inspector, lender, title agent and resolver, the **closing deadline** (the deposit and the contingencies must be done before it), the **dispute deadline** (later than the closing deadline) and the **KYC policy** (minimum KYC level, maximum AML risk score). Submit with **Apply**. You can apply changes several times while the escrow is *Initializing*; each change starts a new configuration version and clears both acceptances, so finish all changes before the parties accept.

### 5. Private terms package

**Terms & KYC** tab → *Private terms package*:

1. Enter the **amount** in the token's base units (the app does not apply decimals) and the buyer's and seller's payout keys. Click **Generate package**.
2. Click **Commit to the contract (configure)**. Only salted commitments go on-chain; the price and payout keys stay in the package.
3. Already generated the package on another address or browser? Use **Restore the package from a backup** with your terms backup file and its passphrase. Never generate a second package once its commitments are on-chain.

### 6. Distribute and back up the package

*Distribute and back up* card:

1. For each recipient (buyer, seller, resolver, custodian), paste their **envelope public key** and click **Encrypt & download**. Send each file `terms-for-<role>.json` to its owner; only their vault can open it.
2. Type a backup passphrase (12+ characters) and click **Download encrypted backup**. Keep the file and the passphrase apart.
3. Finalize requires at least one confirmed backup: the custodian copy or the passphrase backup counts.

### 7. Whitelist the CASP

*Trusted CASP whitelist*: the app reads the CASP's published issuer keys. Click **Whitelist** on the active key. Without at least one trusted CASP the configuration is incomplete and nobody can accept.

### 8. Wait for both acceptances, then finalize

1. Tell the buyer and seller they can accept. The *Finalize initialization* card shows **Acceptance on-chain: buyer ✓ / seller ✓** and refreshes every 15 seconds (or click **Refresh**).
2. When the card says ready, click **Finalize initialization**. The status becomes **Created**: the buyer can deposit.

Finalize is refused while: a party has not accepted the current version, no terms backup is confirmed, the resolver is also another role, an attestor is the seller, the dispute deadline is not after the closing deadline, or the closing deadline has passed.

### 9. After finalization

- Follow progress on the **Contract** tab (refreshes every 20 seconds) and the **Log** tab.
- Back up the vault (**Vault** tab) after each important step.
- Before funding, **Cancel before funding** is still available to the admin while the escrow is *Initializing*.

## Buyer guide

The buyer agrees to the terms, proves KYC, locks the exact agreed price in the escrow, then either lets the deal close or gets the money back if a contingency fails. Work on your own address, e.g. `http://buyer.localhost:3000/buyer`, with your own wallet account.

### Before the deploy: send three things to the admin

1. **Role id.** Open *My role id* (`/role-id`), click **Generate new key**, save the **secret key** in a password manager, and send only the **role id** to the admin.
2. **Shielded payout key.** On the buyer page, unlock or create the vault, connect your wallet, and click **Show my shielded payout key** (*My shielded payout key* card). Send the 64-hex key: a refund is paid to it.
3. **Envelope public key.** In the *Private terms vault* card, copy the **Envelope public key**. The admin uses it to send you the terms so that only your vault can open them.

None of these three is secret. Never send the secret role key to anyone.

### When the admin says the terms are ready: import, check, accept

1. Choose **Wallet Mode**, connect the wallet and enter the contract address, then **Load**.
2. *My role key*: paste your secret key in *Or derive from an existing key* and click **Import**. The card must show **This key holds: buyer**.
3. *Private terms vault*: **Import package** → choose `terms-for-buyer.json` (leave the passphrase empty). The ledger check must show **amount: match · buyerPayout: match · sellerPayout: match**. Read the amount: that is the exact price you will lock.
4. Check the *Escrow status* and *Initialization checklist*: all items green, maintenance authority renounced (immutable).
5. *Actions* → **Accept configuration**, then approve in the wallet. Your acceptance is tied to this configuration version: if the admin changes anything, you accept again.

### Before depositing: get your KYC attestation

*Buyer KYC (originator)* card → **Request attestation** (in tests, choose a CASP simulator persona; `buyer-clean` passes the default policy). The signed attestation is stored in your vault and pre-checked at once: issuer whitelisted, bound to your role id and payout key, KYC level and AML score within the policy, not expired. Nothing goes on-chain yet. A real CASP may send a file instead: use **Import attestation file**.

### When the status is Created: deposit

1. Make sure the wallet's **shielded balance** of the escrow token covers the amount, and that you have DUST for the fee. The *Funding & vault* card shows the amount, your balance and any shortfall.
2. *Actions* → **Deposit into escrow**, confirm, approve in the wallet. Deadline: **before the closing deadline**.
3. The status becomes **Funded**, and *KYC buyer* shows verified. The deposit is one shielded coin of exactly the agreed amount; any other amount is rejected.

### During the contingency review

1. **Open contingency review** (buyer or seller) once funded: the status becomes **ContingenciesPending** and the inspector, lender and title agent can attest.
2. Follow the *Contingencies* card. For each one you may:
   - **Waive contingency** (choose which): you accept the risk without that attestation. Final.
   - Wait for the attestor's result.
3. When every contingency is passed or waived, the status becomes **ReadyToClose**.
4. If a result is **failed**: **Cancel and refund**. The status becomes **Refunded**.
5. If you disagree with a result: **Open dispute** before the **dispute deadline**. The escrow freezes until the resolver decides.

### Closing

- **Deal goes ahead (ReadyToClose):** buyer or seller clicks **Release to seller**. It needs the seller's KYC on-chain and valid. The funds go to the seller's committed payout key; the status becomes **Closed**.
- **Refunded or Expired:** buyer, seller or resolver clicks **Refund buyer**. The funds go to your committed payout key.
- **Deadline passed while still Funded or in review:** anyone can **Expire escrow**, then **Refund buyer**.
- **Before your deposit:** buyer or seller can **Cancel before funding**; nothing needs refunding.

The *Settlement* card then shows the payout and a settlement receipt.

## Seller guide

The seller agrees to the terms, proves KYC on-chain, and receives the price when the deal closes. Work on your own address, e.g. `http://seller.localhost:3000/seller`, with your own wallet account (never the buyer's).

### Before the deploy: send three things to the admin

1. **Role id** from *My role id* → **Generate new key** (keep the secret key in a password manager).
2. **Shielded payout key**: seller page → connect your wallet → **Show my shielded payout key**. The price is paid to this key; it must differ from the buyer's.
3. **Envelope public key** from the *Private terms vault* card.

### When the terms are ready: import, check, accept

Same steps as the buyer: **Wallet Mode** → **Load** the contract → import your role key (**This key holds: seller**) → **Import package** with `terms-for-seller.json` (all three badges **match**; check the amount and that *sellerPayout* is your key) → **Accept configuration**.

### Your KYC: attestation, then on-chain

1. *Seller KYC (beneficiary)* card → **Request attestation** (test persona `seller-clean`), or **Import attestation file** from a real CASP. The pre-check must pass.
2. *Actions* → **Submit seller KYC**. It can be sent from **Created** onwards and must be on-chain and valid before the release. The *Commitments and compliance anchors* card then shows *KYC seller: verified* with its expiry.
3. If the card warns that the seller KYC **expires soon**, request a new attestation and submit it again: an expired attestation blocks the release.

### While the escrow is funded

- Buyer or seller can **Open contingency review** once **Funded**.
- Follow the *Contingencies* card. Only the buyer can waive; only the attestors can submit results.
- Disagree with a result? **Open dispute** before the dispute deadline.
- To back out of the sale while **Funded**, in review or **ReadyToClose**: **Withdraw (seller)**. The buyer is then refunded.

### Getting paid

1. When the status is **ReadyToClose**, buyer or seller clicks **Release to seller**. The app checks your seller KYC (verified, issuer still whitelisted, not revoked, not expired) before proving.
2. The release spends the vault coin, so your browser needs its position (the vault index). The buyer's browser records it at the deposit (*Funding & vault* → *Vault tracking*). If your browser did not make the deposit, the app finds the deposit transaction on the public chain by itself before the release. To check beforehand, the *Vault tracking* card (shown from **Funded** on) has **Locate vault index**; if that fails, paste the deposit transaction hash or the index the buyer shares.
3. The status becomes **Closed**. The *Settlement* card shows the payout to your committed key and a settlement receipt; **Export payout coin** gives the coin details if your wallet does not list it yet.

After a dispute settled in your favour (**Settled**), the **resolver** executes the release.

## Inspector, lender and title agent guide

Each attestor submits one result for their contingency, once, during the contingency review. Only a hash of the report goes on-chain; the report itself stays with you.

| Attestor | Page | Contingency | Action |
| --- | --- | --- | --- |
| Inspector | `/inspector` | Inspection | Submit inspection |
| Lender | `/lender` | Financing | Submit financing |
| Title agent | `/title-agent` | Title | Submit title |

### Before the deploy

Open *My role id* → **Generate new key**, keep the secret key safe and send only the **role id** to the admin, who sets it on the **Initialize** tab. You must be independent: the app refuses to finalize if an attestor's role id is the seller's.

### When the status is ContingenciesPending

1. Open your page on your own address (e.g. `http://inspector.localhost:3000/inspector`), unlock the vault, choose **Wallet Mode**, connect your wallet (you pay a small DUST fee), and **Load** the contract.
2. *My role key*: import your secret key. The card must show **This key holds: inspector** (or lender, titleAgent).
3. *Attestation* card:
   1. **Choose document**: your report (PDF or any file). The browser hashes it locally with a fresh random salt; the file is never uploaded.
   2. Pick the **Outcome**: *Favourable (pass / approve / clear)* or *Unfavourable*.
   3. **Submit on-chain** and confirm. The result is anchored with the **Report commitment**.
4. Click **Export encrypted bundle** and send it with the report to the buyer, seller and notary: the salt it carries lets them check that the report matches the on-chain commitment (Notary portal → *Local verifier*).

### Rules

- One result per contingency. After it, the card says *An outcome is already on record*.
- A wrong result can only be undone by the **dispute resolver**, during a dispute (**Void a contingency result**). You can then attest again.
- A favourable result clears your contingency; an unfavourable one lets the buyer **Cancel and refund**.
- The salt of every report you committed is kept in your vault: back it up (see *Keys, vault and backups*).

## Dispute resolver guide

The resolver acts only when buyer or seller opens a dispute, and must decide **before the dispute deadline**: after it, anyone can expire the escrow and the buyer is refunded. The resolver must be a role id distinct from every other party.

### Before the deploy

1. *My role id* → **Generate new key**; send only the role id to the admin.
2. On `/resolver` (your own address), unlock the vault and send the admin your **Envelope public key** (*Private terms vault* card).
3. When the admin sends `terms-for-resolver.json`, **Import package** and check the three badges show **match**. You need the terms to execute a payout after your decision.

### When a dispute is opened (status Disputed)

1. **Wallet Mode** → connect the wallet → **Load** the contract → import your role key (**This key holds: resolver**). Your *Actions* card shows only what you can do now.
2. Review the evidence the parties send you (an optional encrypted note from **Open dispute**, the attestors' reports and bundles) and the *Contingencies* card.
3. Decide:

| Decision | Action | When allowed | Result |
| --- | --- | --- | --- |
| The seller should be paid | **Resolve: settle to seller** | every contingency is cleared (passed or waived) | **Settled** |
| The buyer should get the money back | **Resolve: refund buyer** | always while Disputed | **Refunded** |
| An attestation was wrong | **Void a contingency result** (choose which) | that contingency has an attested result | the attestor can submit again |
| The dispute has no merit | **Dismiss dispute** | always while Disputed | the escrow resumes |

### Executing the payout

- After **Settled**: only you can click **Release to seller**. The seller's KYC must be on-chain and valid.
- After **Refunded**: you, the buyer or the seller can click **Refund buyer**.

Both spend the vault coin, so the browser that sends them needs the vault index, which the buyer's browser records at the deposit. Your browser did not make the deposit: the app finds the deposit transaction on the public chain by itself. The *Vault tracking* card has **Locate vault index** to check beforehand, or to paste a deposit hash or index if that fails. Every decision is final and asks for confirmation.

## Notary guide

The notary verifies the escrow independently and keeps the custodian copy of the terms. Everything happens on the **Notary portal** (`/verify`), with no wallet and no fee: the portal reads the public chain and checks files locally, without uploading them.

### Open the escrow

Open **Notary** in the menu, paste the **contract address** and click **Verify**. The page `/verify/<address>` refreshes every 20 seconds and shows the status, deadlines, contingencies, commitments and compliance anchors.

### Before closing: become the custodian

The admin needs a confirmed backup of the private terms before finalizing; the custodian copy is that backup.

1. *Custodian copy of the terms* card: create or unlock your vault on this page.
2. Copy the **Custodian envelope public key** and send it to the admin.
3. When the admin sends `terms-for-custodian.json`: **Import the custodian copy**. It is checked against the on-chain commitments and stored encrypted in your vault; a wrong or mismatching file is refused.
4. You hold no role key: you can never act on the escrow, only restore the terms.

Later, with the copy held:

- **Restore to a party** who lost their vault: choose the recipient, paste their envelope public key, **Encrypt & download**, and send them the file.
- **Single openings**: export the price or one payout key on its own, or click **Verify the price now** to add the verified price to the certificate.
- **Download an offline archive** with a passphrase (12+ characters).
- **Remove the custodian copy** only once the escrow is closed or archived (type REMOVE).

### When the parties ask for verification

*Proof of locked funds* states whether the price is locked. *Local verifier* checks files against the chain:

| You receive | From | Load with | Proves |
| --- | --- | --- | --- |
| An opening file (`opening-amount.json`, …) | buyer, seller or your custodian copy | **Load opening** | the price or a payout key matches its on-chain commitment |
| A KYC attestation file | buyer or seller | **Load CASP record** | it is signed by a whitelisted CASP and anchored as the buyer's or seller's KYC |
| A report + its document salt | an attestor (encrypted bundle) | enter the **Document salt**, then **Load document** | the report is the one committed on-chain for that contingency |

### Issue the certificate

*EU notarial escrow certificate*: **Export JSON bundle** (the proof bundle with the verified openings, never their salts) or **Print / save as PDF**, ready for a qualified electronic seal or signature.

## Compliance officer guide

The compliance officer watches the KYC side of the escrow and, when a CASP withdraws an attestation or a key, puts that revocation on-chain. The page is `/compliance`; it talks to the CASP through the dApp's server, so the CASP's officer token never reaches the browser.

### Set up (once)

1. The CASP simulator prints an **officer token** (and optionally a notary token) at start. Put them in the dApp's `.env.local` as `CASP_OFFICER_TOKEN` and `CASP_NOTARY_TOKEN`, then restart the dApp.
2. On `/compliance`, load the escrow with the mode bar (Wallet Mode → connect → contract address → **Load**). Broadcasting needs a wallet for the fee; checking does not.

### Check the escrow's KYC at any time

- *CASP connection*: **Connected**, and each CASP issuer key shows **whitelisted on this escrow** or **not whitelisted**.
- *CASP record* for the buyer's and seller's attestation references: **Attestation status** and **Travel Rule record** straight from the CASP. Source of funds is attested by the CASP; shielded inputs cannot be traced on-chain.

### When the CASP revokes an attestation or its key

1. *Revocations* card: enter the **Attestation reference (kycRef)** shown in the escrow's compliance anchors and a **Reason**, then **Request signed revocation**. Or **Import revocation file** if the CASP sent one.
2. The console checks the CASP's signature against the whitelisted key: **Signature valid for the whitelisted issuer key**.
3. **Broadcast on-chain**. Anyone may send it (the contract checks the CASP signature, not the sender).

Effect: a revoked seller attestation, or a revoked issuer key, blocks **Release to seller** until the seller submits a fresh, valid attestation.

## Keys, vault and backups

Four different keys are involved. Only the first must stay secret; the other three are meant to be shared.

| Key | Who has one | Where it comes from | Share it? | Used for |
| --- | --- | --- | --- | --- |
| Secret role key | every role except notary and compliance | *My role id* → Generate new key (admin: Keys tab) | **Never** | proving your role in zero knowledge |
| Role id | same | derived from the secret role key | yes, with the admin | written in the contract to recognise you |
| Shielded payout key | buyer, seller | your wallet, *My shielded payout key* | yes, with the admin | where a refund or the price is paid |
| Envelope public key | buyer, seller, resolver, custodian | your vault, *Private terms vault* or *Custodian* card | yes, with the admin | receiving the terms encrypted to you only |

### The vault

- The vault is the encrypted store in your browser: role keys, terms package, KYC attestations, report salts, the transaction log (admin: also the admin key and the contract authority key).
- It is protected by your **vault passphrase** (8+ characters) and is tied to the **address** you opened the dApp on: `localhost:3000` and `buyer.localhost:3000` are two different vaults.
- **Lock** clears the keys from memory and empties the admin console's forms.

### Back up

- **Whole vault (admin console → Vault tab):** **Download encrypted backup** with a backup passphrase of 12+ characters. It contains everything, including the admin key if you tick it. Keep it offline, apart from its passphrase.
- **Terms package only:** the passphrase backup on the admin's *Distribute and back up* card, the **Download encrypted backup** button in a party's *Private terms vault*, or the notary's custodian archive.
- **Role key:** keep the secret in a password manager when you generate it. A lost role key cannot be recovered: that role is lost for the escrow.

### Restore or move to another address

- **Admin moving address** (e.g. `localhost:3000` → `admin.localhost:3000`): on the new address the *Create vault* card offers **Restore a vault from a backup**: choose the backup, enter its passphrase, check the preview, choose a new vault passphrase, **Create the vault and restore**.
- **Into an existing vault:** Vault tab → *Restore from a backup* → **Decrypt and preview** → **Restore (merge)**. Nothing is deleted; where the backup disagrees, the current value is kept and the difference listed.
- **Party lost the terms:** import a fresh `terms-for-<role>.json` from the admin or the custodian.

### Removing keys and data

- **Remove key from this vault** (type REMOVE): the role key is kept in the vault's history and **Restore removed key** brings it back.
- **Erase locally** (type ERASE) deletes the escrow's terms, attestations and role keys from this browser, with no history. If no one else holds the terms, payout and refund become impossible: back up first.

## Transaction log, fees and DUST

### The transaction log

Every transaction your browser builds is logged in your vault: when, which action, which role, which escrow, the outcome (**in progress**, **confirmed**, **failed**, **interrupted**), the transaction hash and block, or the error. Find it on the **Log** tab (admin) or the **Transaction log** card at the bottom of every party page.

- **Interrupted** = the page was closed before the outcome was known. Check the wallet history, or import the history from the chain.
- **Import history from chain** reads every transaction of the escrow from the public indexer, including those made by other parties. Your own entries get **on-chain ✓**, the others are marked **from chain**. The chain does not reveal who sent a transaction: where several roles could, the log lists them (e.g. *buyer / seller ?*).
- **Export CSV** or **Export JSON** for an auditor or a spreadsheet.
- Only public facts are logged: never keys, terms or attestations.

### Fees

- Every transaction costs a fee in **DUST**, paid by the wallet of the person who sends it. DUST is generated over time by the **NIGHT** the wallet holds (up to 5 DUST per NIGHT).
- The admin console's *DUST* card shows the balance in whole units. If a wallet refuses with *Not enough DUST*, the error adds the wallet's DUST report: a low balance means wait or get NIGHT; a good balance means a wallet-side sponsoring problem.
- The escrow token itself (e.g. EURe) is separate: the buyer needs the full price in that token **and** DUST for the fee.
- Reading the chain, the Notary portal and Simulator Mode cost nothing.

## Troubleshooting and FAQ

| What you see | Why | What to do |
| --- | --- | --- |
| The vault card says the page is not secure (or *Cannot read properties of undefined (reading 'importKey')*) | The address is not a secure page (e.g. a LAN IP) | Use `localhost`, `127.0.0.1` or a `*.localhost` name |
| A role page starts with an empty vault | Each address has its own vault | Use the address you used before, or restore a vault backup |
| *Contract state not found on this network* | Wrong address, wrong network, or a contract from before the 0.36 upgrade | Check the address and the wallet's network; redeploy if the contract is from an older build |
| *This contract was deployed on the ledger 8 era* | Built with the previous compiler | Deploy a new escrow |
| *TERMS\_COMMITMENT\_MISMATCH* | The terms package is not the one committed on-chain | Ask the admin (or custodian) for the right `terms-for-<role>.json` |
| *This envelope is addressed to another key* | The file was encrypted to another envelope key, or opened on another address | Send the admin the envelope key of the vault you use, and get a new file |
| *Configuration is incomplete* on Accept | An initialization item is missing, often the CASP whitelist | The admin completes the checklist |
| Accept is disabled, *Already accepted at this version* | You already accepted | Nothing; if the admin changes the configuration, accept again |
| The admin page still says *Buyer and seller must accept* | It shows an older reading | Wait 15 seconds or click **Refresh** on the Finalize card; check the acceptance badges and version |
| Deposit blocked: *maintenance authority is still active* | The admin has not renounced the authority | The admin registers all circuits and clicks **Renounce authority** |
| Deposit blocked: *Shielded balance too low* | Not enough of the escrow token | Top up the shielded balance of the committed wallet, before the closing deadline |
| *Not enough DUST* | Fee budget too low, or wallet sponsoring problem | Read the DUST report in the error; wait for DUST or get NIGHT |
| *Local proof server not reachable* | Proof server not running | `npm run proof-server:start` (image 9.0.1) |
| *issuer not whitelisted* on a KYC pre-check | The CASP key changed or was never whitelisted | The admin whitelists the active CASP key (before finalization) |
| Release blocked: *ERROR\_SELLER\_KYC\_REQUIRED* / *ERROR\_KYC\_EXPIRED* | Seller KYC missing or expired on-chain | The seller requests a new attestation and clicks **Submit seller KYC** |
| *CASP simulator unreachable* | The simulator is not running | Start it on port 8787 |

**Can the amount be changed after acceptance?** Only before finalization: the admin generates a new package and configures again, and both parties accept again.

**Can I accept or deposit on behalf of someone else?** No. Every action proves the caller's own role key, and payouts go only to the committed payout keys.

## Glossary

| Term | Meaning |
| --- | --- |
| Attestation (contingency) | The inspector's, lender's or title agent's on-chain result, anchored with a hash of their report |
| CASP | Crypto-asset service provider: the regulated KYC provider whose signed attestations the escrow accepts |
| Closing deadline | The deposit and the contingency review must be done before it; after it the escrow can be expired |
| Commitment | A salted hash of a private value (price, payout key) stored on-chain instead of the value |
| Configuration version | A counter that increases on every configuration change; acceptances are tied to it |
| Custodian copy | The notary's escrowed backup of the terms package |
| Dispute deadline | Last moment to open a dispute, and the resolver's deadline to decide |
| DUST / NIGHT | DUST pays transaction fees; it is generated by the NIGHT a wallet holds |
| Envelope | A file encrypted to one person's envelope public key |
| Escrow color / token | The on-chain identifier of the shielded token held in escrow |
| KYC policy | Minimum KYC level and maximum AML risk score the escrow accepts |
| Maintenance authority | The key that could change the contract's circuits; renounced to make the contract immutable |
| Opening | One private value plus its salt, so a third party can check it against its commitment |
| Role id | The public fingerprint of a secret role key, written in the contract |
| Shielded payout key | The wallet key a refund or the price is paid to |
| Terms package | The private price and payout keys with their salts; it opens the on-chain commitments |
| Vault | The encrypted store in your browser, one per address |
| Vault coin / vault index | The shielded coin holding the escrowed price, and its position in the chain's coin tree (needed to pay it out) |
