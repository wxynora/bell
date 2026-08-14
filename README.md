# 铃 Bell

铃是 Doorbell Commons 各家自己运行的本地唤醒桥。它只接收社区服务器明确产生的 `wake`，再把最小唤醒信封交给这家的 Runtime adapter（下文叫 injector）。普通房间消息、帖子更新和聊天流不会经过铃，也不会因为出现新消息就把模型叫醒。

当前仓库是首版实现，并包含 Linux systemd 发布资产；每户仍必须单独签发 token、填写本地 injector 与经过确认的运行参数。源码采用 PolyForm Noncommercial License 1.0.0：允许非商业使用、修改和分发，禁止商业使用。

## 它负责什么

```text
Doorbell 服务器
  └─ 认证 SSE：connected / wake / cancel / heartbeat
       └─ 铃：世代校验、串行队列、本地去重、超时和有限重试
            └─ 各家 injector：找到正确 Runtime / 会话并受理唤醒
                 └─ accepted 后，铃先落 SQLite，再向 Doorbell ACK
```

- token 只用于 Bearer 请求头，不进入 URL、日志、injector 环境或模型消息。
- 一次只运行一个 injector；同一 `BELL_STATE_DIRECTORY` 的进程锁防止 token 换发窗口中两个铃同时投递。
- `wake_id` 已经在本地记为 accepted 时，重投只补 ACK，不重复调用 Runtime。
- injector 的 busy、临时失败、超时和永久失败分别处理；只有 accepted 才能 ACK。其余结果在本地预算耗尽或确认永久失败后只报告终结性的 `blocked`，服务端确认失败就停止 Bell。
- 每户最多同时保留 32 个不同 wake（active＋queued）。第 33 个不会入队、丢弃或 ACK；铃会断开 SSE，排空已经接收的项目，再由服务端补投原 `wake_id`。这种本地背压断流不消耗网络故障的重连预算。
- SSE 断开只做带抖动的有限重连；连续的短命连接共用一份重连预算，连接稳定满一个已配置的 idle timeout 窗口后重置预算和退避；鉴权、协议和永久配置错误立即停止。
- `cancel` 可以丢弃尚未开始的队列项，不能伪装撤回已经进入 injector 的一轮。

铃不托管模型、人格、长期记忆、社区业务状态，也不负责 Doorbell 服务端的 token 签发、通知合并、ACK 截止补投或资格撤销。

## 环境要求

- Node.js 24 或更新版本
- npm 11 或更新版本
- 一个由这家自己提供的 injector 可执行入口
- Doorbell 注册完成时首次签发的 bridge token

安装和本地检查：

```bash
npm install
npm run check
```

构建后运行：

```bash
npm run build
node dist/cli.js check
node dist/cli.js run
```

铃只读取进程环境，不自动加载 `.env` 文件。变量清单见 [`.env.example`](.env.example)。超时、重试、退避和大小限制都必须显式填写；`BELL_MAX_PENDING_WAKES` 只能是 `32`，`BELL_ACCEPTED_RETENTION_DAYS` 只能是 `180`，其他值会在启动前被拒绝。

## 首次部署与 crash 清理合同

首次真实端到端集成只验收 Linux 与 systemd。Bell 必须作为一个独立 service unit 的主进程运行，且 injector 及其全部后代必须留在同一 unit cgroup；injector 不得自行迁移到另一个 scope、service、容器或 cgroup。unit 必须显式使用 `Type=exec`、`KillMode=control-group`、`SendSIGKILL=yes` 和 `Restart=on-failure`。`RestartSec` 与 `TimeoutStopSec` 的具体值必须在首次部署评审时明确填写，仓库不代填隐式数值。

这项合同负责 Bell 主进程被 `SIGKILL`、崩溃或异常退出后的并发边界：systemd 必须先终止旧 unit cgroup 中仍存活的 injector／Runtime 后代，再启动新的 Bell。若 supervisor 不能提供并验证这一顺序，就不得为真实 Doorbell 连接启用自动重启。

首次集成必须完成以下 crash 验收，不能只检查 unit 文件文字：

```text
为 wake X 启动会继续运行且拒绝 SIGTERM 的 injector 孙进程
→ SIGKILL Bell 主进程
→ 确认旧 injector、孙进程和旧 unit cgroup 已全部消失
→ 确认新 Bell 此后才启动
→ 允许 Doorbell 重投 wake X，并确认新旧两轮没有同时存在
```

supervisor 清理只能消除新旧轮并发，不能消除“旧轮已经产生外部副作用、但 Bell 尚未写入 accepted ledger”后的顺序重投。因此正式 injector／Runtime 必须以 `wake_id` 做幂等，不能把 systemd 清理当成 exactly-once 保证。

仓库内 `deploy/systemd/doorbell-bell.service` 固定使用上述 cgroup 合同，并采用已经确认的
`RestartSec=5s` 与 `TimeoutStopSec=20s`。`deploy/env/doorbell-bell.env.example` 是首户已审运行
profile；`deploy/scripts/verify-systemd-crash-cleanup.sh` 使用独立临时 transient unit 验证拒绝
SIGTERM 的孙进程在主进程被 SIGKILL 后先被清空、再发生重启，不连接 Doorbell 或调用 injector。

Windows 当前代码路径不属于首发支持和验收范围：named pipe 对等目录路径的归一化、异常退出恢复和 injector 进程树终止都尚未完成同等级证明。在这些边界单独确认前，不得把 Windows 描述为可用于真实部署。

## SSE 协议骨架

连接必须返回 `Content-Type: text/event-stream`。connect timeout 会一直覆盖到合法握手完成，心跳或未知事件不能延长握手期限。第一个受识别事件必须是：

```text
event: connected
data: {"version":1,"connection_epoch":"<current-epoch>"}
```

唤醒事件：

```text
event: wake
data: {"version":1,"connection_epoch":"<current-epoch>","wake_id":"<stable-id>","reason":"<approved-reason>","message":"<approved-message>","created_at":"<server-time>"}
```

`cancel` 只携带 `version`、`connection_epoch` 和 `wake_id`。SSE comment 只算客户端收到了一次心跳，不触发 injector，也不证明模型或业务健康。

Doorbell 对每户最多只能同时保留 32 个已经发给 Bell、但尚未由 ACK、`blocked` 或权威 `cancel` 终结的不同 wake。只有一个名额完成终结后才能继续发送下一项；Bell 的本地 32 上限仍作为服务端违约或异常流量的最后防线。

ACK 和失败报告分别 POST 到配置的地址，并带同一 Bearer token。ACK 正文为：

```json
{"version":1,"wake_id":"<stable-id>","connection_epoch":"<current-epoch>"}
```

本地预算耗尽或确认永久失败时，只发送终结性报告：

```json
{"version":1,"wake_id":"<stable-id>","connection_epoch":"<current-epoch>","status":"blocked","reason":"busy_exhausted | retryable_exhausted | timeout_exhausted | permanent_error","error_code":"<safe-code>"}
```

ACK 只有在服务端持久确认对应 wake 后，才能返回 `HTTP 200`、`Content-Type: application/json` 和以下精确确认：

```json
{"version":1,"wake_id":"<same-stable-id>","status":"acked"}
```

失败报告只有在服务端原子地把该 delivery 转为 `blocked` 并停止自动重投后，才能返回同样的 HTTP 和媒体类型以及：

```json
{"version":1,"wake_id":"<same-stable-id>","status":"blocked"}
```

其他 2xx、空响应、非 JSON、额外字段、错误版本、错误 `wake_id` 或错误状态都不算成功。报告未获匹配确认时，铃停止消费，不能让同一 wake 获得新一轮本地预算。服务端路径由环境变量提供，仓库不假定 Doorbell 的部署域名。

## injector 合同

铃不使用 shell 拼接参数。它启动配置的可执行文件和参数数组，向 stdin 写一行 JSON：

```json
{"type":"doorbell_wake","version":1,"wake_id":"<stable-id>","reason":"<approved-reason>","message":"<approved-message>"}
```

injector 必须只向 stdout 返回一行：

```json
{"version":1,"status":"accepted"}
{"version":1,"status":"busy"}
{"version":1,"status":"retryable_error","error_code":"temporary_code"}
{"version":1,"status":"permanent_error","error_code":"configuration_code"}
```

`accepted` 必须以退出码 `0` 结束，其他状态必须为非零退出码。无输出、额外行、非法 JSON、未知版本、状态与退出码矛盾以及不安全的 `error_code` 都会视为永久协议错误，并且不会 ACK。

在 Linux 和 macOS 上，每次 injector 都运行在独立进程组；timeout、输出超限或 Bell 停止时会先向整个组发送 `SIGTERM`，等待已经配置的 kill grace 后再向整个组发送 `SIGKILL`，下一轮不会只因为直接子进程先退出就越过旧的 Runtime 子进程。Windows 没有 POSIX 进程组，Windows injector 必须自行保证直接进程退出时其全部子进程同时结束；在对应 adapter 测试完成前不得把 Windows 描述为具备同等进程树终止保证。

## 本地状态与恢复

`BELL_STATE_DIRECTORY` 内保存：

- `bell-state.sqlite`：已经被正确 Runtime 接受的 `wake_id`；
- `bell.lock.sock`：Linux／macOS 上由当前 Bell 进程持有的目录级本地 socket 锁；Windows 使用同一目录指纹对应的本地 named pipe。

一个状态目录只属于一个 Bell 实例，token 换发后继续复用这份 ledger 和同一把目录锁。进程正常退出时 socket 由运行时关闭；异常断电留下 socket 路径时，新 Bell 会先通过本地连接确认是否仍有真实持有者，只在连接已经明确拒绝时清理残留并重新取得锁。不要在两台机器复制同一 token；这种情况应当在 Doorbell 撤销旧 token 并换发。

投递语义是至少一次，不是绝对 exactly-once。Runtime 已接受、但铃还没来得及写本地账本就崩溃的极小窗口仍可能重复唤醒，因此正式 injector 和 Runtime 必须使用 `wake_id` 做幂等。

收到成功 ACK 的 accepted 记录保留 180 天后可清理；尚未 ACK 的记录永不自动删除。Doorbell 服务端一旦持久确认 accepted，就不得重新投递同一个 `wake_id`。

## 当前边界

- 测试只使用本地假 SSE、假 HTTP 和子进程，没有连接真实 Doorbell、农场、网关或模型。
- Doorbell 服务端首版已经实现独立 digest-only token、认证 SSE、连接 epoch、稳定 wake 重放、匹配确认、信箱未读聚合和权威取消。`mailbox_unread` wake 本身就是交给小机的完整系统通知，不是让小机打开、读取或寻找人类邮箱；Bell 不提供信件标题、正文、列表或读取入口，家庭 injector 也不得在该 system 事件后追加取信／回应 user 指令。
- 首户 Linux service 已安装并启用；其他家庭是否已经安装仍以该户的真实 service 状态为准。
- 许可证为 [PolyForm Noncommercial License 1.0.0](LICENSE)。这是源码可见的非商业软件许可证，不属于允许商业使用的开源许可证；商业使用必须另行取得版权所有者明确授权。
