import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { createChainWriter } from '../chain-writer';
import { readCertificateByTransaction } from '../chain-reader';
import { compareCertificate, computeHashes, hashContent } from '../protocol';
import type { ChainProof, ReportEnvelope, ReportPayload } from '../types';

const require = createRequire(import.meta.url);
const solc = require('solc') as { compile(input: string): string };

/** An isolated random-wallet EVM: no .env, saved wallet or external RPC is read. */
test('real EVM authorization, queued writes, receipt verification and tamper detection', { timeout: 30000 }, async t => {
  const source = await readFile(new URL('../CrossCheck.sol', import.meta.url), 'utf8');
  const compiled = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { 'CrossCheck.sol': { content: source } },
    settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  })));
  assert.deepEqual((compiled.errors ?? []).filter((error: any) => error.severity === 'error'), []);
  const artifact = compiled.contracts['CrossCheck.sol'].CrossCheck;
  const evm = ganache.server({
    chain: { chainId: 31337, networkId: 31337, hardfork: 'shanghai' },
    wallet: { totalAccounts: 2, defaultBalance: 100 }, logging: { quiet: true },
  });
  await evm.listen(0, '127.0.0.1');
  const address = evm.address();
  assert(address && typeof address !== 'string');
  const rpcUrl = `http://127.0.0.1:${address.port}`;
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 100;
  t.after(async () => { provider.destroy(); await evm.close(); });
  const accounts = Object.values(evm.provider.getInitialAccounts());
  const owner = new ethers.Wallet(accounts[0].secretKey, provider);
  const outsider = new ethers.Wallet(accounts[1].secretKey, provider);
  const deployed = await new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, owner).deploy();
  await deployed.waitForDeployment();
  const contractAddress = await deployed.getAddress();
  const contract = new ethers.Contract(contractAddress, artifact.abi, owner);
  const foreignContract = contract.connect(outsider) as ethers.Contract;
  const config = { rpcUrl, contractAddress, issuerAddress: owner.address, chainId: 31337, chainMode: 'local' as const };
  const writer = createChainWriter({ ...config, privateKey: accounts[0].secretKey });
  t.after(() => writer.close());

  const payloads: ReportPayload[] = [1, 2, 3].map(index => ({
    schema_version: '1', job_id: `real-evm-${index}`, mode: 'demo', raw_text: `  第${index}份原文\n`,
    submitted_at: '2026-10-17T00:00:00.000Z', completed_at: '2026-10-17T00:00:01.000Z',
    rule_version: 'test-v1', prompt_hash: hashContent('test-prompt'), model_config_hash: hashContent('fixed-demo'),
    models: ['a', 'b'].map(slot => ({ slot, provider: 'fixed-demo', requested_model: 'fixed-v1', returned_model: 'fixed-v1', status: 'succeeded', verdict: 'questionable', reason: '固定演示，不代表真实模型审核', error_code: null })) as ReportPayload['models'],
    agreement: 0,
  }));
  const broadcasts: string[] = [];
  const anchor = (payload: ReportPayload) => writer.anchor({ job_id: payload.job_id, ...computeHashes(payload), agreement: payload.agreement }, async hash => { broadcasts.push(hash); });
  let proofs: ChainProof[] = [];

  await t.test('only issuer can certify or rotate issuer; invalid agreement reverts', async () => {
    const hashes = computeHashes(payloads[0]);
    await assert.rejects(foreignContract.certify(hashes.content_hash, hashes.verdict_hash, 0));
    await assert.rejects(foreignContract.transferIssuer(outsider.address));
    await assert.rejects(contract.certify.staticCall(hashes.content_hash, hashes.verdict_hash, 3));
    await assert.rejects(contract.transferIssuer.staticCall(ethers.ZeroAddress));
    assert.equal(await contract.certificateCount(), 0n);
    assert.equal(await contract.issuer(), owner.address);
  });

  await t.test('one sequential and two concurrent anchors receive distinct correct IDs/nonces', async () => {
    const first = await anchor(payloads[0]);
    proofs = [first, ...await Promise.all(payloads.slice(1).map(anchor))];
    assert.deepEqual(proofs.map(proof => proof.certificate_id), ['1', '2', '3']);
    assert.equal(new Set(broadcasts).size, 3);
    assert.equal(await contract.certificateCount(), 3n);
    const nonces = await Promise.all(broadcasts.map(async hash => (await provider.getTransaction(hash))!.nonce));
    assert.deepEqual(nonces, [1, 2, 3]);
  });

  await t.test('transaction-path reader reproduces proof and rejects tampering/wrong identity', async () => {
    const proof = proofs[1];
    const record = await readCertificateByTransaction(proof.tx_hash, proof.certificate_id, config);
    const envelope: ReportEnvelope = { payload: payloads[1], proof };
    assert.deepEqual(record.proof, proof);
    assert.equal(compareCertificate(envelope, record).valid, true);
    const tampered = structuredClone(envelope);
    tampered.payload.models[0].reason = '替换模型审核理由';
    assert.equal(compareCertificate(tampered, record).valid, false);
    const trimmed = structuredClone(envelope);
    trimmed.payload.raw_text = trimmed.payload.raw_text.trim();
    assert.equal(compareCertificate(trimmed, record).valid, false);
    await assert.rejects(readCertificateByTransaction(proof.tx_hash, '999', config), /Certified/);
    await assert.rejects(readCertificateByTransaction(proof.tx_hash, proof.certificate_id, { ...config, issuerAddress: outsider.address }), /Certified/);
    await assert.rejects(readCertificateByTransaction(proof.tx_hash, proof.certificate_id, { ...config, contractAddress: outsider.address }), /没有部署合约/);
  });

  await t.test('issuer rotation emits its event and makes the original writer unauthorized', async () => {
    // Query the exact pending nonce because the queue used a separate Wallet instance.
    const nonce = Number(BigInt(await provider.send('eth_getTransactionCount', [owner.address, 'pending'])));
    const transaction = await contract.transferIssuer(outsider.address, { nonce });
    const receipt = await transaction.wait();
    const event = receipt.logs.map((log: ethers.Log) => { try { return contract.interface.parseLog(log); } catch { return null; } }).find((event: ethers.LogDescription | null) => event?.name === 'IssuerTransferred');
    assert(event);
    assert.equal(event.args[0], owner.address);
    assert.equal(event.args[1], outsider.address);
    assert.equal(await contract.issuer(), outsider.address);
    await assert.rejects(anchor(payloads[0]), /授权 issuer/);
    const hashes = computeHashes(payloads[0]);
    const newIssuerTransaction = await foreignContract.certify(hashes.content_hash, hashes.verdict_hash, 0);
    await newIssuerTransaction.wait();
    assert.equal(await contract.certificateCount(), 4n);
    // Historical proofs remain readable using their explicitly pinned issuer.
    const historical = await readCertificateByTransaction(proofs[0].tx_hash, '1', config);
    assert.equal(historical.proof.issuer, owner.address);
  });
});
