import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createCrossCheckServer, loadServerConfig, type ServerOptions } from '../server';
import { computeHashes } from '../protocol';
import type { ModelResult } from '../types';
import { callModel } from '../server/models';

async function fixture(overrides: Partial<ReturnType<typeof loadServerConfig>> = {}, modelRunner?: ServerOptions['modelRunner'], chainWriter: ServerOptions['chainWriter'] = null) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crosscheck-api-'));
  for (const name of ['index.html', 'submit.html', 'screen.html', 'cert.html']) await fs.writeFile(path.join(directory, name), '<!doctype html><title>fixture</title>');
  await fs.writeFile(path.join(directory, '.env'), 'PRIVATE_KEY=never-public-secret');
  await fs.writeFile(path.join(directory, 'server.ts'), 'never-public-source');
  const config = { ...loadServerConfig({}, directory), demoDelayMs: 5, ...overrides };
  let service = await createCrossCheckServer({ config, modelRunner, chainWriter });
  let server: Server;
  let origin: string;
  async function start() {
    server = await new Promise<Server>(resolve => { const handle = service.app.listen(0, '127.0.0.1', () => resolve(handle)); });
    origin = `http://127.0.0.1:${(server.address() as any).port}`;
  }
  await start();
  return {
    get service() { return service; },
    get origin() { return origin; }, directory,
    async request(route: string, body?: object) { return fetch(`${origin}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); },
    async submit(body: object) { const response = await this.request('/api/verify', body); return { response, body: await response.json() as any }; },
    async restart() { await service.waitForIdle(); await new Promise<void>(resolve => server.close(() => resolve())); service.close(); service = await createCrossCheckServer({ config, modelRunner, chainWriter }); await start(); },
    async cleanup() { await service.waitForIdle(); await new Promise<void>(resolve => server.close(() => resolve())); service.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test('demo creates exact-text report, independent random jobs, late SSE replay, and persistent report', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const content = '  <script>alert("xss")</script>\n原文末尾保留空格  ';
  const submitted = await f.submit({ content, mode: 'demo', scenario: 'disagreement', request_id: 'request-001' });
  assert.equal(submitted.response.status, 202);
  const id = submitted.body.job_id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  await f.service.waitForIdle();
  const response = await f.request(`/api/reports/${id}`);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const report = await response.json() as any;
  assert.equal(report.report.payload.raw_text, content);
  assert.equal(report.report.payload.agreement, 1);
  assert.equal(report.report.payload.mode, 'demo');
  assert.equal(report.report.proof, null);
  assert.match(report.report.payload.models[0].provider, /固定演示/);
  assert.deepEqual(report.hashes, computeHashes(report.report.payload));
  const stream = await f.request(`/api/stream/${id}`);
  const text = await stream.text();
  assert.match(text, /event: job/);
  const replay = JSON.parse(text.split('data: ')[1].split('\n\n')[0]);
  assert.equal(replay.status, 'report_ready');
  assert.equal(replay.payload.raw_text, content);
  const retry = await f.submit({ content, mode: 'demo', scenario: 'disagreement', request_id: 'request-001' });
  assert.equal(retry.body.job_id, id);
  const collision = await f.submit({ content: `${content}不同`, mode: 'demo', scenario: 'disagreement', request_id: 'request-001' });
  assert.equal(collision.response.status, 409);
  const another = await f.submit({ content, mode: 'demo' });
  assert.notEqual(another.body.job_id, id);
  await f.service.waitForIdle();
  await f.restart();
  assert.deepEqual(await (await f.request(`/api/reports/${id}`)).json(), report);
  assert.equal((await (await f.request('/api/jobs/latest')).json() as any).job_id, another.body.job_id);
  const restartedRetry = await f.submit({ content, mode: 'demo', scenario: 'disagreement', request_id: 'request-001' });
  assert.equal(restartedRetry.body.job_id, id);
});

test('live without both provider keys and explicit models is refused without creating a job', async t => {
  let called = false;
  const f = await fixture({}, async () => { called = true; throw new Error('must not run'); }); t.after(() => f.cleanup());
  const result = await f.submit({ content: '用户输入', mode: 'live' });
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error.code, 'LIVE_UNAVAILABLE');
  assert.equal(called, false);
  assert.equal(await (await f.request('/api/jobs/latest')).json(), null);
  const publicConfig = await (await f.request('/api/config')).json() as any;
  assert.equal(publicConfig.liveAvailable, false);
  assert.equal(publicConfig.chainMode, 'unconfigured');
  assert.equal('privateKey' in publicConfig, false);
  assert.equal('openaiKey' in publicConfig, false);
});

test('only exact public assets are served; source, .env, node_modules and traversal stay inaccessible', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  for (const route of ['/', '/submit.html', '/screen.html', '/cert.html']) assert.equal((await f.request(route)).status, 200);
  for (const route of ['/.env', '/server.ts', '/types.ts', '/package.json', '/node_modules/ethers/package.json', '/data/reports/x.json', '/%2eenv', '/..%2f.env']) {
    const response = await f.request(route);
    assert.equal(response.status, 404, route);
    assert.doesNotMatch(await response.text(), /never-public/);
  }
  const rejected = await fetch(`${f.origin}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.invalid' }, body: JSON.stringify({ content: 'attack' }) });
  assert.equal(rejected.status, 403);
});

test('read-only RPC rejects transaction submission, batch mutation and unconfigured reads', async t => {
  const f = await fixture({ rpcUrl: 'http://127.0.0.1:1' }); t.after(() => f.cleanup());
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_unlockAccount', 'evm_mine']) {
    const response = await f.request('/rpc', { jsonrpc: '2.0', id: 1, method, params: [] });
    assert.equal(response.status, 403);
  }
  const batch = await f.request('/rpc', [{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }, { jsonrpc: '2.0', id: 2, method: 'eth_sendTransaction' }] as any);
  assert.equal(batch.status, 403);
  const unavailable = await f.request('/rpc', { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  assert.equal(unavailable.status, 502);
});

test('two provider failures are retained as a failed report, never replaced by demo results', async t => {
  const f = await fixture({ openaiKey: 'test-only', anthropicKey: 'test-only', openaiModel: 'chosen-openai', anthropicModel: 'chosen-anthropic' }, async slot => ({
    slot, provider: slot === 'a' ? 'Anthropic' : 'OpenAI', requested_model: slot === 'a' ? 'chosen-anthropic' : 'chosen-openai',
    returned_model: null, status: 'failed', verdict: null, reason: null, error_code: 'PROVIDER_UNAVAILABLE',
  } satisfies ModelResult)); t.after(() => f.cleanup());
  const submitted = await f.submit({ content: '等待真实审阅', mode: 'live' });
  await f.service.waitForIdle();
  const job = await (await f.request(`/api/jobs/${submitted.body.job_id}`)).json() as any;
  assert.equal(job.status, 'failed');
  assert.equal(job.payload.mode, 'live');
  assert.equal(job.payload.agreement, 2);
  assert.equal(job.error.code, 'BOTH_MODELS_FAILED');
  assert.equal(job.proof, null);
  assert.ok(job.payload.models.every((model: ModelResult) => model.status === 'failed' && model.reason === null));
});

test('invalid payloads are rejected and unknown report ids return safe errors', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  for (const body of [{ content: '' }, { content: '   ' }, { content: 12 }, { content: 'x'.repeat(10001) }, { content: 'x', mode: 'unknown' }, { content: 'x', scenario: '<script>' }])
    assert.equal((await f.submit(body)).response.status, 400);
  assert.equal((await f.request('/api/cert/does-not-exist')).status, 404);
  const invalidJson = await fetch(`${f.origin}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid' });
  assert.equal(invalidJson.status, 400);
});

test('concurrent identical request ids produce exactly one persisted job', async t => {
  const f = await fixture({ demoDelayMs: 20 }); t.after(() => f.cleanup());
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.submit({ content: '并发请求', request_id: 'same-request-001', mode: 'demo' })));
  assert.ok(replies.every(result => result.response.status === 202));
  assert.equal(new Set(replies.map(result => result.body.job_id)).size, 1);
  await f.service.waitForIdle();
  assert.equal(f.service.store.jobs.size, 1);
  assert.equal((await fs.readdir(path.join(f.directory, 'data', 'reports'))).filter(name => name.endsWith('.json')).length, 1);
});

test('a broadcast then anchor failure preserves exportable report and tx hash without retry on restart', async t => {
  let anchors = 0;
  const txHash = `0x${'ab'.repeat(32)}`;
  const f = await fixture({ chainMode: 'local', chainId: 31337 }, undefined, {
    async anchor(_input, onBroadcast) { anchors++; await onBroadcast(txHash); throw new Error('simulated confirmation timeout'); },
    close() {},
  }); t.after(() => f.cleanup());
  const submitted = await f.submit({ content: '完整报告仍能下载', mode: 'demo' });
  await f.service.waitForIdle();
  const job = await (await f.request(`/api/jobs/${submitted.body.job_id}`)).json() as any;
  assert.equal(job.status, 'anchor_failed');
  assert.equal(job.proof, null);
  assert.ok(job.results.every((model: ModelResult) => model.status === 'succeeded'));
  assert.match(job.error.message, new RegExp(txHash));
  const report = await (await f.request(`/api/reports/${job.job_id}`)).json() as any;
  assert.equal(report.report.payload.raw_text, '完整报告仍能下载');
  assert.deepEqual(report.hashes, computeHashes(report.report.payload));
  const record = JSON.parse(await fs.readFile(path.join(f.directory, 'data', 'reports', `${job.job_id}.json`), 'utf8'));
  assert.equal(record.broadcastTxHash, txHash);
  await f.restart();
  assert.equal(anchors, 1);
  assert.equal((await (await f.request(`/api/jobs/${job.job_id}`)).json() as any).status, 'anchor_failed');
});

test('QR is generated locally for project URLs and rejects foreign origins', async t => {
  const f = await fixture(); t.after(() => f.cleanup());
  const response = await f.request(`/api/qr?text=${encodeURIComponent(`${f.origin}/cert.html?job=test`)}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /image\/png/);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((await f.request(`/api/qr?text=${encodeURIComponent('https://evil.invalid/cert.html')}`)).status, 400);
  assert.equal(loadServerConfig({}, f.directory).host, '127.0.0.1');
});

test('live adapters use configured official endpoints and returned model metadata; malformed output stays failed', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests: Array<{ url: string; body: any; headers: any }> = [];
  const config = { ...loadServerConfig({}), openaiKey: 'fixture-openai-key', anthropicKey: 'fixture-anthropic-key', openaiModel: 'explicit-openai-model', anthropicModel: 'explicit-anthropic-model' };
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    const result = JSON.stringify({ verdict: 'unable_to_determine', reason: '缺少可独立核对的证据。' });
    return new Response(JSON.stringify(String(url).includes('anthropic') ? { model: 'actual-anthropic-model', stop_reason: 'end_turn', content: [{ type: 'text', text: result }] }
      : { model: 'actual-openai-model', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: result }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const input = '  精确输入\n<script>不执行</script>  ';
  const [a, b] = await Promise.all([callModel('a', input, config), callModel('b', input, config)]);
  assert.equal(a.returned_model, 'actual-anthropic-model');
  assert.equal(b.returned_model, 'actual-openai-model');
  assert.equal(a.status, 'succeeded');
  assert.equal(b.verdict, 'unable_to_determine');
  assert.deepEqual(requests.map(request => request.url).sort(), ['https://api.anthropic.com/v1/messages', 'https://api.openai.com/v1/responses'].sort());
  assert.equal(requests.find(request => request.url.includes('anthropic'))!.body.messages[0].content, input);
  assert.equal(requests.find(request => request.url.includes('openai'))!.body.input[0].content, input);
  assert.equal(requests.find(request => request.url.includes('openai'))!.body.model, config.openaiModel);
  globalThis.fetch = (async () => new Response(JSON.stringify({ model: 'actual-model', status: 'completed', output: [{ content: [{ type: 'output_text', text: '模型未返回JSON，也不能猜一个判断' }] }] }), { status: 200 })) as typeof fetch;
  const malformed = await callModel('b', input, config);
  assert.equal(malformed.status, 'failed');
  assert.equal(malformed.error_code, 'INVALID_MODEL_JSON');
  assert.equal(malformed.verdict, null);
  assert.equal(malformed.reason, null);
  globalThis.fetch = (async () => new Response('private upstream diagnostic', { status: 429 })) as typeof fetch;
  const rateLimited = await callModel('a', input, config);
  assert.equal(rateLimited.error_code, 'PROVIDER_HTTP_429');
  assert.equal(rateLimited.returned_model, null);
});

test('a slow live provider is aborted and produces a failed result', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = ((_url: any, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true });
  })) as typeof fetch;
  const result = await callModel('a', 'timeout fixture', { ...loadServerConfig({}), anthropicModel: 'explicit-model', modelTimeoutMs: 5 });
  assert.equal(result.status, 'failed');
  assert.equal(result.error_code, 'MODEL_TIMEOUT');
  assert.equal(result.verdict, null);
});
