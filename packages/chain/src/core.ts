/** Browser-safe adapter around B's tested receipt parser. Never import server.ts here. */
import { ethers } from 'ethers';
import { anchorInputSchema, certificateRecordSchema } from '@crosscheck/protocol';
import type { AnchorInput, CertificateRecord, PublicConfig } from '@crosscheck/protocol';
import { certificateFromReceipt, CROSSCHECK_ABI } from '../../../chain-reader.js';

export { CROSSCHECK_ABI };
export type ChainMode = 'monad' | 'local';
export type ChainCode = 'NOT_CONFIGURED' | 'CONFIRMATION_TIMEOUT' | 'CHAIN_UNAVAILABLE' |
  'CHAIN_ID_MISMATCH' | 'TRANSACTION_REVERTED' | 'CERTIFICATE_NOT_FOUND' | 'RECORD_MISMATCH';
export type ReaderConfig = Partial<PublicConfig> & {
  rpc_url?: string; abi?: unknown[]; chainMode?: ChainMode; tx_hash?: string;
  confirmations?: number; confirmation_timeout_ms?: number;
};
export type ResolvedConfig = {
  rpc_url: string; chain_id: number; contract_address: string; issuer: string;
  deployment_block: number; confirmations: number; confirmation_timeout_ms: number;
};
export const iface = new ethers.Interface(CROSSCHECK_ABI);
const receiptIndex = new Map<string, string>();

export function chainError(code: ChainCode, message: string, tx_hash?: string, cause?: unknown): Error & { code: ChainCode; tx_hash?: string } {
  return Object.assign(new Error(message, { cause }), { code, ...(tx_hash ? { tx_hash } : {}) });
}
export function normalizeError(error: unknown, tx_hash?: string): Error {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && ['NOT_CONFIGURED', 'CONFIRMATION_TIMEOUT', 'CHAIN_UNAVAILABLE', 'CHAIN_ID_MISMATCH', 'TRANSACTION_REVERTED', 'CERTIFICATE_NOT_FOUND', 'RECORD_MISMATCH'].includes(code)) {
    if (tx_hash && !(error as { tx_hash?: string }).tx_hash) Object.assign(error as object, { tx_hash });
    return error as Error;
  }
  if (code === 'TIMEOUT') return chainError('CHAIN_UNAVAILABLE', '链读取超时，未取得可核对的交易记录', tx_hash, error);
  if (code === 'CALL_EXCEPTION') return chainError('TRANSACTION_REVERTED', '交易或合约调用已回滚', tx_hash, error);
  return chainError('CHAIN_UNAVAILABLE', '当前无法完成链上核对', tx_hash, error);
}

export function validateAnchorInput(value: unknown): AnchorInput {
  try { return anchorInputSchema.parse(value); }
  catch (cause) { throw chainError('RECORD_MISMATCH', '存证输入不符合共享协议', undefined, cause); }
}

export function resolveConfig(value: ReaderConfig): ResolvedConfig {
  const mode = value.chainMode ?? 'monad';
  const expected = mode === 'local' ? 31337 : 10143;
  if (!['local', 'monad'].includes(mode) || (value.chain_id != null && value.chain_id !== expected)) throw chainError('CHAIN_ID_MISMATCH', '仅支持 Monad 测试网10143；本机31337必须显式选择local');
  if (!value.contract_address || !value.issuer || value.deployment_block == null) throw chainError('NOT_CONFIGURED', '缺少合约、issuer或部署区块配置');
  let contract: string, issuer: string;
  try { contract = ethers.getAddress(value.contract_address); issuer = ethers.getAddress(value.issuer); }
  catch (cause) { throw chainError('NOT_CONFIGURED', '合约或issuer地址格式无效', undefined, cause); }
  if (contract === ethers.ZeroAddress || issuer === ethers.ZeroAddress) throw chainError('NOT_CONFIGURED', '不得使用零地址占位');
  if (!/^(0|[1-9][0-9]*)$/.test(String(value.deployment_block))) throw chainError('NOT_CONFIGURED', '部署区块格式无效');
  const deploymentBlock = Number(value.deployment_block);
  if (!Number.isSafeInteger(deploymentBlock)) throw chainError('NOT_CONFIGURED', '部署区块超过安全范围');
  const rpcUrl = value.rpc_url ?? 'https://testnet-rpc.monad.xyz';
  let url: URL;
  try { url = new URL(rpcUrl); } catch (cause) { throw chainError('NOT_CONFIGURED', 'RPC URL无效', undefined, cause); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw chainError('NOT_CONFIGURED', 'RPC必须是无内嵌凭据的HTTP(S)地址');
  if (mode === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw chainError('CHAIN_ID_MISMATCH', 'local模式只允许本机RPC');
  const confirmations = value.confirmations ?? 1;
  const timeout = value.confirmation_timeout_ms ?? 30000;
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 100) throw chainError('NOT_CONFIGURED', '确认数必须是1至100');
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) throw chainError('NOT_CONFIGURED', '确认超时配置无效');
  return { rpc_url: rpcUrl, chain_id: expected, contract_address: contract, issuer, deployment_block: deploymentBlock, confirmations, confirmation_timeout_ms: timeout };
}

export function makeProvider(config: ResolvedConfig): ethers.JsonRpcProvider {
  const request = new ethers.FetchRequest(config.rpc_url);
  request.timeout = Math.min(Math.max(config.confirmation_timeout_ms, 1000), 10000);
  const provider = new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = config.chain_id === 31337 ? 100 : 1000;
  return provider;
}

export async function assertDeployment(provider: ethers.JsonRpcProvider, config: ResolvedConfig, writing = false): Promise<void> {
  if (BigInt(await provider.send('eth_chainId', [])) !== BigInt(config.chain_id)) throw chainError('CHAIN_ID_MISMATCH', 'RPC实际链与固定部署配置不符');
  if (await provider.getCode(config.contract_address) === '0x') throw chainError('RECORD_MISMATCH', '固定合约地址没有部署代码');
  const deploymentBlock = await provider.getBlock(config.deployment_block);
  if (!deploymentBlock || await provider.getCode(config.contract_address, config.deployment_block) === '0x') throw chainError('RECORD_MISMATCH', '部署区块不存在或该区块尚无合约');
  const contract = new ethers.Contract(config.contract_address, CROSSCHECK_ABI, provider);
  const issuer = ethers.getAddress(await contract.issuer());
  if (issuer === ethers.ZeroAddress || (writing && issuer !== config.issuer)) throw chainError('RECORD_MISMATCH', '当前授权issuer与应用配置不符');
}

function indexKey(config: ResolvedConfig, id: string) { return `${config.chain_id}:${config.contract_address.toLowerCase()}:${config.issuer.toLowerCase()}:${id}`; }
export function remember(config: ResolvedConfig, record: CertificateRecord) {
  receiptIndex.set(indexKey(config, record.proof.certificate_id), record.proof.tx_hash);
  if (receiptIndex.size > 10000) receiptIndex.delete(receiptIndex.keys().next().value!);
}
export function rememberedTransaction(config: ResolvedConfig, id: string) { return receiptIndex.get(indexKey(config, id)); }

/** Reads only. A pending/unconfirmed transaction returns null; malformed identities never pass. */
export async function readReceipt(provider: ethers.JsonRpcProvider, config: ResolvedConfig, tx_hash: string, input?: AnchorInput, id?: string): Promise<CertificateRecord | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) throw chainError('RECORD_MISMATCH', '交易哈希格式无效');
  if (input) validateAnchorInput(input);
  const receipt = await provider.getTransactionReceipt(tx_hash);
  if (!receipt) return null;
  if (receipt.hash.toLowerCase() !== tx_hash.toLowerCase()) throw chainError('RECORD_MISMATCH', 'RPC返回不同交易收据', tx_hash);
  if (receipt.status !== 1) throw chainError('TRANSACTION_REVERTED', '存证交易已回滚', tx_hash);
  if (receipt.to?.toLowerCase() !== config.contract_address.toLowerCase() || receipt.from.toLowerCase() !== config.issuer.toLowerCase() || receipt.blockNumber < config.deployment_block) throw chainError('RECORD_MISMATCH', '交易目标、发起者或部署范围不符', tx_hash);
  const latest = await provider.getBlockNumber();
  if (latest - receipt.blockNumber + 1 < config.confirmations) return null;
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block || block.hash !== receipt.blockHash) throw chainError('CHAIN_UNAVAILABLE', '交易区块已重组，暂不能核对', tx_hash);
  let record: CertificateRecord;
  try {
    record = certificateRecordSchema.parse(certificateFromReceipt(receipt, {
      contractAddress: config.contract_address, issuerAddress: config.issuer, chainId: config.chain_id,
      ...(id ? { id } : {}), ...(input ? { contentHash: input.content_hash, verdictHash: input.verdict_hash, agreement: input.agreement } : {}),
    }, block.timestamp));
  } catch (cause) { throw chainError('RECORD_MISMATCH', '收据未包含唯一匹配来源、输入和时间的凭证事件', tx_hash, cause); }
  const transaction = await provider.getTransaction(tx_hash);
  if (!transaction || transaction.chainId !== BigInt(config.chain_id) || transaction.to?.toLowerCase() !== config.contract_address.toLowerCase() || transaction.from.toLowerCase() !== config.issuer.toLowerCase() || transaction.value !== 0n) throw chainError('RECORD_MISMATCH', '交易本身与固定部署不符', tx_hash);
  try {
    const call = iface.parseTransaction({ data: transaction.data, value: transaction.value });
    if (!call || call.name !== 'certify' || call.args[0].toLowerCase() !== record.content_hash.toLowerCase() || call.args[1].toLowerCase() !== record.verdict_hash.toLowerCase() || Number(call.args[2]) !== record.agreement) throw new Error('calldata mismatch');
  } catch (cause) { throw chainError('RECORD_MISMATCH', '存证调用参数与事件不符', tx_hash, cause); }
  remember(config, record);
  return record;
}
