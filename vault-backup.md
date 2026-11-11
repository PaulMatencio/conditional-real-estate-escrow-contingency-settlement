# Vault backup and restore

Admin page → **Vault** tab (next to *Keys*). Added 2026-11-08.

The browser vault is the only place that holds an escrow's private material: role keys, private terms, KYC attestations, document salts, the contract maintenance-authority key and the envelope key. If the browser profile is lost, so is that material. The Vault tab writes it all to **one encrypted file** and merges such a file back into a vault later, in the same or another browser.

---

## 1. Backing up the vault

1. Unlock the vault (top of the admin page).
2. Open the **Vault** tab. *Back up the vault* shows what will be saved:
   - every escrow in the vault, with badges for its terms, role keys, KYC attestations and authority key (or *renounced*);
   - whether the envelope key is present;
   - the date of the last backup made from this browser.
3. Leave **Include the admin secret key** ticked (default) unless you keep the admin key elsewhere.
4. Enter a **backup passphrase** twice: at least 12 characters, preferably different from the vault passphrase. It cannot be recovered.
5. Click **Download encrypted backup**. The file is saved as `escrow-vault-backup-YYYY-MM-DD.json`.

### What the file contains

| Item | Source |
| :--- | :--- |
| Role keys (admin, buyer, seller, attestors, resolver) per escrow | vault record of each escrow |
| Private terms package (amount, payout keys, salts, vault index) | vault record |
| KYC attestation bundles (buyer, seller) | vault record |
| Document salts and report hashes (attestors) | vault record |
| Contract maintenance-authority key and its history; renounce date | vault record |
| Local transaction history and confirmed terms backups | vault record |
| Custodian copy of the terms package (notary portal) and what was handed out from it | vault record (`custody`) |
| Envelope key pair (X25519) and earlier envelope keys | vault identity record (`_identity`) |
| Admin secret key and the keys it replaced (optional) | vault admin record (`_admin`) |
| Transaction log: every transaction built in this browser, all escrows and roles, with its outcome | vault log record (`_txlog`) |
| Loaded contract address | admin console |

### Encryption

AES-256-GCM with a key derived from the backup passphrase (PBKDF2-SHA-256, 310,000 iterations, random salt). The file is self-contained: no server is involved, and nothing private appears in clear in it. Keep it offline (USB key, password manager), as carefully as the vault itself.

---

## 2. Restoring from a backup

1. Unlock the vault of the browser you are restoring into. A new browser first creates its vault with any vault passphrase; it does not need to match the backup passphrase, because restored records are re-encrypted with this vault's key.
2. **Vault** tab → *Restore from a backup* → **Choose backup file**.
3. Enter the backup passphrase and click **Decrypt and preview**. Nothing is written yet: the preview lists the escrows and items the file contains.
4. Click **Restore (merge)**. The result lists the new escrows, merged escrows, added items and any differences.

### Merge rules: never delete, never overwrite silently

| Item | Rule |
| :--- | :--- |
| Escrow not in this vault | added as is |
| Terms package | added if missing; if both differ, the current one is kept and the difference reported; a missing vault index is filled in |
| Role keys, KYC attestations | added if missing; if different, the current one is kept and the difference reported |
| Authority key | added if missing; if different, the current one is kept and the backup's goes to the key history; a key whose authority was renounced is never brought back |
| Authority key history, documents, confirmed backups, transaction history | merged (union, no duplicates) |
| Transaction log (`_txlog`) | merged by entry: the most recently updated copy of each entry wins; the restore report shows how many entries were added |
| Envelope key | if this vault holds no escrows yet (new browser), the backup's key becomes current and the newly created one is kept as a previous key; otherwise the current key is kept and the backup's is stored as a previous key |
| Admin secret key | restored only if this browser has none; otherwise the current key is kept and the backup's goes to the admin key history. Backups made before 2026-11-08 (key in `admin.secretKey`) are handled the same way |
| Loaded contract address | set only if no contract is loaded |

Previous envelope keys are still tried when importing an envelope, so terms packages encrypted to an older key still open.

---

### Moving to another address (e.g. `localhost:3000` → `admin.localhost:3000`)

Each address has its own browser storage, so a new address starts with **no vault**. Don't create an empty one: restore it.

1. On the **old** address, Vault tab → **Back up the vault** (include the admin secret key) → download the file.
2. Open the **new** address. The "Create vault" card shows *Moved from another address? … Restore a vault from a backup*; click it (or open the Vault tab).
3. **Choose backup file**, type the **backup passphrase**, **Decrypt and preview**: check the escrows, keys and log it contains.
4. Choose the **new vault passphrase** (twice; it can differ from the old one) → **Create the vault and restore**.

The vault is created and the backup merged in one step: escrows, role keys, terms packages, KYC attestations, authority keys, the **envelope key** (the backup's replaces the one generated for the empty vault, so envelopes sent to it still open), the admin secret key and the transaction log. The old address keeps its own copy until you erase it.

## 3. Where the vault is stored

In the browser's **IndexedDB**, database `escrow-vault`, object store `kv`, for the dApp's origin (e.g. `http://localhost:3000`). On Linux, inside the browser profile, e.g. `~/.config/google-chrome/Default/IndexedDB/http_localhost_3000.indexeddb.leveldb/`. Inspect it in DevTools → *Application* → *IndexedDB*.

| Entry | Content |
| :--- | :--- |
| `vault:meta` | random salt and an encrypted check value (the passphrase is never stored) |
| `vault:rec:<contract address>` | one AES-GCM record per escrow |
| `vault:rec:_identity` | envelope key pair |
| `vault:rec:_admin` | admin secret key (since 2026-11-08) |
| `vault:rec:_txlog` | transaction log (since 2026-11-09; at most 5,000 entries, oldest dropped first) |

- One vault per browser profile **and** per origin: `localhost:3000` and `127.0.0.1:3000` have separate vaults.
- Clearing site data, or a private window, removes it: keep a backup.
- Since 2026-11-08 the **admin secret key** is no longer in plain `localStorage`. On the next unlock, a key found at `escrow:admin:sk` is moved into the vault, verified, then deleted (a different key already in the vault stays current; the old one goes to the history). The admin console reads the key only while the vault is unlocked; when locked, the Keys tab asks to unlock it.
- Still in plain `localStorage` (`escrow:…`): only non-secret settings (mode, loaded contract address, language, theme, last backup date).

## 4. When to make a backup

- Right after deploying, while the vault holds a live maintenance-authority key. Losing it before renouncing means losing control of the contract.
- After generating or importing a terms package, role keys or KYC attestations.
- Before clearing browser data, changing computer or browser profile.

---

## 5. Implementation

| File | Role |
| :--- | :--- |
| `src/application/vaultBackup.ts` | Backup format `EscrowVaultBackupV1`, summary, merge rules (`mergeRecord`, `mergeIdentity`) |
| `src/infrastructure/storage/vaultBackupStore.ts` | `exportVault`, `sealBackup`, `openBackup`, `restoreVault` |
| `src/presentation/components/admin/VaultTab.tsx` | Admin Vault tab (backup and restore cards) |
| `src/presentation/providers/EscrowProvider.tsx` | `identities` (current + previous envelope keys), `reloadVault` after a restore |
| `src/presentation/components/party/TermsPanel.tsx` | Opens envelopes with any envelope key the vault holds |
| `src/infrastructure/storage/vaultInstance.ts` | Shared vault, `vaultSignal`, admin key load/save and plaintext migration |
| `tests/vaultBackup.test.ts` | Round trip, merge rules, wrong passphrase, wrong file kinds, legacy admin key |
| `tests/authority.test.ts` | Authority and admin key migration, locked-vault behaviour |

Texts are available in English, French and Spanish.

## 6. Verification

- Unit tests: export → seal → open → restore into a fresh vault; merge without loss; renounced authority key not restored; identity rules; wrong passphrase; a terms-backup file rejected as "not a vault backup".
- Browser test: backup downloaded in one browser profile, restored into a fresh one ("Restored: 1 new escrow(s)", envelope key restored), no page errors.
- Browser test: a plaintext admin key is moved into the vault on unlock and deleted from `localStorage`; the Keys tab hides it while locked and shows it again after a reload and unlock.
