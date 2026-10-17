/** Read-only chain verification. Defaults to Monad testnet; local is explicit. */
import { ethers } from 'ethers';
import type { CertificateRecord, ChainMode } from './types';

export const CROSSCHECK_ABI = [
  'function issuer() view returns (address)',
  'function certificateCount() view returns (uint256)',
  'function certify(bytes32 contentHash, bytes32 verdictHash, uint8 agreement) returns (uint256)',
  'event Certified(uint256 indexed id, address indexed issuer, bytes32 contentHash, bytes32 verdictHash, uint8 agreement, uint256 timestamp)',
];
const contractInterface = new ethers.Interface(CROSSCHECK_ABI);
const HASH = /^0x[0-9a-fA-F]{64}$/;
const POSITIVE_UINT = /^[1-9][0-9]*$/;

export interface PublicConfig {
  rpcUrl: string;
  contractAddress: string;
  issuerAddress?: string;
  deploymentBlock?: number;
  chainId?: number;
  chainMode?: ChainMode;
  txHash?: string;
}

export function expectedChainId(config: Pick<PublicConfig, 'chainMode' | 'chainId' | 'rpcUrl'>): number {
  const mode = config.chainMode ?? 'monad';
  if (mode !== 'monad' && mode !== 'local') throw new Error('不支持的链模式');
  const id = config.chainId ?? (mode === 'local' ? 31337 : 10143);
  if (id !== (mode === 'local' ? 31337 : 10143)) throw new Error('只允许 Monad 测试网 10143，或显式本地测试链 31337');
  const url = new URL(config.rpcUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('RPC 必须使用 HTTP(S)');
  if (mode === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('本地测试链 RPC 必须指向本机');
  return id;
}

export async function assertExpectedNetwork(provider: ethers.JsonRpcProvider, config: PublicConfig): Promise<number> {
  const expected = expectedChainId(config);
  const actual = BigInt(await provider.send('eth_chainId', []));
  if (actual !== BigInt(expected)) throw new Error(`RPC 链 ID 不匹配：需要 ${expected}，实际 ${actual}`);
  return expected;
}

export async function inspectContract(provider: ethers.JsonRpcProvider, config: PublicConfig): Promise<string> {
  const address = ethers.getAddress(config.contractAddress);
  if (address === ethers.ZeroAddress) throw new Error('合约地址不能为零地址');
  if (await provider.getCode(address) === '0x') throw new Error('配置地址上没有部署合约');
  const contract = new ethers.Contract(address, CROSSCHECK_ABI, provider);
  const currentIssuer = ethers.getAddress(await contract.issuer());
  if (currentIssuer === ethers.ZeroAddress) throw new Error('合约 issuer 无效');
  return currentIssuer;
}

export interface ReceiptExpectation {
  contractAddress: string;
  issuerAddress: string;
  chainId: number;
  id?: string;
  contentHash?: string;
  verdictHash?: string;
  agreement?: 0 | 1 | 2;
}

type ReceiptLike = {
  status: number | null;
  hash: string;
  blockNumber: number;
  logs: readonly { address: string; data: string; topics: readonly string[]; removed?: boolean }[];
};

/** Exported so receipt filtering can be tested without a live RPC or private key. */
export function certificateFromReceipt(receipt: ReceiptLike, expected: ReceiptExpectation, blockTime: number): CertificateRecord {
  if (receipt.status !== 1) throw new Error('存证交易未成功执行');
  const address = ethers.getAddress(expected.contractAddress);
  const issuer = ethers.getAddress(expected.issuerAddress);
  const matches: ethers.LogDescription[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address.toLowerCase() || log.removed) continue;
    let parsed: ethers.LogDescription | null;
    try { parsed = contractInterface.parseLog({ data: log.data, topics: [...log.topics] }); } catch { continue; }
    if (!parsed || parsed.name !== 'Certified' || ethers.getAddress(parsed.args[1]) !== issuer) continue;
    if (expected.id !== undefined && parsed.args[0].toString() !== expected.id) continue;
    if (expected.contentHash && parsed.args[2].toLowerCase() !== expected.contentHash.toLowerCase()) continue;
    if (expected.verdictHash && parsed.args[3].toLowerCase() !== expected.verdictHash.toLowerCase()) continue;
    if (expected.agreement !== undefined && Number(parsed.args[4]) !== expected.agreement) continue;
    matches.push(parsed);
  }
  if (matches.length !== 1) throw new Error('未找到唯一匹配合约、issuer 与输入的 Certified 事件');
  const args = matches[0].args;
  if (args[0] <= 0n || ![0, 1, 2].includes(Number(args[4]))) throw new Error('链上凭证字段无效');
  if (!Number.isSafeInteger(blockTime) || blockTime < 0 || args[5] !== BigInt(blockTime)) throw new Error('事件时间与区块时间不一致');
  return {
    proof: {
      chain_id: expected.chainId,
      contract_address: address,
      certificate_id: args[0].toString(),
      issuer,
      tx_hash: receipt.hash,
      block_number: receipt.blockNumber.toString(),
      block_time: String(blockTime),
    },
    content_hash: args[2], verdict_hash: args[3], agreement: Number(args[4]) as 0 | 1 | 2,
  };
}

async function recordFromTransaction(provider: ethers.JsonRpcProvider, txHash: string, id: string, config: PublicConfig, issuer: string, chainId: number) {
  if (!HASH.test(txHash)) throw new Error('交易哈希格式无效');
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt || receipt.hash.toLowerCase() !== txHash.toLowerCase()) throw new Error('交易不存在或尚未确认');
  const block = await provider.getBlock(receipt.blockNumber);
  if (!block || block.hash !== receipt.blockHash) throw new Error('交易区块不存在或已发生重组，请重试');
  return certificateFromReceipt(receipt, { contractAddress: config.contractAddress, issuerAddress: issuer, chainId, id }, block.timestamp);
}

export async function readCertificateByTransaction(txHash: string, id: string, config: PublicConfig): Promise<CertificateRecord> {
  if (!POSITIVE_UINT.test(id)) throw new Error('凭证 ID 必须是大于零的十进制整数');
  expectedChainId(config);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  try {
    const chainId = await assertExpectedNetwork(provider, config);
    const currentIssuer = await inspectContract(provider, config);
    // A configured historical issuer is allowed after issuer rotation.
    const issuer = config.issuerAddress ? ethers.getAddress(config.issuerAddress) : currentIssuer;
    return await recordFromTransaction(provider, txHash, id, config, issuer, chainId);
  } finally { provider.destroy(); }
}

/** A transaction hash is the normal path. Historical scans are bounded and need a deployment block. */
export async function readCertificate(id: string, config: PublicConfig, txHash?: string): Promise<CertificateRecord> {
  if (txHash || config.txHash) return readCertificateByTransaction(txHash ?? config.txHash!, id, config);
  if (!POSITIVE_UINT.test(id)) throw new Error('凭证 ID 无效');
  if (!Number.isSafeInteger(config.deploymentBlock) || config.deploymentBlock! < 0) throw new Error('按 ID 查询需要部署区块；请优先提供交易哈希');
  expectedChainId(config);
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  try {
    const chainId = await assertExpectedNetwork(provider, config);
    const currentIssuer = await inspectContract(provider, config);
    const issuer = config.issuerAddress ? ethers.getAddress(config.issuerAddress) : currentIssuer;
    const latest = await provider.getBlockNumber();
    const first = config.deploymentBlock!;
    if (latest - first > 100000) throw new Error('查询范围过大，请提供交易哈希以验证凭证');
    const topics = contractInterface.encodeFilterTopics('Certified', [id, issuer]);
    const hashes = new Set<string>();
    for (let from = first; from <= latest; from += 1000) {
      const logs = await provider.getLogs({ address: config.contractAddress, topics, fromBlock: from, toBlock: Math.min(from + 999, latest) });
      for (const log of logs) if (!log.removed) hashes.add(log.transactionHash);
    }
    if (hashes.size !== 1) throw new Error(`凭证 ${id} 不存在或不是唯一记录`);
    return await recordFromTransaction(provider, [...hashes][0], id, config, issuer, chainId);
  } finally { provider.destroy(); }
}
