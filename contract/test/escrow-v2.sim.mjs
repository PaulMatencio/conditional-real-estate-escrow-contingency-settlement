/**
 * Simulator tests for conditional-real-estate-escrow-contingency-settlement-v2.compact
 * (lender deposit, buyer top-up, loan refusal refund term). The first part is the v1 suite run on a v2 cash
 * deal (FinancingMode.Attested, lender share 0); the "Loan" sections cover the new rules.
 *   cd contract && npm run compile:v2 && npm run test:v2
 * Runs every circuit off-chain with @midnight-ntwrk/compact-runtime (no node, no proofs).
 *   cd contract && npm install && npm run compile   (compact compile +0.36.0 --skip-zk -> managed/escrow)
 *   npm test
 * Exits with code 1 if any check fails.
 */
import * as rt from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits, EscrowStatus, Contingency, InitAttribute, FinancingMode } from '../managed/escrow-v2/contract/index.js';
import { createCaspSigner, schnorrReduction, verifyKycSignature, newSalt } from './casp-signer.mjs';
const S = Object.fromEntries(Object.entries(EscrowStatus).filter(([k]) => isNaN(k)).map(([k, v]) => [v, k]));
const sk = (n) => { const b = new Uint8Array(32); b[0] = n; return b; };
const K = { admin: sk(8), buyer: sk(1), seller: sk(2), inspector: sk(3), lender: sk(4), title: sk(5), resolver: sk(6), rando: sk(9) };
const DOC = { insp: sk(51), insp2: sk(52), fin: sk(53), title: sk(54), empty: new Uint8Array(32) };
const id = (k) => pureCircuits.roleIdOf(k);
const addr = (n) => ({ bytes: sk(100 + n) });
// ---- CASPs (KYC providers): one trusted, one not whitelisted ----
const CASP = { id: sk(200), ...createCaspSigner(0x1234567890abcdef1234567890abcdefn, pureCircuits) };
CASP.pk = CASP.publicKey;
const ROGUE = { id: sk(201), ...createCaspSigner(0x777n, pureCircuits) };
ROGUE.pk = ROGUE.publicKey;
const sign = (signer, att) => signer.sign(att);
const goodAtt = (over = {}) => ({ subject: pureCircuits.roleIdOf(sk(1)), wallet: { bytes: (() => { const b = new Uint8Array(32); b[0] = 101; return b; })() },
  kycLevel: 2n, amlRiskScore: 10n, validUntil: 5_000_000n, travelRuleRef: new Uint8Array(32).fill(4), salt: new Uint8Array(32).fill(9), ...over });
// Seller's attestation (beneficiary): subject = seller role id, wallet = seller payout address addr(2).
const sellerAtt = (over = {}) => goodAtt({ subject: pureCircuits.roleIdOf(sk(2)), wallet: { bytes: (() => { const b = new Uint8Array(32); b[0] = 102; return b; })() },
  travelRuleRef: new Uint8Array(32).fill(5), salt: new Uint8Array(32).fill(8), ...over });
let KYC = null; // [att, sig, issuerId] supplied by the buyer's wallet
const setKyc = (att, signer = CASP, issuer = CASP.id) => { KYC = [att, sign(signer, att), issuer]; };
setKyc(goodAtt());
const c = new Contract({
  localSecretKey: ({ privateState }) => [privateState, privateState.sk],
  kycAttestation: ({ privateState }) => [privateState, KYC],
  schnorrReduction: ({ privateState }, cFull) => [privateState, schnorrReduction(cFull)],
  privateTerms: ({ privateState }) => [privateState, TERMS_W],
  vaultCoin: ({ privateState }) => [privateState, VAULT_W],
  secondCoin: ({ privateState }) => [privateState, SECOND_W],
  lenderTerms: ({ privateState }) => [privateState, LTERMS_W],
});
const CPK = '00'.repeat(32);
const CADDR = rt.sampleContractAddress();
const T0 = 1_000_000, DL = 2_000_000, DDL = 3_000_000;
let pass = 0, fail = 0;

// ---- Private escrow terms (shielded custody) ----
// Known off-chain to buyer, seller and admin; the ledger only stores salted commitments.
const COLOR = sk(77);   // shielded token type (e.g. a shielded EUR EMT)
const TERMS = { amount: 1000n, amountSalt: new Uint8Array(32).fill(21), buyerPayout: addr(1), buyerSalt: new Uint8Array(32).fill(22),
  sellerPayout: addr(2), sellerSalt: new Uint8Array(32).fill(23),
  // v2 cash deal: price = buyer share, no loan
  price: 1000n, priceSalt: new Uint8Array(32).fill(24), lenderShare: 0n, lenderShareSalt: new Uint8Array(32).fill(25),
  lenderPayout: addr(4), lenderPayoutSalt: new Uint8Array(32).fill(26), refundOnLoss: true, loanTermsSalt: new Uint8Array(32).fill(27) };
const lenderPart = (t) => ({ lenderShare: t.lenderShare, lenderShareSalt: t.lenderShareSalt, lenderPayout: t.lenderPayout,
  lenderPayoutSalt: t.lenderPayoutSalt, refundOnLoss: t.refundOnLoss, loanTermsSalt: t.loanTermsSalt });
const financingOf = (t, mode, offerExpiry, window) => [some(mode), some(pureCircuits.priceCommitmentOf(t.price, t.priceSalt)),
  some(pureCircuits.lenderShareCommitmentOf(t.lenderShare, t.lenderShareSalt)), some(pureCircuits.payoutCommitmentOf(t.lenderPayout, t.lenderPayoutSalt)),
  some(pureCircuits.loanTermsCommitmentOf(t.refundOnLoss, t.loanTermsSalt)), some(BigInt(offerExpiry)), some(BigInt(window))];
const COMMIT = { amount: pureCircuits.amountCommitmentOf(TERMS.amount, TERMS.amountSalt),
  buyer: pureCircuits.payoutCommitmentOf(TERMS.buyerPayout, TERMS.buyerSalt),
  seller: pureCircuits.payoutCommitmentOf(TERMS.sellerPayout, TERMS.sellerSalt) };
const SELF = new Uint8Array(rt.encodeContractAddress(CADDR));
const VAULT_NONCE = pureCircuits.vaultNonceOf(SELF, TERMS.buyerSalt, TERMS.sellerSalt);
const VAULT = { nonce: VAULT_NONCE, color: COLOR, value: TERMS.amount };   // the coin the buyer deposits
let TERMS_W = TERMS;                       // what the caller's dApp supplies as privateTerms()
let VAULT_W = { ...VAULT, mt_index: 0n };  // vault coin + Merkle index (from the indexer on a real network)
let SECOND_W = { ...VAULT, mt_index: 1n };  // v2: second coin (loan or top-up), set per test
let LTERMS_W = lenderPart(TERMS);           // v2: the lender package

const some = (v) => ({ is_some: true, value: v });
const NONE32 = { is_some: false, value: new Uint8Array(32) };
const none = (v) => ({ is_some: false, value: v });
const POLICY = { minKycLevel: 2n, maxAmlRiskScore: 30n };
function fullTerms() {
  return [some(id(K.inspector)), some(id(K.lender)), some(id(K.title)), some(id(K.resolver)),
    some(COMMIT.buyer), some(COMMIT.seller), some(COMMIT.amount), some(BigInt(DL)), some(BigInt(DDL)), some(POLICY)];
}
function emptyTerms() {
  return [NONE32, NONE32, NONE32, NONE32, NONE32, NONE32,
    NONE32, none(0n), none(0n), none({ minKycLevel: 0n, maxAmlRiskScore: 0n })];
}
async function deployRaw(terms, admin = K.seller, withIssuer = true, withFinancing = withIssuer) {
  const r = await c.initialState(rt.createConstructorContext({ sk: K.buyer }, CPK), id(admin), id(K.buyer), id(K.seller), sk(77), 'EMT', ...terms);
  const e = { state: r.currentContractState, time: T0 };
  if (withIssuer) await call(e, admin === K.seller ? 'seller' : 'admin', 'addKycIssuer', CASP.id, CASP.pk);
  if (withFinancing) await call(e, admin === K.seller ? 'seller' : 'admin', 'configureFinancing', ...financingOf(TERMS, FinancingMode.Attested, DL, 1));
  return e;
}
const L = (e) => ledger(e.state.data ?? e.state);
async function deploy() {
  const e = await deployRaw(fullTerms());
  const v = L(e).configVersion;
  await call(e, 'buyer', 'acceptConfiguration', v); await call(e, 'seller', 'acceptConfiguration', v);
  await call(e, 'seller', 'finalizeInitialization');
  return e;
}
async function call(env, who, circuit, ...args) {
  if (circuit === 'depositToEscrow' && args.length === 0) args = [VAULT];   // default: the correct vault coin
  // compact-runtime 0.21 (Compact 0.36): options object, async circuits, per-contract query contexts.
  const ctx = rt.createCircuitContext({ circuitId: circuit, contractAddress: CADDR, coinPublicKeyOrZswapState: CPK, contractState: env.state, privateState: { sk: K[who] }, time: env.time });
  const r = await c.circuits[circuit](ctx, ...args);
  env.state = r.context.queryContexts[CADDR].state;
  env.zswap = r.context.zswapLocalStates[CADDR];   // shielded inputs/outputs of the last call
  return r;
}
const st = (env) => S[ledger(env.state.data ?? env.state).status];
async function ok(env, who, circuit, ...args) {
  try { await call(env, who, circuit, ...args); return true; } catch (e) { return e.message; }
}
async function expectOk(label, env, who, circuit, ...args) {
  const r = await ok(env, who, circuit, ...args);
  if (r === true) { pass++; console.log(`  ok   ${label} -> ${st(env)}`); } else { fail++; console.log(`  FAIL ${label}: ${r}`); }
}
async function expectErr(label, env, who, circuit, ...args) {
  const before = st(env); const r = await ok(env, who, circuit, ...args);
  if (r !== true) { pass++; console.log(`  ok   ${label} rejected: ${String(r).split('\n')[0].slice(0, 90)}`); }
  else { fail++; console.log(`  FAIL ${label} should be rejected (was ${before}, now ${st(env)})`); }
}
async function toPending() { const e = await deploy(); await expectOk('fund', e, 'buyer', 'depositToEscrow'); await expectOk('open review', e, 'seller', 'openContingencyReview'); return e; }

const expectErrMsg = async (label, env, who, circuit, needle, ...args) => {
  const r = await ok(env, who, circuit, ...args);
  if (r !== true && String(r).includes(needle)) { pass++; console.log(`  ok   ${label}: ${needle}`); }
  else { fail++; console.log(`  FAIL ${label}: expected "${needle}", got ${r === true ? 'success' : String(r).split('\n')[0]}`); }
};
const check = (label, cond) => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}`); } };
// Runs a payout on a COPY of the escrow and checks the shielded effects:
// one input (the vault coin) and one output of the full amount to `to`.
const h = (b) => Buffer.from(b).toString('hex');
async function expectPayout(label, env, who, circuit, to) {
  const copy = { ...env };
  const r = await ok(copy, who, circuit);
  const z = copy.zswap;
  const o = z?.outputs?.[0];
  const good = r === true && st(copy) === 'Closed' && z.inputs.length === 1 && z.outputs.length === 1 &&
    h(z.inputs[0].nonce) === h(VAULT_NONCE) && o.coinInfo.value === TERMS.amount && h(o.coinInfo.color) === h(COLOR) &&
    o.recipient.is_left && h(o.recipient.left.bytes) === h(to.bytes) && h(o.coinInfo.nonce) === h(pureCircuits.payoutNonceOf(VAULT_NONCE));
  if (good) { pass++; console.log(`  ok   ${label} -> Closed, shielded output ${TERMS.amount} to ${h(to.bytes).slice(0, 8)}…`); }
  else { fail++; console.log(`  FAIL ${label}: ${r === true ? 'unexpected shielded effects' : String(r).split('\n')[0]}`); }
}

console.log('CASP signing helper');
{
  const att = goodAtt({ salt: newSalt() });
  const sig = CASP.sign(att);
  check('signature verifies off-chain', verifyKycSignature(CASP.publicKey, att, sig, pureCircuits));
  check('tampered claim fails off-chain', !verifyKycSignature(CASP.publicKey, { ...att, kycLevel: 3n }, sig, pureCircuits));
  check('other issuer key fails off-chain', !verifyKycSignature(ROGUE.publicKey, att, sig, pureCircuits));
  const sig2 = CASP.sign(att);
  check('fresh random nonce per signature', rt.jubjubPointX(sig.announcement) !== rt.jubjubPointX(sig2.announcement));
}

console.log('Happy path');
let e = await toPending();
await expectErr('rando submits inspection', e, 'rando', 'submitInspection', true, DOC.insp);
await expectErr('empty inspection report hash rejected', e, 'inspector', 'submitInspection', true, DOC.empty);
await expectOk('inspection pass', e, 'inspector', 'submitInspection', true, DOC.insp);
check('inspectionReport hash anchored on-chain', Buffer.from(L(e).inspectionReport).equals(Buffer.from(DOC.insp)));
await expectErr('inspector overwrites', e, 'inspector', 'submitInspection', false, DOC.insp2);
await expectOk('financing ok', e, 'lender', 'submitFinancing', true, DOC.fin);
check('financingLetter hash anchored on-chain', Buffer.from(L(e).financingLetter).equals(Buffer.from(DOC.fin)));
await expectOk('title ok', e, 'title', 'submitTitle', true, DOC.title);
check('titleCommitment hash anchored on-chain', Buffer.from(L(e).titleCommitment).equals(Buffer.from(DOC.title)));
console.log('   status:', st(e));
await expectErrMsg('release blocked without seller KYC', e, 'seller', 'releaseToSeller', 'ERROR_SELLER_KYC_REQUIRED');

console.log('Resolver cannot flip a FAILED inspection into a seller payout');
e = await toPending();
await expectOk('inspection FAIL', e, 'inspector', 'submitInspection', false, DOC.insp);
await expectOk('financing ok', e, 'lender', 'submitFinancing', true, DOC.fin);
await expectOk('title ok', e, 'title', 'submitTitle', true, DOC.title);
await expectOk('seller disputes', e, 'seller', 'openDispute');
await expectErr('resolver settles to seller', e, 'resolver', 'resolveDisputeSettlement');
await expectErr('attestor submits while disputed', e, 'inspector', 'submitInspection', true, DOC.insp2);
await expectOk('resolver voids inspection', e, 'resolver', 'voidContingencyResult', Contingency.Inspection);
check('voided report hash archived in voidedReportHistory[0]', Buffer.from(L(e).voidedReportHistory.lookup(0n)).equals(Buffer.from(DOC.insp)));
await expectErr('resolver submits value itself', e, 'resolver', 'submitInspection', true, DOC.insp2);
await expectOk('original inspector re-attests', e, 'inspector', 'submitInspection', true, DOC.insp2);
check('new inspectionReport hash replaces voided hash', Buffer.from(L(e).inspectionReport).equals(Buffer.from(DOC.insp2)));
console.log('   status:', st(e), 'corrections:', ledger(e.state.data ?? e.state).correctionCount);

console.log('Buyer waiver / cancellation');
e = await toPending();
await expectOk('title FAIL', e, 'title', 'submitTitle', false, DOC.title);
await expectErr('seller waives', e, 'seller', 'waiveContingency', Contingency.Title);
await expectOk('buyer cancelAndRefund', e, 'buyer', 'cancelAndRefund');
e = await toPending();
await expectOk('title FAIL', e, 'title', 'submitTitle', false, DOC.title);
await expectOk('buyer waives title', e, 'buyer', 'waiveContingency', Contingency.Title);
await expectOk('buyer waives inspection (pending)', e, 'buyer', 'waiveContingency', Contingency.Inspection);
await expectOk('financing ok', e, 'lender', 'submitFinancing', true, DOC.fin);
e.state; await expectOk('dispute', e, 'buyer', 'openDispute');
await expectErr('resolver voids waived title', e, 'resolver', 'voidContingencyResult', Contingency.Title);
await expectOk('resolver dismisses', e, 'resolver', 'dismissDispute');

console.log('Expiry is time-gated');
e = await toPending();
await expectErr('expire before deadline', e, 'rando', 'expireEscrow');
e.time = DL + 1; await expectOk('expire after deadline', e, 'rando', 'expireEscrow');
await expectErr('rando refunds', e, 'rando', 'refundBuyer');
await expectPayout('seller triggers refund to the buyer (shielded)', e, 'seller', 'refundBuyer', TERMS.buyerPayout);
e = await toPending(); await expectOk('dispute', e, 'buyer', 'openDispute');
e.time = DL + 1; await expectErr('expire disputed before dispute deadline', e, 'rando', 'expireEscrow');
e.time = DDL; await expectOk('expire disputed after dispute deadline', e, 'rando', 'expireEscrow');
e = await deploy(); e.time = DL; await expectErr('fund after deadline', e, 'buyer', 'depositToEscrow');

console.log('Back-outs');
e = await deploy(); await expectErr('rando cancels', e, 'rando', 'cancelBeforeFunding'); await expectOk('seller cancels before funding', e, 'seller', 'cancelBeforeFunding');
await expectErr('fund cancelled', e, 'buyer', 'depositToEscrow');
e = await toPending(); await expectErr('buyer sellerWithdraw', e, 'buyer', 'sellerWithdraw'); await expectOk('seller withdraws', e, 'seller', 'sellerWithdraw');
await expectErr('buyer cancel without failure', await toPending(), 'buyer', 'cancelAndRefund');

console.log('Delayed initialization');
const ATTRS = Object.keys(InitAttribute).filter((k) => isNaN(k));
const missing = (e) => ATTRS.filter((a) => !L(e).configured.member(InitAttribute[a]));
e = await deployRaw(emptyTerms(), K.admin, false);
console.log('   status:', st(e), '| missing:', missing(e).join(','));
await expectErr('fund while Initializing', e, 'buyer', 'depositToEscrow');
await expectErr('accept incomplete config', e, 'buyer', 'acceptConfiguration', 0n);
await expectErr('finalize incomplete', e, 'admin', 'finalizeInitialization');
let t = emptyTerms(); t[0] = some(id(K.inspector)); t[6] = some(COMMIT.amount); t[3] = some(id(K.resolver));
await expectErr('seller (not admin) configures', e, 'seller', 'configure', ...t);
await expectOk('admin sets inspector, resolver, amount', e, 'admin', 'configure', ...t);
console.log('   missing now:', missing(e).join(','));
t = emptyTerms(); t[6] = some(new Uint8Array(32)); await expectErr('admin sets empty amount commitment', e, 'admin', 'configure', ...t);
t = fullTerms(); t[0] = some(id(K.seller)); await expectOk('admin sets remaining (seller as inspector!)', e, 'admin', 'configure', ...t);
console.log('   missing now:', missing(e).join(',') || '(none)');
await expectErr('seller (not admin) configures financing', e, 'seller', 'configureFinancing', ...financingOf(TERMS, FinancingMode.Attested, DL, 1));
await expectOk('admin configures financing (cash deal)', e, 'admin', 'configureFinancing', ...financingOf(TERMS, FinancingMode.Attested, DL, 1));
console.log('   missing now:', missing(e).join(',') || '(none)');
await expectErr('admin adds identity-point issuer', e, 'admin', 'addKycIssuer', CASP.id, rt.ecMulGenerator(0n));
await expectErr('seller adds issuer', e, 'seller', 'addKycIssuer', CASP.id, CASP.pk);
await expectOk('admin adds CASP issuer', e, 'admin', 'addKycIssuer', CASP.id, CASP.pk);
console.log('   missing now:', missing(e).join(',') || '(none)', '| version', L(e).configVersion);
let v = L(e).configVersion;
await expectOk('buyer accepts v' + v, e, 'buyer', 'acceptConfiguration', v);
await expectOk('seller accepts v' + v, e, 'seller', 'acceptConfiguration', v);
await expectErr('finalize with seller as inspector', e, 'admin', 'finalizeInitialization');
t = emptyTerms(); t[0] = some(id(K.inspector)); await expectOk('admin fixes inspector', e, 'admin', 'configure', ...t);
console.log('   acceptances reset:', L(e).buyerAccepted, L(e).sellerAccepted);
await expectErr('buyer accepts stale version', e, 'buyer', 'acceptConfiguration', v);
v = L(e).configVersion;
await expectErr('rando accepts', e, 'rando', 'acceptConfiguration', v);
await expectOk('buyer accepts', e, 'buyer', 'acceptConfiguration', v);
await expectErr('finalize without seller acceptance', e, 'admin', 'finalizeInitialization');
await expectOk('seller accepts', e, 'seller', 'acceptConfiguration', v);
await expectErr('non-admin finalizes', e, 'buyer', 'finalizeInitialization');
await expectOk('admin removes CASP issuer', e, 'admin', 'removeKycIssuer', CASP.id);
console.log('   missing now:', missing(e).join(','), '| acceptances', L(e).buyerAccepted, L(e).sellerAccepted);
await expectErr('finalize without KYC issuer', e, 'admin', 'finalizeInitialization');
await expectOk('admin re-adds CASP issuer', e, 'admin', 'addKycIssuer', CASP.id, CASP.pk);
v = L(e).configVersion; await call(e, 'buyer', 'acceptConfiguration', v); await call(e, 'seller', 'acceptConfiguration', v);
await expectOk('admin finalizes', e, 'admin', 'finalizeInitialization');
await expectErr('admin adds issuer after finalize', e, 'admin', 'addKycIssuer', ROGUE.id, ROGUE.pk);
await expectErr('admin configures after finalize', e, 'admin', 'configure', ...fullTerms());
await expectErr('admin cancels after finalize', e, 'admin', 'cancelBeforeFunding');
await expectOk('buyer funds', e, 'buyer', 'depositToEscrow');
e = await deployRaw(emptyTerms(), K.admin); await expectOk('admin abandons during init', e, 'admin', 'cancelBeforeFunding');
e = await deployRaw(fullTerms(), K.admin); v = L(e).configVersion; await call(e,'buyer','acceptConfiguration',v); await call(e,'seller','acceptConfiguration',v);
e.time = DL; await expectErr('finalize with past closing deadline', e, 'admin', 'finalizeInitialization');

console.log('KYC gate on deposit');
const fresh = async () => await deploy();
const tryDeposit = async (label, att, signer, issuer, ok = false) => { setKyc(att, signer, issuer); const e = await fresh(); await (ok ? expectOk : expectErr)(label, e, 'buyer', 'depositToEscrow'); return e; };
await tryDeposit('rogue (non-whitelisted) CASP', goodAtt(), ROGUE, ROGUE.id);
await tryDeposit('rogue key claiming trusted issuer id', goodAtt(), ROGUE, CASP.id);
{ setKyc(goodAtt()); KYC = [{ ...KYC[0], amlRiskScore: 5n }, KYC[1], KYC[2]]; const e = await fresh(); await expectErr('tampered claims (risk score)', e, 'buyer', 'depositToEscrow'); }
await tryDeposit('attestation for another subject', goodAtt({ subject: id(K.rando) }), CASP, CASP.id);
await tryDeposit('different wallet', goodAtt({ wallet: addr(9) }), CASP, CASP.id);
await tryDeposit('expired attestation', goodAtt({ validUntil: BigInt(T0) }), CASP, CASP.id);
await tryDeposit('KYC level too low', goodAtt({ kycLevel: 1n }), CASP, CASP.id);
await tryDeposit('AML risk too high', goodAtt({ amlRiskScore: 31n }), CASP, CASP.id);
{ const e = await tryDeposit('valid attestation', goodAtt(), CASP, CASP.id, true);
  const l = L(e); console.log('   buyerKycVerified', l.buyerKycVerified, '| ref == kycReference(att):',
    Buffer.from(l.buyerKycRef).equals(Buffer.from(pureCircuits.kycReference(goodAtt()))), '| ticker', l.escrowTicker); }
setKyc(goodAtt());

const readyToClose = async () => { setKyc(goodAtt()); const e = await toPending(); await call(e, 'inspector', 'submitInspection', true, DOC.insp); await call(e, 'lender', 'submitFinancing', true, DOC.fin); await call(e, 'title', 'submitTitle', true, DOC.title); return e; };

console.log('Travel Rule anchor');
{ setKyc(goodAtt()); const e = await deploy(); await call(e, 'buyer', 'depositToEscrow');
  check('buyerTravelRuleRef recorded at deposit', Buffer.from(L(e).buyerTravelRuleRef).equals(Buffer.from(goodAtt().travelRuleRef))); }

console.log('Seller KYC before payout');
e = await readyToClose();
console.log('   status:', st(e));
await expectErrMsg('release without seller KYC', e, 'seller', 'releaseToSeller', 'ERROR_SELLER_KYC_REQUIRED');
setKyc(sellerAtt());
await expectErr('buyer submits seller KYC', e, 'buyer', 'submitSellerKyc');
setKyc(goodAtt());
await expectErr('seller submits the BUYER attestation', e, 'seller', 'submitSellerKyc');
setKyc(sellerAtt({ wallet: addr(9) }));
await expectErr('seller attestation for another wallet', e, 'seller', 'submitSellerKyc');
setKyc(sellerAtt());
await expectOk('seller submits valid KYC', e, 'seller', 'submitSellerKyc');
check('sellerTravelRuleRef recorded', Buffer.from(L(e).sellerTravelRuleRef).equals(Buffer.from(sellerAtt().travelRuleRef)));
await expectPayout('release pays the seller (shielded)', e, 'seller', 'releaseToSeller', TERMS.sellerPayout);
{ const e2 = { ...e }; e2.time = Number(sellerAtt().validUntil);
  await expectErrMsg('release after seller attestation expired', e2, 'seller', 'releaseToSeller', 'ERROR_KYC_EXPIRED'); }
await expectErr('expire Ready escrow before dispute deadline', e, 'rando', 'expireEscrow');
{ const e2 = { ...e }; e2.time = DDL; await expectErr('expire Ready escrow with valid seller KYC', e2, 'rando', 'expireEscrow'); }
{ const e3 = await readyToClose(); e3.time = DDL; await expectOk('expire Ready escrow when seller never did KYC', e3, 'rando', 'expireEscrow'); }

console.log('CASP-signed revocation');
const sellerRef = pureCircuits.kycReference(sellerAtt());
await expectErr('revocation signed by rogue key', e, 'rando', 'revokeKycAttestation', CASP.id, sellerRef, ROGUE.revokeAttestation(sellerRef));
await expectErr('attestation signature replayed as revocation', e, 'rando', 'revokeKycAttestation', CASP.id, sellerRef, CASP.sign(sellerAtt()));
await expectOk('anyone submits CASP revocation of seller attestation', e, 'rando', 'revokeKycAttestation', CASP.id, sellerRef, CASP.revokeAttestation(sellerRef));
await expectErrMsg('release after revocation', e, 'seller', 'releaseToSeller', 'ERROR_KYC_REVOKED');
setKyc(sellerAtt());
await expectErrMsg('re-submit the revoked attestation', e, 'seller', 'submitSellerKyc', 'ERROR_KYC_REVOKED');
setKyc(sellerAtt({ salt: new Uint8Array(32).fill(3) }));
await expectOk('seller submits a renewed attestation', e, 'seller', 'submitSellerKyc');
await expectPayout('release pays the seller again after renewal', e, 'seller', 'releaseToSeller', TERMS.sellerPayout);
{ const ref = pureCircuits.kycReference(goodAtt()); const e4 = await deploy();
  await call(e4, 'rando', 'revokeKycAttestation', CASP.id, ref, CASP.revokeAttestation(ref));
  setKyc(goodAtt()); await expectErrMsg('deposit with revoked buyer attestation', e4, 'buyer', 'depositToEscrow', 'ERROR_KYC_REVOKED'); }

console.log('CASP withdraws its own key');
await expectErr('issuer revocation signed by rogue key', e, 'rando', 'revokeKycIssuer', CASP.id, ROGUE.revokeIssuer(CASP.id));
await expectErr('attestation revocation replayed as issuer revocation', e, 'rando', 'revokeKycIssuer', CASP.id, CASP.revokeAttestation(CASP.id));
await expectOk('anyone submits CASP self-revocation', e, 'rando', 'revokeKycIssuer', CASP.id, CASP.revokeIssuer(CASP.id));
check('issuer removed from whitelist', !L(e).kycIssuers.member(CASP.id));
await expectErrMsg('release after issuer revoked', e, 'seller', 'releaseToSeller', 'seller KYC issuer was revoked');
setKyc(sellerAtt({ salt: new Uint8Array(32).fill(3) }));
await expectErrMsg('seller KYC from revoked issuer', e, 'seller', 'submitSellerKyc', 'issuer is not a trusted CASP');
{ const e5 = { ...e }; e5.time = DDL; await expectOk('expire after dispute deadline (no usable seller KYC)', e5, 'rando', 'expireEscrow'); }
setKyc(goodAtt());

console.log('Shielded custody & private terms');
{
  const l = L(await deploy());
  check('no public amount / payout address on the ledger', !('escrowAmount' in l) && !('buyerAddress' in l) && !('sellerAddress' in l));
  check('ledger holds only the salted commitments', h(l.amountCommitment) === h(COMMIT.amount) && h(l.buyerPayoutCommitment) === h(COMMIT.buyer));
  setKyc(goodAtt());
  let e = await deploy();
  await expectErrMsg('deposit coin with wrong value', e, 'buyer', 'depositToEscrow', 'ERROR_DEPOSIT_COIN_MISMATCH', { ...VAULT, value: 999n });
  await expectErrMsg('deposit coin with wrong token color', e, 'buyer', 'depositToEscrow', 'ERROR_DEPOSIT_COIN_MISMATCH', { ...VAULT, color: sk(78) });
  await expectErrMsg('deposit coin with random nonce', e, 'buyer', 'depositToEscrow', 'ERROR_DEPOSIT_COIN_MISMATCH', { ...VAULT, nonce: sk(99) });
  TERMS_W = { ...TERMS, amount: 1n };
  await expectErrMsg('deposit with wrong amount opening', e, 'buyer', 'depositToEscrow', 'ERROR_TERMS_MISMATCH: amount');
  TERMS_W = { ...TERMS, buyerPayout: addr(7) };
  await expectErrMsg('deposit with another buyer payout key', e, 'buyer', 'depositToEscrow', 'ERROR_TERMS_MISMATCH: buyer payout key');
  TERMS_W = TERMS;
  await expectOk('deposit of the exact vault coin', e, 'buyer', 'depositToEscrow');
  check('receiveShielded: one shielded output to the contract', e.zswap.outputs.length === 1 && !e.zswap.outputs[0].recipient.is_left && h(e.zswap.outputs[0].coinInfo.nonce) === h(VAULT_NONCE));
  await call(e, 'seller', 'sellerWithdraw');
  VAULT_W = { ...VAULT, value: 1n, mt_index: 0n };
  await expectErrMsg('refund with a different coin than the vault', e, 'buyer', 'refundBuyer', 'ERROR_VAULT_COIN_MISMATCH');
  VAULT_W = { ...VAULT, mt_index: 0n };
  TERMS_W = { ...TERMS, sellerPayout: addr(7) };
  await expectErrMsg('refund with tampered seller key opening', e, 'buyer', 'refundBuyer', 'ERROR_TERMS_MISMATCH: seller payout key');
  TERMS_W = TERMS;
  await expectPayout('buyer refund to the committed buyer key', e, 'buyer', 'refundBuyer', TERMS.buyerPayout);
}

console.log('Constructor guards');
for (const [lbl, a, b, sl] of [['admin == buyer', K.buyer, K.buyer, K.seller], ['buyer == seller', K.admin, K.buyer, K.buyer]]) {
  try { await c.initialState(rt.createConstructorContext({ sk: K.buyer }, CPK), id(a), id(b), id(sl), sk(77), 'EMT', ...emptyTerms()); fail++; console.log('  FAIL', lbl); }
  catch (er) { pass++; console.log('  ok  ', lbl, 'rejected'); }
}

// =====================================================================
// v2: LOAN-FINANCED ESCROWS (FinancingMode.Deposited)
// =====================================================================
const OE = 1_500_000, WIN = 100_000;   // loan offer expiry, top-up window (seconds)
const LOAN = { ...TERMS, amount: 600n, price: 1000n, lenderShare: 400n };
const LOAN_NONCE = pureCircuits.lenderNonceOf(SELF, LOAN.lenderShareSalt, LOAN.lenderPayoutSalt);
const TOPUP_NONCE = pureCircuits.topUpNonceOf(SELF, LOAN.buyerSalt, LOAN.sellerSalt);
const BUYER_COIN = { nonce: VAULT_NONCE, color: COLOR, value: 600n };
const LOAN_COIN = { nonce: LOAN_NONCE, color: COLOR, value: 400n };
const TOPUP_COIN = { nonce: TOPUP_NONCE, color: COLOR, value: 400n };
const LETTER = sk(60);

/** Deploys a loan escrow (refund term on/off), funded by the buyer and in review. */
async function loanPending({ refund = true, terms = LOAN, offerExpiry = OE } = {}) {
  const t = { ...terms, refundOnLoss: refund };
  TERMS_W = t; LTERMS_W = lenderPart(t); VAULT_W = { ...BUYER_COIN, mt_index: 0n }; SECOND_W = { ...LOAN_COIN, mt_index: 1n };
  setKyc(goodAtt());
  const f = fullTerms(); f[6] = some(pureCircuits.amountCommitmentOf(t.amount, t.amountSalt));
  const e = await deployRaw(f, K.seller, true, false);
  await call(e, 'seller', 'configureFinancing', ...financingOf(t, FinancingMode.Deposited, offerExpiry, WIN));
  const v = L(e).configVersion;
  await call(e, 'buyer', 'acceptConfiguration', v); await call(e, 'seller', 'acceptConfiguration', v);
  await call(e, 'seller', 'finalizeInitialization');
  await call(e, 'buyer', 'depositToEscrow', BUYER_COIN);
  await call(e, 'seller', 'openContingencyReview');
  return e;
}
const clearOthers = async (e) => { await call(e, 'inspector', 'submitInspection', true, DOC.insp); await call(e, 'title', 'submitTitle', true, DOC.title); };
/** Shielded effects of the last call: [{ to, value, nonce }] per output, plus the spent input nonces. */
const outs = (e) => (e.zswap?.outputs ?? []).map((o) => ({ to: o.recipient.is_left ? h(o.recipient.left.bytes) : 'contract', value: o.coinInfo.value }));
const ins = (e) => (e.zswap?.inputs ?? []).map((i) => h(i.nonce));
const key = (a) => `${a.to}:${a.value}`;
const sameOuts = (got, want) => JSON.stringify([...got].map(key).sort()) === JSON.stringify([...want].map(key).sort());
const _unused = (got, want) => JSON.stringify([...got].sort((a, b) => (a.to + a.value).localeCompare(b.to + b.value))) ===
  JSON.stringify([...want].sort((a, b) => (a.to + a.value).localeCompare(b.to + b.value)));

console.log('Loan: the lender deposits its exact share, the release pays the full price');
{
  const e = await loanPending();
  await expectErr('lender uses submitFinancing in loan mode', e, 'lender', 'submitFinancing', true, DOC.fin);
  await expectErr('buyer waives financing in loan mode', e, 'buyer', 'waiveContingency', Contingency.Financing);
  await expectErr('buyer deposits the loan', e, 'buyer', 'depositLoan', LOAN_COIN, LETTER);
  await expectErrMsg('loan coin with wrong value', e, 'lender', 'depositLoan', 'ERROR_LOAN_COIN_MISMATCH', { ...LOAN_COIN, value: 399n }, LETTER);
  await expectErrMsg('loan coin with the vault nonce', e, 'lender', 'depositLoan', 'ERROR_LOAN_COIN_MISMATCH', { ...LOAN_COIN, nonce: VAULT_NONCE }, LETTER);
  LTERMS_W = { ...lenderPart(LOAN), lenderShare: 1n };
  await expectErrMsg('lender package with another share', e, 'lender', 'depositLoan', 'ERROR_TERMS_MISMATCH: lender share', LOAN_COIN, LETTER);
  LTERMS_W = lenderPart(LOAN);
  await expectErr('empty letter hash', e, 'lender', 'depositLoan', LOAN_COIN, DOC.empty);
  await clearOthers(e);
  check('not ready to close before the loan is in', st(e) === 'ContingenciesPending');
  await expectOk('lender deposits the exact loan share', e, 'lender', 'depositLoan', LOAN_COIN, LETTER);
  check('loan received by the contract, financing approved, letter anchored',
    sameOuts(outs(e), [{ to: 'contract', value: 400n }]) && L(e).loanHeld && L(e).financingApproved && h(L(e).financingLetter) === h(LETTER));
  check('status ReadyToClose', st(e) === 'ReadyToClose');
  await expectErr('lender deposits twice', e, 'lender', 'depositLoan', LOAN_COIN, LETTER);
  e.time = OE; await expectErr('lender withdraws once ReadyToClose', e, 'lender', 'withdrawLoan', BigInt(OE));
  setKyc(sellerAtt()); await call(e, 'seller', 'submitSellerKyc'); setKyc(goodAtt());
  await expectOk('seller releases', e, 'seller', 'releaseToSeller');
  check('release pays both coins (600 + 400 = price) to the seller and closes',
    st(e) === 'Closed' && sameOuts(outs(e), [{ to: h(LOAN.sellerPayout.bytes), value: 600n }, { to: h(LOAN.sellerPayout.bytes), value: 400n }]) &&
    ins(e).includes(h(VAULT_NONCE)) && ins(e).includes(h(LOAN_NONCE)));
}

console.log('Loan: commitments and dates');
{
  const e = await loanPending();
  e.time = OE; await expectErrMsg('loan deposit at the offer expiry', e, 'lender', 'depositLoan', 'Loan offer has expired', LOAN_COIN, LETTER);
  const bad = { ...LOAN, price: 999n };
  TERMS_W = bad; LTERMS_W = lenderPart(bad); setKyc(goodAtt());
  { const f = fullTerms(); f[6] = some(pureCircuits.amountCommitmentOf(bad.amount, bad.amountSalt));
    const e2 = await deployRaw(f, K.seller, true, false); await call(e2, 'seller', 'configureFinancing', ...financingOf(bad, FinancingMode.Deposited, OE, WIN));
    const v = L(e2).configVersion; await call(e2, 'buyer', 'acceptConfiguration', v); await call(e2, 'seller', 'acceptConfiguration', v); await call(e2, 'seller', 'finalizeInitialization');
    await expectErrMsg('shares that do not add up to the price', e2, 'buyer', 'depositToEscrow', 'price is not buyer share + lender share', BUYER_COIN); }
  { const cashWithLoan = { ...TERMS, amount: 600n, lenderShare: 400n }; TERMS_W = cashWithLoan;
    const f = fullTerms(); f[6] = some(pureCircuits.amountCommitmentOf(600n, TERMS.amountSalt));
    const e3 = await deployRaw(f, K.seller, true, false); await call(e3, 'seller', 'configureFinancing', ...financingOf(cashWithLoan, FinancingMode.Attested, DL, 1));
    const v = L(e3).configVersion; await call(e3, 'buyer', 'acceptConfiguration', v); await call(e3, 'seller', 'acceptConfiguration', v); await call(e3, 'seller', 'finalizeInitialization');
    await expectErrMsg('cash deal with a lender share', e3, 'buyer', 'depositToEscrow', 'a cash deal has no lender share', BUYER_COIN); }
  TERMS_W = LOAN; LTERMS_W = lenderPart(LOAN);
  for (const [lbl, mut] of [['offer expiry after the closing deadline', (fin) => { fin[5] = some(BigInt(DL + 1)); }], ['zero top-up window', (fin) => { fin[6] = some(0n); }]]) {
    const f = fullTerms(); f[6] = some(pureCircuits.amountCommitmentOf(LOAN.amount, LOAN.amountSalt));
    const e4 = await deployRaw(f, K.seller, true, false); const fin = financingOf(LOAN, FinancingMode.Deposited, OE, WIN); mut(fin);
    await call(e4, 'seller', 'configureFinancing', ...fin); const v = L(e4).configVersion;
    await call(e4, 'buyer', 'acceptConfiguration', v); await call(e4, 'seller', 'acceptConfiguration', v);
    await expectErr('finalize with ' + lbl, e4, 'seller', 'finalizeInitialization');
  }
  { const f = fullTerms(); f[1] = some(id(K.buyer)); f[6] = some(pureCircuits.amountCommitmentOf(LOAN.amount, LOAN.amountSalt));
    const e5 = await deployRaw(f, K.seller, true, false); await call(e5, 'seller', 'configureFinancing', ...financingOf(LOAN, FinancingMode.Deposited, OE, WIN));
    const v = L(e5).configVersion; await call(e5, 'buyer', 'acceptConfiguration', v); await call(e5, 'seller', 'acceptConfiguration', v);
    await expectErr('finalize with the buyer as lender in loan mode', e5, 'seller', 'finalizeInitialization'); }
}

console.log('Loan refused, refund term ON: top-up window, then refund');
{
  const T = T0 + 10_000;
  let e = await loanPending({ refund: true }); e.time = T;
  await expectErr('refusal with a time in the future', e, 'lender', 'declineLoan', LETTER, BigInt(T + 5));
  await expectErr('refusal with a stale time', e, 'lender', 'declineLoan', LETTER, BigInt(T - 601));
  await expectOk('lender refuses the loan', e, 'lender', 'declineLoan', LETTER, BigInt(T));
  check('loan lost, refund term disclosed, window ends at refusal + window', L(e).loanLost && L(e).loanLostRefund && L(e).topUpWindowEnd === BigInt(T + WIN));
  await expectErr('lender refuses twice', e, 'lender', 'declineLoan', LETTER, BigInt(T));
  await expectErr('lender deposits after refusing', e, 'lender', 'depositLoan', LOAN_COIN, LETTER);
  await expectErrMsg('end the window too early', e, 'rando', 'endTopUpWindow', 'Top-up window is not over');
  e.time = T + WIN; await expectErrMsg('top-up after the window', e, 'buyer', 'depositTopUp', 'Top-up window is over', TOPUP_COIN);
  await expectOk('anyone ends the window', e, 'rando', 'endTopUpWindow');
  check('status Refunded', st(e) === 'Refunded');
  await expectOk('refund to the buyer', e, 'seller', 'refundBuyer');
  check('buyer refunded 600, escrow closed', st(e) === 'Closed' && sameOuts(outs(e), [{ to: h(LOAN.buyerPayout.bytes), value: 600n }]));

  e = await loanPending({ refund: true }); e.time = T;
  await call(e, 'lender', 'declineLoan', LETTER, BigInt(T));
  await expectOk('buyer gives up the window early', e, 'buyer', 'cancelAndRefund');
  check('status Refunded', st(e) === 'Refunded');

  e = await loanPending({ refund: true }); e.time = T; await clearOthers(e);
  await call(e, 'lender', 'declineLoan', LETTER, BigInt(T));
  SECOND_W = { ...TOPUP_COIN, mt_index: 1n };
  await expectErrMsg('top-up coin with the loan nonce', e, 'buyer', 'depositTopUp', 'ERROR_TOPUP_COIN_MISMATCH', LOAN_COIN);
  await expectErr('seller tops up', e, 'seller', 'depositTopUp', TOPUP_COIN);
  setKyc(goodAtt({ validUntil: BigInt(T) }));
  await expectErrMsg('top-up with an expired KYC attestation', e, 'buyer', 'depositTopUp', 'ERROR_KYC_EXPIRED', TOPUP_COIN);
  setKyc(goodAtt());
  e.time = T + WIN - 1; await expectOk('buyer tops up inside the window', e, 'buyer', 'depositTopUp', TOPUP_COIN);
  check('top-up held, financing covered, ReadyToClose', L(e).topUpHeld && L(e).financingApproved && st(e) === 'ReadyToClose');
  await expectErr('window cannot end after a top-up', e, 'rando', 'endTopUpWindow');
  setKyc(sellerAtt()); await call(e, 'seller', 'submitSellerKyc'); setKyc(goodAtt());
  await expectOk('seller releases', e, 'buyer', 'releaseToSeller');
  check('seller receives buyer share + top-up', st(e) === 'Closed' && ins(e).includes(h(TOPUP_NONCE)) &&
    sameOuts(outs(e), [{ to: h(LOAN.sellerPayout.bytes), value: 600n }, { to: h(LOAN.sellerPayout.bytes), value: 400n }]));
  SECOND_W = { ...LOAN_COIN, mt_index: 1n };

  // The window never runs past the closing deadline.
  e = await loanPending({ refund: true }); const late = DL - 1000; e.time = late;
  await call(e, 'lender', 'declineLoan', LETTER, BigInt(late));
  check('window cut at the closing deadline', L(e).topUpWindowEnd === BigInt(DL));
}

console.log('Loan refused, refund term OFF: top up before the closing deadline or forfeit');
{
  const T = T0 + 10_000;
  let e = await loanPending({ refund: false }); e.time = T;
  await expectOk('lender refuses the loan', e, 'lender', 'declineLoan', LETTER, BigInt(T - 700));   // no window: time not checked
  check('loan lost, refund term off', L(e).loanLost && !L(e).loanLostRefund);
  await expectErr('buyer cancels and refunds', e, 'buyer', 'cancelAndRefund');
  await expectErr('anyone ends a window', e, 'rando', 'endTopUpWindow');
  e.time = DL; await expectOk('expire at the closing deadline', e, 'rando', 'expireEscrow');
  check('status Forfeited', st(e) === 'Forfeited');
  await expectErr('buyer asks a refund', e, 'buyer', 'refundBuyer');
  await expectErrMsg('seller claims without KYC', e, 'seller', 'claimForfeit', 'ERROR_SELLER_KYC_REQUIRED');
  setKyc(sellerAtt()); await call(e, 'seller', 'submitSellerKyc'); setKyc(goodAtt());
  await expectErr('buyer claims the forfeit', e, 'buyer', 'claimForfeit');
  await expectOk('seller claims the forfeited deposit', e, 'seller', 'claimForfeit');
  check('seller receives the buyer share, escrow closed', st(e) === 'Closed' && sameOuts(outs(e), [{ to: h(LOAN.sellerPayout.bytes), value: 600n }]));

  e = await loanPending({ refund: false }); e.time = T;
  await call(e, 'lender', 'declineLoan', LETTER, BigInt(T));
  SECOND_W = { ...TOPUP_COIN, mt_index: 1n };
  e.time = DL - 1; await expectOk('buyer tops up before the closing deadline', e, 'buyer', 'depositTopUp', TOPUP_COIN);
  e.time = DL; await expectOk('expire (inspection never came)', e, 'rando', 'expireEscrow');
  check('no forfeit after a top-up: Expired', st(e) === 'Expired');
  await expectOk('refund to the buyer', e, 'buyer', 'refundBuyer');
  check('buyer gets buyer share + top-up back, closed', st(e) === 'Closed' &&
    sameOuts(outs(e), [{ to: h(LOAN.buyerPayout.bytes), value: 600n }, { to: h(LOAN.buyerPayout.bytes), value: 400n }]));
  SECOND_W = { ...LOAN_COIN, mt_index: 1n };

  e = await loanPending({ refund: false }); e.time = DL;
  await expectOk('silent lender: expire at the closing deadline', e, 'rando', 'expireEscrow');
  check('silence is not a refusal: Expired', st(e) === 'Expired');
}

console.log('Loan withdrawal after the offer expiry');
{
  let e = await loanPending({ refund: true });
  await expectOk('lender deposits', e, 'lender', 'depositLoan', LOAN_COIN, LETTER);
  await expectErrMsg('second loan deposit while in review', e, 'lender', 'depositLoan', 'The second coin is already deposited', LOAN_COIN, LETTER);
  await expectErrMsg('buyer top-up while the loan is held', e, 'buyer', 'depositTopUp', 'The second coin is already deposited', TOPUP_COIN);
  await expectErrMsg('withdraw before the offer expiry', e, 'lender', 'withdrawLoan', 'Loan offer has not expired yet', BigInt(T0));
  e.time = OE;
  await expectErr('seller withdraws the loan', e, 'seller', 'withdrawLoan', BigInt(OE));
  await expectOk('lender withdraws at the offer expiry', e, 'lender', 'withdrawLoan', BigInt(OE));
  check('loan paid back to the lender, counted as lost', sameOuts(outs(e), [{ to: h(LOAN.lenderPayout.bytes), value: 400n }]) &&
    !L(e).loanHeld && L(e).loanLost && L(e).loanWithdrawn && L(e).topUpWindowEnd === BigInt(OE + WIN));
  await expectErr('lender withdraws twice', e, 'lender', 'withdrawLoan', BigInt(OE));
  await expectOk('buyer gives up the window', e, 'buyer', 'cancelAndRefund');
  await expectOk('refund to the buyer', e, 'buyer', 'refundBuyer');
  check('closed after the buyer refund (loan already repaid)', st(e) === 'Closed');

  e = await loanPending({ refund: false });
  await call(e, 'lender', 'depositLoan', LOAN_COIN, LETTER); e.time = OE;
  await call(e, 'lender', 'withdrawLoan', BigInt(OE));
  e.time = DL; await call(e, 'rando', 'expireEscrow');
  check('withdrawal with the term off and no top-up: Forfeited', st(e) === 'Forfeited');

  e = await loanPending({ refund: false });
  await call(e, 'lender', 'depositLoan', LOAN_COIN, LETTER); await call(e, 'buyer', 'openDispute'); e.time = OE;
  await expectErr('withdraw while disputed', e, 'lender', 'withdrawLoan', BigInt(OE));
}

console.log('Unwinds return each coin to its depositor');
{
  let e = await loanPending();
  await call(e, 'lender', 'depositLoan', LOAN_COIN, LETTER);
  await call(e, 'inspector', 'submitInspection', false, DOC.insp);
  await expectOk('inspection failed: buyer cancels', e, 'buyer', 'cancelAndRefund');
  await expectErr('rando refunds the lender', e, 'rando', 'refundLender');
  await expectOk('buyer refund', e, 'seller', 'refundBuyer');
  check('buyer paid, still open for the lender coin', st(e) === 'Refunded' && sameOuts(outs(e), [{ to: h(LOAN.buyerPayout.bytes), value: 600n }]));
  await expectOk('lender refund (lender package)', e, 'lender', 'refundLender');
  check('lender paid back, escrow closed', st(e) === 'Closed' && sameOuts(outs(e), [{ to: h(LOAN.lenderPayout.bytes), value: 400n }]));
  await expectErr('lender refunded twice', e, 'lender', 'refundLender');

  e = await loanPending();
  await call(e, 'lender', 'depositLoan', LOAN_COIN, LETTER);
  await expectOk('seller withdraws', e, 'seller', 'sellerWithdraw');
  await expectOk('lender refund first', e, 'buyer', 'refundLender');
  await expectOk('then the buyer refund', e, 'buyer', 'refundBuyer');
  check('closed once both coins are paid', st(e) === 'Closed');

  e = await loanPending();
  await call(e, 'lender', 'depositLoan', LOAN_COIN, LETTER);
  e.time = DL; await expectOk('expire with the loan held', e, 'rando', 'expireEscrow');
  check('Expired, not forfeited', st(e) === 'Expired');
  await call(e, 'buyer', 'refundBuyer'); await expectOk('lender refund after expiry', e, 'lender', 'refundLender');
  check('closed', st(e) === 'Closed');

  e = await loanPending(); await clearOthers(e);
  await call(e, 'lender', 'depositLoan', LOAN_COIN, LETTER); await call(e, 'seller', 'openDispute');
  await expectOk('resolver settles (loan held)', e, 'resolver', 'resolveDisputeSettlement');
  setKyc(sellerAtt()); await call(e, 'seller', 'submitSellerKyc'); setKyc(goodAtt());
  await expectOk('resolver releases', e, 'resolver', 'releaseToSeller');
  check('settled release pays both coins', st(e) === 'Closed' && outs(e).length === 2);
}

console.log('Disputes over the loan decision');
{
  const T = T0 + 10_000;
  let e = await loanPending({ refund: false }); e.time = T;
  await call(e, 'lender', 'declineLoan', LETTER, BigInt(T));
  await expectOk('buyer disputes the refusal', e, 'buyer', 'openDispute');
  await expectOk('resolver voids the refusal', e, 'resolver', 'voidContingencyResult', Contingency.Financing);
  check('loan no longer lost, back in review', !L(e).loanLost && st(e) === 'ContingenciesPending');
  await expectOk('lender deposits after all', e, 'lender', 'depositLoan', LOAN_COIN, LETTER);

  e = await loanPending({ refund: false });
  await call(e, 'lender', 'depositLoan', LOAN_COIN, LETTER); e.time = OE; await call(e, 'lender', 'withdrawLoan', BigInt(OE));
  await call(e, 'buyer', 'openDispute');
  await expectErrMsg('a withdrawal cannot be voided', e, 'resolver', 'voidContingencyResult', Contingency.Financing, 'Only a loan refusal can be voided');
  e.time = DDL; await expectOk('dispute outlives the dispute deadline', e, 'rando', 'expireEscrow');
  check('a disputed escrow expires to a refund, never a forfeit', st(e) === 'Expired');

  e = await loanPending();
  await call(e, 'lender', 'depositLoan', LOAN_COIN, LETTER); await call(e, 'buyer', 'openDispute');
  await expectErr('an approval (deposit) cannot be voided', e, 'resolver', 'voidContingencyResult', Contingency.Financing);
}
TERMS_W = TERMS; LTERMS_W = lenderPart(TERMS); VAULT_W = { ...VAULT, mt_index: 0n };

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
