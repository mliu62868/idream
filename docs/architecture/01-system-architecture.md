# 01 · 系统架构

更新日期：2026-08-28

## 1. 架构形态

iDream 是 Bun + Turborepo monorepo，按事实权威和执行时长拆成五个一方包：

| 包 | 职责 | 持久化权威 |
| --- | --- | --- |
| `packages/main` | 用户产品、Character、ChatSession/Turn、计费、Generation、媒体、Admin API | PostgreSQL + Blob |
| `packages/chat` | 接收不可变 Turn 快照；内嵌 DSH/igrep 执行；流式 AgentRun | 未决/失败 run trace + DSH/igrep workspace；Redis 只缓存 SSE |
| `packages/gen` | 图片/视频 provider 执行与不可变终态记录 | Blob + Main/Gen durable protocol |
| `packages/admin` | 运营界面；写操作进入 Main authority | 无独立产品数据库 |
| `packages/shared` | 跨包协议、Zod schema 和稳定类型 | 无运行时权威 |

核心取舍只有一个：**产品事实集中在 Main；模型和生成执行可以拆进程，但不建立第二份产品数据库。**

## 2. Chat 与生成主链

```text
Browser
  -> Main BFF
     -> Main PostgreSQL: transaction creates user message + pending assistant Turn
     -> signed immutable execution snapshot
        -> Chat: local AgentRun
           -> Chat embedded agent-runtime: DSH model/tool loop
              -> image/video ToolEffect
                 -> Main: entitlement + reserve + Generation Request/Attempt
                    -> Gen: provider execution
                    -> Main: Delivery + Settlement/refund
           -> terminal candidate
        -> Main: exact attempt CAS + durable ACK
  <- Main SSE/history: only selected product Turn and current-attempt attachments
```

Chat 收到 Main terminal ACK 后才能发送 SSE `done`；随后删除成功 run 文件。长期记忆只由 Main 已提交 Turn 的异步投影更新。DSH 事件、token、工具输出和本地 transcript 都不能反向成为用户消息列表。

## 3. 一致性边界

| 边界 | 一致性规则 |
| --- | --- |
| Main 内部产品写入 | Prisma transaction；同一交互事务内查询串行执行 |
| Chat terminal | `turnId + assistantMessageId + attempt` CAS；完全相同才算幂等 replay |
| ToolEffect | `turnId + attempt + callId + argumentsDigest` 幂等；Main 先 reserve/admit，再 ACK |
| Generation | `Request -> Attempt -> TransportExecution -> TerminalRecord -> Artifact/Delivery -> Settlement` |
| SSE | 可丢、可重连的暂态传输；不能作为完成权威 |
| AgentRun 文件 | 单 writer、原子 input/proposal、append+fsync events；成功 ACK 后删除，失败 trace 保留 7 天 |
| companion memory | 从已提交 Turn 派生，可删除/重建；不能覆盖 Main 产品事实 |

## 4. Main 内部分层

```text
Next Route/BFF
  -> domain module / authority seam
     -> Prisma transaction or durable queue admission
     -> provider port
```

- Route 只做 HTTP 适配、鉴权上下文和 schema 校验。
- 领域 module 保存不变量、授权、状态转换和事务。
- Provider 只封装第三方/本地执行器，不承载产品计费规则。
- `packages/shared` 只放真正跨包的 wire contract；包内实现类型留在包内。

## 5. 异步与进程

- BullMQ 用于 Main/Gen 的生成、terminal/finalizer、webhook 与后台任务。
- Chat 不使用 BullMQ；一次 Turn 是 Main 到 Chat 的有界 HTTP AgentRun。
- Redis 在 Chat 侧只保存可恢复的 SSE token stream；最终历史来自 Main PostgreSQL。
- PM2 是完整产品拓扑的进程管理器；所有一方 TypeScript/Next 进程由 Bun 解释执行。
- Docker Compose 只提供本地 PostgreSQL/Redis，不是产品部署入口。

## 6. 数据与部署

- 只有 Main 使用 Prisma/PostgreSQL。`packages/chat` 没有 schema、role、migration 或数据库 URL。
- 媒体字节进入 Blob；数据库保存身份、状态、校验和、交付和结算事实。
- `CHAT_FS_ROOT` 必须是 Chat 单 writer 可持久访问的绝对路径。多实例前必须先解决共享文件和写入仲裁；当前固定 `instances: 1`。
- DSH/igrep 与 Chat 同进程、同生命周期；只有 Main 端口可提交产品终态或 ToolEffect。

## 7. 架构不变量

1. 用户看到的会话、user message、唯一最终回复、附件和计量只来自 Main。
2. Chat 文件不保存可独立展示的第二份聊天历史，不保存余额/usage ledger。
3. 图片/视频计费属于 Main Generation/Ledger；不存在“provider 成功后回调直接扣费”。
4. 同一 ToolEffect 重试不得重复生成或重复扣费；参数变化必须冲突。
5. 旧 attempt 的终态或附件不得覆盖/泄漏到当前 attempt。
6. 没有 immutable Character content/Soul pin 时不启动 ChatSession/AgentRun。
7. 删除产品 Turn 与清理 AgentRun 是不同数据类别；两者分别由 Main 和 Chat 执行并通过精确回执协调。
8. 旧 Chat PG 只可作为一次性离线导入来源，不能重新接回运行时。

Chat 的详细协议见 [14-chat-service-tech-design.md](./14-chat-service-tech-design.md) 与 [ADR-20](./20-local-file-chat-authority.md)；队列与生成见 [06-async-jobs-and-ai.md](./06-async-jobs-and-ai.md)。
