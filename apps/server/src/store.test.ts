import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashContent, hashPayload, type ReportPayload } from '@crosscheck/protocol';
import { JobStore, validateStoredJob, type StoredJob } from './store.js';

function sample(): StoredJob {
  const job_id = randomUUID();
  const submitted_at = '2026-10-17T02:00:00.000Z';
  const payload: ReportPayload = {
    schema_version: '1', job_id, mode: 'demo', raw_text: '  原文\r\nDemo only.  ',
    submitted_at, completed_at: '2026-10-17T02:00:01.000Z', rule_version: 'test-v1',
    prompt_hash: hashContent('test-rule'), model_config_hash: hashContent('test-config'),
    models: ['a', 'b'].map((slot) => ({ slot, provider: `demo-${slot}`, requested_model: 'fixture-v1',
      returned_model: 'fixture-v1', status: 'succeeded', verdict: 'credible', reason: 'Synthetic test only',
      error_code: null })) as ReportPayload['models'], agreement: 0,
  };
  return {
    job_id, mode: 'demo', status: 'report_ready', results: structuredClone(payload.models), payload,
    hashes: { content_hash: hashContent(payload.raw_text), verdict_hash: hashPayload(payload) },
    proof: null, error: null, raw_text: payload.raw_text, submitted_at,
    cache_key: hashContent('test-cache'), finished: true, anchor: { attempted_at: null, tx_hash: null },
    events: [{ id: 1, event: 'done', data: { job_id, status: 'report_ready' } }],
  };
}

test('serialized writes capture each snapshot before later in-memory mutation and survive restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crosscheck-store-'));
  const store = new JobStore(directory);
  try {
    await store.init();
    const job = sample();
    const first = store.save(job);
    job.error = { code: 'TEST', message: 'Second snapshot only' };
    const second = store.save(job);
    job.error.message = 'Must never reach disk';
    await Promise.all([first, second]);
    const saved = JSON.parse(await readFile(join(directory, `${job.job_id}.json`), 'utf8'));
    assert.equal(saved.error.message, 'Second snapshot only');
    await store.close();
    const restored = await store.init();
    assert.equal(restored.length, 1);
    assert.equal(restored[0]!.error?.message, 'Second snapshot only');
    assert.equal(restored[0]!.payload?.raw_text, '  原文\r\nDemo only.  ');
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a second writer and an ambiguous empty lock fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crosscheck-lock-'));
  const first = new JobStore(directory);
  const second = new JobStore(directory);
  try {
    await first.init();
    await assert.rejects(second.init(), /DATA_DIR_LOCKED/);
    await first.close();
    await writeFile(join(directory, '.server.lock'), '');
    await assert.rejects(second.init(), /DATA_DIR_LOCKED/);
    assert.equal(await readFile(join(directory, '.server.lock'), 'utf8'), '');
  } finally { await first.close(); await second.close(); await rm(directory, { recursive: true, force: true }); }
});

test('restart rejects altered payload/hash/raw text/results and releases its acquired lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crosscheck-corrupt-'));
  const store = new JobStore(directory);
  try {
    const valid = sample();
    for (const mutate of [
      (job: StoredJob) => { job.payload!.raw_text += ' tampered'; },
      (job: StoredJob) => { job.hashes!.verdict_hash = hashContent('forged'); },
      (job: StoredJob) => { job.raw_text = 'different original'; },
      (job: StoredJob) => { job.results[0]!.reason = 'different reason'; },
      (job: StoredJob) => { job.status = 'confirmed'; },
    ]) {
      const corrupt = structuredClone(valid); mutate(corrupt);
      await writeFile(join(directory, `${valid.job_id}.json`), JSON.stringify(corrupt));
      await assert.rejects(store.init(), /CORRUPT_JOB_STORE/);
      await assert.rejects(readFile(join(directory, '.server.lock'), 'utf8'), { code: 'ENOENT' });
    }
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('snapshot validation rejects wrong event identity/order, statuses and fake demo proof', () => {
  assert.equal(validateStoredJob(sample()).mode, 'demo');
  for (const mutate of [
    (job: StoredJob) => { job.events[0]!.id = 2; },
    (job: StoredJob) => { job.events[0]!.data.job_id = randomUUID(); },
    (job: StoredJob) => { job.events.push(structuredClone(job.events[0]!)); },
    (job: StoredJob) => { (job as unknown as { status: string }).status = 'made_up'; },
    (job: StoredJob) => { job.proof = { chain_id: 10143, contract_address: `0x${'11'.repeat(20)}`,
      certificate_id: '1', issuer: `0x${'22'.repeat(20)}`, tx_hash: `0x${'33'.repeat(32)}`,
      block_number: '123', block_time: '2026-10-17T02:00:02Z' }; },
  ]) {
    const corrupt = sample(); mutate(corrupt);
    assert.throws(() => validateStoredJob(corrupt), /CORRUPT_JOB_STORE/);
  }
});

test('failed adapters cannot be restored as a normal report, while interrupted partial work can', () => {
  const job = sample();
  job.results = job.results.map((result) => ({ ...result, status: 'failed', verdict: null,
    reason: null, error_code: 'MODEL_TIMEOUT' }));
  job.payload!.models = job.results as ReportPayload['models'];
  job.payload!.agreement = 2;
  assert.throws(() => validateStoredJob(job), /CORRUPT_JOB_STORE/);
  job.payload = null; job.hashes = null; job.status = 'interrupted';
  job.events = [{ id: 1, event: 'done', data: { job_id: job.job_id, status: 'interrupted' } }];
  assert.equal(validateStoredJob(job).status, 'interrupted');
});
