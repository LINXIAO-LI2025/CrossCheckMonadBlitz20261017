import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createCrossCheckServer, loadServerConfig } from '../server';

test('legacy B serves its matching historical page and camelCase API independently from A pages', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crosscheck-legacy-web-'));
  const config = { ...loadServerConfig({}, root), dataDir: directory, demoDelayMs: 1 };
  const service = await createCrossCheckServer({ config, chainWriter: null, static_root: path.join(root, 'legacy', 'b-web') });
  const server = await new Promise<Server>(resolve => {
    const handle = service.app.listen(0, '127.0.0.1', () => resolve(handle));
  });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => {
    await service.waitForIdle();
    service.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const html = await (await fetch(`${origin}/submit.html`)).text();
  assert.match(html, /id="modeInput"/);
  assert.doesNotMatch(html, /vendor\/protocol\.js/);
  const script = await (await fetch(`${origin}/submit-page.js`)).text();
  assert.match(script, /config\?\.liveAvailable/);
  assert.match(script, /scenario:/);
  const publicConfig = await (await fetch(`${origin}/api/config`)).json() as any;
  assert.equal(publicConfig.chainId, 10143);
  assert.equal(publicConfig.contractAddress, '');
  assert.equal('chain_id' in publicConfig, false);
  assert.equal((await fetch(`${origin}/vendor/ethers.js`)).status, 200);
  const content = '  legacy B original text  ';
  const accepted = await fetch(`${origin}/api/verify`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, mode: 'demo', scenario: 'disagreement' }) });
  assert.equal(accepted.status, 202);
  const { job_id } = await accepted.json() as any;
  await service.waitForIdle();
  const result = await (await fetch(`${origin}/api/reports/${job_id}`)).json() as any;
  assert.equal(result.report.payload.raw_text, content);
  assert.equal(result.report.payload.agreement, 1);
  assert.equal(result.report.proof, null);
});
