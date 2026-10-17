# CrossCheckMonadBlitz20261017 · CrossCheck

以 A 的共享协议和后端为主入口，接入 B 的四页面界面、Solidity 合约和链上核验。双方提交历史和原有实现均保留；B 原后端通过 start:legacy 单独运行。

## 在线演示

[打开 CrossCheckMonadBlitz20261017](https://yanyu473.github.io/CrossCheckMonadBlitz20261017/) · [项目说明](https://yanyu473.github.io/CrossCheckMonadBlitz20261017/about.html) · [站点地图](https://yanyu473.github.io/CrossCheckMonadBlitz20261017/sitemap.xml)

公开站回放固定样例，支持报告导出与真实 Monad 测试网记录核验。任意文字的实时审阅需要运行下方完整 Node 服务并配置模型 API。

## 运行

Node.js 22+，在仓库根目录执行：

```sh
npm ci
npm run check
npm start
```

打开 http://localhost:3001 。无需 Key 的默认 demo 使用明确标识的固定模型结果，报告 proof=null，不发送交易。原文按输入原始字节计算哈希，前端与服务端均使用 packages/protocol。

需要配置时复制 .env.example 到 .env。真实双模型模式需要 MODE=live 和两个厂商的 API Key、可调用模型 ID。实际存证另需 CHAIN_ENABLED=true、ISSUER_PRIVATE_KEY 和 deployment.json；浏览器只读 RPC。私钥、Key、运行报告不提交。

## 实现

- apps/server：A 的队列、缓存、SDK 适配器、持久化、SSE、下载与恢复。默认端口3001，同时提供 B 页面。
- packages/protocol：A 的唯一共享类型、schema、规范序列化与哈希。
- packages/chain：B 链实现对 A 接口的适配，包含独立 server/browser 入口。
- apps/web/src 与根 HTML/JS：B 界面，构建时注入共享协议与只读链模块。
- server.ts、server/、protocol.ts、types.ts：保留的 B 原实现；npm run start:legacy 启动，npm run demo:legacy 使用本地 EVM。默认产品不使用这些协议副本。
- docs/ 与 showcase/：历史已存证样例的静态回放；固定模型结果不代表实际模型调用。

API 和字段以 [共享接口](docs/interface-contract.md) 为准。集成说明见 [INTEGRATION.md](INTEGRATION.md)，A/B 原说明保存在 docs/history。

## 证明边界

报告指纹匹配只证明文件与指定合约记录相符，不证明内容正确、真实模型调用发生或模型厂商签名。现有 Monad 测试网公开部署记录保留在 deployment.json；静态回放中的报告与该合约匹配。真实 OpenAI/Anthropic 调用需各自有效凭据，目前不能据代码或 demo 宣称已实测。
