/**
 * CrossCheck 共享类型定义
 * 这个文件会被前端和后端共同使用
 */

export type Verdict = 'credible' | 'questionable' | 'not_credible' | 'unable_to_determine';

export type ChainMode = 'monad' | 'local';

export type ModelResult = {
  slot: 'a' | 'b';
  provider: string;
  requested_model: string;
  returned_model: string | null;
  status: 'succeeded' | 'failed';
  verdict: Verdict | null;
  reason: string | null;
  error_code: string | null;
};

export type ReportPayload = {
  schema_version: '1';
  job_id: string;
  mode: 'live' | 'demo';
  raw_text: string;
  submitted_at: string;
  completed_at: string;
  rule_version: string;
  prompt_hash: string;
  model_config_hash: string;
  models: [ModelResult, ModelResult];
  agreement: 0 | 1 | 2;
};

export type ChainProof = {
  chain_id: number;
  contract_address: string;
  certificate_id: string;
  issuer: string;
  tx_hash: string;
  block_number: string;
  block_time: string;
};

export type AnchorInput = {
  job_id: string;
  content_hash: string;
  verdict_hash: string;
  agreement: 0 | 1 | 2;
};

export type CertificateRecord = {
  proof: ChainProof;
  content_hash: string;
  verdict_hash: string;
  agreement: 0 | 1 | 2;
};

export type ReportEnvelope = {
  payload: ReportPayload;
  proof: ChainProof | null;
};

export type JobStatus =
  | 'queued'
  | 'running'
  | 'report_ready'
  | 'anchoring'
  | 'confirmed'
  | 'failed'
  | 'anchor_failed'
  | 'interrupted';

export type JobView = {
  job_id: string;
  mode: 'live' | 'demo';
  status: JobStatus;
  results: ModelResult[];
  payload: ReportPayload | null;
  hashes: { content_hash: string; verdict_hash: string } | null;
  proof: ChainProof | null;
  error: { code: string; message: string } | null;
};
