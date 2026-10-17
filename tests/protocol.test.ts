import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, compareCertificate, computeHashes, deriveAgreement, hashContent, hashPayload, validateReportEnvelope } from '../protocol';
import type { CertificateRecord, ModelResult, ReportEnvelope, ReportPayload } from '../types';

const model = (slot: 'a' | 'b'): ModelResult => ({ slot, provider: 'fixed-demo', requested_model: 'fixed-v1', returned_model: 'fixed-v1', status: 'succeeded', verdict: 'questionable', reason: '缺少可核对的证据', error_code: null });
const payload = (): ReportPayload => ({ schema_version: '1', job_id: 'test-job', mode: 'demo', raw_text: ' 原文\n', submitted_at: '2026-10-17T00:00:00.000Z', completed_at: '2026-10-17T00:00:01.000Z', rule_version: '1', prompt_hash: hashContent('prompt'), model_config_hash: hashContent('config'), models: [model('a'), model('b')], agreement: 0 });
const envelope = (): ReportEnvelope => ({ payload: payload(), proof: { chain_id: 31337, contract_address: '0x1111111111111111111111111111111111111111', certificate_id: '1', issuer: '0x2222222222222222222222222222222222222222', tx_hash: '0x' + 'a'.repeat(64), block_number: '2', block_time: '1792195201' } });

test('recursive canonical JSON retains nested model keys and preserves array order', () => {
  assert.equal(canonicalize({ z: [{ reason: '理由', a: 1 }], a: { z: 0, a: true } }), '{"a":{"a":true,"z":0},"z":[{"a":1,"reason":"理由"}]}');
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  assert.equal(canonicalize(-0), '0');
  const first = payload();
  const changed = structuredClone(first);
  changed.models[1].reason = '被替换的理由';
  assert.notEqual(hashPayload(first), hashPayload(changed));
  changed.models[1].reason = first.models[1].reason;
  changed.models[1].returned_model = 'other-model';
  assert.notEqual(hashPayload(first), hashPayload(changed));
});

test('exact original whitespace and Unicode are hashed without normalization', () => {
  assert.notEqual(hashContent(' 原文\n'), hashContent('原文'));
  assert.notEqual(hashContent('é'), hashContent('e\u0301'));
  assert.equal(hashContent('😀'), hashContent('😀'));
});

test('canonical JSON refuses lossy or invalid input', () => {
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), { a: undefined }, [undefined], '\ud800', { '\udfff': 1 }]) assert.throws(() => canonicalize(value));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => canonicalize(cycle));
  assert.throws(() => canonicalize(Array(1)));
  assert.throws(() => hashContent('\ud800'));
});

test('failed or unable models never produce agreement=0', () => {
  const models = [model('a'), model('b')];
  assert.equal(deriveAgreement(models), 0);
  models[1].verdict = 'credible'; assert.equal(deriveAgreement(models), 1);
  models[1].verdict = 'unable_to_determine'; assert.equal(deriveAgreement(models), 2);
  models[0].verdict = 'unable_to_determine'; assert.equal(deriveAgreement(models), 2);
  models[1].status = 'failed'; models[1].verdict = null; models[1].reason = null; models[1].error_code = 'TIMEOUT';
  assert.equal(deriveAgreement(models), 2);
});

test('schema validation rejects malformed structures without throwing', () => {
  assert.equal(validateReportEnvelope(envelope()).valid, true);
  assert.equal(validateReportEnvelope({ payload: payload(), proof: null }).valid, true);
  for (const malformed of [null, [], {}, { payload: null }, { payload: { raw_text: 42 }, proof: null }]) assert.equal(validateReportEnvelope(malformed).valid, false);
  const changes: ((report: any) => void)[] = [
    r => r.payload.models[1].slot = 'a',
    r => r.payload.models[0].status = 'failed',
    r => r.payload.agreement = 0.5,
    r => r.payload.models[0].verdict = 'made-up',
    r => r.payload.prompt_hash = 'not-a-hash',
    r => r.payload.completed_at = '2026-02-30T00:00:00.000Z',
    r => r.payload.completed_at = '2026-10-16T00:00:00.000Z',
    r => r.payload.models = [null, {}],
    r => r.payload.extra = true,
    r => r.proof.chain_id = 1,
    r => r.proof.block_number = 2,
    r => r.proof.certificate_id = '0',
    r => r.proof.tx_hash = '0xab',
  ];
  for (const change of changes) { const report = envelope(); change(report); assert.equal(validateReportEnvelope(report).valid, false); }
});

test('chain comparison detects every report/identity change', () => {
  const report = envelope();
  const record: CertificateRecord = { proof: structuredClone(report.proof!), ...computeHashes(report.payload), agreement: 0 };
  assert.equal(compareCertificate(report, record).valid, true);
  const nestedTamper = structuredClone(report); nestedTamper.payload.models[0].reason = '替换审核理由';
  assert.equal(compareCertificate(nestedTamper, record).valid, false);
  const textTamper = structuredClone(report); textTamper.payload.raw_text = textTamper.payload.raw_text.trim();
  assert.equal(compareCertificate(textTamper, record).valid, false);
  for (const key of ['chain_id', 'certificate_id', 'block_number', 'block_time', 'contract_address', 'issuer', 'tx_hash'] as const) {
    const changed = structuredClone(report);
    if (key === 'chain_id') changed.proof![key] = 10143;
    else if (key === 'contract_address' || key === 'issuer') changed.proof![key] = '0x3333333333333333333333333333333333333333';
    else if (key === 'tx_hash') changed.proof![key] = '0x' + 'b'.repeat(64);
    else changed.proof![key] = '9';
    assert.equal(compareCertificate(changed, record).valid, false, key);
  }
  assert.equal(compareCertificate({ payload: report.payload, proof: null }, record).valid, false);
});
