# 13 · 未完成功能 Backlog（后续准备）

更新日期：2026-06-15

> 本文件是**当前真实状态**下的未完成清单，作为后续迭代的起点。与 [12-roadmap.md](./12-roadmap.md)（里程碑/暂缓项）和各 ADR（[02](./02-technical-decisions.md)）互补：roadmap 讲"计划顺序与硬门"，本文件讲"截至今天，代码里到底还差什么"。
>
> 校对方式：逐项基于 `src/` 代码核对（grep/读源码），不是凭设计文档推断。

## 0. 当前基线（已完成，便于对照）

- ✅ 后台 API 面 100% 覆盖 `BackendFeatureSpec §5`（auth/me/age-gate/characters/drafts/chat/generation/media/billing/library/profile/referral/redeem/account/reports/appeals/admin/feed/community/users-follow/events）。
- ✅ 数据模型（43 model）、双库可移植 schema、seed。
- ✅ 鉴权（better-auth + 自管 session + dev 头）、age gate 强制、举报+审核闭环、underage 即时隐藏、dreamcoin ledger、mock 支付计费链路、entitlement 派生、Premium 门（402）。
- ✅ 测试：76 个 L2/L3（Vitest，含安全/鉴权/计费/流程/队列/状态机）+ 4 个 L4 E2E（Playwright，7 关键流）+ 覆盖率门（Stmts 88.6%/Lines 91.4%/Branch 78%）+ 双库 CI。
- ✅ 前端：Explore/详情/Auth/Chat/Create/Generate/Profile/Upgrade workspace 接 API；顶栏登录态。
- ✅ 真实 Chrome 端到端走通：age gate→explore→详情→注册→聊天(mock 回复)→刷新历史在。

---

## A. 合规与资金（上线前 P0 硬门）

> 对应 roadmap §"暂缓项"。MVP 用 mock 顶上，**面向真实用户/真实内容上线前必须清零**。业务层已留接口，接真实实现时应零改动、只换 provider + 开门控。

| 项 | 现状 | 待办 | 关联 |
| --- | --- | --- | --- |
| **真实加密支付** | `MockPaymentProvider`（createInvoice + 自动确认 IPN）跑通 checkout→webhook→entitlement→ledger | 接 BTCPay/处理器，签名校验，testnet→mainnet，对账/退款 | ADR-4 / [08](./08-billing-and-entitlements.md) / M7 |
| **CSAM 检测 + NCMEC 上报** | `MockModerationProvider` 仅关键词（underage/minor/csam）+ 角色 age≥18 硬规则 + moderation_events | 接哈希匹配(PhotoDNA)+分类器，命中留证+法律上报 runbook（需法务） | [07 §3.2](./07-security-and-compliance.md) |
| **第三方身份年龄验证** | `age_verifications` 表 + `requireAgeVerified` 守卫 + webhook 幂等就位；默认 `not_required` 直通；provider 为 mock | 接 Go.cam 等，按辖区/风险触发，真实跳转+回调 | ADR-7 / [07 §2.3](./07-security-and-compliance.md) |

---

## B. AI 真实接入（核心，目前全部为 mock）

> `src/server/providers/index.ts` 当前**只注册 Mock\* provider**；env 允许 `*_PROVIDER=pipeline` 但**无 pipeline 实现**。这是"除 AI 外功能对齐"的那个"除"——按目标，AI 留接口、用 mock，但真实产品必须接入。

| 项 | 现状 | 待办 |
| --- | --- | --- |
| Chat 模型 | `MockChatModel`（回 `Mock <name> reply: ...`） | `PipelineChatModel`（OpenAI 兼容内网流水线 API），system prompt 注入、多轮、停用词 |
| 图片生成 | `MockImageModel`（返回固定资产） | `PipelineImageModel`，分辨率/朝向/preset→真实参数，输出落 BlobStore |
| 视频生成 | `MockVideoModel` | `PipelineVideoModel`，时长/帧率，异步回调 |
| 语音 | `MockVoiceModel`（**未接任何路由**） | 设计语音端点 + TTS/voice clone 接入 |
| 审核 | `MockModerationProvider`（关键词） | 真实多模态审核（见 A 的 CSAM 项），输入+输出双层 |
| 模型基建 | 无 | 自托管开源模型推理集群（GPU）、流水线 API 网关、容量/限速/超时 |

---

## C. 异步运行时（设计已出，未接线）

> 文档 [06](./06-async-jobs-and-ai.md) 设计了 DB 队列 + worker + `after()`，但**生成/聊天目前在请求内联同步执行**，队列只入不出。

| 项 | 现状 | 待办 |
| --- | --- | --- |
| **队列消费/worker 处理器** | `DbJobQueue` 能 enqueue/claim/complete/fail/dead；`/api/internal/worker` **只 claim 不处理**；各队列（chat.generate/generation.image/moderation.\*/report.triage/reward.ledger…）入队后无消费者，job 堆积 | 实现各队列 handler（认领后真正处理）；把内联生成/聊天迁移为真正异步 + 状态轮询/SSE |
| **Cron 调度** | 无 `vercel.json/vercel.ts` crons；worker 端点无触发源 | 配 Vercel Cron 定时打 worker；超时/重入/死信重放 runbook |
| **`after()` 收尾** | 未使用 | 把 analytics、views 自增、非关键副作用移到 `after()` |
| **聊天 SSE 流式** | `sendChatMessage` 服务端拉完整 mock 回复后一次性返回；无 `text/event-stream`；spec 的 `?stream=1` 未接 | 真正 token 级 SSE 到前端，前端逐字渲染 |
| **聊天记忆 summary** | `ChatSession.memorySummary` 字段存在但**从不写入** | 滚动摘要/长程记忆，注入后续 prompt |

---

## D. 平台能力（ADR 已定，未实现）

| 项 | 现状 | 待办 | 关联 |
| --- | --- | --- | --- |
| **限流** | 无任何限流逻辑（仅 `rate_limited` 错误码存在） | 鉴权/生成/聊天/举报端点限流；dev DB 令牌桶 / prod Upstash | ADR-9 |
| **缓存** | 无 `use cache`/`cacheTag`；公开目录/SEO 全动态 | Cache Components 缓存目录/角色，按 tag 失效 | ADR-10 |
| **可观测性** | `pino` 日志在；无 Sentry；analytics_events 入库但**无漏斗/看板** | 接 Sentry，PRD §9 漏斗 SQL/看板 | [10](./10-operations.md) |
| **对象存储真实化** | `MockBlobStore.signGetUrl` 返回占位；媒体 url 直指 `/images/...` | R2/Vercel Blob(private) + 真实签名 URL + 防盗链 | ADR-8 |

---

## E. 鉴权扩展

| 项 | 现状 | 待办 |
| --- | --- | --- |
| OAuth（google/discord） | `Account.providerId` 支持，但只接了 `credential`；better-auth 未配 socialProviders | 接 Google/Discord 等社交登录 |
| 邮箱验证 | 注册即 `emailVerified:true`（跳过） | 发验证邮件 + 验证流程 |
| 密码重置 | 无 | forgot/reset password 流程（`Verification` 表已在） |
| 会话安全 | 自管 session + better-auth 双路径并存 | 统一策略；设备管理 UI（sign-out-all 已有 API） |

---

## F. P1 / V1.1 产品功能（部分为占位/空态）

> 对应 roadmap V1.1。当前多为 200 占位或空态。

| 项 | 现状 | 待办 |
| --- | --- | --- |
| Feed 动作 | GET feed 返回热门角色；`share`/`report` 真实；`items/:id/like`、`remix` 为 `{accepted:true}` 占位 | 真实 like/remix（remix→草稿/生成流） |
| Community 榜单 | `leaderboards.characters` 真实；`dreamers`/`collections` 为空数组；`collections` 端点返回公共 collection | dreamers 榜（创作者）、collections 榜与详情 |
| Group chats / Packs | `library/group-chats`、`library/packs` 返回空态 + Create CTA | 多角色群聊、内容包 模型与流程 |
| Creator profile 公开 | 无公开创作者主页 | `/creator/:id` 公开页 + follow（follow API 已有） |
| 高级生成控制 | 基础 mode/prompt/preset/outputCount | 负面提示、朝向、模型选择、批量、ControlNet 类参数（多数需 B） |
| 生成资产管理 | 列表/like/下载/删除/批量在 | 收藏夹/collection UI、筛选、分享 |
| SEO 文章正文 | `[...slug]` 路由页用模板占位文案 | 真实文章正文、内链、结构化数据、内容运营 |
| 通知 | `notificationSettings` 偏好字段在；无投递 | 站内/邮件通知投递 |
| 兑换/推荐发奖 | redeem(恰好一次)、referral invite 在 | referral 达成→自动发奖（reward.ledger 队列消费，见 C） |

---

## G. 前端深度与设计

| 项 | 现状 | 待办 |
| --- | --- | --- |
| Workspaces 完整度 | Create/Generate/Profile/Upgrade 已接 API，但交互深度/多步细节相对目标站简化 | 对照 `docs/research/*` 与目标站补齐多步、状态、空/错/载入态 |
| 顶栏/导航联动 | 顶栏登录态已修；筛选 Pill（Female/Style/Age）为静态展示 | Pill 接 `gender/style/age` 查询参数；移动端导航/搜索联动 |
| 像素级还原 | 主要页面接近 | 逐页对照设计参考核对间距/字体/动效（AGENTS 的 beauty-first） |

---

## H. 测试补强

| 项 | 现状 | 待办 |
| --- | --- | --- |
| Postgres 实跑 | CI 有 postgres job；本地默认 SQLite | 本地起 Docker PG 跑 `test:postgres`，消除双库差异税；覆盖 PG-only 认领路径（SKIP LOCKED） |
| 分支覆盖 | 78%（PG 路径/env 配置分支不可达） | 接入 PG 后补分支；service 错误分支补测 |
| E2E webServer | Playwright 自管 `next dev` 就绪探测本机失效，已改外部 server 模式 | 排查根因或固化外部 server 方案；CI e2e job 已就位 |
| worker 处理器测试 | 仅测 claim | 实现 C 的处理器后，补"入队→消费→完成/失败/重试/死信"全链路 + 幂等/重入 |
| 负载/并发 | 无 | 队列认领并发、ledger 并发扣减、webhook 并发幂等的压力测试 |

---

## 建议下一步顺序（增量、可验证）

1. **C 队列消费 + Cron**：让异步设计真正跑起来（最影响"架构是否成立"），并补 worker 全链路测试。
2. **D 限流 + 存储真实化**：上线前的平台硬需求，成本/安全。
3. **B AI pipeline 接入**：在 GPU/推理就绪后，逐 provider 替换 mock（chat→image→video），业务层零改动。
4. **A 合规三项**：在面向公众前清零（支付→年龄验证→CSAM，按法务）。
5. **F/E/G 产品与鉴权扩展**：按增长需要排期。

> 原则不变：**接口/数据/守卫照常实现，只把"外部供应商对接 + 真实计算/扣款/检测"留作开关**；每接一项都要有可验证闭环（CLI/测试/E2E）。
