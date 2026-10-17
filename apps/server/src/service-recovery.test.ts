import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashContent, hashPayload, type AnchorInput, type ChainProof, type ModelResult, type ReportPayload } from '@crosscheck/protocol';
import type { ModelAdapter } from './adapters.js';
import { loadConfig } from './config.js';
import { JobService } from './service.js';
import { JobStore, type StoredJob } from './store.js';

function unfinishedCompleteJob(mode: 'demo' | 'live'): StoredJob {
  const job_id = randomUUID();
  const payload: ReportPayload = {
    schema_version: '1', job_id, mode, raw_text: 'Synthetic restart fixture, not a model call.',
    submitted_at: '2026-10-17T02:00:00.000Z', completed_at: '2026-10-17T02:00:01.000Z',
    rule_version: 'restart-test-v1', prompt_hash: hashContent('test-rule'), model_config_hash: hashContent('test-config'),
    models: (['a', 'b'] as const).map((slot) => ({ slot, provider: `test-${slot}`, requested_model: 'test-v1',
      returned_model: 'test-v1', status: 'succeeded' as const, verdict: 'credible' as const,
      reason: 'Synthetic test response.', error_code: null })) as ReportPayload['models'], agreement: 0,
  };
  // This proof exists only in a local unit test; no RPC or signing operation occurs.
  const proof: ChainProof | null = mode === 'live' ? {
    chain_id: 10143, contract_address: `0x${'11'.repeat(20)}`, certificate_id: 'test-recovery-cert',
    issuer: `0x${'22'.repeat(20)}`, tx_hash: `0x${'33'.repeat(32)}`,
    block_number: '1', block_time: '2026-10-17T02:00:02.000Z',
  } : null;
  const status = mode === 'live' ? 'confirmed' : 'report_ready';
  return {
    job_id, mode, status, results: structuredClone(payload.models), payload,
    hashes: { content_hash: hashContent(payload.raw_text), verdict_hash: hashPayload(payload) },
    proof, error: null, raw_text: payload.raw_text, submitted_at: payload.submitted_at,
    cache_key: hashContent('restart-test-cache'), finished: false,
    anchor: { attempted_at: proof ? '2026-10-17T02:00:01.000Z' : null, tx_hash: proof?.tx_hash ?? null },
    events: [{ id: 1, event: 'job_status', data: { job_id, status } }],
  };
}

test('a timed-out writer keeps the wallet gate until settlement; a late callback is durably recovered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crosscheck-late-writer-'));
  const store = new JobStore(join(directory, 'data'));
  let service: JobService | undefined;
  let resolveWriter: ((proof: ChainProof) => void) | undefined;
  try {
    const testProof = unfinishedCompleteJob('live').proof!;
    const deployment = join(directory, 'synthetic-deployment.json');
    await writeFile(deployment, JSON.stringify({ chainId: testProof.chain_id,
      contract: testProof.contract_address, issuer: testProof.issuer, deploymentBlock: '1', abi: [] }));
    const config = await loadConfig({ MODE: 'live', DATA_DIR: store.directory,
      DEPLOYMENT_FILE: deployment, CHAIN_TIMEOUT_MS: '10', RECOVERY_INTERVAL_MS: '60000' });
    const adapters = (['a', 'b'] as const).map((slot): ModelAdapter => ({
      slot, provider: `test-${slot}`, requested_model: 'test-v1',
      async run(): Promise<ModelResult> { return { slot, provider: `test-${slot}`, requested_model: 'test-v1',
        returned_model: 'test-v1', status: 'succeeded', verdict: 'credible', reason: 'Synthetic test result', error_code: null }; },
    })) as [ModelAdapter, ModelAdapter];
    let writeCalls = 0;
    let recoveryCalls = 0;
    let firstInput: AnchorInput | undefined;
    let lateBroadcast: ((tx_hash: string) => Promise<void>) | undefined;
    const unresolvedWriter = new Promise<ChainProof>((resolve) => { resolveWriter = resolve; });
    service = new JobService(config, store, {
      configured: true,
      async anchor(input, onBroadcast) {
        writeCalls++;
        firstInput = input;
        lateBroadcast = onBroadcast;
        return unresolvedWriter;
      },
      async read() { throw new Error('Timed-out writer should be recovered by persisted transaction'); },
      async recover(tx_hash, input) {
        recoveryCalls++;
        assert.equal(tx_hash, testProof.tx_hash);
        assert.deepEqual(input, firstInput);
        return { proof: testProof, content_hash: input.content_hash, verdict_hash: input.verdict_hash, agreement: input.agreement };
      },
    }, adapters);
    await service.init();
    const first = await service.submit('First writer remains pending beyond the API timeout');
    await service.idle();
    assert.equal(service.view(first.job_id).status, 'anchor_failed');
    assert.equal(service.view(first.job_id).error?.code, 'CONFIRMATION_TIMEOUT');
    assert.ok(service.get(first.job_id).anchor.attempted_at);
    assert.equal(writeCalls, 1);

    const second = await service.submit('Second report must not race the unresolved wallet call');
    await service.idle();
    assert.equal(writeCalls, 1);
    assert.equal(service.view(second.job_id).error?.code, 'CHAIN_WRITER_BUSY');
    assert.equal(service.get(second.job_id).anchor.attempted_at, null);
    assert.equal(service.get(second.job_id).anchor.tx_hash, null);
    assert.ok(service.report(second.job_id).payload);

    await lateBroadcast!(testProof.tx_hash);
    const saved = JSON.parse(await readFile(join(store.directory, `${first.job_id}.json`), 'utf8')) as StoredJob;
    assert.equal(saved.anchor.tx_hash, testProof.tx_hash);
    assert.equal(saved.events.at(-1)?.event, 'anchor_submitted');
    await service.recoverBroadcasts();
    assert.equal(recoveryCalls, 1);
    assert.equal(service.view(first.job_id).status, 'confirmed');
    assert.deepEqual(service.report(first.job_id).proof, testProof);
    assert.equal(writeCalls, 1);
    resolveWriter!(testProof);
    await unresolvedWriter;
  } finally {
    resolveWriter?.(unfinishedCompleteJob('live').proof!);
    await service?.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ['live', 'demo'] as const) {
  test(`restart preserves ${mode === 'live' ? 'confirmed proof' : 'ready demo report'} saved before done`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosscheck-recovery-'));
    const store = new JobStore(join(directory, 'data'));
    let service: JobService | undefined;
    try {
      const original = unfinishedCompleteJob(mode);
      await store.init();
      await store.save(original);
      await store.close();
      const config = await loadConfig({ MODE: mode, DATA_DIR: store.directory,
        DEPLOYMENT_FILE: join(directory, 'unconfigured-deployment.json'), RECOVERY_INTERVAL_MS: '60000' });
      let networkCalls = 0;
      service = new JobService(config, store, {
        configured: false,
        async anchor() { networkCalls++; throw new Error('Must not resend a completed job'); },
        async read() { networkCalls++; throw new Error('No network call expected for this restore'); },
      });
      await service.init();
      const restored = service.get(original.job_id);
      assert.equal(restored.finished, true);
      assert.equal(restored.status, original.status);
      assert.equal(restored.error, null);
      assert.deepEqual(restored.payload, original.payload);
      assert.deepEqual(restored.proof, original.proof);
      assert.deepEqual(restored.hashes, original.hashes);
      assert.equal(restored.events.at(-1)?.event, 'done');
      assert.equal(restored.events.at(-1)?.data.status, original.status);
      assert.equal(networkCalls, 0);
      await service.close();
      // Verify the repair itself leaves a structurally valid durable snapshot.
      const [saved] = await store.init();
      assert.equal(saved?.finished, true);
      assert.equal(saved?.status, original.status);
    } finally {
      await service?.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
