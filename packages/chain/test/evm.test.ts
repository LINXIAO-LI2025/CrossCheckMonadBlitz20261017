import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { hashContent, hashPayload } from '@crosscheck/protocol';
import type { AnchorInput, PublicConfig, ReportPayload } from '@crosscheck/protocol';
import { createChainWriter } from '../src/server.js';
import { readCertificate, readCertificateByTransaction } from '../src/browser.js';
import { resolveConfig } from '../src/core.js';

const require = createRequire(import.meta.url);
const solc = require('solc') as { compile(input: string): string };
const payload = (id: number): ReportPayload => ({
  schema_version: '1', job_id: `integration-${id}`, mode: 'live', raw_text: ` 原文 ${id}\n`,
  submitted_at: '2026-10-17T00:00:00.000Z', completed_at: '2026-10-17T00:00:01.000Z',
  rule_version: 'test-v1', prompt_hash: hashContent('test-rule'), model_config_hash: hashContent('fixed-test-adapter'),
  models: ['a', 'b'].map(slot => ({ slot, provider: 'fixed-test-adapter', requested_model: 'test-v1', returned_model: 'test-v1', status: 'succeeded', verdict: 'questionable', reason: '测试样本，无真实模型请求', error_code: null })) as ReportPayload['models'],
  agreement: 0,
});
const input = (id: number): AnchorInput => {
  const report = payload(id);
  return { job_id: report.job_id, content_hash: hashContent(report.raw_text), verdict_hash: hashPayload(report), agreement: report.agreement };
};

test('snake_case A/B chain integration with a real isolated EVM', { timeout: 30000 }, async t => {
  const source = await readFile(new URL('../../../CrossCheck.sol', import.meta.url), 'utf8');
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'CrossCheck.sol': { content: source } }, settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  assert.deepEqual((compiled.errors ?? []).filter((error: any) => error.severity === 'error'), []);
  const artifact = compiled.contracts['CrossCheck.sol'].CrossCheck;
  const evm = ganache.server({ chain: { chainId: 31337, hardfork: 'shanghai' }, wallet: { totalAccounts: 2, defaultBalance: 100 }, logging: { quiet: true } });
  await evm.listen(0, '127.0.0.1');
  const address = evm.address(); assert(address && typeof address !== 'string');
  const rpc_url = `http://127.0.0.1:${address.port}`;
  const provider = new ethers.JsonRpcProvider(rpc_url, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 100;
  t.after(async () => { provider.destroy(); await evm.close(); });
  const accounts = Object.values(evm.provider.getInitialAccounts());
  const owner = new ethers.Wallet(accounts[0].secretKey, provider);
  const outsider = new ethers.Wallet(accounts[1].secretKey, provider);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, owner);
  const deployed = await factory.deploy(); await deployed.waitForDeployment();
  const contractAddress = await deployed.getAddress();
  const deploymentReceipt = await deployed.deploymentTransaction()!.wait(); assert(deploymentReceipt);
  const deployment = { chainId: 31337, contract: contractAddress, issuer: owner.address, abi: artifact.abi, deploymentBlock: String(deploymentReceipt.blockNumber) };
  const public_config: PublicConfig = { mode: 'live', public_origin: null, chain_id: 31337, contract_address: contractAddress, issuer: owner.address, deployment_block: deployment.deploymentBlock, explorer_tx_base_url: null };
  const options = { rpc_url, private_key: accounts[0].secretKey, deployment, public_config, chainMode: 'local' as const };
  const readerConfig = { ...public_config, rpc_url, chainMode: 'local' as const };
  const writer = createChainWriter(options);
  t.after(() => writer.close());
  const contract = new ethers.Contract(contractAddress, artifact.abi, owner);
  const hashes: string[] = [];
  const onBroadcast = async (hash: string) => { hashes.push(hash); };

  await t.test('guards missing config, forbidden chains, inconsistent public config and wallet', () => {
    assert.equal(createChainWriter({}).configured, false);
    assert.equal(writer.configured, true);
    assert.throws(() => createChainWriter({ ...options, chainMode: undefined }), (error: any) => error.code === 'CHAIN_ID_MISMATCH');
    assert.throws(() => createChainWriter({ ...options, deployment: { ...deployment, chainId: 103123 } }), (error: any) => error.code === 'CHAIN_ID_MISMATCH');
    assert.throws(() => createChainWriter({ ...options, public_config: { ...public_config, issuer: outsider.address } }), (error: any) => error.code === 'RECORD_MISMATCH');
    assert.throws(() => createChainWriter({ ...options, private_key: accounts[1].secretKey }), (error: any) => error.code === 'RECORD_MISMATCH');
    assert.throws(() => resolveConfig({ ...readerConfig, rpc_url: 'https://example.invalid' }), (error: any) => error.code === 'CHAIN_ID_MISMATCH');
  });

  await t.test('concurrent anchors serialize nonces and recover by tx without certificate ID', async () => {
    const proofs = await Promise.all([1, 2, 3].map(id => writer.anchor(input(id), onBroadcast)));
    assert.deepEqual(proofs.map(proof => proof.certificate_id), ['1', '2', '3']);
    assert.equal(new Set(hashes).size, 3);
    const nonces = await Promise.all(hashes.map(async hash => (await provider.getTransaction(hash))!.nonce));
    assert.deepEqual(nonces, [1, 2, 3]);
    const record = await writer.recover(hashes[1], input(2));
    assert(record); assert.deepEqual(record.proof, proofs[1]);
    assert.deepEqual(record.content_hash, input(2).content_hash);
    assert.deepEqual((await readCertificateByTransaction(hashes[1], '2', readerConfig)).proof, proofs[1]);
    assert.deepEqual((await readCertificate('2', readerConfig)).proof, proofs[1]);
    assert.equal(await writer.recover('0x' + 'f'.repeat(64), input(2)), null);
    assert.equal(await contract.certificateCount(), 3n);
  });

  await t.test('recovery rejects changed hashes/agreement and reader rejects wrong ID', async () => {
    const reasonTampered = payload(1);
    reasonTampered.models[0].reason = '被替换的模型理由';
    for (const tamper of [{ content_hash: hashContent(payload(1).raw_text.trim()) }, { verdict_hash: hashPayload(reasonTampered) }, { agreement: 1 as const }]) {
      await assert.rejects(writer.recover(hashes[0], { ...input(1), ...tamper }), (error: any) => error.code === 'RECORD_MISMATCH' && error.tx_hash === hashes[0]);
    }
    await assert.rejects(readCertificateByTransaction(hashes[0], '9', readerConfig), (error: any) => error.code === 'RECORD_MISMATCH');
    assert.equal(await contract.certificateCount(), 3n);
  });

  await t.test('confirmation timeout preserves tx hash; recovery only reads until enough confirmations', async () => {
    const strictWriter = createChainWriter({ ...options, confirmations: 2, confirmation_timeout_ms: 200 });
    t.after(() => strictWriter.close());
    let pending: string | undefined;
    await assert.rejects(strictWriter.anchor(input(4), async hash => { pending = hash; }), (error: any) => error.code === 'CONFIRMATION_TIMEOUT' && error.tx_hash === pending);
    assert(pending);
    assert.equal(await strictWriter.recover(pending, input(4)), null);
    const before = await contract.certificateCount();
    await provider.send('evm_mine', []);
    const recovered = await strictWriter.recover(pending, input(4));
    assert(recovered); assert.equal(recovered.proof.certificate_id, '4');
    assert.equal(await contract.certificateCount(), before);
  });

  await t.test('wrong deployment/issuer targets, actual wrong chain and reverted transactions cannot certify', async () => {
    const pendingNonce = async () => Number(BigInt(await provider.send('eth_getTransactionCount', [owner.address, 'pending'])));
    const other = await factory.deploy({ nonce: await pendingNonce() }); await other.waitForDeployment();
    const otherContract = new ethers.Contract(await other.getAddress(), artifact.abi, owner);
    const wrongTarget = await otherContract.certify(input(5).content_hash, input(5).verdict_hash, 0, { nonce: await pendingNonce() }); await wrongTarget.wait();
    await assert.rejects(writer.recover(wrongTarget.hash, input(5)), (error: any) => error.code === 'RECORD_MISMATCH');
    await assert.rejects(readCertificateByTransaction(hashes[0], '1', { ...readerConfig, contract_address: outsider.address }), (error: any) => error.code === 'RECORD_MISMATCH');
    const wrongChain = createChainWriter({ ...options, chainMode: undefined, deployment: { ...deployment, chainId: 10143 }, public_config: { ...public_config, chain_id: 10143 } });
    t.after(() => wrongChain.close());
    await assert.rejects(wrongChain.recover(hashes[0], input(1)), (error: any) => error.code === 'CHAIN_ID_MISMATCH');
    const reverted = await outsider.sendTransaction({ to: contractAddress, data: contract.interface.encodeFunctionData('certify', [input(6).content_hash, input(6).verdict_hash, 0]), gasLimit: 100000 });
    await assert.rejects(reverted.wait());
    await assert.rejects(writer.recover(reverted.hash, input(6)), (error: any) => error.code === 'TRANSACTION_REVERTED');
    const rotated = await contract.transferIssuer(outsider.address, { nonce: await pendingNonce() }); await rotated.wait();
    const outsiderContract = contract.connect(outsider) as ethers.Contract;
    const validNewIssuer = await outsiderContract.certify(input(7).content_hash, input(7).verdict_hash, 0); await validNewIssuer.wait();
    await assert.rejects(writer.recover(validNewIssuer.hash, input(7)), (error: any) => error.code === 'RECORD_MISMATCH');
    await assert.rejects(writer.anchor(input(8), onBroadcast), (error: any) => error.code === 'RECORD_MISMATCH');
    assert((await writer.recover(hashes[0], input(1)))?.proof.issuer === owner.address);
  });
});
