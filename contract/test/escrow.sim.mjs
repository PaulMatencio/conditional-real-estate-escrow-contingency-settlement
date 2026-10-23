/**
 * Simulator tests for conditional-real-estate-escrow-contingency-settlement.compact.
 * Runs every circuit off-chain with @midnight-ntwrk/compact-runtime (no node, no proofs).
 *   cd contract && npm install && npm run compile   (compact compile +0.31.1 --skip-zk -> managed/escrow)
 *   npm test
 * Exits with code 1 if any check fails.
 */
import * as rt from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits, EscrowStatus, Contingency, InitAttribute } from '../managed/escrow/contract/index.js';
import { createCaspSigner, schnorrReduction, verifyKycSignature, newSalt } from './casp-signer.mjs';
const S = Object.fromEntries(Object.entries(EscrowStatus).filter(([k]) => isNaN(k)).map(([k, v]) => [v, k]));
const sk = (n) => { const b = new Uint8Array(32); b[0] = n; return b; };
const K = { admin: sk(8), buyer: sk(1), seller: sk(2), inspector: sk(3), lender: sk(4), title: sk(5), resolver: sk(6), rando: sk(9) };
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
});
const CPK = '00'.repeat(32);
const CADDR = rt.sampleContractAddress ? rt.sampleContractAddress() : '02' + '11'.repeat(32);
const T0 = 1_000_000, DL = 2_000_000, DDL = 3_000_000;
let pass = 0, fail = 0;

const some = (v) => ({ is_some: true, value: v });
const NONE32 = { is_some: false, value: new Uint8Array(32) };
const none = (v) => ({ is_some: false, value: v });
const POLICY = { minKycLevel: 2n, maxAmlRiskScore: 30n };
function fullTerms() {
  return [some(id(K.inspector)), some(id(K.lender)), some(id(K.title)), some(id(K.resolver)),
    some(addr(1)), some(addr(2)), some(1000n), some(BigInt(DL)), some(BigInt(DDL)), some(POLICY)];
}
function emptyTerms() {
  return [NONE32, NONE32, NONE32, NONE32, none({ bytes: new Uint8Array(32) }), none({ bytes: new Uint8Array(32) }),
    none(0n), none(0n), none(0n), none({ minKycLevel: 0n, maxAmlRiskScore: 0n })];
}
function deployRaw(terms, admin = K.seller, withIssuer = true) {
  const r = c.initialState(rt.createConstructorContext({ sk: K.buyer }, CPK), id(admin), id(K.buyer), id(K.seller), sk(77), 'EMT', ...terms);
  const e = { state: r.currentContractState, time: T0 };
  if (withIssuer) call(e, admin === K.seller ? 'seller' : 'admin', 'addKycIssuer', CASP.id, CASP.pk);
  return e;
}
const L = (e) => ledger(e.state.data ?? e.state);
function deploy() {
  const e = deployRaw(fullTerms());
  const v = L(e).configVersion;
  call(e, 'buyer', 'acceptConfiguration', v); call(e, 'seller', 'acceptConfiguration', v);
  call(e, 'seller', 'finalizeInitialization');
  return e;
}
function call(env, who, circuit, ...args) {
  const ctx = rt.createCircuitContext(CADDR, CPK, env.state, { sk: K[who] }, undefined, undefined, env.time);
  const r = c.circuits[circuit](ctx, ...args);
  env.state = r.context.currentQueryContext.state;
  return r;
}
const st = (env) => S[ledger(env.state.data ?? env.state).status];
function ok(env, who, circuit, ...args) {
  try { call(env, who, circuit, ...args); return true; } catch (e) { return e.message; }
}
function expectOk(label, env, who, circuit, ...args) {
  const r = ok(env, who, circuit, ...args);
  if (r === true) { pass++; console.log(`  ok   ${label} -> ${st(env)}`); } else { fail++; console.log(`  FAIL ${label}: ${r}`); }
}
function expectErr(label, env, who, circuit, ...args) {
  const before = st(env); const r = ok(env, who, circuit, ...args);
  if (r !== true) { pass++; console.log(`  ok   ${label} rejected: ${String(r).split('\n')[0].slice(0, 90)}`); }
  else { fail++; console.log(`  FAIL ${label} should be rejected (was ${before}, now ${st(env)})`); }
}
function toPending() { const e = deploy(); expectOk('fund', e, 'buyer', 'depositToEscrow'); expectOk('open review', e, 'seller', 'openContingencyReview'); return e; }

const check = (label, cond) => { if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}`); } };

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
let e = toPending();
expectErr('rando submits inspection', e, 'rando', 'submitInspection', true);
expectOk('inspection pass', e, 'inspector', 'submitInspection', true);
expectErr('inspector overwrites', e, 'inspector', 'submitInspection', false);
expectOk('financing ok', e, 'lender', 'submitFinancing', true);
expectOk('title ok', e, 'title', 'submitTitle', true);
console.log('   status:', st(e));
console.log('   (releaseToSeller needs a real unshielded balance; the simulator holds none:)', ok(e, 'seller', 'releaseToSeller') === true ? 'released' : 'balance check enforced');

console.log('Resolver cannot flip a FAILED inspection into a seller payout');
e = toPending();
expectOk('inspection FAIL', e, 'inspector', 'submitInspection', false);
expectOk('financing ok', e, 'lender', 'submitFinancing', true);
expectOk('title ok', e, 'title', 'submitTitle', true);
expectOk('seller disputes', e, 'seller', 'openDispute');
expectErr('resolver settles to seller', e, 'resolver', 'resolveDisputeSettlement');
expectErr('attestor submits while disputed', e, 'inspector', 'submitInspection', true);
expectOk('resolver voids inspection', e, 'resolver', 'voidContingencyResult', Contingency.Inspection);
expectErr('resolver submits value itself', e, 'resolver', 'submitInspection', true);
expectOk('original inspector re-attests', e, 'inspector', 'submitInspection', true);
console.log('   status:', st(e), 'corrections:', ledger(e.state.data ?? e.state).correctionCount);

console.log('Buyer waiver / cancellation');
e = toPending();
expectOk('title FAIL', e, 'title', 'submitTitle', false);
expectErr('seller waives', e, 'seller', 'waiveContingency', Contingency.Title);
expectOk('buyer cancelAndRefund', e, 'buyer', 'cancelAndRefund');
e = toPending();
expectOk('title FAIL', e, 'title', 'submitTitle', false);
expectOk('buyer waives title', e, 'buyer', 'waiveContingency', Contingency.Title);
expectOk('buyer waives inspection (pending)', e, 'buyer', 'waiveContingency', Contingency.Inspection);
expectOk('financing ok', e, 'lender', 'submitFinancing', true);
e.state; expectOk('dispute', e, 'buyer', 'openDispute');
expectErr('resolver voids waived title', e, 'resolver', 'voidContingencyResult', Contingency.Title);
expectOk('resolver dismisses', e, 'resolver', 'dismissDispute');

console.log('Expiry is time-gated');
e = toPending();
expectErr('expire before deadline', e, 'rando', 'expireEscrow');
e.time = DL + 1; expectOk('expire after deadline', e, 'rando', 'expireEscrow');
expectErr('rando refunds', e, 'rando', 'refundBuyer');
e = toPending(); expectOk('dispute', e, 'buyer', 'openDispute');
e.time = DL + 1; expectErr('expire disputed before dispute deadline', e, 'rando', 'expireEscrow');
e.time = DDL; expectOk('expire disputed after dispute deadline', e, 'rando', 'expireEscrow');
e = deploy(); e.time = DL; expectErr('fund after deadline', e, 'buyer', 'depositToEscrow');

console.log('Back-outs');
e = deploy(); expectErr('rando cancels', e, 'rando', 'cancelBeforeFunding'); expectOk('seller cancels before funding', e, 'seller', 'cancelBeforeFunding');
expectErr('fund cancelled', e, 'buyer', 'depositToEscrow');
e = toPending(); expectErr('buyer sellerWithdraw', e, 'buyer', 'sellerWithdraw'); expectOk('seller withdraws', e, 'seller', 'sellerWithdraw');
expectErr('buyer cancel without failure', toPending(), 'buyer', 'cancelAndRefund');

console.log('Delayed initialization');
const ATTRS = Object.keys(InitAttribute).filter((k) => isNaN(k));
const missing = (e) => ATTRS.filter((a) => !L(e).configured.member(InitAttribute[a]));
e = deployRaw(emptyTerms(), K.admin, false);
console.log('   status:', st(e), '| missing:', missing(e).join(','));
expectErr('fund while Initializing', e, 'buyer', 'depositToEscrow');
expectErr('accept incomplete config', e, 'buyer', 'acceptConfiguration', 0n);
expectErr('finalize incomplete', e, 'admin', 'finalizeInitialization');
let t = emptyTerms(); t[0] = some(id(K.inspector)); t[6] = some(1000n); t[3] = some(id(K.resolver));
expectErr('seller (not admin) configures', e, 'seller', 'configure', ...t);
expectOk('admin sets inspector, resolver, amount', e, 'admin', 'configure', ...t);
console.log('   missing now:', missing(e).join(','));
t = emptyTerms(); t[6] = some(0n); expectErr('admin sets amount 0', e, 'admin', 'configure', ...t);
t = fullTerms(); t[0] = some(id(K.seller)); expectOk('admin sets remaining (seller as inspector!)', e, 'admin', 'configure', ...t);
console.log('   missing now:', missing(e).join(',') || '(none)');
expectErr('admin adds identity-point issuer', e, 'admin', 'addKycIssuer', CASP.id, rt.ecMulGenerator(0n));
expectErr('seller adds issuer', e, 'seller', 'addKycIssuer', CASP.id, CASP.pk);
expectOk('admin adds CASP issuer', e, 'admin', 'addKycIssuer', CASP.id, CASP.pk);
console.log('   missing now:', missing(e).join(',') || '(none)', '| version', L(e).configVersion);
let v = L(e).configVersion;
expectOk('buyer accepts v' + v, e, 'buyer', 'acceptConfiguration', v);
expectOk('seller accepts v' + v, e, 'seller', 'acceptConfiguration', v);
expectErr('finalize with seller as inspector', e, 'admin', 'finalizeInitialization');
t = emptyTerms(); t[0] = some(id(K.inspector)); expectOk('admin fixes inspector', e, 'admin', 'configure', ...t);
console.log('   acceptances reset:', L(e).buyerAccepted, L(e).sellerAccepted);
expectErr('buyer accepts stale version', e, 'buyer', 'acceptConfiguration', v);
v = L(e).configVersion;
expectErr('rando accepts', e, 'rando', 'acceptConfiguration', v);
expectOk('buyer accepts', e, 'buyer', 'acceptConfiguration', v);
expectErr('finalize without seller acceptance', e, 'admin', 'finalizeInitialization');
expectOk('seller accepts', e, 'seller', 'acceptConfiguration', v);
expectErr('non-admin finalizes', e, 'buyer', 'finalizeInitialization');
expectOk('admin removes CASP issuer', e, 'admin', 'removeKycIssuer', CASP.id);
console.log('   missing now:', missing(e).join(','), '| acceptances', L(e).buyerAccepted, L(e).sellerAccepted);
expectErr('finalize without KYC issuer', e, 'admin', 'finalizeInitialization');
expectOk('admin re-adds CASP issuer', e, 'admin', 'addKycIssuer', CASP.id, CASP.pk);
v = L(e).configVersion; call(e, 'buyer', 'acceptConfiguration', v); call(e, 'seller', 'acceptConfiguration', v);
expectOk('admin finalizes', e, 'admin', 'finalizeInitialization');
expectErr('admin adds issuer after finalize', e, 'admin', 'addKycIssuer', ROGUE.id, ROGUE.pk);
expectErr('admin configures after finalize', e, 'admin', 'configure', ...fullTerms());
expectErr('admin cancels after finalize', e, 'admin', 'cancelBeforeFunding');
expectOk('buyer funds', e, 'buyer', 'depositToEscrow');
e = deployRaw(emptyTerms(), K.admin); expectOk('admin abandons during init', e, 'admin', 'cancelBeforeFunding');
e = deployRaw(fullTerms(), K.admin); v = L(e).configVersion; call(e,'buyer','acceptConfiguration',v); call(e,'seller','acceptConfiguration',v);
e.time = DL; expectErr('finalize with past closing deadline', e, 'admin', 'finalizeInitialization');

console.log('KYC gate on deposit');
const fresh = () => deploy();
const tryDeposit = (label, att, signer, issuer, ok = false) => { setKyc(att, signer, issuer); const e = fresh(); (ok ? expectOk : expectErr)(label, e, 'buyer', 'depositToEscrow'); return e; };
tryDeposit('rogue (non-whitelisted) CASP', goodAtt(), ROGUE, ROGUE.id);
tryDeposit('rogue key claiming trusted issuer id', goodAtt(), ROGUE, CASP.id);
{ setKyc(goodAtt()); KYC = [{ ...KYC[0], amlRiskScore: 5n }, KYC[1], KYC[2]]; const e = fresh(); expectErr('tampered claims (risk score)', e, 'buyer', 'depositToEscrow'); }
tryDeposit('attestation for another subject', goodAtt({ subject: id(K.rando) }), CASP, CASP.id);
tryDeposit('different wallet', goodAtt({ wallet: addr(9) }), CASP, CASP.id);
tryDeposit('expired attestation', goodAtt({ validUntil: BigInt(T0) }), CASP, CASP.id);
tryDeposit('KYC level too low', goodAtt({ kycLevel: 1n }), CASP, CASP.id);
tryDeposit('AML risk too high', goodAtt({ amlRiskScore: 31n }), CASP, CASP.id);
{ const e = tryDeposit('valid attestation', goodAtt(), CASP, CASP.id, true);
  const l = L(e); console.log('   buyerKycVerified', l.buyerKycVerified, '| ref == kycReference(att):',
    Buffer.from(l.buyerKycRef).equals(Buffer.from(pureCircuits.kycReference(goodAtt()))), '| ticker', l.escrowTicker); }
setKyc(goodAtt());

const expectErrMsg = (label, env, who, circuit, needle, ...args) => {
  const r = ok(env, who, circuit, ...args);
  if (r !== true && String(r).includes(needle)) { pass++; console.log(`  ok   ${label}: ${needle}`); }
  else { fail++; console.log(`  FAIL ${label}: expected "${needle}", got ${r === true ? 'success' : String(r).split('\n')[0]}`); }
};
// Simulator holds no unshielded balance, so a payout that passes every KYC gate stops at the balance check.
const BAL = 'Escrow balance is insufficient';
const readyToClose = () => { setKyc(goodAtt()); const e = toPending(); call(e, 'inspector', 'submitInspection', true); call(e, 'lender', 'submitFinancing', true); call(e, 'title', 'submitTitle', true); return e; };

console.log('Travel Rule anchor');
{ setKyc(goodAtt()); const e = deploy(); call(e, 'buyer', 'depositToEscrow');
  check('buyerTravelRuleRef recorded at deposit', Buffer.from(L(e).buyerTravelRuleRef).equals(Buffer.from(goodAtt().travelRuleRef))); }

console.log('Seller KYC before payout');
e = readyToClose();
console.log('   status:', st(e));
expectErrMsg('release without seller KYC', e, 'seller', 'releaseToSeller', 'ERROR_SELLER_KYC_REQUIRED');
setKyc(sellerAtt());
expectErr('buyer submits seller KYC', e, 'buyer', 'submitSellerKyc');
setKyc(goodAtt());
expectErr('seller submits the BUYER attestation', e, 'seller', 'submitSellerKyc');
setKyc(sellerAtt({ wallet: addr(9) }));
expectErr('seller attestation for another wallet', e, 'seller', 'submitSellerKyc');
setKyc(sellerAtt());
expectOk('seller submits valid KYC', e, 'seller', 'submitSellerKyc');
check('sellerTravelRuleRef recorded', Buffer.from(L(e).sellerTravelRuleRef).equals(Buffer.from(sellerAtt().travelRuleRef)));
expectErrMsg('release passes KYC gates (stops at balance)', e, 'seller', 'releaseToSeller', BAL);
{ const e2 = { ...e }; e2.time = Number(sellerAtt().validUntil);
  expectErrMsg('release after seller attestation expired', e2, 'seller', 'releaseToSeller', 'ERROR_KYC_EXPIRED'); }
expectErr('expire Ready escrow before dispute deadline', e, 'rando', 'expireEscrow');
{ const e2 = { ...e }; e2.time = DDL; expectErr('expire Ready escrow with valid seller KYC', e2, 'rando', 'expireEscrow'); }
{ const e3 = readyToClose(); e3.time = DDL; expectOk('expire Ready escrow when seller never did KYC', e3, 'rando', 'expireEscrow'); }

console.log('CASP-signed revocation');
const sellerRef = pureCircuits.kycReference(sellerAtt());
expectErr('revocation signed by rogue key', e, 'rando', 'revokeKycAttestation', CASP.id, sellerRef, ROGUE.revokeAttestation(sellerRef));
expectErr('attestation signature replayed as revocation', e, 'rando', 'revokeKycAttestation', CASP.id, sellerRef, CASP.sign(sellerAtt()));
expectOk('anyone submits CASP revocation of seller attestation', e, 'rando', 'revokeKycAttestation', CASP.id, sellerRef, CASP.revokeAttestation(sellerRef));
expectErrMsg('release after revocation', e, 'seller', 'releaseToSeller', 'ERROR_KYC_REVOKED');
setKyc(sellerAtt());
expectErrMsg('re-submit the revoked attestation', e, 'seller', 'submitSellerKyc', 'ERROR_KYC_REVOKED');
setKyc(sellerAtt({ salt: new Uint8Array(32).fill(3) }));
expectOk('seller submits a renewed attestation', e, 'seller', 'submitSellerKyc');
expectErrMsg('release passes again (stops at balance)', e, 'seller', 'releaseToSeller', BAL);
{ const ref = pureCircuits.kycReference(goodAtt()); const e4 = deploy();
  call(e4, 'rando', 'revokeKycAttestation', CASP.id, ref, CASP.revokeAttestation(ref));
  setKyc(goodAtt()); expectErrMsg('deposit with revoked buyer attestation', e4, 'buyer', 'depositToEscrow', 'ERROR_KYC_REVOKED'); }

console.log('CASP withdraws its own key');
expectErr('issuer revocation signed by rogue key', e, 'rando', 'revokeKycIssuer', CASP.id, ROGUE.revokeIssuer(CASP.id));
expectErr('attestation revocation replayed as issuer revocation', e, 'rando', 'revokeKycIssuer', CASP.id, CASP.revokeAttestation(CASP.id));
expectOk('anyone submits CASP self-revocation', e, 'rando', 'revokeKycIssuer', CASP.id, CASP.revokeIssuer(CASP.id));
check('issuer removed from whitelist', !L(e).kycIssuers.member(CASP.id));
expectErrMsg('release after issuer revoked', e, 'seller', 'releaseToSeller', 'seller KYC issuer was revoked');
setKyc(sellerAtt({ salt: new Uint8Array(32).fill(3) }));
expectErrMsg('seller KYC from revoked issuer', e, 'seller', 'submitSellerKyc', 'issuer is not a trusted CASP');
{ const e5 = { ...e }; e5.time = DDL; expectOk('expire after dispute deadline (no usable seller KYC)', e5, 'rando', 'expireEscrow'); }
setKyc(goodAtt());

console.log('Constructor guards');
for (const [lbl, a, b, sl] of [['admin == buyer', K.buyer, K.buyer, K.seller], ['buyer == seller', K.admin, K.buyer, K.buyer]]) {
  try { c.initialState(rt.createConstructorContext({ sk: K.buyer }, CPK), id(a), id(b), id(sl), sk(77), 'EMT', ...emptyTerms()); fail++; console.log('  FAIL', lbl); }
  catch (er) { pass++; console.log('  ok  ', lbl, 'rejected'); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
