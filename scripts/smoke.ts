import assert from 'node:assert/strict';
import { hashContent, hashPayload, validateReportEnvelope } from '@crosscheck/protocol';
const base = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
const raw = '[demo:disagree]  CrossCheck 本地冒烟测试\r\n  ';
const health = await fetch(`${base}/api/health`).then((r) => r.json()) as { mode: string };
assert.equal(health.mode, 'demo', 'Smoke script only runs in explicit demo mode');
const submitted = await fetch(`${base}/api/verify`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: raw }),
});
assert.equal(submitted.status, 202);
const job = await submitted.json() as { job_id: string; stream_url: string };
const events = await fetch(`${base}${job.stream_url}`).then((r) => r.text());
assert.match(events, /event: report_ready/); assert.match(events, /event: done/);
const download = await fetch(`${base}/api/jobs/${job.job_id}/report`);
assert.equal(download.status, 200);
const report = validateReportEnvelope(await download.json());
assert.equal(report.payload.raw_text, raw); assert.equal(report.payload.mode, 'demo'); assert.equal(report.proof, null);
assert.equal(report.payload.agreement, 1);
const tampered = structuredClone(report.payload); tampered.raw_text += '!';
assert.notEqual(hashPayload(tampered), hashPayload(report.payload));
const again = await fetch(`${base}/api/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: raw }) }).then((r) => r.json()) as { job_id: string };
assert.equal(again.job_id, job.job_id);
console.log(JSON.stringify({ result: 'PASS', mode: 'demo', job_id: job.job_id,
  content_hash: hashContent(raw), verdict_hash: hashPayload(report.payload), proof: null,
  checks: ['202', 'SSE replay', 'exact raw text', 'JSON download', 'tamper detection', 'cache reuse'] }, null, 2));
