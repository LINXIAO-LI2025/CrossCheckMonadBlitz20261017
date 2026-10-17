import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import vm from 'node:vm';
import { createApp } from '../apps/server/src/app.js';
import { loadConfig } from '../apps/server/src/config.js';
import { JobStore } from '../apps/server/src/store.js';
import { JobService } from '../apps/server/src/service.js';
import { AppError } from '../apps/server/src/chain.js';
import { validateReportEnvelope, hashContent, hashPayload, type ReportEnvelope } from '@crosscheck/protocol';

async function integrated(t: TestContext, mode: 'demo' | 'live' = 'demo') {
  const dir = await mkdtemp(join(tmpdir(), 'crosscheck-ab-http-'));
  const config = await loadConfig({ MODE: mode, DATA_DIR: dir, DEPLOYMENT_FILE: 'integration-no-deployment.json',
    RATE_LIMIT_PER_MINUTE: '100', RECOVERY_INTERVAL_MS: '60000' });
  let broadcasts = 0;
  const service = new JobService(config, new JobStore(dir), {
    configured: true,
    async anchor() { broadcasts++; throw new Error('Integration fixture must not broadcast'); },
    async read() { throw new AppError('CHAIN_UNAVAILABLE', 503); },
  });
  await service.init();
  const { app, closeStreams } = createApp(service);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    closeStreams(); server.close(); server.closeAllConnections(); await once(server, 'close');
    await service.close(); await rm(dir, { recursive: true, force: true });
  });
  return { base, service, get broadcasts() { return broadcasts; },
    submit: (content: string) => fetch(`${base}/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }),
  };
}

test('A-backed HTTP flow covers three B demo scenes, exact downloads, SSE replay and no chain writes', async t => {
  const h = await integrated(t);
  const browserBundle = await fetch(`${h.base}/vendor/protocol.js`);
  assert.equal(browserBundle.status, 200, 'build:web must produce the actual shared browser protocol bundle');
  const browserContext = vm.createContext({ TextEncoder, TextDecoder, Uint8Array });
  vm.runInContext('globalThis.window = globalThis;', browserContext);
  vm.runInContext(await browserBundle.text(), browserContext);
  const browserProtocol = browserContext.CrossCheckProtocol as {
    validateReportEnvelope(value: unknown): ReportEnvelope; hashContent(value: string): string; hashPayload(value: ReportEnvelope['payload']): string;
  };
  assert.equal(typeof browserProtocol?.validateReportEnvelope, 'function');
  assert.equal(await fetch(`${h.base}/api/jobs/latest`).then(response => response.json()), null);
  let last = '';
  for (const [scene, agreement] of [['agree', 0], ['disagree', 1], ['unable', 2]] as const) {
    const content = `[demo:${scene}]  <script>alert("untrusted")</script>\r\n原文空白\t `;
    const response = await h.submit(content);
    assert.equal(response.status, 202);
    const accepted = await response.json() as { job_id: string; status: string; stream_url: string; reused: boolean };
    assert.match(accepted.job_id, /^[0-9a-f-]{36}$/); assert.equal(accepted.reused, false);
    await h.service.idle();
    const job = await fetch(`${h.base}/api/jobs/${accepted.job_id}`).then(response => response.json()) as any;
    assert.equal(job.status, 'report_ready'); assert.equal(job.payload.agreement, agreement);
    assert.equal(job.payload.mode, 'demo'); assert.equal(job.proof, null);
    assert.equal(job.anchor.attempted_at, null); assert.equal(job.anchor.tx_hash, null);
    assert.equal(job.payload.raw_text, content);
    assert.ok(job.results.every((result: any) => result.provider === 'demo-fixture'));
    const streamResponse = await fetch(h.base + accepted.stream_url);
    assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/);
    const events = await streamResponse.text();
    assert.match(events, /event: model_result/); assert.match(events, /event: report_ready/); assert.match(events, /event: done/);
    assert.doesNotMatch(events, /event: anchor_submitted|event: anchor_confirmed/);
    const ids = [...events.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
    assert.deepEqual(ids, ids.map((_, index) => index + 1));
    const resumed = await fetch(h.base + accepted.stream_url, { headers: { 'Last-Event-ID': String(ids[1]) } }).then(response => response.text());
    assert.ok([...resumed.matchAll(/^id: (\d+)$/gm)].every(match => Number(match[1]) > ids[1]!));
    const download = await fetch(`${h.base}/api/jobs/${accepted.job_id}/report`);
    assert.match(download.headers.get('content-disposition') || '', /attachment/);
    assert.match(download.headers.get('content-type') || '', /application\/json/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    const envelope = validateReportEnvelope(await download.json()) as ReportEnvelope;
    assert.equal(envelope.payload.raw_text, content); assert.equal(envelope.proof, null);
    assert.equal(hashContent(envelope.payload.raw_text), job.hashes.content_hash);
    assert.equal(hashPayload(envelope.payload), job.hashes.verdict_hash);
    // Exercise the exact browser bundle served to B, rather than copying the hashing implementation.
    const browserEnvelope = browserProtocol.validateReportEnvelope(JSON.parse(JSON.stringify(envelope)));
    assert.equal(browserProtocol.hashContent(browserEnvelope.payload.raw_text), job.hashes.content_hash);
    assert.equal(browserProtocol.hashPayload(browserEnvelope.payload), job.hashes.verdict_hash);
    const reformat = JSON.parse(JSON.stringify(envelope, null, 6)) as ReportEnvelope;
    assert.equal(hashPayload(reformat.payload), job.hashes.verdict_hash);
    reformat.payload.models[0].reason += ' changed';
    assert.notEqual(hashPayload(reformat.payload), job.hashes.verdict_hash);
    last = accepted.job_id;
  }
  assert.equal((await fetch(`${h.base}/api/jobs/latest`).then(response => response.json()) as any).job_id, last);
  assert.equal(h.broadcasts, 0);
});

test('A is the same-origin page server while private/source paths remain inaccessible', async t => {
  const h = await integrated(t);
  for (const route of ['/', '/index.html', '/submit.html', '/screen.html', '/cert.html', '/browser-shared.js', '/index-page.js', '/submit-page.js', '/screen-page.js', '/cert-page.js', '/front-overrides.css', '/vendor/ethers.js', '/vendor/protocol.js']) {
    const response = await fetch(h.base + route);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const route of ['/.env', '/.secrets', '/server.ts', '/apps/server/src/config.ts', '/packages/protocol/src/index.ts', '/deployment.json', '/package.json', '/node_modules/ethers/package.json', '/data/anything.json', '/..%2f.env'])
    assert.equal((await fetch(h.base + route)).status, 404, route);
  const config = await fetch(`${h.base}/api/config`).then(response => response.json()) as any;
  assert.equal(config.backend_mode, 'a-integrated'); assert.equal(config.chain_id, 10143);
  assert.equal(config.live_available, false); assert.equal(config.mode, 'demo');
  assert.equal('chainId' in config, false); assert.equal('private_key' in config, false);
  const qr = await fetch(`${h.base}/api/qr?text=${encodeURIComponent(`${h.base}/cert.html?job=example`)}`);
  assert.equal(qr.status, 200); assert.match(qr.headers.get('content-type') || '', /image\/png/);
  assert.deepEqual([...new Uint8Array(await qr.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((await fetch(`${h.base}/api/qr?text=${encodeURIComponent('https://unrelated.invalid/cert.html')}`)).status, 400);
});

test('A live mode without model credentials fails explicitly and never falls back to demo', async t => {
  const h = await integrated(t, 'live');
  const response = await h.submit('无API配置时的真实模式检查');
  assert.equal(response.status, 202);
  const accepted = await response.json() as { job_id: string; stream_url: string };
  await h.service.idle();
  const job = await fetch(`${h.base}/api/jobs/${accepted.job_id}`).then(response => response.json()) as any;
  assert.equal(job.mode, 'live'); assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'BOTH_MODELS_FAILED');
  assert.equal(job.payload, null); assert.equal(job.proof, null); assert.equal(h.broadcasts, 0);
  assert.ok(job.results.every((result: any) => result.status === 'failed' && result.error_code === 'NOT_CONFIGURED' && result.verdict === null && result.reason === null));
  const stream = await fetch(h.base + accepted.stream_url).then(response => response.text());
  assert.match(stream, /event: model_error/); assert.doesNotMatch(stream, /event: report_ready/);
  assert.equal((await fetch(`${h.base}/api/jobs/${accepted.job_id}/report`)).status, 409);
});
