import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import test from 'node:test';
import ganache from 'ganache';
import { ethers } from 'ethers';
import { hashContent, hashPayload, validateReportEnvelope } from '@crosscheck/protocol';
import type { ModelResult, ReportEnvelope } from '@crosscheck/protocol';
import type { ModelAdapter } from '../apps/server/src/adapters.js';
import { createApp } from '../apps/server/src/app.js';
import { createGateway } from '../apps/server/src/chain.js';
import { loadConfig } from '../apps/server/src/config.js';
import { JobService } from '../apps/server/src/service.js';
import { JobStore } from '../apps/server/src/store.js';

const require = createRequire(import.meta.url);
const solc = require('solc') as { compile(input: string): string };

/** End-to-end integration only: loopback chain 10143, ephemeral wallet and explicit test models. */
test('A HTTP/service → real gateway/EVM → verified downloads and fresh reads after restart', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'crosscheck-a-b-evm-'));
  const source = await readFile(new URL('../CrossCheck.sol', import.meta.url), 'utf8');
  const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'CrossCheck.sol': { content: source } }, settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
  assert.deepEqual((compiled.errors ?? []).filter((error: any) => error.severity === 'error'), []);
  const artifact = compiled.contracts['CrossCheck.sol'].CrossCheck;
  const evm = ganache.server({ chain: { chainId: 10143, networkId: 10143, hardfork: 'shanghai' }, wallet: { totalAccounts: 1, defaultBalance: 100 }, logging: { quiet: true } });
  await evm.listen(0, '127.0.0.1');
  const evmAddress = evm.address(); assert(evmAddress && typeof evmAddress !== 'string');
  const rpc_url = `http://127.0.0.1:${evmAddress.port}`;
  const provider = new ethers.JsonRpcProvider(rpc_url, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 100;
  let closeServices: () => Promise<void> = async () => {};
  t.after(async () => {
    try { await closeServices(); }
    finally { provider.destroy(); await evm.close(); await rm(directory, { recursive: true, force: true }); }
  });
  const initial = Object.values(evm.provider.getInitialAccounts())[0];
  const owner = new ethers.Wallet(initial.secretKey, provider);
  const deployed = await new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, owner).deploy();
  await deployed.waitForDeployment();
  const contract_address = await deployed.getAddress();
  const deploymentReceipt = await deployed.deploymentTransaction()!.wait(); assert(deploymentReceipt);
  const deploymentPath = join(directory, 'ephemeral-deployment.json');
  await writeFile(deploymentPath, JSON.stringify({ chainId: 10143, contract: contract_address, issuer: owner.address, abi: artifact.abi, deploymentBlock: String(deploymentReceipt.blockNumber) }));
  const snapshot = await provider.send('evm_snapshot', []);
  const config = await loadConfig({
    MODE: 'live', CHAIN_ENABLED: 'true', MONAD_RPC_URL: rpc_url, ISSUER_PRIVATE_KEY: initial.secretKey,
    DATA_DIR: join(directory, 'data'), DEPLOYMENT_FILE: deploymentPath, RECOVERY_INTERVAL_MS: '60000', CHAIN_TIMEOUT_MS: '5000',
    MODEL_TIMEOUT_MS: '1000', OPENAI_MODEL: 'test-only-a', ANTHROPIC_MODEL: 'test-only-b',
  });
  let modelCalls = 0;
  const adapters = (['a', 'b'] as const).map((slot): ModelAdapter => ({
    slot, provider: `test-only-local-${slot}`, requested_model: `test-only-${slot}`,
    async run(): Promise<ModelResult> {
      modelCalls++;
      return { slot, provider: `test-only-local-${slot}`, requested_model: `test-only-${slot}`, returned_model: `test-only-${slot}`, status: 'succeeded', verdict: 'questionable', reason: '明确标识的测试适配器；未请求任何真实模型API', error_code: null };
    },
  })) as [ModelAdapter, ModelAdapter];

  type Handle = { service: JobService; server: Server; origin: string; closeStreams: () => void };
  const handles = new Set<Handle>();
  async function start(): Promise<Handle> {
    const gateway = createGateway(config);
    assert.equal(gateway.configured, true);
    const service = new JobService(config, new JobStore(config.data_dir), gateway, adapters);
    await service.init();
    const { app, closeStreams } = createApp(service);
    const server = await new Promise<Server>(resolve => { const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); });
    const address = server.address(); assert(address && typeof address !== 'string');
    const handle = { service, server, closeStreams, origin: `http://127.0.0.1:${address.port}` };
    handles.add(handle); return handle;
  }
  async function stop(handle: Handle) {
    if (!handles.delete(handle)) return;
    handle.closeStreams();
    await new Promise<void>((resolve, reject) => handle.server.close(error => error ? reject(error) : resolve()));
    await handle.service.close();
  }
  closeServices = async () => { for (const handle of [...handles]) await stop(handle); };

  const first = await start();
  const raw_text = '  本地真实EVM集成测试，保留原文空格与换行。\n';
  const submittedResponse = await fetch(`${first.origin}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: raw_text }) });
  assert.equal(submittedResponse.status, 202);
  const submitted = await submittedResponse.json() as { job_id: string };
  await first.service.idle();
  const job = first.service.view(submitted.job_id);
  assert.equal(job.status, 'confirmed', JSON.stringify(job.error));
  assert(job.payload && job.proof && job.hashes);
  assert.equal(job.payload.raw_text, raw_text);
  assert.equal(job.payload.models[0].provider, 'test-only-local-a');
  assert.equal(job.hashes.content_hash, hashContent(raw_text));
  assert.equal(job.hashes.verdict_hash, hashPayload(job.payload));
  assert.equal(job.proof.chain_id, 10143);
  assert.equal(job.proof.contract_address, contract_address);
  assert.equal(job.proof.issuer, owner.address);
  assert.equal(job.proof.certificate_id, '1');
  assert.match(job.proof.block_time, /^[0-9]+$/);
  assert.equal(modelCalls, 2);

  const certResponse = await fetch(`${first.origin}/api/cert/1`);
  assert.equal(certResponse.status, 200);
  const certificate = await certResponse.json() as { report: ReportEnvelope; hashes: { content_hash: string; verdict_hash: string } };
  assert.deepEqual(certificate.report, { payload: job.payload, proof: job.proof });
  assert.deepEqual(certificate.hashes, job.hashes);
  validateReportEnvelope(certificate.report);
  for (const route of [`/api/jobs/${submitted.job_id}/report`, '/api/cert/1/report']) {
    const response = await fetch(`${first.origin}${route}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.deepEqual(await response.json(), certificate.report);
  }

  await stop(first);
  const restarted = await start();
  assert.equal(restarted.service.view(submitted.job_id).status, 'confirmed');
  const fresh = await fetch(`${restarted.origin}/api/cert/1`);
  assert.equal(fresh.status, 200);
  assert.deepEqual(await fresh.json(), certificate);
  assert.equal(modelCalls, 2, 'restarting must not call adapters or resubmit a confirmed job');
  assert.equal(await new ethers.Contract(contract_address, artifact.abi, provider).certificateCount(), 1n);

  // Remove the mined certificate while retaining the local confirmed report.
  // Both public certificate routes must now fail their fresh chain check.
  assert.equal(await provider.send('evm_revert', [snapshot]), true);
  assert.equal(restarted.service.view(submitted.job_id).status, 'confirmed');
  for (const route of ['/api/cert/1', '/api/cert/1/report']) {
    const response = await fetch(`${restarted.origin}${route}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'CERTIFICATE_NOT_FOUND');
  }
  assert.equal(modelCalls, 2);
});
