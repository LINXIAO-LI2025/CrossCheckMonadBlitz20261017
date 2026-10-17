import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './config.js';

test('default configuration is demo with no fabricated deployment or model IDs', async () => {
  const config = await loadConfig({ DEPLOYMENT_FILE: 'does-not-exist.json' });
  assert.equal(config.mode, 'demo'); assert.equal(config.chain_enabled, false);
  assert.equal(config.public.chain_id, 10143); assert.equal(config.public.contract_address, null);
  assert.equal(config.models.openai?.model, undefined); assert.equal(config.models.anthropic?.model, undefined);
});
test('invalid limits and modes fail before serving traffic', async () => {
  for (const env of [{ MODE: 'unknown' }, { PORT: '0' }, { MAX_CONCURRENT_JOBS: '0' },
    { MAX_QUEUE_SIZE: '-1' }, { CHAIN_ENABLED: 'yes' }, { MODEL_TIMEOUT_MS: 'NaN' }]) {
    await assert.rejects(loadConfig(env));
  }
});
test('deployment rejects mainnet, placeholder addresses and unsafe numeric block numbers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'crosscheck-config-'));
  const file = join(dir, 'deployment.json');
  const valid = { chainId: 10143, contract: `0x${'1'.repeat(40)}`, issuer: `0x${'2'.repeat(40)}`, abi: [], deploymentBlock: '1' };
  try {
    for (const change of [{ chainId: 143 }, { contract: `0x${'0'.repeat(40)}` },
      { issuer: `0x${'0'.repeat(40)}` }, { deploymentBlock: Number.MAX_SAFE_INTEGER + 1 }, { abi: undefined }]) {
      await writeFile(file, JSON.stringify({ ...valid, ...change }));
      await assert.rejects(loadConfig({ DEPLOYMENT_FILE: file }), /Invalid Monad testnet deployment/);
    }
    await writeFile(file, JSON.stringify({ ...valid, deploymentBlock: '9007199254740993' }));
    const config = await loadConfig({ DEPLOYMENT_FILE: file, ISSUER_PRIVATE_KEY: 'test-private-value' });
    assert.equal(config.public.deployment_block, '9007199254740993');
    assert.doesNotMatch(JSON.stringify(config.public), /test-private-value|private_key/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
