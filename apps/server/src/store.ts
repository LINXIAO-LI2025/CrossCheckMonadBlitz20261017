import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalizeJson, chainProofSchema, hashContent, hashPayload, hashSchema,
  isValidUnicode, jobStatusSchema, modelResultSchema, reportHashesSchema,
  validateReportPayload, type JobView } from '@crosscheck/protocol';

export interface StoredEvent { id: number; event: string; data: Record<string, unknown> & { job_id: string } }
export interface StoredJob extends JobView {
  raw_text: string; submitted_at: string; cache_key: string;
  events: StoredEvent[]; finished: boolean;
  anchor: { attempted_at: string | null; tx_hash: string | null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' &&
  value.trim().length > 0 && isValidUnicode(value);
const timestamp = (value: unknown): value is string => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new Error('CORRUPT_JOB_STORE');
}
function same(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}
function validError(value: unknown): boolean {
  return object(value) && text(value.code) && text(value.message) &&
    Object.keys(value).every((key) => key === 'code' || key === 'message');
}

/** Check local snapshots as untrusted data before recovery, caching, or SSE replay. */
export function validateStoredJob(value: unknown, expectedId?: string): StoredJob {
  try {
    requireValid(object(value));
    const job = value as unknown as StoredJob;
    requireValid(typeof job.job_id === 'string' && UUID.test(job.job_id));
    requireValid(expectedId === undefined || job.job_id === expectedId);
    requireValid(job.mode === 'demo' || job.mode === 'live');
    jobStatusSchema.parse(job.status);
    requireValid(text(job.raw_text) && timestamp(job.submitted_at));
    hashSchema.parse(job.cache_key);
    requireValid(typeof job.finished === 'boolean');
    requireValid(job.error === null || validError(job.error));
    requireValid(object(job.anchor));
    requireValid(job.anchor.attempted_at === null || timestamp(job.anchor.attempted_at));
    requireValid(job.anchor.tx_hash === null || hashSchema.safeParse(job.anchor.tx_hash).success);
    requireValid(job.anchor.tx_hash === null || job.anchor.attempted_at !== null);
    requireValid(Array.isArray(job.results) && job.results.length <= 2);
    for (const result of job.results) modelResultSchema.parse(result);
    requireValid(job.results.every((result, index) => index === 0 || job.results[index - 1]!.slot < result.slot));
    if (job.payload === null) {
      requireValid(job.hashes === null && job.proof === null);
      requireValid(['queued', 'running', 'failed', 'interrupted'].includes(job.status));
      requireValid(job.anchor.attempted_at === null && job.anchor.tx_hash === null);
    } else {
      const payload = validateReportPayload(job.payload);
      const hashes = reportHashesSchema.parse(job.hashes);
      requireValid(payload.job_id === job.job_id && payload.mode === job.mode &&
        payload.raw_text === job.raw_text && payload.submitted_at === job.submitted_at);
      requireValid(same(payload.models, job.results));
      requireValid(hashes.content_hash.toLowerCase() === hashContent(payload.raw_text) &&
        hashes.verdict_hash.toLowerCase() === hashPayload(payload));
      requireValid(!['queued', 'running', 'failed'].includes(job.status));
    }
    if (job.proof !== null) {
      const proof = chainProofSchema.parse(job.proof);
      requireValid(job.mode === 'live' && job.payload !== null && job.status === 'confirmed');
      requireValid(job.anchor.tx_hash?.toLowerCase() === proof.tx_hash.toLowerCase());
    }
    requireValid(job.status !== 'confirmed' || job.proof !== null);
    requireValid(job.mode !== 'demo' || (job.proof === null && job.anchor.attempted_at === null));
    requireValid(!job.finished || !['queued', 'running', 'anchoring'].includes(job.status));
    requireValid(Array.isArray(job.events));
    for (const [index, event] of job.events.entries()) {
      requireValid(object(event) && event.id === index + 1 && object(event.data) && event.data.job_id === job.job_id);
      const data = event.data;
      switch (event.event) {
        case 'job_status': jobStatusSchema.parse(data.status); break;
        case 'model_delta':
          requireValid((data.slot === 'a' || data.slot === 'b') && typeof data.delta === 'string' && isValidUnicode(data.delta));
          break;
        case 'model_result':
        case 'model_error': {
          const result = modelResultSchema.parse(data.result);
          requireValid(data.slot === result.slot && same(job.results.find((item) => item.slot === result.slot), result));
          requireValid(result.status === (event.event === 'model_result' ? 'succeeded' : 'failed'));
          if (event.event === 'model_error') requireValid(validError(data.error) && (data.error as { code: string }).code === result.error_code);
          break;
        }
        case 'report_ready':
          requireValid(job.payload !== null && same(data.payload, job.payload) && same(data.hashes, job.hashes));
          break;
        case 'anchor_submitted':
          hashSchema.parse(data.tx_hash);
          requireValid(job.mode === 'live' && (data.tx_hash as string).toLowerCase() === job.anchor.tx_hash?.toLowerCase());
          break;
        case 'anchor_confirmed':
          requireValid(job.proof !== null && same(data.proof, job.proof));
          break;
        case 'anchor_error':
          requireValid(validError(data.error));
          requireValid(data.tx_hash === undefined || data.tx_hash === null || hashSchema.safeParse(data.tx_hash).success);
          break;
        case 'done':
          jobStatusSchema.parse(data.status);
          requireValid(!['queued', 'running', 'anchoring'].includes(data.status as string));
          break;
        default: throw new Error('CORRUPT_JOB_STORE');
      }
    }
    return job;
  } catch {
    throw new Error('CORRUPT_JOB_STORE');
  }
}

/** A serialized per-job atomic snapshot is the source of truth; indexes rebuild at startup. */
export class JobStore {
  private tail: Promise<void> = Promise.resolve();
  private lock?: Awaited<ReturnType<typeof open>>;
  constructor(readonly directory: string) {}
  async init(): Promise<StoredJob[]> {
    if (this.lock) throw new Error('DATA_DIR_LOCKED');
    await mkdir(this.directory, { recursive: true });
    const lockPath = join(this.directory, '.server.lock');
    try { this.lock = await open(lockPath, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid: number;
      let oldIdentity: Awaited<ReturnType<typeof stat>>;
      try {
        oldIdentity = await stat(lockPath);
        const lockText = await readFile(lockPath, 'utf8');
        if (!/^[1-9][0-9]*$/.test(lockText)) throw new Error('DATA_DIR_LOCKED');
        pid = Number(lockText);
      } catch { throw new Error('DATA_DIR_LOCKED'); }
      if (!Number.isSafeInteger(pid!) || pid! < 1) throw new Error('DATA_DIR_LOCKED');
      try { process.kill(pid, 0); throw new Error('DATA_DIR_LOCKED'); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('DATA_DIR_LOCKED'); }
      // Fail closed if another starter changed the stale file during inspection.
      const currentIdentity = await stat(lockPath);
      if (currentIdentity.ino !== oldIdentity!.ino || currentIdentity.dev !== oldIdentity!.dev ||
          currentIdentity.mtimeMs !== oldIdentity!.mtimeMs) throw new Error('DATA_DIR_LOCKED');
      await unlink(lockPath);
      this.lock = await open(lockPath, 'wx', 0o600);
    }
    const jobs: StoredJob[] = [];
    try {
      await this.lock.writeFile(String(process.pid));
      await this.lock.sync();
      for (const file of await readdir(this.directory)) {
        if (file.endsWith('.json')) {
          const expectedId = file.slice(0, -5);
          requireValid(UUID.test(expectedId));
          let parsed: unknown;
          try { parsed = JSON.parse(await readFile(join(this.directory, file), 'utf8')); }
          catch { throw new Error('CORRUPT_JOB_STORE'); }
          jobs.push(validateStoredJob(parsed, expectedId));
        }
      }
      return jobs;
    } catch (e) { try { await this.close(); } catch { /* Preserve the original failure. */ } throw e; }
  }
  save(job: StoredJob): Promise<void> {
    if (!this.lock) return Promise.reject(new Error('STORE_CLOSED'));
    if (!UUID.test(job.job_id)) return Promise.reject(new Error('CORRUPT_JOB_STORE'));
    // Capture bytes before entering the queue so unrelated later mutations cannot leak into this write.
    const bytes = JSON.stringify(job);
    const target = join(this.directory, `${job.job_id}.json`);
    const task = this.tail.then(async () => {
      const tmp = `${target}.tmp`;
      const file = await open(tmp, 'w', 0o600);
      try { await file.writeFile(bytes, 'utf8'); await file.sync(); } finally { await file.close(); }
      await rename(tmp, target);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async close() {
    await this.tail;
    if (this.lock) {
      const ownedLock = this.lock;
      this.lock = undefined;
      const identity = await ownedLock.stat();
      await ownedLock.close();
      const lockPath = join(this.directory, '.server.lock');
      try {
        const current = await stat(lockPath);
        if (current.ino === identity.ino && current.dev === identity.dev) await unlink(lockPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
