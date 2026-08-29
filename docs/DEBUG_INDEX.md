# Bell Debug Index

Only completed and currently valid implementation entry points belong here.

## BELL-SHARED-MEME-UPDATE-003

- 协议与分流：`src/{protocol,dispatcher,runner}.ts` 接受同一认证 SSE 上的 `update_available { resource: "shared_meme", available_version }`，先核验协议版本与当前 `connection_epoch`，再写本地状态；该事件不进入 injector、wake 队列、ACK 或 blocked report。
- 本地状态：`src/state/ledger.ts` 在既有 `bell-state.sqlite` 保存 `bell_updates`。普通可用／已应用提示继续单调取高；家庭后端只有在 Doorbell 返回 `shared_meme_version_ahead` 且权威全量同步成功后，才可调用 `replaceUpdateWatermarkAfterFullSync()` 把 available／applied 精确替换为服务端当前版本，随后新版本仍正常形成 available > applied。Bell 本身不下载共享梗正文，也不要求收到提示后立即同步。
- 普通 wake 固定样本：`tests/fixtures/doorbell-wake-v1.json` 与 Doorbell server 的同名 fixture 保持同一顶层 `message`＋`created_at` 外壳，并由 `tests/protocol.test.ts` 直接交给严格 `decodeBellEvent()`；不兼容旧 `payload` 形状。
- 定向验证：双 TypeScript 检查通过；协议／状态定向测试 11/11，覆盖非法资源拒绝、旧版本不回退、`319 → 权威全量 318 → 新提示 319`、关闭重开仍保留水位及跨仓普通 wake fixture。全部均未 install／deploy，也未连接真实 Doorbell、网关或模型。

## BELL-LOCAL-BRIDGE-001

- 配置与 CLI：`src/config.ts`、`src/cli.ts`；所有数值仍显式填写，其中 pending wake 固定为 32、成功 ACK 记录保留期固定为 180 天，配置加载拒绝其他值。
- SSE 与协议：`src/sse/client.ts`、`src/sse/parser.ts`、`src/protocol.ts`；connect timeout 覆盖到合法 `connected` 握手，只有握手完成后才切换 idle timeout，心跳或未知事件不能延长握手期限；事件在 parser 回调中逐条交付，不为单个 chunk 建立第二个无界数组。
- 本地投递闭环：`src/dispatcher.ts`、`src/injector.ts`、`src/control-client.ts`、`src/runner.ts`；连续短命连接共用有限网络重连预算，稳定性只按真实 SSE 存活时长判断，不包含断流后的队列排空时间；active＋queued 不同 wake 上限为 32，超限断流且不接收／丢弃／ACK 新项，排空后重连不消耗网络预算；ACK／report 只接受 `HTTP 200`、JSON、相同 `wake_id` 和对应 `acked`／`blocked` 状态的三字段确认，任意其他 2xx 不算成功；本地失败终态统一报告 `blocked`，未获服务端确认就停止。Linux／macOS injector 使用独立进程组，timeout、输出超限或停止会按已配置 grace 对整个组发送 TERM／KILL；Windows 仅有文档化的 adapter 子进程生命周期责任，尚无同等进程树保证。
- 防重与恢复：`src/process-lock.ts`、`src/state/ledger.ts`；一个 state directory 只允许一个 Bell，token 换发继续复用同一 ledger；Linux／macOS 用进程持有的本地 socket 锁并在确认无持有者后恢复异常退出残留，Windows 用目录指纹对应的 named pipe；未 ACK accepted 永不清理，已 ACK accepted 保留 180 天后在后续 ACK 事务中清理。
- 边界：只处理 Doorbell 明确发出的 wake，不从消息、信箱或业务正文自行推导。人类 Doorbell 信箱已经从社区生产者中移除；早期 `mailbox_unread` 仅作为首户验收历史，遗留 pending 由服务端 cancel。当前聊天不进入，未来聊天是否叫铃随社区接入模式另定。只有 injector 返回 accepted 才先写本地账本再 ACK；cancel 不强杀已经进入 Runtime 的轮。Bell 自身被 `SIGKILL` 时无法执行本地进程组清理，所以首次真实集成只允许 Linux systemd，并要求 `KillMode=control-group` 在重启前清空旧 injector cgroup；这不能替代正式 injector／Runtime 对 `wake_id` 的幂等。Windows 尚未完成同等级的目录等价锁和进程树验收，不属于首发支持路径。
- 定向验证：Node.js 25.8.2 下 `npm run check`（双 TypeScript 检查、33 项本地隔离测试、构建）、`node dist/cli.js --version`、`node dist/cli.js --help`；Node.js 24.19.0 下双 TypeScript 检查、同一组 33 项测试、构建和 CLI version。新增回归直接覆盖两轮满队列不耗网络预算、孙进程终止、跨 token 目录锁、异常退出锁恢复、固定 32／180 与控制确认拒绝。
- 许可证：`LICENSE` 与 `package.json` 使用 PolyForm Noncommercial License 1.0.0，禁止商业使用。

## BELL-LINUX-FIRST-HOUSEHOLD-002

- 发布资产：`deploy/systemd/doorbell-bell.service`、`deploy/env/doorbell-bell.env.example`；Bell 以独立 `Type=exec` unit 运行，injector 留在同一 control-group，异常退出按 `RestartSec=5s` 重启，停止最多等待 `20s` 后由 `SendSIGKILL=yes` 清理整组。首户明确使用 10 秒连接／HTTP deadline、90 秒 SSE idle、1→30 秒有限重连、5 分钟 injector deadline、30 秒 retry／busy 间隔，以及已审机器信封大小护栏。
- crash 验收：`deploy/scripts/verify-systemd-crash-cleanup.sh` 只启动独立临时 transient unit，不读取 Bell token、不连接 Doorbell、不调用正式 injector；第一轮孙进程拒绝 SIGTERM，主进程被 SIGKILL 后，脚本要求旧孙进程消失且无 overlap 标记，第二轮才能成功启动。
- 部署边界：GitHub main 的 `9f5164f8643e232f83bd87215bd0b8f4ff77fe10` 已安装到网关 `/opt/bell`。正式 env `/etc/doorbell-bell.env` 为 mode 0600，token 只在 Bell 进程 Bearer 请求中使用并由 `src/injector.ts` 从子进程环境删除；`BELL_STATE_DIRECTORY=/var/lib/doorbell-bell` 不和网关业务数据库混用。`doorbell-bell.service` 已 enabled 且 active/running，`NRestarts=0`。
- 定向验证：`bash -n deploy/scripts/verify-systemd-crash-cleanup.sh`；`npm run check`（33/33、本地双 typecheck、构建）；目标 Linux 上的真实拒绝 SIGTERM 孙进程 crash 清理通过。生产 SSE 已连接，历史首只 `mailbox_unread` 完成 accepted／ACK；该原因现已停止生产，记录只作为链路验收历史。首户 injector 的隔离回归另要求一个 wake 只生成一个 system 消息，没有追加 user 消息或真实模型调用。
