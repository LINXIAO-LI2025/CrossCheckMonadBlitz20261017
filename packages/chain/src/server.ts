/** Node/server entry. Private keys are never imported by the browser entry. */
import { ethers } from 'ethers';
import type { AnchorInput, CertificateRecord, ChainProof, PublicConfig } from '@crosscheck/protocol';
import { assertDeployment, chainError, CROSSCHECK_ABI, makeProvider, normalizeError, readReceipt, resolveConfig, validateAnchorInput } from './core.js';
import type { ChainMode } from './core.js';

export interface ChainWriterConfig {
  rpc_url?: string;
  private_key?: string;
  deployment?: Record<string, unknown> | null;
  public_config?: Partial<PublicConfig>;
  chainMode?: ChainMode;
  confirmations?: number;
  confirmation_timeout_ms?: number;
}
export interface ChainWriter {
  configured: boolean;
  anchor(input: AnchorInput, onBroadcast: (tx_hash: string) => Promise<void>): Promise<ChainProof>;
  recover(tx_hash: string, input: AnchorInput): Promise<CertificateRecord | null>;
  close(): void;
}

export function createChainWriter(options: ChainWriterConfig): ChainWriter {
  if (!options.deployment || !options.private_key) {
    return { configured: false,
      async anchor() { throw chainError('NOT_CONFIGURED', '真实链存证尚未配置'); },
      async recover() { throw chainError('NOT_CONFIGURED', '真实链读取尚未配置'); }, close() {},
    };
  }
  const deployment = options.deployment;
  const config = resolveConfig({
    ...options.public_config, rpc_url: options.rpc_url, chainMode: options.chainMode,
    chain_id: Number(deployment.chainId), contract_address: String(deployment.contract ?? deployment.contractAddress ?? ''),
    issuer: String(deployment.issuer ?? ''), deployment_block: String(deployment.deploymentBlock ?? ''),
    confirmations: options.confirmations, confirmation_timeout_ms: options.confirmation_timeout_ms,
  });
  if (!Array.isArray(deployment.abi)) throw chainError('NOT_CONFIGURED', '部署文件必须包含ABI');
  // The supplied ABI cannot redefine the event accepted by the fixed protocol.
  try {
    const supplied = new ethers.Interface(deployment.abi as ethers.InterfaceAbi);
    if (supplied.getFunction('certify')?.format('sighash') !== 'certify(bytes32,bytes32,uint8)' || supplied.getEvent('Certified')?.format('sighash') !== 'Certified(uint256,address,bytes32,bytes32,uint8,uint256)' || !supplied.getFunction('issuer')) throw new Error('ABI mismatch');
  } catch (cause) { throw chainError('NOT_CONFIGURED', '部署ABI与CrossCheck协议不符', undefined, cause); }
  for (const [key, expected] of [['chain_id', config.chain_id], ['contract_address', config.contract_address], ['issuer', config.issuer], ['deployment_block', String(config.deployment_block)]] as const) {
    const supplied = options.public_config?.[key];
    if (supplied != null && String(supplied).toLowerCase() !== String(expected).toLowerCase()) throw chainError('RECORD_MISMATCH', '公开配置与部署文件不符');
  }
  const provider = makeProvider(config);
  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(options.private_key, provider);
  } catch {
    provider.destroy();
    // Do not retain an invalid signing key in a nested library error/cause.
    throw chainError('NOT_CONFIGURED', '签名钱包配置无效');
  }
  if (wallet.address !== config.issuer) {
    provider.destroy();
    throw chainError('RECORD_MISMATCH', '钱包与固定issuer不符');
  }
  const contract = new ethers.Contract(config.contract_address, CROSSCHECK_ABI, wallet);
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  return {
    configured: true,
    anchor(value, onBroadcast) {
      const run = async (): Promise<ChainProof> => {
        let tx_hash: string | undefined;
        try {
          if (closed) throw chainError('NOT_CONFIGURED', '链写入器已关闭');
          const input = validateAnchorInput(value);
          await assertDeployment(provider, config, true);
          const nonce = Number(BigInt(await provider.send('eth_getTransactionCount', [wallet.address, 'pending'])));
          if (!Number.isSafeInteger(nonce) || nonce < 0) throw chainError('CHAIN_UNAVAILABLE', '钱包nonce无效');
          const tx = await contract.certify(input.content_hash, input.verdict_hash, input.agreement, { nonce });
          tx_hash = tx.hash;
          await onBroadcast(tx.hash);
          const receipt = await provider.waitForTransaction(tx.hash, config.confirmations, config.confirmation_timeout_ms).catch((error: unknown) => {
            if ((error as { code?: unknown })?.code === 'TIMEOUT') throw chainError('CONFIRMATION_TIMEOUT', '等待确认超时；只可按已有交易恢复，不得自动重发', tx.hash, error);
            throw error;
          });
          if (!receipt) throw chainError('CONFIRMATION_TIMEOUT', '确认超时；必须按已有交易恢复', tx.hash);
          const record = await readReceipt(provider, config, tx.hash, input);
          if (!record) throw chainError('CONFIRMATION_TIMEOUT', '交易尚未达到确认策略', tx.hash);
          return record.proof;
        } catch (error) { throw normalizeError(error, tx_hash); }
      };
      const result = queue.then(run);
      queue = result.then(() => undefined, () => undefined);
      return result;
    },
    async recover(tx_hash, value) {
      try {
        if (closed) throw chainError('NOT_CONFIGURED', '链写入器已关闭');
        const input = validateAnchorInput(value);
        await assertDeployment(provider, config);
        return await readReceipt(provider, config, tx_hash, input);
      } catch (error) { throw normalizeError(error, tx_hash); }
    },
    close() { closed = true; provider.destroy(); },
  };
}
