import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import { keccak256, toUtf8Bytes } from 'ethers';
import { createChainWriter, type ChainWriter } from './chain-writer';
import { canonicalize, computeHashes, deriveAgreement } from './protocol';
import type { JobView, ModelResult, ReportPayload } from './types';
import { loadServerConfig, liveAvailable, chainConfigured, type ServerConfig } from './server/config';
import { JobStore, type StoredJob } from './server/store';
import { callModel, demoResult, PROMPT_HASH, RULE_VERSION, type DemoScenario, type ModelRunner } from './server/models';

export { loadServerConfig } from './server/config';
export interface ServerOptions { config?: ServerConfig; modelRunner?: ModelRunner; chainWriter?: ChainWriter | null; static_root?: string }
const asyncRoute = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { handler(req, res, next).catch(next); };
const readonlyRpc = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_getLogs', 'eth_getBlockByHash', 'eth_getBlockByNumber',
  'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call', 'net_version', 'web3_clientVersion']);
const hash = (value: unknown) => keccak256(toUtf8Bytes(canonicalize(value)));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sleep = (duration: number) => new Promise<void>(resolve => setTimeout(resolve, duration));

export async function createCrossCheckServer(options: ServerOptions = {}) {
  const config = options.config || loadServerConfig();
  const staticRoot = path.resolve(options.static_root || config.rootDir);
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' }); next();
  });
  app.use(express.json({ limit: '48kb', strict: true }));
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.get('origin')) {
      try { if (new URL(req.get('origin')!).host !== req.get('host')) return res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: '请从本服务的页面提交。' } }); }
      catch { return res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: '请求来源无效。' } }); }
    }
    next();
  });

  const assets = new Map([
    ['/', 'index.html'], ['/index.html', 'index.html'], ['/submit.html', 'submit.html'], ['/screen.html', 'screen.html'], ['/cert.html', 'cert.html'],
    ['/browser-shared.js', 'browser-shared.js'], ['/vendor/ethers.js', 'node_modules/ethers/dist/ethers.umd.min.js'],
    ['/index-page.js', 'index-page.js'], ['/submit-page.js', 'submit-page.js'], ['/screen-page.js', 'screen-page.js'], ['/cert-page.js', 'cert-page.js'],
    ['/front-overrides.css', 'front-overrides.css'],
  ]);
  for (const [route, filename] of assets) {
    const assetRoot = route === '/vendor/ethers.js' ? config.rootDir : staticRoot;
    app.get(route, (req, res, next) => res.sendFile(path.resolve(assetRoot, filename), error => { if (error) next(error); }));
  }
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  const store = new JobStore(path.join(config.dataDir, 'reports'));
  await store.init();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pending = new Set<Promise<void>>();
  let activeCount = 0;
  let writer: ChainWriter | null = null;
  if (options.chainWriter !== undefined) writer = options.chainWriter;
  else if (chainConfigured(config)) writer = createChainWriter({ rpcUrl: config.rpcUrl, privateKey: config.privateKey, contractAddress: config.contractAddress,
    issuerAddress: config.issuerAddress || undefined, chainId: config.chainId, chainMode: config.chainMode as 'local' | 'monad' });

  // Only explicit configuration enables a remote teammate's API. Local files remain served by the allowlist above.
  const remote = config.backendOrigin && ![ `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}` ].includes(config.backendOrigin);
  if (remote) {
    const remoteUrl = new URL(config.backendOrigin);
    if (!['http:', 'https:'].includes(remoteUrl.protocol) || remoteUrl.username || remoteUrl.password) throw new Error('BACKEND_ORIGIN must be an HTTP(S) origin');
    app.use('/api', asyncRoute(async (req, res) => {
      const controller = new AbortController();
      const isStream = req.path.startsWith('/stream/');
      const timer = isStream ? null : setTimeout(() => controller.abort(), 60000);
      res.on('close', () => controller.abort());
      try {
        const response = await fetch(`${config.backendOrigin}/api${req.url}`, { method: req.method, signal: controller.signal,
          headers: req.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
          body: req.method === 'POST' ? JSON.stringify(req.body) : undefined });
        res.status(response.status);
        res.setHeader('content-type', response.headers.get('content-type') || 'application/json');
        if (req.path === '/config' && response.ok) return res.json({ ...await response.json() as object, backendMode: 'remote' });
        if (!response.body) return res.end();
        if (isStream) res.flushHeaders();
        for await (const chunk of response.body as any) { if (res.destroyed) break; res.write(chunk); }
        res.end();
      } catch { if (!res.headersSent) res.status(502).json({ error: { code: 'BACKEND_UNAVAILABLE', message: '队友后端暂时不可用，请检查BACKEND_ORIGIN。' } }); else res.end(); }
      finally { if (timer) clearTimeout(timer); }
    }));
  }

  app.get('/api/config', (_req, res) => res.json({
    chainId: config.chainId, contractAddress: config.contractAddress, issuerAddress: config.issuerAddress,
    deploymentBlock: config.deploymentBlock, rpcUrl: config.rpcUrl ? '/rpc' : '', explorerUrl: config.explorerUrl,
    mode: config.mode, chainMode: writer ? config.chainMode : 'unconfigured', liveAvailable: liveAvailable(config), backendMode: 'local', publicOrigin: config.publicOrigin,
  }));
  app.get('/api/qr', asyncRoute(async (req, res) => {
    const text = req.query.text;
    if (typeof text !== 'string' || text.length > 2000) return res.status(400).json({ error: { code: 'INVALID_QR_URL', message: '二维码URL无效。' } });
    try {
      const target = new URL(text);
      const allowedOrigins = new Set([`${req.protocol}://${req.get('host')}`]);
      if (config.publicOrigin) allowedOrigins.add(new URL(config.publicOrigin).origin);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || !allowedOrigins.has(target.origin) || !['/cert.html', '/submit.html', '/screen.html', '/', '/index.html'].includes(target.pathname)) throw new Error('invalid');
    } catch { return res.status(400).json({ error: { code: 'INVALID_QR_URL', message: '二维码只支持本项目页面URL。' } }); }
    res.type('image/png').send(await QRCode.toBuffer(text, { width: 320, margin: 2, errorCorrectionLevel: 'M' }));
  }));
  app.post('/rpc', asyncRoute(async (req, res) => {
    if (!config.rpcUrl) return res.status(503).json({ error: { code: 'RPC_UNCONFIGURED', message: '尚未配置RPC。' } });
    const batch = Array.isArray(req.body) ? req.body : [req.body];
    if (!batch.length || batch.length > 20 || batch.some(call => !call || typeof call !== 'object' || call.jsonrpc !== '2.0' || !readonlyRpc.has(call.method)))
      return res.status(403).json({ error: { code: 'RPC_METHOD_REJECTED', message: '此代理只允许读取链上证据。' } });
    try {
      const response = await fetch(config.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(15000) });
      if (!response.ok) return res.status(502).json({ error: { code: 'RPC_UNAVAILABLE', message: 'RPC读取失败。' } });
      res.json(await response.json());
    } catch { res.status(502).json({ error: { code: 'RPC_UNAVAILABLE', message: 'RPC读取失败或超时。' } }); }
  }));

  const emit = (job: JobView) => events.emit(job.job_id, 'job', clone(job));
  const update = async (record: StoredJob) => { await store.persist(record); emit(record.job); };
  const terminal = (job: JobView) => ['confirmed', 'failed', 'anchor_failed', 'interrupted'].includes(job.status) || (job.status === 'report_ready' && !writer);
  async function processJob(record: StoredJob, content: string, scenario: DemoScenario) {
    const job = record.job;
    try {
      job.status = 'running'; await update(record);
      const run = async (slot: 'a' | 'b') => {
        let result: ModelResult;
        if (job.mode === 'demo') { await sleep(config.demoDelayMs * (slot === 'a' ? 1 : 2)); result = demoResult(slot, scenario); }
        else result = await (options.modelRunner || callModel)(slot, content, config);
        job.results = [...job.results.filter(item => item.slot !== slot), result].sort((a, b) => a.slot.localeCompare(b.slot));
        events.emit(job.job_id, 'delta', { slot, delta: result.reason || `调用失败：${result.error_code}` });
        await update(record);
        return result;
      };
      const models = await Promise.all([run('a'), run('b')]) as [ModelResult, ModelResult];
      const payload: ReportPayload = {
        schema_version: '1', job_id: job.job_id, mode: job.mode, raw_text: content, submitted_at: record.submittedAt,
        completed_at: new Date().toISOString(), rule_version: RULE_VERSION, prompt_hash: PROMPT_HASH,
        model_config_hash: hash(job.mode === 'demo' ? { mode: 'demo', sample_version: 'fixed-demo-v1', scenario }
          : { mode: 'live', a: { provider: 'Anthropic', model: config.anthropicModel }, b: { provider: 'OpenAI', model: config.openaiModel } }),
        models, agreement: deriveAgreement(models),
      };
      job.payload = payload; job.hashes = computeHashes(payload);
      if (models.every(model => model.status === 'failed')) {
        job.status = 'failed'; job.error = { code: 'BOTH_MODELS_FAILED', message: '两个模型调用均失败；已保存失败报告，没有生成链上凭证。' }; await update(record); return;
      }
      job.status = 'report_ready'; await update(record);
      if (!writer) return;
      job.status = 'anchoring'; await update(record);
      try {
        job.proof = await writer.anchor({ job_id: job.job_id, ...job.hashes, agreement: payload.agreement }, async txHash => {
          // Broadcast does not create a proof. A proof is attached only after the writer validates its receipt and event.
          if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('INVALID_BROADCAST_HASH');
          record.broadcastTxHash = txHash;
          await update(record);
        });
        job.status = 'confirmed'; job.error = null; await update(record);
      } catch (error) {
        const possibleHash = error && typeof error === 'object' && 'tx_hash' in error ? error.tx_hash : null;
        if (!record.broadcastTxHash && typeof possibleHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(possibleHash)) record.broadcastTxHash = possibleHash;
        job.status = 'anchor_failed'; job.error = { code: 'ANCHOR_FAILED', message: `链上存证未确认；报告已保留，可导出，不能作为已上链凭证。${record.broadcastTxHash ? `已广播交易：${record.broadcastTxHash}；请独立查证，系统不会自动重试。` : ''}` }; await update(record);
      }
    } catch {
      job.status = 'failed'; job.error = { code: 'PROCESSING_FAILED', message: '处理失败，没有生成确认的凭证。' };
      await update(record).catch(() => emit(job));
    }
  }

  app.post('/api/verify', asyncRoute(async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.content !== 'string' || !body.content.trim() || body.content.length > 10000)
      return res.status(400).json({ error: { code: 'INVALID_CONTENT', message: '请输入1至10000字符的内容。' } });
    const mode = body.mode === undefined ? config.mode : body.mode;
    if (mode !== 'demo' && mode !== 'live') return res.status(400).json({ error: { code: 'INVALID_MODE', message: 'mode必须是demo或live。' } });
    const scenario = body.scenario || 'agreement';
    if (!['agreement', 'disagreement', 'unable'].includes(scenario)) return res.status(400).json({ error: { code: 'INVALID_SCENARIO', message: '未知的演示样例。' } });
    if (mode === 'live' && !liveAvailable(config)) return res.status(503).json({ error: { code: 'LIVE_UNAVAILABLE', message: '实时模式需要两个API Key和两个明确的模型ID；当前没有调用任何AI。' } });
    const requestId = body.request_id;
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)))
      return res.status(400).json({ error: { code: 'INVALID_REQUEST_ID', message: 'request_id须为8至128位字母、数字、下划线或连字符。' } });
    const fingerprint = hash({ content: body.content, mode, scenario });
    const existing = requestId ? store.requests.get(requestId) : null;
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) return res.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: '同一个request_id不能用于不同的内容。' } });
      return res.status(202).json({ job_id: existing.job.job_id });
    }
    if (activeCount >= config.maxActiveJobs) return res.status(429).json({ error: { code: 'BUSY', message: '当前任务较多，请稍后再试。' } });
    activeCount++;
    const job: JobView = { job_id: randomUUID(), mode, status: 'queued', results: [], payload: null, hashes: null, proof: null, error: null };
    const record: StoredJob = { job, submittedAt: new Date().toISOString(), ...(requestId ? { requestId, requestFingerprint: fingerprint } : {}) };
    try { await store.insert(record); }
    catch { activeCount--; return res.status(500).json({ error: { code: 'STORAGE_UNAVAILABLE', message: '报告存储不可用，任务未启动。' } }); }
    res.status(202).json({ job_id: job.job_id });
    const task = processJob(record, body.content, scenario as DemoScenario).finally(() => { activeCount--; pending.delete(task); });
    pending.add(task);
  }));
  app.get('/api/jobs/latest', (_req, res) => res.json(store.latest()));
  app.get('/api/jobs/:id', (req, res) => {
    const record = store.jobs.get(req.params.id);
    if (!record) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '任务不存在。' } });
    res.json(record.job);
  });
  app.get('/api/stream/:id', (req, res) => {
    const record = store.jobs.get(req.params.id);
    if (!record) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '任务不存在。' } });
    res.set({ 'content-type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    const send = (event: string, value: unknown) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); };
    send('job', record.job);
    if (terminal(record.job)) return res.end();
    const listener = (event: string, value: any) => { send(event, value); if (event === 'job' && terminal(value)) res.end(); };
    events.on(req.params.id, listener);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
    res.on('close', () => { clearInterval(heartbeat); events.off(req.params.id, listener); });
  });
  const reportResponse = (job: JobView | null, res: Response) => {
    if (!job) return res.status(404).json({ error: { code: 'NOT_FOUND', message: '报告不存在。' } });
    if (!job.payload || !job.hashes) return res.status(409).json({ error: { code: 'REPORT_PENDING', message: '报告尚未生成。' } });
    res.json({ report: { payload: job.payload, proof: job.proof }, hashes: job.hashes });
  };
  app.get('/api/reports/:jobId', (req, res) => reportResponse(store.jobs.get(req.params.jobId)?.job || null, res));
  app.get('/api/cert/:id', (req, res) => reportResponse(store.jobs.get(req.params.id)?.job || store.byCertificate(req.params.id), res));
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '页面或接口不存在。' } }));
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return res.end();
    const status = error.status === 413 ? 413 : error.type === 'entity.parse.failed' ? 400 : error.status === 404 ? 404 : 500;
    res.status(status).json({ error: { code: status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 400 ? 'INVALID_JSON' : status === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', message: '请求无法处理。' } });
  });
  return { app, config, store, waitForIdle: () => Promise.allSettled([...pending]), close: () => writer?.close() };
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  const service = await createCrossCheckServer();
  service.app.listen(service.config.port, service.config.host, () => {
    console.log(`CrossCheck: http://localhost:${service.config.port} (${service.config.mode}; chain=${service.config.chainMode}; live=${liveAvailable(service.config)})`);
  });
}
