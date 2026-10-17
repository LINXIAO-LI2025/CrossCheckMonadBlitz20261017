import { z } from 'zod';
import { deriveAgreement } from './agreement.js';
import { isValidUnicode } from './unicode.js';
import type { ReportEnvelope, ReportPayload } from './types.js';

const unicodeString = z.string().refine(isValidUnicode, 'Invalid Unicode: lone surrogate');
const nonemptyString = unicodeString.refine((value) => value.trim().length > 0, 'Must not be blank');
export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Expected a 32-byte hex hash');
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Expected a 20-byte address');
const decimalString = z.string().regex(/^(0|[1-9][0-9]*)$/, 'Expected an unsigned decimal string');
const isoDate = z.string().datetime({ offset: true });
const chainIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const agreementSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export const verdictSchema = z.enum(['credible', 'questionable', 'not_credible', 'unable_to_determine']);
export const jobStatusSchema = z.enum([
  'queued', 'running', 'report_ready', 'anchoring', 'confirmed',
  'failed', 'anchor_failed', 'interrupted',
]);

export const modelResultSchema = z.object({
  slot: z.enum(['a', 'b']),
  provider: nonemptyString,
  requested_model: unicodeString,
  returned_model: nonemptyString.nullable(),
  status: z.enum(['succeeded', 'failed']),
  verdict: verdictSchema.nullable(),
  reason: nonemptyString.nullable(),
  error_code: nonemptyString.nullable(),
}).strict().superRefine((result, context) => {
  // A missing configured model ID must stay visibly absent instead of being invented.
  const missingConfiguration = result.status === 'failed' && result.error_code === 'NOT_CONFIGURED';
  if (result.requested_model.trim().length === 0 && !(missingConfiguration && result.requested_model === '')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['requested_model'], message: 'A model ID is required except for a NOT_CONFIGURED failure' });
  }
  if (result.status === 'succeeded') {
    if (result.verdict === null || result.reason === null || result.error_code !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Success requires verdict and reason, and null error_code' });
    }
  } else if (result.verdict !== null || result.reason !== null || result.error_code === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Failure requires null verdict/reason and a nonempty error_code' });
  }
});

export const reportPayloadSchema = z.object({
  schema_version: z.literal('1'),
  job_id: nonemptyString,
  mode: z.enum(['live', 'demo']),
  raw_text: nonemptyString,
  submitted_at: isoDate,
  completed_at: isoDate,
  rule_version: nonemptyString,
  prompt_hash: hashSchema,
  model_config_hash: hashSchema,
  models: z.tuple([modelResultSchema, modelResultSchema]),
  agreement: agreementSchema,
}).strict().superRefine((payload, context) => {
  if (payload.models[0].slot !== 'a' || payload.models[1].slot !== 'b') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['models'], message: 'Models must be ordered a, b' });
  }
  // Invalid model schemas already have their own diagnostics; do not throw here.
  if (payload.models.some((model) => model.status === 'succeeded' && model.verdict === null)) return;
  const expected = deriveAgreement(payload.models);
  if (expected === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['models'], message: 'Both models failed; no report payload may be created' });
  } else if (expected !== payload.agreement) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['agreement'], message: 'Agreement does not match model results' });
  }
  if (Date.parse(payload.completed_at) < Date.parse(payload.submitted_at)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['completed_at'], message: 'Completion cannot precede submission' });
  }
});

export const chainProofSchema = z.object({
  chain_id: chainIdSchema,
  contract_address: addressSchema,
  certificate_id: nonemptyString,
  issuer: addressSchema,
  tx_hash: hashSchema,
  block_number: decimalString,
  block_time: nonemptyString,
}).strict();

export const reportEnvelopeSchema = z.object({
  payload: reportPayloadSchema,
  proof: chainProofSchema.nullable(),
}).strict();

export const reportHashesSchema = z.object({
  content_hash: hashSchema,
  verdict_hash: hashSchema,
}).strict();

export const anchorInputSchema = z.object({
  job_id: nonemptyString,
  content_hash: hashSchema,
  verdict_hash: hashSchema,
  agreement: agreementSchema,
}).strict();

export const certificateRecordSchema = z.object({
  proof: chainProofSchema,
  content_hash: hashSchema,
  verdict_hash: hashSchema,
  agreement: agreementSchema,
}).strict();

export const publicConfigSchema = z.object({
  mode: z.enum(['live', 'demo']),
  public_origin: z.string().url().nullable(),
  chain_id: chainIdSchema.nullable(),
  contract_address: addressSchema.nullable(),
  deployment_block: decimalString.nullable(),
  issuer: addressSchema.nullable(),
  explorer_tx_base_url: z.string().url().nullable(),
}).strict();

/** Validate the file shape only. Chain verification must separately read known deployment data. */
export function validateReportEnvelope(value: unknown): ReportEnvelope {
  return reportEnvelopeSchema.parse(value);
}

export function validateReportPayload(value: unknown): ReportPayload {
  return reportPayloadSchema.parse(value);
}

export function safeParseReportEnvelope(value: unknown) {
  return reportEnvelopeSchema.safeParse(value);
}
