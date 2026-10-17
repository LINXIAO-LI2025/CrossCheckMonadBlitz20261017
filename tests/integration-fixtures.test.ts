import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { hashContent, hashPayload, validateReportEnvelope } from '@crosscheck/protocol';
import { computeHashes as legacyHashes } from '../protocol.js';

test('B historical anchored fixtures preserve hashes under A shared protocol and rebuilt showcase bundle', async () => {
  const samples = JSON.parse(await readFile(new URL('../docs/samples.json', import.meta.url), 'utf8'));
  assert.equal(await readFile(new URL('../docs/samples.json', import.meta.url), 'utf8'), await readFile(new URL('../showcase/samples.json', import.meta.url), 'utf8'));
  const context = vm.createContext({ TextEncoder, TextDecoder, Uint8Array });
  vm.runInContext('globalThis.window = globalThis;', context);
  vm.runInContext(await readFile(new URL('../docs/shared.js', import.meta.url), 'utf8'), context);
  for (const sample of samples) {
    const report = validateReportEnvelope(sample.report);
    assert.equal(report.payload.mode, 'demo');
    assert.equal(report.proof?.chain_id, 10143);
    const hashes = { content_hash: hashContent(report.payload.raw_text), verdict_hash: hashPayload(report.payload) };
    assert.deepEqual(hashes, legacyHashes(report.payload));
    assert.equal(context.ShowcaseProtocol.validateReportEnvelope(sample.report).valid, true);
    // JSON downloads are parsed in the browser realm, not passed as Node object prototypes.
    context.payloadJson = JSON.stringify(report.payload);
    const browserHashes = vm.runInContext('ShowcaseProtocol.computeHashes(JSON.parse(payloadJson))', context);
    assert.equal(browserHashes.content_hash, hashes.content_hash);
    assert.equal(browserHashes.verdict_hash, hashes.verdict_hash);
    const tampered = structuredClone(report.payload);
    tampered.models[0].reason += ' tampered';
    assert.notEqual(hashPayload(tampered), hashes.verdict_hash);
  }
  assert.equal(samples.length, 3);
});
