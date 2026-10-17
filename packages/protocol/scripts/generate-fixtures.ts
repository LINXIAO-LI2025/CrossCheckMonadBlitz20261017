import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  canonicalizeJson, canonicalizePayload, hashContent, hashPayload,
  validateReportEnvelope, type ReportEnvelope,
} from '../src/index.js';

// These are explicit synthetic fixtures. They never call a model or a chain.
const fixtureRule = 'CrossCheck demo fixture rule v1: evaluate the supplied text independently; return a verdict and reason. This fixture is synthetic.';
const fixtureModelConfig = {
  a: { provider: 'demo-provider-a', requested_model: 'fixture-a-v1' },
  b: { provider: 'demo-provider-b', requested_model: 'fixture-b-v1' },
};
const normal: ReportEnvelope = validateReportEnvelope({
  payload: {
    schema_version: '1',
    job_id: 'demo-fixture-20261017-001',
    mode: 'demo',
    raw_text: '  演示文本：这是一条待核对的信息。\r\nCrossCheck demo — not a real model call.  ',
    submitted_at: '2026-10-17T10:00:00+08:00',
    completed_at: '2026-10-17T10:00:01+08:00',
    rule_version: 'demo-fixture-rule-v1',
    prompt_hash: hashContent(fixtureRule),
    model_config_hash: hashContent(canonicalizeJson(fixtureModelConfig)),
    models: [
      {
        slot: 'a', provider: 'demo-provider-a', requested_model: 'fixture-a-v1',
        returned_model: 'fixture-a-v1', status: 'succeeded',
        verdict: 'questionable', reason: '演示结果 A：缺少可核验来源，需进一步核对。', error_code: null,
      },
      {
        slot: 'b', provider: 'demo-provider-b', requested_model: 'fixture-b-v1',
        returned_model: 'fixture-b-v1', status: 'succeeded',
        verdict: 'questionable', reason: '演示结果 B：此文本没有提供支持其结论的证据。', error_code: null,
      },
    ],
    agreement: 0,
  },
  proof: null,
});
const tampered = structuredClone(normal);
tampered.payload.raw_text += '\n篡改：新增的文字不在原始报告中。';
const reasonTampered = structuredClone(normal);
reasonTampered.payload.models[0].reason += ' [edited]';
const expected = {
  description: 'Synthetic demo fixtures only. No provider requests or blockchain transactions occurred.',
  algorithm: 'Ethereum Keccak-256; RFC 8785 JSON canonicalization semantics',
  rule_text: fixtureRule,
  model_config: fixtureModelConfig,
  normal: { content_hash: hashContent(normal.payload.raw_text), verdict_hash: hashPayload(normal.payload) },
  tampered: { content_hash: hashContent(tampered.payload.raw_text), verdict_hash: hashPayload(tampered.payload) },
  reason_tampered: { content_hash: hashContent(reasonTampered.payload.raw_text), verdict_hash: hashPayload(reasonTampered.payload) },
};
const directory = new URL('../fixtures/', import.meta.url);
await mkdir(directory, { recursive: true });
for (const [filename, value] of Object.entries({
  'normal.demo.json': normal,
  'tampered.demo.json': tampered,
  'reason-tampered.demo.json': reasonTampered,
  'expected-hashes.json': expected,
})) {
  await writeFile(new URL(filename, directory), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
await writeFile(new URL('normal.canonical.txt', directory), canonicalizePayload(normal.payload), 'utf8');
console.log(`Wrote deterministic demo fixtures to ${fileURLToPath(directory)}`);
