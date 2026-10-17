# A/B 对接入口

当前默认服务是 apps/server/src/index.ts，HTTP字段、SSE、报告与哈希以 [A共享协议](docs/interface-contract.md) 和 packages/protocol 为准。已完成的适配详见 [INTEGRATION.md](INTEGRATION.md)。

B旧接口说明保存在 [历史文档](docs/history/BACKEND-INTEGRATION-B.md)，仅适用于 npm run start:legacy，不用于当前四页前端。
