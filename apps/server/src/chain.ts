import { createChainWriter } from '@crosscheck/chain/server';
import { readCertificate, readCertificateByTransaction } from '@crosscheck/chain/browser';
import type { AnchorInput, CertificateRecord, ChainProof } from '@crosscheck/protocol';
import type { ServerConfig } from './config.js';

export interface ChainGateway {
  configured: boolean;
  anchor(input: AnchorInput, onBroadcast: (tx_hash: string) => Promise<void>): Promise<ChainProof>;
  read(id: string, tx_hash?: string): Promise<CertificateRecord>;
  /** Read receipts/events only. Must never send a transaction. B implements this extension. */
  recover?(tx_hash: string, input: AnchorInput): Promise<CertificateRecord | null>;
  close?(): void | Promise<void>;
}
export function createGateway(config: ServerConfig): ChainGateway {
  const writer = createChainWriter({ rpc_url: config.rpc_url, private_key: config.private_key,
    deployment: config.deployment, public_config: config.public, confirmation_timeout_ms: config.chain_timeout_ms }) as {
      configured?: boolean; anchor: ChainGateway['anchor']; recover?: ChainGateway['recover']; close?: ChainGateway['close'];
    };
  return {
    configured: config.chain_enabled && !!config.deployment && !!config.private_key && writer.configured === true,
    anchor: writer.anchor.bind(writer),
    read: (id, tx_hash) => {
      const abi = config.deployment?.abi;
      const publicConfig = { ...config.public, rpc_url: config.rpc_url, abi: Array.isArray(abi) ? abi : undefined };
      return tx_hash ? readCertificateByTransaction(tx_hash, id, publicConfig) : readCertificate(id, publicConfig);
    },
    recover: writer.recover?.bind(writer),
    close: writer.close?.bind(writer),
  };
}
export class AppError extends Error {
  constructor(readonly code: string, readonly http_status = 500, message = code) { super(message); }
}
export function safeChainCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && ['NOT_CONFIGURED', 'CONFIRMATION_TIMEOUT', 'CHAIN_UNAVAILABLE',
    'CHAIN_ID_MISMATCH', 'TRANSACTION_REVERTED', 'CERTIFICATE_NOT_FOUND', 'RECORD_MISMATCH'].includes(code)
    ? code : 'CHAIN_UNAVAILABLE';
}
