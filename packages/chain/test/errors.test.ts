import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeError } from '../src/core.js';

test('RPC read timeout stays unavailable even when a transaction hash is known', () => {
  const tx_hash = '0x' + 'a'.repeat(64);
  const timeout = Object.assign(new Error('isolated RPC timeout fixture'), { code: 'TIMEOUT' });
  const error = normalizeError(timeout, tx_hash) as Error & { code: string; tx_hash?: string };
  assert.equal(error.code, 'CHAIN_UNAVAILABLE');
  assert.equal(error.tx_hash, tx_hash);
});
