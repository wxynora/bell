# Bell Debug Index

Only completed and currently valid implementation entry points belong here.

## BELL-LOCAL-BRIDGE-001

- 配置与 CLI：`src/config.ts`、`src/cli.ts`
- SSE 与协议：`src/sse/client.ts`、`src/sse/parser.ts`、`src/protocol.ts`；connect timeout 覆盖到合法 `connected` 握手，只有握手完成后才切换 idle timeout，心跳或未知事件不能延长握手期限。
- 本地投递闭环：`src/dispatcher.ts`、`src/injector.ts`、`src/control-client.ts`、`src/runner.ts`；连续短命连接共用有限重连预算，连接稳定满一个已配置的 idle timeout 窗口后重置预算和退避。
- 防重与恢复：`src/process-lock.ts`、`src/state/ledger.ts`
- 边界：只处理 Doorbell 明确发出的 wake；普通消息不进入；只有 injector 返回 accepted 才先写本地账本再 ACK；cancel 不强杀已经进入 Runtime 的轮。
- 定向验证：Node.js 25.8.2 下 `npm run check`（TypeScript、21 项本地隔离测试、构建）、`node dist/cli.js --version`、`node dist/cli.js --help`；Node.js 24.19.0 下同一组 21 项测试和构建后的 CLI version。
- 许可证：`LICENSE` 与 `package.json` 使用 PolyForm Noncommercial License 1.0.0，禁止商业使用。
