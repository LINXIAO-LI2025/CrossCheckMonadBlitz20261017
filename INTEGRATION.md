# A/B 集成

来源：A PR #2 / codex/backend，b964a16f5f7f6f528dfe45477879314577911407；B PR #1，ca66775f4fdaa2f38b1e77a7bea85e4010012adb。采用 merge 保留双方提交历史，保留 B 原后端、协议、legacy/b-web原页面与测试供回归；当前产品采用 A 共享协议。

## 接口决定

- 默认端口3001，A后端同源提供B四页及精确静态白名单。可选 npm run dev:web 提供5173→3001代理，BACKEND_ORIGIN仅供该开发代理和B旧服务。
- POST /api/verify 只包含 {content}。mode、Key、模型ID与链接口由A服务器控制。原文不做trim或Unicode规范化。
- config保留A七个核心snake_case字段，增加 backend_mode/live_available/chain_ready。前端先摘核心字段作严格schema校验。增加GET /api/jobs/latest、GET /api/qr，未改变共享schema。
- 浏览器由apps/web/src编译导入@crosscheck/protocol与@crosscheck/chain/browser。docs/shared.js、showcase/shared.js也由同一A共享包生成；历史payload和proof不改。
- SSE事件触发GET最新job；历史done不能覆盖后来的恢复。已有广播号时继续查询，不自动发第二笔交易。
- 下载使用 /api/jobs/:job_id/report；proof=null允许导出。/api/cert/:id与下载每次读取链，再比较存储payload和固定部署，断网拒绝返回已验证成功。
- demo最终report_ready、proof=null，从不调用writer；live缺Key明确失败。静态历史报告虽mode=demo但已有真实测试网proof，仍保留原记录，不作为当前A demo会发链的证据。

## 链模块

packages/chain/server读取服务器key，串行nonce，广播后先持久化tx_hash，验证receipt/event/calldata/链ID/目标/issuer/部署块/确认数。recover只读；超时不等于失败交易，不自动重发。Gateway关闭时清理provider，重启后利用持久交易号作定位提示但仍fresh核对。仅明确回滚允许新任务；其他查询失败继续保护未知结果。browser入口只能读取，全面比较指纹与proof。默认仅10143，本地31337需显式local和loopback RPC。

## 依赖与运行

统一npm workspaces和package-lock.json。B原pnpm文件保存在docs/history，仅作历史参考。npm ci后，npm run check运行浏览器bundle构建、完整类型检查、共享包构建、固定fixture校验，以及A/B和跨模块集成测试。npm test也会先构建浏览器bundle。

真实OpenAI/Anthropic调用需要各自有效API凭据；本次自动测试使用明确的test-only adapter，不能当作真实模型调用验收。

## 验证记录

2026-10-17 本机：npm workspaces安装成功；npm ci --dry-run通过；完整check含类型检查、共享包构建、固定fixtures及111项测试全部通过，0失败/跳过。测试涵盖A全部原测试、B全部原测试、新链模块隔离EVM、A HTTP→Gateway→真实隔离EVM→重启fresh read及拒绝本地proof兜底。

Edge独立无登录会话：三demo场景、POST仅content、原文/空白保留、XSS文本转义、报告下载/导入、嵌套理由篡改提示、4页390px（innerWidth和scrollWidth均390）通过，无页面JS错误。此项为浏览器模拟尺寸，不代表实际手机网络验收。

依赖锁对Ganache上游捆绑的Darwin-only fsevents显式标optional，修复Windows/Linux npm ci的平台错误；tarball完整性值保留，下载统一官方registry。

B独立入口npm run start:legacy默认5174、data-legacy/，使用legacy/b-web原版页面，保持B原API；本地EVM脚本显式传入的端口和目录仍优先。

浏览器经官方RPC只读复核现有Monad测试网凭证#3（区块71727673）通过，修改嵌套模型理由后被新reader拒绝；未新增公网交易。独立Node直连曾因本机网络超时不可用，错误分类已补回归，读RPC超时不会误报等待链确认。
