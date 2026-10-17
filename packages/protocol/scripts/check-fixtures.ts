import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalizePayload, hashContent, hashPayload, validateReportEnvelope } from '../src/index.js';

const directory = new URL('../fixtures/', import.meta.url);
const readJson = async (filename: string) => JSON.parse(await readFile(new URL(filename, directory), 'utf8'));
const expected = await readJson('expected-hashes.json');
for (const [filename, key] of [
  ['normal.demo.json', 'normal'],
  ['tampered.demo.json', 'tampered'],
  ['reason-tampered.demo.json', 'reason_tampered'],
] as const) {
  const report = validateReportEnvelope(await readJson(filename));
  assert.deepEqual({
    content_hash: hashContent(report.payload.raw_text),
    verdict_hash: hashPayload(report.payload),
  }, expected[key]);
  if (key === 'normal') {
    assert.equal(canonicalizePayload(report.payload), await readFile(new URL('normal.canonical.txt', directory), 'utf8'));
  }
  console.log(`PASS ${filename}: deterministic hashes match`);
}
assert.notEqual(expected.normal.content_hash, expected.tampered.content_hash);
assert.notEqual(expected.normal.verdict_hash, expected.tampered.verdict_hash);
assert.equal(expected.normal.content_hash, expected.reason_tampered.content_hash);
assert.notEqual(expected.normal.verdict_hash, expected.reason_tampered.verdict_hash);
console.log('PASS text edits change both hashes; model reason edits change only verdict_hash');
