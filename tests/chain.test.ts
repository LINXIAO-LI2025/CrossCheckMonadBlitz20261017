import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';
import { assertExpectedNetwork, certificateFromReceipt, CROSSCHECK_ABI, expectedChainId, readCertificate } from '../chain-reader';
import { createChainWriter } from '../chain-writer';

const contractAddress = '0x1111111111111111111111111111111111111111';
const issuerAddress = '0x2222222222222222222222222222222222222222';
const contentHash = '0x' + 'a'.repeat(64);
const verdictHash = '0x' + 'b'.repeat(64);
const iface = new ethers.Interface(CROSSCHECK_ABI);
const log = (address = contractAddress, issuer = issuerAddress, id = 1n, time = 123n) => ({ address, ...iface.encodeEventLog(iface.getEvent('Certified')!, [id, issuer, contentHash, verdictHash, 0, time]) });
const receipt = (logs = [log()]) => ({ status: 1, hash: '0x' + 'c'.repeat(64), blockNumber: 2, logs });
const expected = { contractAddress, issuerAddress, chainId: 31337, id: '1', contentHash, verdictHash, agreement: 0 as const };

test('default chain guard permits only Monad testnet or explicitly selected local chain', async () => {
  assert.equal(expectedChainId({ rpcUrl: 'https://example.invalid' }), 10143);
  assert.equal(expectedChainId({ rpcUrl: 'http://127.0.0.1:8545', chainMode: 'local' }), 31337);
  assert.throws(() => expectedChainId({ rpcUrl: 'https://example.invalid', chainId: 1 }));
  assert.throws(() => expectedChainId({ rpcUrl: 'https://example.invalid', chainId: 31337 }));
  assert.throws(() => expectedChainId({ rpcUrl: 'https://example.invalid', chainId: 31337, chainMode: 'local' }));
  const fakeProvider = { send: async () => '0x1' } as unknown as ethers.JsonRpcProvider;
  await assert.rejects(assertExpectedNetwork(fakeProvider, { rpcUrl: 'https://example.invalid', contractAddress }), /ID/);
});

test('receipt parser ignores same-signature events emitted by another contract', () => {
  const other = '0x3333333333333333333333333333333333333333';
  assert.throws(() => certificateFromReceipt(receipt([log(other)]), expected, 123));
  const verified = certificateFromReceipt(receipt([log(other), log()]), expected, 123);
  assert.equal(verified.proof.certificate_id, '1');
  assert.equal(verified.proof.chain_id, 31337);
  assert.equal(verified.proof.contract_address, contractAddress);
});

test('receipt parser binds issuer, certificate id, both hashes and agreement', () => {
  assert.throws(() => certificateFromReceipt(receipt([log(contractAddress, '0x3333333333333333333333333333333333333333')]), expected, 123));
  assert.throws(() => certificateFromReceipt(receipt([log(contractAddress, issuerAddress, 2n)]), expected, 123));
  for (const change of [{ contentHash: verdictHash }, { verdictHash: contentHash }, { agreement: 1 as const }]) assert.throws(() => certificateFromReceipt(receipt(), { ...expected, ...change }, 123));
  assert.throws(() => certificateFromReceipt(receipt([log(), log()]), expected, 123));
  assert.throws(() => certificateFromReceipt({ ...receipt(), status: 0 }, expected, 123));
  assert.throws(() => certificateFromReceipt(receipt([log(contractAddress, issuerAddress, 1n, 124n)]), expected, 123));
});

test('reader refuses unbounded full-chain scans and writer refuses mainnet config', async () => {
  await assert.rejects(readCertificate('1', { rpcUrl: 'http://127.0.0.1:1', contractAddress }), /部署区块/);
  assert.throws(() => createChainWriter({ rpcUrl: 'http://127.0.0.1:1', privateKey: 'not-a-key', contractAddress, chainId: 1 }));
});
