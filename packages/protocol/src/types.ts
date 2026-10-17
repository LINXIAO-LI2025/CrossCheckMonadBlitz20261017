export type Verdict =
  | 'credible'
  | 'questionable'
  | 'not_credible'
  | 'unable_to_determine';

export type Agreement = 0 | 1 | 2;
export type ReportMode = 'live' | 'demo';
export type ModelSlot = 'a' | 'b';

export type ModelResult = {
  slot: ModelSlot;
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
  mode: ReportMode;
  raw_text: string;
  submitted_at: string;
  completed_at: string;
  rule_version: string;
  prompt_hash: string;
  model_config_hash: string;
  models: [ModelResult, ModelResult];
  agreement: Agreement;
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
  agreement: Agreement;
};

export type CertificateRecord = {
  proof: ChainProof;
  content_hash: string;
  verdict_hash: string;
  agreement: Agreement;
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

export type ReportHashes = { content_hash: string; verdict_hash: string };
export type JobError = { code: string; message: string };

export type JobView = {
  job_id: string;
  mode: ReportMode;
  status: JobStatus;
  results: ModelResult[];
  payload: ReportPayload | null;
  hashes: ReportHashes | null;
  proof: ChainProof | null;
  error: JobError | null;
};

export type PublicConfig = {
  mode: ReportMode;
  public_origin: string | null;
  chain_id: number | null;
  contract_address: string | null;
  deployment_block: string | null;
  issuer: string | null;
  explorer_tx_base_url: string | null;
};

export type VerifyAccepted = {
  job_id: string;
  status: JobStatus;
  stream_url: string;
};

export type CertificateResponse = {
  report: ReportEnvelope;
  hashes: ReportHashes;
};

export type JobEventDataMap = {
  job_status: { job_id: string; status: JobStatus };
  model_delta: { job_id: string; slot: ModelSlot; delta: string };
  model_result: { job_id: string; slot: ModelSlot; result: ModelResult };
  model_error: {
    job_id: string;
    slot: ModelSlot;
    result: ModelResult;
    error: JobError;
  };
  report_ready: { job_id: string; payload: ReportPayload; hashes: ReportHashes };
  anchor_submitted: { job_id: string; tx_hash: string };
  anchor_confirmed: { job_id: string; proof: ChainProof };
  anchor_error: { job_id: string; error: JobError; tx_hash?: string };
  done: { job_id: string; status: JobStatus };
};

export type JobEventName = keyof JobEventDataMap;
export type JobEvent = {
  [K in JobEventName]: { id: number; event: K; data: JobEventDataMap[K] };
}[JobEventName];
