import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { hashContent, hashPayload, type AnchorInput, type CertificateRecord, type ChainProof,
  type ModelResult } from '@crosscheck/protocol';
import { type ModelAdapter } from './adapters.js';
import { AppError, type ChainGateway } from './chain.js';
import { loadConfig } from './config.js';
import { JobService } from './service.js';
import { JobStore, type StoredJob } from './store.js';

// All credentials, model responses and chain records in this file are local test fixtures.
// No SDK, RPC endpoint, wallet, or real contract is called.
const CONTRACT = `0x${'1'.repeat(40)}`;
const ISSUER = `0x${'2'.repeat(40)}`;
const TX_HASH = `0x${'a'.repeat(64)}`;
const proof: ChainProof = {
  chain_id: 10143, contract_address: CONTRACT, issuer: ISSUER,
  certificate_id: 'local-test-certificate-1', tx_hash: TX_HASH,
  block_number: '42', block_time: '2026-10-17T00:00:00.000Z',
};
const unavailable: ChainGateway = {
  configured: false,
  async anchor() { throw new Error('TEST: unexpected chain write'); },
  async read() { throw new AppError('NOT_CONFIGURED'); },
};

async function harness(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'crosscheck-service-test-'));
  const stores = new Set<JobStore>();
  const services = new Set<JobService>();
  t.after(async () => {
    try {
      for (const service of services) await service.close();
      for (const store of stores) await store.close();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const deploymentPath = join(directory, 'synthetic-deployment.json');
  await writeFile(deploymentPath, JSON.stringify({ chainId: 10143, contract: CONTRACT,
    issuer: ISSUER, deploymentBlock: '1', abi: [] }));
  const config = await loadConfig({ MODE: 'demo', DATA_DIR: join(directory, 'data'),
    DEPLOYMENT_FILE: deploymentPath, RECOVERY_INTERVAL_MS: '60000', CHAIN_TIMEOUT_MS: '100',
    OPENAI_API_KEY: 'TEST_FIXTURE_NOT_A_KEY', OPENAI_MODEL: 'test-openai-model',
    ANTHROPIC_API_KEY: 'TEST_FIXTURE_NOT_A_KEY', ANTHROPIC_MODEL: 'test-anthropic-model', ...env });
  return {
    directory, config,
    newStore() { const store = new JobStore(config.data_dir); stores.add(store); return store; },
    async start(chain: ChainGateway = unavailable, adapters?: [ModelAdapter, ModelAdapter]) {
      const store = new JobStore(config.data_dir);
      stores.add(store);
      const service = new JobService(config, store, chain, adapters);
      services.add(service);
      await service.init();
      return service;
    },
    async seed(job: StoredJob) {
      const store = new JobStore(config.data_dir);
      stores.add(store);
      await store.init();
      await store.save(job);
      await store.close();
    },
    async snapshot(job_id: string): Promise<StoredJob> {
      return JSON.parse(await readFile(join(config.data_dir, `${job_id}.json`), 'utf8')) as StoredJob;
    },
  };
}

function fakeAdapters(onCall?: (slot: 'a' | 'b', content: string) => void | Promise<void>): [ModelAdapter, ModelAdapter] {
  return (['a', 'b'] as const).map((slot): ModelAdapter => ({
    slot, provider: `test-vendor-${slot}`, requested_model: `test-model-${slot}`,
    async run(content): Promise<ModelResult> {
      await onCall?.(slot, content);
      return { slot, provider: `test-vendor-${slot}`, requested_model: `test-model-${slot}`,
        returned_model: `test-returned-model-${slot}`, status: 'succeeded',
        verdict: 'credible', reason: 'Synthetic test response only.', error_code: null };
    },
  })) as [ModelAdapter, ModelAdapter];
}

function matchingRecord(input: AnchorInput, chainProof: ChainProof = proof): CertificateRecord {
  return { proof: structuredClone(chainProof), content_hash: input.content_hash,
    verdict_hash: input.verdict_hash, agreement: input.agreement };
}

function pendingJob(status: StoredJob['status'] = 'running'): StoredJob {
  const job_id = randomUUID();
  return { job_id, mode: 'demo', status, results: [], payload: null, hashes: null, proof: null,
    error: null, raw_text: 'Original pending text', submitted_at: '2026-10-17T00:00:00.000Z',
    cache_key: hashContent('test-pending-cache-key'), finished: false, anchor: { attempted_at: null, tx_hash: null },
    events: [{ id: 1, event: 'job_status', data: { job_id, status } }] };
}

for (const [scene, agreement, finalStatus] of [
  ['agree', 0, 'report_ready'], ['disagree', 1, 'report_ready'], ['unable', 2, 'report_ready'],
  ['single-failure', 2, 'report_ready'], ['both-failure', null, 'failed'],
] as const) {
  test(`demo scene ${scene} produces the agreed status without a chain write`, async (t) => {
    const h = await harness(t);
    let writes = 0;
    const service = await h.start({ ...unavailable, configured: true,
      async anchor() { writes += 1; throw new Error('Never write demo reports'); } });
    const submitted = await service.submit(`[demo:${scene}] example`);
    assert.equal(submitted.status, 'queued');
    assert.equal(submitted.reused, false);
    assert.equal(submitted.stream_url, `/api/stream/${submitted.job_id}`);
    await service.idle();
    const view = service.view(submitted.job_id);
    assert.equal(view.status, finalStatus);
    assert.equal(view.proof, null);
    assert.deepEqual(view.results.map((result) => result.slot), ['a', 'b']);
    assert.equal(writes, 0);
    if (agreement === null) {
      assert.equal(view.payload, null);
      assert.equal(view.hashes, null);
      assert.equal(view.error?.code, 'BOTH_MODELS_FAILED');
      assert.throws(() => service.report(submitted.job_id), { code: 'REPORT_NOT_READY' });
    } else {
      assert.equal(view.payload?.agreement, agreement);
      assert.equal(view.payload.mode, 'demo');
      assert.equal(view.hashes?.verdict_hash, hashPayload(view.payload));
      assert.ok(view.payload.models.every((model) => model.provider === 'demo-fixture'));
    }
    const events = service.get(submitted.job_id).events;
    assert.deepEqual(events.map((event) => event.id), events.map((_, index) => index + 1));
    assert.ok(events.every((event) => event.data.job_id === submitted.job_id));
    assert.equal(events.at(-1)?.event, 'done');
    assert.equal(events.at(-1)?.data.status, finalStatus);
    assert.deepEqual(await h.snapshot(submitted.job_id), service.get(submitted.job_id));
  });
}

test('raw text, UTF-8 hashes and completed timestamps survive duplicates, cache hits and restart', async (t) => {
  const h = await harness(t);
  let modelCalls = 0;
  const raw = '  中文 e\u0301 😀\r\nA claim with trailing spaces. \n ';
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const adapters = fakeAdapters(async (_, content) => { modelCalls += 1; assert.equal(content, raw); await gate; });
  const service = await h.start(unavailable, adapters);
  let responses: Awaited<ReturnType<JobService['submit']>>[];
  try { responses = await Promise.all(Array.from({ length: 12 }, () => service.submit(raw))); }
  finally { release(); }
  assert.equal(new Set(responses.map((response) => response.job_id)).size, 1);
  assert.equal(responses.filter((response) => !response.reused).length, 1);
  await service.idle();
  const id = responses[0]!.job_id;
  const report = service.report(id);
  assert.equal(report.payload.raw_text, raw);
  assert.equal(service.view(id).hashes?.content_hash, hashContent(raw));
  assert.notEqual(hashContent(raw), hashContent(raw.trim()));
  assert.equal(modelCalls, 2);
  const cached = await service.submit(raw);
  assert.equal(cached.reused, true);
  assert.equal(cached.job_id, id);
  assert.equal(service.report(cached.job_id).payload.completed_at, report.payload.completed_at);
  // A consumer cannot mutate the saved payload or proof via a read response.
  report.payload.raw_text = 'Changed only in the caller';
  assert.equal(service.report(id).payload.raw_text, raw);
  await service.close();
  const restarted = await h.start(unavailable, adapters);
  const restored = await restarted.submit(raw);
  assert.equal(restored.reused, true);
  assert.equal(restored.job_id, id);
  assert.equal(restarted.report(id).payload.completed_at, report.payload.completed_at);
  assert.equal(modelCalls, 2);
});

for (const scene of ['unable', 'single-failure', 'both-failure'] as const) {
  test(`completed ${scene} requests are not kept in the normal report cache`, async (t) => {
    const h = await harness(t);
    const service = await h.start();
    const first = await service.submit(`[demo:${scene}] retryable`);
    await service.idle();
    const second = await service.submit(`[demo:${scene}] retryable`);
    assert.equal(second.reused, false);
    assert.notEqual(second.job_id, first.job_id);
    await service.idle();
  });
}

test('model configuration is part of the cache key across restarts', async (t) => {
  const h = await harness(t);
  const firstService = await h.start(unavailable, fakeAdapters());
  const first = await firstService.submit('A stable original text');
  await firstService.idle();
  await firstService.close();
  const changed = fakeAdapters();
  const original = changed[0];
  changed[0] = { ...original, requested_model: 'test-new-model-a',
    async run(content, signal) { return { ...(await original.run(content, signal)), requested_model: 'test-new-model-a' }; } };
  const secondService = await h.start(unavailable, changed);
  const second = await secondService.submit('A stable original text');
  assert.notEqual(second.job_id, first.job_id);
  assert.equal(second.reused, false);
  assert.notEqual(secondService.model_config_hash, firstService.model_config_hash);
  await secondService.idle();
});

test('a chain failure preserves the immutable report and downloads with null proof', async (t) => {
  const h = await harness(t, { MODE: 'live' });
  let writes = 0;
  const service = await h.start({ configured: true,
    async anchor() { writes += 1; throw new AppError('TRANSACTION_REVERTED', 503, 'do not expose secret details'); },
    async read() { throw new Error('Must not query before a successful broadcast'); },
  }, fakeAdapters());
  const { job_id } = await service.submit('Saved even if anchoring fails');
  await service.idle();
  const view = service.view(job_id);
  assert.equal(view.status, 'anchor_failed');
  assert.equal(view.error?.code, 'TRANSACTION_REVERTED');
  assert.equal(view.proof, null);
  assert.equal(view.payload?.mode, 'live');
  assert.equal(service.report(job_id).payload.raw_text, 'Saved even if anchoring fails');
  assert.equal(view.hashes?.verdict_hash, hashPayload(view.payload!));
  assert.equal(writes, 1);
  assert.doesNotMatch(JSON.stringify(view), /secret details/);
  const before = service.report(job_id).payload;
  await service.recoverBroadcasts();
  assert.deepEqual(service.report(job_id).payload, before);
  assert.equal(writes, 1);
});

test('unconfigured live chain keeps the real-mode report without a synthetic certificate', async (t) => {
  const h = await harness(t, { MODE: 'live' });
  const service = await h.start(unavailable, fakeAdapters());
  const { job_id } = await service.submit('No deployed chain module');
  await service.idle();
  const view = service.view(job_id);
  assert.equal(view.status, 'anchor_failed');
  assert.equal(view.error?.code, 'NOT_CONFIGURED');
  assert.equal(view.payload?.mode, 'live');
  assert.equal(view.proof, null);
  assert.equal(view.anchor.attempted_at, null);
  assert.equal(service.report(job_id).proof, null);
});

test('live confirmation reads the known deployment and certificate retrieval rechecks the chain', async (t) => {
  const h = await harness(t, { MODE: 'live' });
  let input: AnchorInput | undefined;
  let reads = 0;
  let mismatch = false;
  let broadcastSnapshot: StoredJob | undefined;
  const gateway: ChainGateway = { configured: true,
    async anchor(value, onBroadcast) {
      input = structuredClone(value);
      await onBroadcast(proof.tx_hash);
      broadcastSnapshot = await h.snapshot(value.job_id);
      assert.equal(broadcastSnapshot.anchor.tx_hash, proof.tx_hash);
      assert.equal(broadcastSnapshot.events.at(-1)?.event, 'anchor_submitted');
      return structuredClone(proof);
    },
    async read(id) {
      reads += 1;
      assert.equal(id, proof.certificate_id);
      const record = matchingRecord(input!);
      if (mismatch) record.content_hash = `0x${'0'.repeat(64)}`;
      return record;
    },
  };
  const service = await h.start(gateway, fakeAdapters());
  const { job_id } = await service.submit('A synthetic live confirmation test');
  await service.idle();
  assert.equal(service.view(job_id).status, 'confirmed');
  assert.equal(reads, 1);
  assert.deepEqual(service.view(job_id).proof, proof);
  assert.deepEqual(service.report(job_id).payload, broadcastSnapshot!.payload);
  const certificate = await service.certificate(proof.certificate_id);
  assert.equal(reads, 2);
  assert.deepEqual(certificate.hashes, service.view(job_id).hashes);
  assert.deepEqual(certificate.report.proof, proof);
  mismatch = true;
  await assert.rejects(service.certificate(proof.certificate_id), { code: 'RECORD_MISMATCH' });
  assert.equal(reads, 3);
  assert.equal(service.report(job_id).payload.raw_text, 'A synthetic live confirmation test');
});

test('wrong chain records cannot turn a saved report into a confirmed certificate', async (t) => {
  const changes: Array<[string, (record: CertificateRecord) => void]> = [
    ['chain ID', (record) => { record.proof.chain_id = 1; }],
    ['contract', (record) => { record.proof.contract_address = `0x${'3'.repeat(40)}`; }],
    ['issuer', (record) => { record.proof.issuer = `0x${'3'.repeat(40)}`; }],
    ['content hash', (record) => { record.content_hash = `0x${'0'.repeat(64)}`; }],
    ['report hash', (record) => { record.verdict_hash = `0x${'0'.repeat(64)}`; }],
    ['agreement', (record) => { record.agreement = 1; }],
    ['transaction', (record) => { record.proof.tx_hash = `0x${'b'.repeat(64)}`; }],
    ['certificate ID', (record) => { record.proof.certificate_id = 'different-id'; }],
  ];
  for (const [name, change] of changes) {
    await t.test(name, async (child) => {
      const h = await harness(child, { MODE: 'live' });
      let input: AnchorInput | undefined;
      const service = await h.start({ configured: true,
        async anchor(value, onBroadcast) { input = value; await onBroadcast(proof.tx_hash); return structuredClone(proof); },
        async read() { const record = matchingRecord(input!); change(record); return record; },
      }, fakeAdapters());
      const { job_id } = await service.submit('Validate against known deployment');
      await service.idle();
      const view = service.view(job_id);
      assert.equal(view.status, 'anchor_failed');
      assert.equal(view.error?.code, 'RECORD_MISMATCH');
      assert.equal(view.proof, null);
      assert.ok(service.report(job_id).payload);
    });
  }
});

test('restart marks queued/running jobs interrupted without silently rerunning models', async (t) => {
  const h = await harness(t);
  const queued = pendingJob('queued');
  const running = pendingJob('running');
  await h.seed(queued);
  await h.seed(running);
  let calls = 0;
  const service = await h.start(unavailable, fakeAdapters(() => { calls += 1; }));
  for (const original of [queued, running]) {
    const view = service.view(original.job_id);
    assert.equal(view.status, 'interrupted');
    assert.equal(view.error?.code, 'PROCESS_INTERRUPTED');
    assert.equal(view.payload, null);
    assert.equal(service.get(original.job_id).finished, true);
    assert.equal((await h.snapshot(original.job_id)).status, 'interrupted');
  }
  await service.idle();
  assert.equal(calls, 0);
});

test('restart recovers a durable broadcast by querying its transaction and never resends', async (t) => {
  const h = await harness(t, { MODE: 'live' });
  let checkpoint: StoredJob | undefined;
  let input: AnchorInput | undefined;
  let initialWrites = 0;
  const first = await h.start({ configured: true,
    async anchor(value, onBroadcast) {
      initialWrites += 1;
      input = value;
      await onBroadcast(proof.tx_hash);
      checkpoint = await h.snapshot(value.job_id);
      throw new AppError('CONFIRMATION_TIMEOUT', 503);
    },
    async read() { throw new Error('No confirmation response yet'); },
  }, fakeAdapters());
  const { job_id } = await first.submit('A report with a pending broadcast');
  await first.idle();
  assert.equal(first.view(job_id).status, 'anchor_failed');
  const pendingDuplicate = await first.submit('A report with a pending broadcast');
  assert.equal(pendingDuplicate.reused, true);
  assert.equal(pendingDuplicate.job_id, job_id);
  assert.equal(initialWrites, 1);
  await first.close();
  // Restore the exact durable checkpoint at broadcast, as if the process died there.
  assert.equal(checkpoint!.status, 'anchoring');
  assert.equal(checkpoint!.finished, false);
  await h.seed(checkpoint!);
  let recoveryQueries = 0;
  let resendAttempts = 0;
  let repeatedModelCalls = 0;
  const restarted = await h.start({ configured: true,
    async anchor() { resendAttempts += 1; throw new Error('Recovery must never resend'); },
    async read() { throw new Error('Recovery uses the persisted transaction'); },
    async recover(txHash, recoveredInput) {
      recoveryQueries += 1;
      assert.equal(txHash, TX_HASH);
      assert.deepEqual(recoveredInput, input);
      return matchingRecord(recoveredInput);
    },
  }, fakeAdapters(() => { repeatedModelCalls += 1; }));
  assert.equal(initialWrites, 1);
  assert.equal(recoveryQueries, 1);
  assert.equal(resendAttempts, 0);
  assert.equal(repeatedModelCalls, 0);
  assert.equal(restarted.view(job_id).status, 'confirmed');
  assert.deepEqual(restarted.report(job_id).payload, checkpoint!.payload);
  assert.deepEqual(restarted.report(job_id).proof, proof);
  const confirmedDuplicate = await restarted.submit('A report with a pending broadcast');
  assert.equal(confirmedDuplicate.reused, true);
  assert.equal(confirmedDuplicate.job_id, job_id);
  await restarted.recoverBroadcasts();
  assert.equal(recoveryQueries, 1);
  assert.equal(resendAttempts, 0);
});

test('serialized snapshots capture immutable bytes and enforce a single writer', async (t) => {
  const h = await harness(t);
  const store = h.newStore();
  const competing = h.newStore();
  await store.init();
  await assert.rejects(competing.init(), /DATA_DIR_LOCKED/);
  const job = pendingJob('queued');
  const firstSave = store.save(job);
  job.status = 'running';
  await firstSave;
  assert.equal((await h.snapshot(job.job_id)).status, 'queued');
  const writes: Promise<void>[] = [];
  for (let index = 2; index <= 30; index += 1) {
    job.events.push({ id: index, event: 'job_status', data: { job_id: job.job_id, status: 'running', index } });
    writes.push(store.save(job));
  }
  await Promise.all(writes);
  const stored = await h.snapshot(job.job_id);
  assert.deepEqual(stored, job);
  assert.deepEqual(stored.events.map((event) => event.id), Array.from({ length: 30 }, (_, index) => index + 1));
  assert.equal((await readdir(h.config.data_dir)).filter((file) => file.endsWith('.tmp')).length, 0);
  await store.close();
  await competing.init();
  await competing.close();
});

test('an unknown broadcast outcome after restart stays unresolved and is never resent', async (t) => {
  const h = await harness(t, { MODE: 'live' });
  let checkpoint: StoredJob | undefined;
  const first = await h.start({ configured: true,
    async anchor(input) {
      checkpoint = await h.snapshot(input.job_id);
      throw new AppError('CONFIRMATION_TIMEOUT', 503);
    },
    async read() { throw new Error('No known transaction'); },
  }, fakeAdapters());
  const { job_id } = await first.submit('No durable transaction hash was received');
  await first.idle();
  await first.close();
  assert.equal(checkpoint!.status, 'anchoring');
  assert.equal(checkpoint!.anchor.tx_hash, null);
  assert.ok(checkpoint!.anchor.attempted_at);
  await h.seed(checkpoint!);
  let sends = 0;
  let queries = 0;
  const restarted = await h.start({ configured: true,
    async anchor() { sends += 1; throw new Error('Never resend an unknown outcome'); },
    async read() { queries += 1; throw new Error('No certificate ID is known'); },
    async recover() { queries += 1; throw new Error('No transaction hash is known'); },
  }, fakeAdapters(() => { throw new Error('Never rerun a saved report'); }));
  await restarted.recoverBroadcasts();
  assert.equal(restarted.view(job_id).status, 'anchor_failed');
  assert.equal(restarted.view(job_id).error?.code, 'BROADCAST_OUTCOME_UNKNOWN');
  const duplicate = await restarted.submit('No durable transaction hash was received');
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.job_id, job_id);
  assert.equal(restarted.report(job_id).proof, null);
  assert.deepEqual(restarted.report(job_id).payload, checkpoint!.payload);
  assert.equal(sends, 0);
  assert.equal(queries, 0);
});

test('concurrency and queue limits bound work while duplicate submissions reuse a pending job', async (t) => {
  const h = await harness(t, { MAX_CONCURRENT_JOBS: '2', MAX_QUEUE_SIZE: '1' });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const twoJobsStarted = new Promise<void>((resolve) => { started = resolve; });
  let activeCalls = 0;
  let maxActiveCalls = 0;
  let calls = 0;
  const service = await h.start(unavailable, fakeAdapters(async () => {
    calls += 1;
    activeCalls += 1;
    maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
    if (activeCalls === 4) started();
    await gate;
    activeCalls -= 1;
  }));
  let startTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await service.submit('First distinct text');
    await service.submit('Second distinct text');
    await Promise.race([twoJobsStarted, new Promise<never>((_, reject) => {
      startTimeout = setTimeout(() => reject(new Error('Two jobs did not begin within the test deadline')), 3_000);
    })]);
    assert.equal(service.health().active_jobs, 2);
    const third = await service.submit('Third queued text');
    assert.equal(third.status, 'queued');
    assert.equal(service.health().queued_jobs, 1);
    await assert.rejects(service.submit('Fourth exceeds capacity'), { code: 'QUEUE_FULL' });
    const duplicate = await service.submit('First distinct text');
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.job_id, first.job_id);
  } finally {
    if (startTimeout) clearTimeout(startTimeout);
    release();
  }
  await service.idle();
  assert.equal(service.jobs.size, 3);
  assert.equal(calls, 6);
  assert.equal(maxActiveCalls, 4);
  assert.equal(service.health().active_jobs, 0);
  assert.equal(service.health().queued_jobs, 0);
  assert.ok([...service.jobs.values()].every((job) => job.status === 'report_ready'));
});

test('invalid content is rejected before creating or charging a model job', async (t) => {
  const h = await harness(t, { MAX_INPUT_CHARS: '20' });
  let calls = 0;
  const service = await h.start(unavailable, fakeAdapters(() => { calls += 1; }));
  for (const content of [undefined, null, {}, '', ' \r\n ']) {
    await assert.rejects(service.submit(content), { code: 'INVALID_CONTENT' });
  }
  await assert.rejects(service.submit('a'.repeat(21)), { code: 'CONTENT_TOO_LONG' });
  await assert.rejects(service.submit('invalid \uD800'), { code: 'INVALID_UNICODE' });
  assert.equal(service.jobs.size, 0);
  assert.equal(calls, 0);
});
