/** Team-sponsored test-chain anchoring. Never expose this module/private key to browsers. */
import { ethers } from 'ethers';
import type { AnchorInput, ChainMode, ChainProof } from './types';
import { assertExpectedNetwork, certificateFromReceipt, CROSSCHECK_ABI, expectedChainId, inspectContract } from './chain-reader';

export interface ChainWriterConfig {
  rpcUrl: string;
  privateKey: string;
  contractAddress: string;
  issuerAddress?: string;
  chainId?: number;
  chainMode?: ChainMode;
}
export interface ChainWriter {
  anchor(input: AnchorInput, onBroadcast: (txHash: string) => Promise<void>): Promise<ChainProof>;
  close(): void;
}

export function createChainWriter(config: ChainWriterConfig): ChainWriter {
  expectedChainId(config);
  const address = ethers.getAddress(config.contractAddress);
  if (address === ethers.ZeroAddress) throw new Error('合约地址不能为零地址');
  // Counter/nonce reads must see the just-confirmed transaction even on an
  // instantly mining local chain; the provider's default short cache is unsafe here.
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
  const wallet = new ethers.Wallet(config.privateKey, provider);
  if (config.issuerAddress && ethers.getAddress(config.issuerAddress) !== wallet.address) {
    provider.destroy();
    throw new Error('配置 issuer 与签名钱包不符');
  }
  const contract = new ethers.Contract(address, CROSSCHECK_ABI, wallet);
  // Serializing through confirmation avoids cached-pending-nonce races and allows
  // the next job to continue after a failed job. A single writer must own the wallet.
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  return {
    anchor(input, onBroadcast) {
      const run = async (): Promise<ChainProof> => {
        if (closed) throw new Error('Chain writer 已关闭');
        if (!input || typeof input.job_id !== 'string' || !input.job_id.trim()) throw new Error('job_id 无效');
        if (!/^0x[0-9a-fA-F]{64}$/.test(input.content_hash) || !/^0x[0-9a-fA-F]{64}$/.test(input.verdict_hash)) throw new Error('存证哈希必须是 bytes32');
        if (![0, 1, 2].includes(input.agreement)) throw new Error('agreement 无效');
        const chainId = await assertExpectedNetwork(provider, config);
        const issuer = await inspectContract(provider, config);
        if (issuer !== wallet.address) throw new Error('签名钱包不是合约授权 issuer');
        const certificateId = (BigInt(await contract.certificateCount()) + 1n).toString();
        const nonce = Number(BigInt(await provider.send('eth_getTransactionCount', [wallet.address, 'pending'])));
        if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('钱包 nonce 无效');
        const tx = await contract.certify(input.content_hash, input.verdict_hash, input.agreement, { nonce });
        // If persistence fails, the caller receives the tx hash on the error and
        // can recover by receipt. Do not silently retry an already-broadcast job.
        try { await onBroadcast(tx.hash); }
        catch (cause) { throw Object.assign(new Error('交易已广播，但交易哈希持久化失败', { cause }), { tx_hash: tx.hash }); }
        const receipt = await tx.wait();
        if (!receipt) throw new Error('交易未返回确认收据');
        const block = await provider.getBlock(receipt.blockNumber);
        if (!block || block.hash !== receipt.blockHash) throw new Error('交易区块不存在或发生重组');
        const record = certificateFromReceipt(receipt, {
          contractAddress: address, issuerAddress: wallet.address, chainId,
          id: certificateId,
          contentHash: input.content_hash, verdictHash: input.verdict_hash, agreement: input.agreement,
        }, block.timestamp);
        return record.proof;
      };
      const result = queue.then(run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    close() { closed = true; provider.destroy(); },
  };
}
