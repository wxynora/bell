# Bell Debug Index

Only completed and currently valid implementation entry points belong here.

## BELL-LOCAL-BRIDGE-001

- 配置与 CLI：`src/config.ts`、`src/cli.ts`
- SSE 与协议：`src/sse/client.ts`、`src/sse/parser.ts`、`src/protocol.ts`；connect timeout 覆盖到合法 `connected` 握手，只有握手完成后才切换 idle timeout，心跳或未知事件不能延长握手期限；事件在 parser 回调中逐条交付，不为单个 chunk 建立第二个无界数组。
- 本地投递闭环：`src/dispatcher.ts`、`src/injector.ts`、`src/control-client.ts`、`src/runner.ts`；连续短命连接共用有限重连预算，稳定性只按真实 SSE 存活时长判断，不包含断流后的队列排空时间；active＋queued 不同 wake 上限为 32，超限断流且不接收／丢弃／ACK 新项；本地失败终态统一报告 `blocked`，未获服务端确认就停止。
- 防重与恢复：`src/process-lock.ts`、`src/state/ledger.ts`；未 ACK accepted 永不清理，已 ACK accepted 保留 180 天后在后续 ACK 事务中清理。
- 边界：只处理 Doorbell 明确发出的 wake；普通消息不进入；只有 injector 返回 accepted 才先写本地账本再 ACK；cancel 不强杀已经进入 Runtime 的轮。
- 定向验证：Node.js 25.8.2 下 `npm run check`（TypeScript、28 项本地隔离测试、构建）、`node dist/cli.js --version`、`node dist/cli.js --help`；Node.js 24.19.0 下双 TypeScript 检查、同一组 28 项测试、构建和 CLI version。
- 许可证：`LICENSE` 与 `package.json` 使用 PolyForm Noncommercial License 1.0.0，禁止商业使用。
