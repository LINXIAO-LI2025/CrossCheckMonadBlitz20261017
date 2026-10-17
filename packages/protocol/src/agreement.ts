import type { Agreement, ModelResult } from './types.js';

/** null means both adapters failed: do not create a report payload or certificate. */
export function deriveAgreement(models: readonly [ModelResult, ModelResult]): Agreement | null {
  const [a, b] = models;
  if (a.status === 'failed' && b.status === 'failed') return null;
  if (a.status === 'failed' || b.status === 'failed') return 2;
  if (a.verdict === null || b.verdict === null) {
    throw new TypeError('A successful model result requires a verdict');
  }
  if (a.verdict === 'unable_to_determine' || b.verdict === 'unable_to_determine') return 2;
  return a.verdict === b.verdict ? 0 : 1;
}

export const calculateAgreement = deriveAgreement;
