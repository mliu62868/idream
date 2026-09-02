# 10 · 运行与发布

更新日期：2026-09-02

## 1. 运行拓扑

完整产品的进程结构由 `scripts/runtime-topology.cjs` 唯一定义，
`ecosystem.config.js` 只负责物化，gated PM2 wrapper 与 worker ownership
检查消费同一份定义：

| 进程 | 作用 |
| --- | --- |
| `main-web` | 产品 HTTP/BFF、Main PostgreSQL authority |
| `admin-web` | 运营 UI |
| `chat` | 本地 AgentRun + 内嵌 DSH/igrep + SSE |
| `gen-image` / `gen-video` | 图片/视频 provider worker；mock video 时不注册 video worker |
| `gen-finalizer` | Generation terminal relay/finalize |
| `main-event-consumer` | Main durable events |
| `admin-command-worker` | Admin command execution |
| `fish-audio` | 可选的参考音频克隆与 Fish 角色声音进程 |
| `pocket-tts` | 默认英语语音与 Pocket 角色声音进程 |

PM2 是生命周期管理器，Bun 是所有一方 JavaScript/TypeScript/Next 进程的解释器。Docker Compose 只提供本地 PostgreSQL/Redis。

```bash
bun run pm2:start
bun run pm2:status
bun run pm2:restart

bun run build
bun run pm2:start:production
```

生产启动/重启只用仓库 wrapper；直接操作 PM2 会绕过 source revision、queue fence 和 readiness。
development 的 source watch 明确是 `non-certifying-source-watch`；只有绑定单一
source revision 的 production immutable topology 才能签发运行态证明。

## 2. 数据权威与运行目录

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 产品/Chat Turn/计费/Generation metadata | Main PostgreSQL | 唯一产品数据库 |
| 媒体字节 | Blob/R2/S3 | DB 保存引用、校验和与交付事实 |
| Chat AgentRun | `CHAT_FS_ROOT/runs` | 未决恢复与 7 天失败诊断，不是产品消息 |
| companion memory | DSH igrep canonical root | 从已提交 Turn 派生 |
| private run memory | DSH igrep private root | 隔离、短期、不可进入 canonical memory |
| Chat token stream | Redis | 暂态 SSE transport |

`packages/chat` 不配置 PostgreSQL URL、role、Prisma 或 BullMQ prefix。Main/Gen 仍共享经过校验的 Redis/BullMQ authority。

## 3. 环境变量边界

### Main

- `DATABASE_URL`
- `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET`
- `CHAT_SERVICE_URL` / `CHAT_BFF_SIGNING_SECRET`
- `INTERNAL_TOKEN`
- `REDIS_URL` / `BULLMQ_PREFIX`
- `VOICE_PROVIDER=pocket-tts`：未绑定角色声音时的默认英语语音权威
- `VOICE_IDENTITY_PROVIDER=fish-audio`：可选的参考音频克隆入口；未设置时新角色声音候选跟随 Pocket；已激活 profile 始终以自身持久化 provider 为权威
- `FISH_AUDIO_*` / `POCKET_TTS_*`：两个独立 runtime 的 endpoint、token、model、language 与 voice registry
- Main moderation、billing、Blob、Generation 和 Sentry 配置

### Chat

- `CHAT_PORT` / `CHAT_FS_ROOT` / `CHAT_REDIS_URL`
- `MAIN_WEB_URL` / `INTERNAL_TOKEN`
- `CHAT_BFF_SIGNING_SECRET`
- `DSH_IGREP_PLUGIN_URL` / `DSH_BOOTSTRAP_STATE_PATH`
- `DSH_IGREP_CANONICAL_ROOT` / `DSH_IGREP_PRIVATE_ROOT`
- `CHAT_MODEL_PROVIDER` / `CHAT_MODEL_BASE_URL` / `CHAT_MODEL_NAME` / `CHAT_MODEL_API_KEY`：Turn 与 full readiness 共用唯一模型配置
- `DSH_MAX_*` / `DSH_AGENT_DEADLINE_MS`：并发、step 与 attempt deadline

Chat 没有独立 moderation provider。输入/输出产品策略属于 Main。

### Gen

- `GEN_REDIS_URL` / `BULLMQ_PREFIX`
- `GEN_IMAGE_PROVIDER` / `GEN_VIDEO_PROVIDER`
- provider/model/workflow exact pins
- Blob 与 Main terminal ingest credentials

每个服务加载自己的 env 文件。`check:launch` 通过显式 `--launch-env-file`、`--admin-env-file`、`--chat-env-file`、`--gen-env-file` 合成只读检查视图，禁止靠 ambient fallback 混淆 authority。

## 4. Readiness

- liveness 只说明进程活着；发布必须使用 full readiness。
- Chat admission readiness 只检查可写 `CHAT_FS_ROOT`、Redis 与签名配置；full certification 另行检查内嵌 DSH package、official igrep plugin/bootstrap、provider/model 和 profile pin。
- Gen readiness 检查 worker ownership、provider/workflow/model bytes 和 terminal ingress。
- Main readiness 检查 migration、Turn ledger、Character/Soul pins、Generation/settlement 和跨服务 secrets。
- Voice live probe 默认验证 Pocket 可播放输出、官方英语 catalog 与 preset alias → synthesize → delete。配置 Fish identity override 时，同一份报告还必须包含 Fish clone → synthesize → delete。生产 PM2 按实际 system/identity provider 要求对应进程和 `/health`，不能只凭进程 online。

```bash
bun run check:launch -- \
  --launch-env-file .tmp/production-main.env \
  --admin-env-file .tmp/production-admin.env \
  --chat-env-file .tmp/production-chat.env \
  --gen-env-file .tmp/production-gen.env \
  --report .tmp/check-launch.json
```

所有运行报告必须绑定同一 `IDREAM_SOURCE_REVISION`。历史报告不能改名后用于新 revision。

四个进程的 Sentry canary 分别刷新，不能用 Main 的报告代替其他服务：

```bash
bun run launch:probe:sentry:main -- --report .tmp/launch-sentry-main-probe.json
bun run launch:probe:sentry:admin -- --report .tmp/launch-sentry-admin-probe.json
bun run launch:probe:sentry:chat -- --report .tmp/launch-sentry-chat-probe.json
bun run launch:probe:sentry:gen -- --report .tmp/launch-sentry-gen-probe.json
```

## 5. 数据库迁移与 Chat cutover

数据库模式只由 Main Prisma migration 管理。迁移和旧数据导入由用户/CI执行。

| 动作 | 入口 |
| --- | --- |
| Main migration | `bun run --filter @idream/main db:migrate:deploy` |
| Chat Turn authority migration | `20260827120000_main_chat_turn_authority` |
| 旧 Chat 产品事实导入 | `db/sql/2026-08-27-chat-turns-to-main.sql` |

Cutover 顺序：

1. 停止新 Turn admission，drain Chat/Gen，确认无 active/unknown attempt。
2. 备份 Main、旧 Chat schema、Blob、AgentRun 与 DSH workspace。
3. 用户/CI部署 Main migration并执行导入脚本。
4. 对账 session、Turn、selected reply、attachment、Scene 与计费引用。
5. 以 Main history + 本地 AgentRun 启动，旧 Chat schema 只读观察。
6. 观察期后另行评审旧 schema/roles 的不可逆删除。

导入脚本不删除旧数据；仓库 agent 不直接连接生产库改表。

## 6. 发布顺序

1. 固定 source revision，构建 immutable artifact。
2. pause Generation admission/queues；等待 active attempt terminal 或明确对账。
3. 停止 Main/Admin/Chat/event/admin workers，再停止 Gen；finalizer 最后；PM2 wrapper 在 drain 与 ownership fence 后停止 Fish 和 Pocket 两个语音 runtime。
4. 执行 migration/cutover（如有）。
5. 启动进程，等待期望实例数和 full readiness。
6. 运行 Main/Chat/Gen probes 与最小真实生成。
7. 明确 resume queues；任何步骤失败时保持 paused。

PM2 `online`、HTTP 200 或 mock 成功都不能单独作为发布通过证据。

## 7. 备份与恢复

同一静默边界的 recovery checkpoint 至少包含：

- Main PostgreSQL custom dump + migration/schema/logical manifests；
- `CHAT_FS_ROOT` AgentRun archive + file checksum manifest；
- DSH canonical/private workspace archive + manifest；
- local Blob archive，或独立 versioned recovery bucket 的 object inventory；
- quiescence receipt、source revision、时间和总 manifest SHA-256。

恢复必须进入 disposable DB/AgentRun/DSH/Blob 目标，比较 checksum、schema、计数、稳定 durable backlog 和引用完整性。数据库 restore 成功不等于聊天执行证据或媒体可恢复。

`bun run recovery:rehearse` 的 schema 2 已移除旧 Chat PG/inbox/file-mutation
假设，并把 Main PostgreSQL、AgentRun、DSH canonical/private、Blob 与 queue
receipt 固定进同一 checkpoint digest。schema-1 的历史 bundle 不再具备当前
认证资格；每次迁移或 source revision 变化后都必须生成新的 schema-2 bundle，
完成所有 authority 的隔离恢复并由 launch gate 验证。

## 8. 验证门

本地变更最少运行：

```bash
bun run test
bun run typecheck
bun run build
bun run lint
```

发布还需：

- fresh/upgrade migration rehearsal；
- Main/Chat/Gen 真实进程 readiness；
- authenticated Playwright 用户与运营旅程；
- 最低充分的真实图片/视频/语音 provider 请求；
- request/attempt/artifact/delivery/settlement、耗时、费用和持久化证据；
- production recovery 与观察窗。

任何失败、跳过或因无生产权限未执行的步骤都必须在结论中明确列出。

## 9. 日志与告警

- 结构化日志关联 request/turn/attempt/toolCall/generation/delivery/settlement identity。
- 不记录 secret、完整敏感正文或签名 payload。
- 告警覆盖：Main terminal CAS 冲突、ACK 延迟、active AgentRun 泄漏、SSE 重连异常、生成队列积压、provider 失败率、重复/缺失 settlement、Blob delivery drift。
- Sentry release 必须与 source revision 一致；四服务分别上报并以 canary probe 验证。
