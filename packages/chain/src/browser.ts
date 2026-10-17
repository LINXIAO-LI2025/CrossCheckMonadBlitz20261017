/** Browser entry: read-only ethers/RPC; no Wallet, filesystem or server imports. */
import type { CertificateRecord } from '@crosscheck/protocol';
import { assertDeployment, chainError, iface, makeProvider, normalizeError, readReceipt, rememberedTransaction, resolveConfig } from './core.js';
import type { ReaderConfig } from './core.js';
export type { ReaderConfig } from './core.js';

export async function readCertificateByTransaction(tx_hash: string, id: string, publicConfig: ReaderConfig): Promise<CertificateRecord> {
  if (!/^[1-9][0-9]*$/.test(id)) throw chainError('CERTIFICATE_NOT_FOUND', '凭证ID无效');
  const config = resolveConfig(publicConfig);
  const provider = makeProvider(config);
  try {
    await assertDeployment(provider, config);
    const record = await readReceipt(provider, config, tx_hash, undefined, id);
    if (!record) throw chainError('CERTIFICATE_NOT_FOUND', '交易尚未达到要求的确认数', tx_hash);
    return record;
  } catch (error) { throw normalizeError(error, tx_hash); }
  finally { provider.destroy(); }
}

export async function readCertificate(id: string, publicConfig: ReaderConfig): Promise<CertificateRecord> {
  if (!/^[1-9][0-9]*$/.test(id)) throw chainError('CERTIFICATE_NOT_FOUND', '凭证ID无效');
  const config = resolveConfig(publicConfig);
  const knownTx = publicConfig.tx_hash ?? rememberedTransaction(config, id);
  if (knownTx) return readCertificateByTransaction(knownTx, id, publicConfig);
  const provider = makeProvider(config);
  try {
    await assertDeployment(provider, config);
    const latest = await provider.getBlockNumber();
    if (latest - config.deployment_block > 100000) throw chainError('CHAIN_UNAVAILABLE', '查询跨度超过100000区块，请提供交易哈希');
    const hashes = new Set<string>();
    const topics = iface.encodeFilterTopics('Certified', [id, config.issuer]);
    for (let from = config.deployment_block; from <= latest; from += 1000) {
      const logs = await provider.getLogs({ address: config.contract_address, topics, fromBlock: from, toBlock: Math.min(from + 999, latest) });
      for (const log of logs) if (!log.removed) hashes.add(log.transactionHash);
    }
    if (hashes.size !== 1) throw chainError('CERTIFICATE_NOT_FOUND', '未找到唯一凭证');
    const record = await readReceipt(provider, config, [...hashes][0], undefined, id);
    if (!record) throw chainError('CERTIFICATE_NOT_FOUND', '凭证尚未达到要求确认数');
    return record;
  } catch (error) { throw normalizeError(error); }
  finally { provider.destroy(); }
}
