import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JobView } from '../types';

export interface StoredJob { job: JobView; submittedAt: string; requestId?: string; requestFingerprint?: string; broadcastTxHash?: string }
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class JobStore {
  readonly jobs = new Map<string, StoredJob>();
  readonly requests = new Map<string, StoredJob>();
  private writes = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}
  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    for (const name of await fs.readdir(this.directory)) {
      if (!JOB_ID.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
      let record: StoredJob;
      try { record = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')); }
      catch { continue; }
      if (record?.job?.job_id !== name.slice(0, -5) || typeof record.submittedAt !== 'string') continue;
      if (['queued', 'running', 'anchoring'].includes(record.job.status)) {
        record.job.status = 'interrupted';
        record.job.error = { code: 'SERVER_RESTARTED', message: `服务重启中断了该任务；已有报告仍可导出，未确认的交易不得视作存证成功。${record.broadcastTxHash ? `已广播交易：${record.broadcastTxHash}；请独立查证，系统不会自动重试。` : ''}` };
        await this.persist(record);
      }
      this.jobs.set(record.job.job_id, record);
      if (record.requestId) this.requests.set(record.requestId, record);
    }
  }
  async persist(record: StoredJob) {
    const id = record.job.job_id;
    if (!JOB_ID.test(id)) throw new Error('Invalid job id');
    // Snapshot now, then serialize writes per job so a slow early write cannot replace a later result.
    const encoded = JSON.stringify(record, null, 2);
    const previous = this.writes.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const temporary = path.join(this.directory, `.${id}.${randomUUID()}.tmp`);
      try { await fs.writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600 }); await fs.rename(temporary, path.join(this.directory, `${id}.json`)); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    });
    this.writes.set(id, current);
    try { await current; } finally { if (this.writes.get(id) === current) this.writes.delete(id); }
  }
  async insert(record: StoredJob) {
    this.jobs.set(record.job.job_id, record);
    if (record.requestId) this.requests.set(record.requestId, record);
    try { await this.persist(record); }
    catch (error) { this.jobs.delete(record.job.job_id); if (record.requestId) this.requests.delete(record.requestId); throw error; }
  }
  latest() { return [...this.jobs.values()].reverse().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0]?.job || null; }
  byCertificate(id: string) { return [...this.jobs.values()].find(record => record.job.proof?.certificate_id === id)?.job || null; }
}
