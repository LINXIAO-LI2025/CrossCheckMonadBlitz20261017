# B 链模块交接

当前 `packages/chain` 只有初始占位，未部署真实合约。server 与 browser 分开导出，browser 不可导入私钥、Node 依赖或服务器入口。A 不填写虚构地址。

## 配置契约

B 的部署文件由后端根目录 `DEPLOYMENT_FILE` 指定，默认 `deployment.json`：

```ts
type Deployment = {
  chainId: 10143;
  contract: string; // 真实部署地址，也兼容 contractAddress
  abi: unknown[];
  deploymentBlock: string; // 十进制整数
  issuer: string; // 真实应用 issuer
};
```

不要用全零或示例地址代替缺失配置。部署前向 RPC 查询 chain ID，必须等于 10143，再检查合约 bytecode、issuer 与链上部署区块。采用 Monad 当前官方部署建议；详情见 development-resources.md。

`createChainWriter` 接收 `{rpc_url, private_key, deployment, public_config}`；private_key 只从服务器 `ISSUER_PRIVATE_KEY` 读取。返回：

```ts
{
  configured: boolean;
  anchor(input: AnchorInput,
         onBroadcast: (tx_hash: string) => Promise<void>): Promise<ChainProof>;
  recover?(tx_hash: string, input: AnchorInput): Promise<CertificateRecord | null>;
}
```

`configured=true` 是 B 模块明确表明实现/初始化就绪；A 还要求 `CHAIN_ENABLED=true`、部署与私钥存在才调用。A 的 demo 无论配置如何都不广播。

writer 广播后必须立即 `await onBroadcast(tx_hash)`，才能进入等待回执阶段。确认超时抛 `{code:'CONFIRMATION_TIMEOUT', tx_hash}`。失败不能吞掉 tx_hash；不得悄悄重发。A 把 attempted_at 在调用前落盘，tx_hash 在回调时落盘。

`recover` 是基础协议的兼容可选扩展：仅按持久化交易查回执和正确合约事件，校验 hash/agreement，再返回 CertificateRecord；未确认返回 null，已回滚用明确错误。无需已知 certificate_id，由事件解析得到。这解决仅有 tx_hash、还没获得 id 的重启恢复场景。未实现时 `chain_recovery_ready=false`，A 保留待确认状态，不自动重发。

`@crosscheck/chain/browser`：

```ts
readCertificate(id, publicConfig): Promise<CertificateRecord>
readCertificateByTransaction(tx_hash, id, publicConfig): Promise<CertificateRecord>
```

publicConfig 为公开协议字段，A 服务器另传 `rpc_url` 与 `abi`。reader 必须读取已知配置中的合约，不能按导入文件的任意地址查询后就认可。找不到抛 `CERTIFICATE_NOT_FOUND`；RPC 不可用抛 `CHAIN_UNAVAILABLE`，不能用本地 proof 兜底。

## A 已执行的防护

A 对 writer 调用排队，记录交易，等待真实 reader 返回的哈希、agreement、chain_id、contract、issuer、certificate_id 与 tx_hash 匹配才标记 confirmed。`GET /api/cert` 每次重新读链。合约事件必须由 B 校验来源、成功 receipt 与确认策略；不能只返回交易哈希就声称成功。

确认超时后同文同配置的重复 POST 返回原任务，保护未知广播结果。该保护与普通报告缓存不同，不因缓存 TTL 到期解除。没有 tx_hash 且 attempted_at 已有值的重启任务标记 `BROADCAST_OUTCOME_UNKNOWN`，需要人工核对钱包/nonce；不要删数据重试。明确已回滚才允许新任务重试。

A 现在只用测试文件中的 mock 覆盖成功、回滚、错链、错合约、错 issuer、错 hash、重启恢复。它们不是网络记录，测试 proof 不能作为比赛凭证。

## 集成验收待 B 到位

1. B 实现免费 issuer-only `certify(bytes32,bytes32,uint8)` 与事件，完成真实测试网部署。
2. B 把网页 `/api` 代理到 A 的 IP:3001，使用共享协议包和示例事件。
3. 最终运行机本地配置模型 Key/ID、私钥和部署文件；不要经 Git 或聊天传秘密。
4. 真实双模型 → 链确认 → 三页面 → 下载 → 改 payload 后不匹配 → 只改 JSON 排版仍匹配。
5. 断网必须显示核对不可用，demo 与真实链凭证分开；保留实际 tx hash 与可查浏览器链接。

本轮不执行合约部署、MOJO 提交或 contract.dev 模拟。
