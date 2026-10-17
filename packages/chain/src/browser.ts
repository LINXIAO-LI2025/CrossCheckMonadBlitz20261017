import type { CertificateRecord } from '@crosscheck/protocol';

/** Browser-safe initial skeleton owned by B after handoff. */
export async function readCertificate(_id: string, _publicConfig: unknown): Promise<CertificateRecord> {
  throw Object.assign(new Error('Chain reader is not configured'), { code: 'NOT_CONFIGURED' });
}
export async function readCertificateByTransaction(_tx_hash: string, _id: string, _publicConfig: unknown): Promise<CertificateRecord> {
  throw Object.assign(new Error('Chain reader is not configured'), { code: 'NOT_CONFIGURED' });
}
