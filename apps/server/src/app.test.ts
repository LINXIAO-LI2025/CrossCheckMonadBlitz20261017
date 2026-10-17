import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createGateway } from './chain.js';
import { JobService } from './service.js';
import { JobStore } from './store.js';
import { hashPayload } from '@crosscheck/protocol';

async function harness(env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crosscheck-http-'));
  const config = await loadConfig({ MODE: 'demo', DATA_DIR: dir, DEPLOYMENT_FILE: 'test-no-deployment.json', ...env });
  const service = new JobService(config, new JobStore(dir), createGateway(config));
  await service.init();
  const { app, closeStreams } = createApp(service);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  return { service, base,
    submit: (content: unknown) => fetch(`${base}/api/verify`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) }),
    async close() { closeStreams(); server.close(); server.closeAllConnections(); await once(server, 'close');
      await service.close(); await rm(dir, { recursive: true, force: true }); },
  };
}
test('HTTP 202, downloads, exact original bytes, SSE late replay and Last-Event-ID', async () => {
  const h = await harness();
  try {
    const original = '  中文\r\n精确保留\t ';
    const response = await h.submit(original); assert.equal(response.status, 202);
    const accepted = await response.json() as { job_id: string; stream_url: string };
    await h.service.idle();
    const late = await fetch(h.base + accepted.stream_url);
    assert.match(late.headers.get('content-type')!, /text\/event-stream/);
    const body = await late.text();
    assert.match(body, /event: report_ready/); assert.match(body, /event: done/);
    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.deepEqual(ids, Array.from({ length: ids.length }, (_, i) => i + 1));
    const resume = await fetch(h.base + accepted.stream_url, { headers: { 'Last-Event-ID': '3' } }).then((r) => r.text());
    assert.ok([...resume.matchAll(/^id: (\d+)$/gm)].every((m) => Number(m[1]) > 3));
    const download = await fetch(`${h.base}/api/jobs/${accepted.job_id}/report`);
    assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition')!, /attachment/);
    const report = await download.json() as any;
    assert.equal(report.payload.raw_text, original); assert.equal(report.proof, null);
    assert.equal(report.payload.mode, 'demo');
    const reformatted = JSON.parse(JSON.stringify(report, null, 8));
    assert.equal(hashPayload(reformatted.payload), hashPayload(report.payload));
    reformatted.payload.models[0].reason += '!';
    assert.notEqual(hashPayload(reformatted.payload), hashPayload(report.payload));
    const again = await h.submit(original).then((r) => r.json()) as any;
    assert.equal(again.job_id, accepted.job_id); assert.equal(again.reused, true);
  } finally { await h.close(); }
});
test('HTTP validates input, Unicode, body size, unknown jobs, JSON, event IDs and unfinished reports', async () => {
  const h = await harness({ MAX_INPUT_CHARS: '10' });
  try {
    for (const bad of ['', '  \n ', null, 5, '\ud800']) assert.equal((await h.submit(bad)).status, 400);
    assert.equal((await h.submit('x'.repeat(11))).status, 413);
    assert.equal((await fetch(`${h.base}/api/jobs/not-a-job`)).status, 404);
    assert.equal((await fetch(`${h.base}/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    const accepted = await h.submit('ok').then((r) => r.json()) as any;
    assert.equal((await fetch(h.base + accepted.stream_url, { headers: { 'Last-Event-ID': '-1' } })).status, 400);
    assert.equal((await fetch(h.base + accepted.stream_url, { headers: { 'Last-Event-ID': '9999' } })).status, 400);
  } finally { await h.close(); }
});
test('public endpoints redact keys and cert API cannot use local proof as chain fact', async () => {
  const h = await harness({ OPENAI_API_KEY: 'test-secret-a', ANTHROPIC_API_KEY: 'test-secret-b', ISSUER_PRIVATE_KEY: 'private-test' });
  try {
    for (const route of ['/api/config', '/api/health']) {
      const response = await fetch(h.base + route); assert.equal(response.status, 200);
      const text = await response.text(); assert.doesNotMatch(text, /test-secret|private-test|api_key|private_key/i);
    }
    for (const route of ['/api/cert/1', '/api/cert/1/report']) {
      const response = await fetch(h.base + route); assert.equal(response.status, 503);
      assert.equal((await response.json() as any).error.code, 'CHAIN_NOT_CONFIGURED');
    }
  } finally { await h.close(); }
});
test('per-IP request limit ignores spoofed forwarded addresses', async () => {
  const h = await harness({ RATE_LIMIT_PER_MINUTE: '1' });
  try {
    assert.equal((await h.submit('first')).status, 202);
    const blocked = await fetch(`${h.base}/api/verify`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4' }, body: JSON.stringify({ content: 'second' }) });
    assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '60');
  } finally { await h.close(); }
});
