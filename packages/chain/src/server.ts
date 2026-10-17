import type { AnchorInput, ChainProof } from '@crosscheck/protocol';

/** B replaces this initial skeleton. No wallet/transaction is created here. */
export function createChainWriter(_config: Record<string, unknown>) {
  return {
    configured: false,
    async anchor(_input: AnchorInput, _onBroadcast: (tx_hash: string) => Promise<void>): Promise<ChainProof> {
      throw Object.assign(new Error('Chain writer is not configured'), { code: 'NOT_CONFIGURED' });
    },
  };
}
