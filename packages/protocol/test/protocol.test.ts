import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  canonicalizeJson, canonicalizePayload, deriveAgreement, hashContent,
  hashPayload, safeParseReportEnvelope, validateReportEnvelope, validateReportPayload,
  type ModelResult,
} from '../src/index.js';

const readFixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const normal = () => validateReportEnvelope(readFixture('normal.demo.json'));
const result = (slot: 'a' | 'b', verdict: ModelResult['verdict'] = 'credible'): ModelResult => ({
  slot, provider: `demo-provider-${slot}`, requested_model: 'fixture-v1',
  returned_model: 'fixture-v1', status: 'succeeded', verdict,
  reason: 'Synthetic fixture result', error_code: null,
});
const failed = (slot: 'a' | 'b'): ModelResult => ({
  ...result(slot), status: 'failed', verdict: null, reason: null,
  returned_model: null, error_code: 'MODEL_TIMEOUT',
});

test('Ethereum Keccak vectors: not standardized SHA3-256', () => {
  assert.equal(hashContent(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(hashContent('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
});

test('raw content preserves whitespace, line endings and Unicode normalization', () => {
  assert.notEqual(hashContent(' text '), hashContent('text'));
  assert.notEqual(hashContent('a\r\nb'), hashContent('a\nb'));
  assert.notEqual(hashContent('\u00e9'), hashContent('e\u0301'));
  const payload = normal().payload;
  assert.equal(validateReportPayload(payload).raw_text, payload.raw_text);
  assert.ok(payload.raw_text.startsWith('  '));
  assert.ok(payload.raw_text.endsWith('  '));
});

test('lone surrogates rejected; paired emoji accepted', () => {
  for (const text of ['\ud800', '\udc00', 'a\ud800b', '\ud800\ud800']) {
    assert.throws(() => hashContent(text), /surrogate/);
    assert.throws(() => canonicalizeJson({ text }), /surrogate/);
  }
  assert.doesNotThrow(() => hashContent('😀'));
  assert.throws(() => canonicalizeJson({ ['\ud800']: 1 }), /surrogate/);
});

test('RFC 8785 number serialization and escaping', () => {
  const input = {
    numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27, -0],
    string: '€$\u000f\nA\u0027B\u0022\\"/',
    literals: [null, true, false],
  };
  assert.equal(
    canonicalizeJson(input),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"string":"€$\\u000f\\nA\u0027B\\"\\\\\\"/"}',
  );
});

test('property names sort lexicographically as UTF-16 code units, including numeric names', () => {
  const input = { '\u20ac': 1, '\r': 2, '\ufb33': 3, '1': 4, '😀': 5, '\u0080': 6, 'ö': 7 };
  assert.equal(canonicalizeJson(input), '{"\\r":2,"1":4,"\u0080":6,"ö":7,"€":1,"😀":5,"דּ":3}');
  assert.equal(canonicalizeJson({ '2': 2, '10': 10 }), '{"10":10,"2":2}');
  assert.equal(canonicalizeJson({ b: [{ z: 1, a: 2 }], a: 3 }), '{"a":3,"b":[{"a":2,"z":1}]}');
});

test('non-JSON inputs are rejected instead of coerced or omitted', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'a', { enumerable: true, get: () => 'secret' });
  for (const value of [NaN, Infinity, -Infinity, undefined, 1n, new Date(), new Array(1), { a: undefined }, cycle, accessor]) {
    assert.throws(() => canonicalizeJson(value), TypeError);
  }
});

test('all agreement branches including successful unable_to_determine', () => {
  assert.equal(deriveAgreement([result('a'), result('b')]), 0);
  assert.equal(deriveAgreement([result('a'), result('b', 'not_credible')]), 1);
  assert.equal(deriveAgreement([result('a', 'unable_to_determine'), result('b')]), 2);
  assert.equal(deriveAgreement([result('a', 'unable_to_determine'), result('b', 'unable_to_determine')]), 2);
  assert.equal(deriveAgreement([result('a'), failed('b')]), 2);
  assert.equal(deriveAgreement([failed('a'), result('b')]), 2);
  assert.equal(deriveAgreement([failed('a'), failed('b')]), null);
});

test('normal payload and independent single-success degraded report are valid', () => {
  assert.equal(normal().payload.mode, 'demo');
  const envelope = normal();
  envelope.payload.models[1] = failed('b');
  envelope.payload.agreement = 2;
  assert.equal(validateReportEnvelope(envelope).payload.agreement, 2);
});

test('missing configured model ID is allowed only for an explicit NOT_CONFIGURED failure', () => {
  const envelope = normal();
  envelope.payload.models[1] = { ...failed('b'), requested_model: '', error_code: 'NOT_CONFIGURED' };
  envelope.payload.agreement = 2;
  assert.equal(validateReportEnvelope(envelope).payload.models[1].requested_model, '');

  envelope.payload.models[1].error_code = 'MODEL_TIMEOUT';
  assert.equal(safeParseReportEnvelope(envelope).success, false);
  envelope.payload.models[1] = { ...result('b'), requested_model: '' };
  assert.equal(safeParseReportEnvelope(envelope).success, false);
  envelope.payload.models[1] = { ...failed('b'), requested_model: ' ', error_code: 'NOT_CONFIGURED' };
  assert.equal(safeParseReportEnvelope(envelope).success, false);
});

test('both failed cannot become a report payload', () => {
  const envelope = normal();
  envelope.payload.models = [failed('a'), failed('b')];
  envelope.payload.agreement = 2;
  assert.throws(() => validateReportEnvelope(envelope), /Both models failed/);
  assert.throws(() => hashPayload(envelope.payload), /Both models failed/);
});

test('schema enforces model order, exact fields and agreement', () => {
  const envelope = normal();
  envelope.payload.models.reverse();
  assert.equal(safeParseReportEnvelope(envelope).success, false);
  const wrongAgreement = normal();
  wrongAgreement.payload.agreement = 1;
  assert.equal(safeParseReportEnvelope(wrongAgreement).success, false);
  assert.equal(safeParseReportEnvelope({ ...normal(), extra: 'forbidden' }).success, false);
  assert.equal(safeParseReportEnvelope({ ...normal(), payload: { ...normal().payload, proof: null } }).success, false);
});

test('schema rejects success/failure inconsistencies and blank content', () => {
  const invalidSuccess = normal();
  invalidSuccess.payload.models[0].verdict = null;
  assert.equal(safeParseReportEnvelope(invalidSuccess).success, false);
  const invalidFailure = normal();
  invalidFailure.payload.models[0].status = 'failed';
  assert.equal(safeParseReportEnvelope(invalidFailure).success, false);
  const blank = normal();
  blank.payload.raw_text = ' \r\n\t';
  assert.equal(safeParseReportEnvelope(blank).success, false);
});

test('reformatting and reordering JSON leaves report hash unchanged', () => {
  const payload = normal().payload;
  const reordered = Object.fromEntries(Object.entries(payload).reverse());
  assert.equal(hashPayload(validateReportPayload(reordered)), hashPayload(payload));
  assert.equal(hashPayload(JSON.parse(JSON.stringify(payload, null, 4))), hashPayload(payload));
});

test('proof is excluded from payload hash and does not prove chain inclusion', () => {
  const envelope = normal();
  const expected = hashPayload(envelope.payload);
  envelope.proof = {
    chain_id: 10143, contract_address: `0x${'11'.repeat(20)}`, certificate_id: '1',
    issuer: `0x${'22'.repeat(20)}`, tx_hash: `0x${'33'.repeat(32)}`,
    block_number: '123', block_time: '2026-10-17T02:00:02Z',
  };
  assert.equal(hashPayload(validateReportEnvelope(envelope).payload), expected);
});

test('fixture hashes are fixed and tampering changes the correct fingerprint', () => {
  const expected = readFixture('expected-hashes.json');
  for (const [filename, key] of [
    ['normal.demo.json', 'normal'],
    ['tampered.demo.json', 'tampered'],
    ['reason-tampered.demo.json', 'reason_tampered'],
  ]) {
    const report = validateReportEnvelope(readFixture(filename!));
    assert.equal(hashContent(report.payload.raw_text), expected[key!].content_hash);
    assert.equal(hashPayload(report.payload), expected[key!].verdict_hash);
  }
  assert.notEqual(expected.normal.content_hash, expected.tampered.content_hash);
  assert.notEqual(expected.normal.verdict_hash, expected.tampered.verdict_hash);
  assert.equal(expected.normal.content_hash, expected.reason_tampered.content_hash);
  assert.notEqual(expected.normal.verdict_hash, expected.reason_tampered.verdict_hash);
  assert.equal(canonicalizePayload(normal().payload), readFileSync(new URL('../fixtures/normal.canonical.txt', import.meta.url), 'utf8'));
});
