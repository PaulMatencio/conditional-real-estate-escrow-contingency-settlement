/** Import of an escrow's on-chain history into the transaction log: decoding, derivation, actor inference, merge. */
import * as rt from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';
import { actionName, importChainHistory, inferActor, type ChainAction } from '@/application/chainHistory';
import type { TxLogEntry } from '@/application/txLog';
import { bytesToHex, hex32ToBytes } from '@/domain/hex';
import { Contract } from '@/infrastructure/contract/module';
import { createWitnesses } from '@/infrastructure/contract/witnesses';
import { decodeStateFacts, deriveActions, type RawContractAction, type StateFacts } from '@/infrastructure/indexer/chainHistorySource';
import { maybeTermsArgs } from '@/infrastructure/simulator/escrowSimulator';
import { COLOR, K, hex, rid } from './helpers/fixtures';

const ADDR = hex(0xe5);
const call = (entryPoint: string, over: Partial<ChainAction> = {}): ChainAction => ({
  kind: 'call',
  entryPoint,
  txHash: hex(0x10),
  identifiers: ['id-1'],
  blockHeight: 10,
  blockTime: 1_700_000_000_000,
  result: 'SUCCESS',
  ...over
});

describe('actor inference', () => {
  it('names the only role allowed, else lists the possible ones', () => {
    expect(inferActor(call('depositToEscrow'))).toBe('buyer');
    expect(inferActor(call('submitInspection'))).toBe('inspector');
    expect(inferActor(call('configure'))).toBe('admin');
    expect(inferActor(call('acceptConfiguration'))).toBe('buyer|seller');
    expect(inferActor(call('acceptConfiguration', { acceptedBy: 'seller' }))).toBe('seller');
    expect(inferActor({ ...call('x'), kind: 'update' })).toBe('admin');
    expect(inferActor(call('notACircuit'))).toBe('unknown');
  });

  it('names maintenance updates from what changed', () => {
    expect(actionName({ ...call(''), kind: 'update', circuitsAdded: ['a', 'b'], circuitsRemoved: [] })).toBe('registerCircuits');
    expect(actionName({ ...call(''), kind: 'update', renounced: true })).toBe('renounceAuthority');
    expect(actionName({ ...call(''), kind: 'update' })).toBe('maintenanceUpdate');
    expect(actionName({ ...call(''), kind: 'deploy' })).toBe('deploy');
  });
});

describe('deriving actions from consecutive states', () => {
  const facts = (ops: string[], committee: number, buyer = false, seller = false): StateFacts => ({ operations: new Set(ops), committeeSize: committee, buyerAccepted: buyer, sellerAccepted: seller });
  const raw = (typename: RawContractAction['__typename'], state: string, height: number, entryPoint?: string): RawContractAction => ({
    __typename: typename,
    entryPoint,
    state,
    transaction: { hash: hex(height), block: { height, timestamp: height * 1000 }, identifiers: [`id-${height}`], fee: '12', transactionResult: { status: 'SUCCESS' } }
  });
  const states: Record<string, StateFacts> = {
    s1: facts(['configure', 'finalizeInitialization'], 1),
    s2: facts(['configure', 'finalizeInitialization'], 1, false, true),
    s3: facts(['configure', 'finalizeInitialization', 'depositToEscrow', 'releaseToSeller'], 1, false, true),
    s4: facts(['configure', 'finalizeInitialization', 'depositToEscrow', 'releaseToSeller'], 0, false, true)
  };
  const actions = deriveActions(
    [raw('ContractDeploy', 's1', 1), raw('ContractCall', 's2', 2, 'acceptConfiguration'), raw('ContractUpdate', 's3', 3), raw('ContractUpdate', 's4', 4)],
    (h) => (h ? states[h] : null)
  );

  it('reads deploy circuits, the acceptor, registered circuits and the renounce', () => {
    expect(actions[0]).toMatchObject({ kind: 'deploy', circuitsAdded: ['configure', 'finalizeInitialization'], blockTime: 1000, fee: '12', identifiers: ['id-1'] });
    expect(actions[1]).toMatchObject({ kind: 'call', entryPoint: 'acceptConfiguration', acceptedBy: 'seller' });
    expect(actions[2]).toMatchObject({ kind: 'update', circuitsAdded: ['depositToEscrow', 'releaseToSeller'], circuitsRemoved: [], renounced: false });
    expect(actions[3]).toMatchObject({ kind: 'update', circuitsAdded: [], renounced: true });
    expect(actions.map(actionName)).toEqual(['deploy', 'acceptConfiguration', 'registerCircuits', 'renounceAuthority']);
  });

  it('decodes a real contract state with the contract runtime', async () => {
    const c = new Contract<undefined>(createWitnesses({ secretKey: () => K.admin }));
    const r = await (c.initialState as unknown as (...a: unknown[]) => Promise<{ currentContractState: rt.ContractState }>)(
      rt.createConstructorContext(undefined, '00'.repeat(32)),
      hex32ToBytes(rid(K.admin)),
      hex32ToBytes(rid(K.buyer)),
      hex32ToBytes(rid(K.seller)),
      hex32ToBytes(COLOR),
      'EURe',
      ...maybeTermsArgs({})
    );
    const f = decodeStateFacts(bytesToHex(r.currentContractState.serialize()));
    expect(f).not.toBeNull();
    expect(f!.operations.has('depositToEscrow')).toBe(true);
    expect(f).toMatchObject({ buyerAccepted: false, sellerAccepted: false });
    expect(decodeStateFacts('zz')).toBeNull();
  });
});

describe('merging into the log', () => {
  const local = (over: Partial<TxLogEntry>): TxLogEntry => ({
    id: 'local-1',
    session: 'old',
    at: 1,
    updatedAt: 1,
    mode: 'wallet',
    network: 'preview',
    contractAddress: ADDR,
    actor: 'buyer',
    action: 'depositToEscrow',
    status: 'pending',
    ...over
  });

  it('completes a matching local entry and adds the others, idempotently', () => {
    const log = [local({ txId: 'id-1' }), local({ id: 'other', contractAddress: hex(0x99), txHash: hex(0x11) })];
    const chain = [
      call('depositToEscrow', { fee: '42' }),
      call('releaseToSeller', { txHash: hex(0x11), identifiers: ['id-2'], blockHeight: 12, blockTime: 2_000 }),
      call('openDispute', { txHash: hex(0x12), identifiers: ['id-3'], result: 'FAILURE' })
    ];
    const r = importChainHistory(log, chain, { contractAddress: ADDR, network: 'preview', now: 5 });
    expect(r).toMatchObject({ added: 2, matched: 1 });
    const mine = r.entries.find((e) => e.id === 'local-1')!;
    expect(mine).toMatchObject({ source: 'both', status: 'confirmed', txHash: hex(0x10), blockHeight: 10, fee: '42', actor: 'buyer' });
    // Same hash but another contract: not matched.
    expect(r.entries.find((e) => e.id === 'other')!.source).toBeUndefined();
    const release = r.entries.find((e) => e.action === 'releaseToSeller')!;
    expect(release).toMatchObject({ source: 'chain', actor: 'buyer|seller|resolver', at: 2_000, status: 'confirmed', session: 'chain', mode: 'wallet' });
    expect(r.entries.find((e) => e.action === 'openDispute')).toMatchObject({ status: 'failed', error: 'Rejected on-chain.', actor: 'buyer|seller' });

    const again = importChainHistory(r.entries, chain, { contractAddress: ADDR, network: 'preview', now: 6 });
    expect(again).toMatchObject({ added: 0, matched: 1 });
    expect(again.entries).toHaveLength(r.entries.length);
  });

  it('turns an interrupted local attempt into its real outcome', () => {
    const r = importChainHistory([local({ txHash: hex(0x10), session: 'crashed' })], [call('depositToEscrow', { result: 'PARTIAL_SUCCESS' })], { contractAddress: ADDR, network: 'preview' });
    expect(r.entries[0]).toMatchObject({ status: 'failed', source: 'both' });
    expect(r.entries[0].error).toMatch(/Partially applied/);
  });
});
