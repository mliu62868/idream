# iDream 后台技术架构（Architecture）

更新日期：2026-09-01
目标产品：全面对标 OurDream.ai 的 18+ AI 角色扮演 / AI 伴侣平台
对标站点：https://ourdream.ai/（定义产品完整度参考；iDream 自身代码、数据与运行证据仍是实现权威）

## 0. 这套文档是什么

`docs/product/` 已经回答了 **"做什么"**（PRD、用户故事、功能图、后台功能规格）。
本目录 `docs/architecture/` 回答 **"怎么做"** —— 在 **Next.js 16 + Prisma + PostgreSQL + Redis/BullMQ** 技术栈、bun + Turborepo monorepo（`packages/{main,chat,gen,admin,shared}`）上，把产品规格落地成可执行、可验证、不丢功能的工程方案。

事实来源（SSoT）链路：

```
docs/product/PRD.md                 ← 产品需求（什么）
docs/product/ProductFeatureMap.md   ← 功能/页面映射
docs/product/BackendFeatureSpec.md  ← 后台模块/实体/状态机/API surface/授权矩阵 + 生成契约
docs/product/ECONOMY_AND_PRICING.md ← 经济模型/dreamcoin 费率卡（计费 SSoT；数值以 seed.ts 为准）
docs/product/CONTENT_POLICY.md      ← 内容安全政策/禁止项/申诉流程（政策 SSoT）
docs/product/ADMIN_CONSOLE_PLAN.md  ← 全产品管理后台/配置控制面方案
docs/product/CURRENT_FUNCTIONAL_COVERAGE.md ← 实现状态（已落地/暂缓）唯一事实来源
        │
        ▼
docs/architecture/*                 ← 技术实现方案（本目录，怎么做）
        │
        ▼
packages/main/prisma/schema.prisma + packages/*/src ← 代码（最终事实来源）
```

> 原则：本目录**不复制** BackendFeatureSpec 已有的"实体字段表 / API 列表 / 授权矩阵 / 状态机"，而是引用它，并补齐"用这个技术栈如何真正实现"。当两者冲突时，以本目录的技术决策（02）为准，并回写更新 BackendFeatureSpec。

## 1. 阅读顺序

| # | 文档 | 内容 | 读者 |
| --- | --- | --- | --- |
| — | [README.md](./README.md) | 索引、技术栈、决策摘要（本文件） | 所有人 |
| 01 | [01-system-architecture.md](./01-system-architecture.md) | 系统架构、分层、请求生命周期、模块依赖、部署拓扑 | 所有工程 |
| 02 | [02-technical-decisions.md](./02-technical-decisions.md) | 关键技术决策（ADR）：栈形态/数据库/Auth/支付/队列/AI/年龄验证/存储/限流/缓存 | 架构、Lead |
| 03 | [03-data-model.md](./03-data-model.md) | Main Prisma schema 参考、迁移与 seed 策略；旧 Chat PG 设计由 ADR-20 取代 | 后台工程 |
| 04 | [04-api-design.md](./04-api-design.md) | API 规范：响应/错误/校验/分页/鉴权/限流/幂等/SSE | 前后端 |
| 05 | [05-module-design.md](./05-module-design.md) | 后台模块职责与关键流程（as-built） | 后台工程 |
| 06 | [06-async-jobs-and-ai.md](./06-async-jobs-and-ai.md) | Redis/BullMQ、跨服务队列、AI provider 抽象、生成流水线 | 后台工程 |
| 07 | [07-security-and-compliance.md](./07-security-and-compliance.md) | 鉴权、年龄合规、内容审核、隐私、密钥、审计 | 全员 + 法务 |
| 08 | [08-billing-and-entitlements.md](./08-billing-and-entitlements.md) | 订阅、PSP、webhook 幂等、权益派生、dreamcoin ledger | 后台工程 |
| 09 | [09-project-structure.md](./09-project-structure.md) | monorepo 目录结构、分层约定、命名、加端点流程 | 所有工程 |
| 10 | [10-operations.md](./10-operations.md) | 环境、env 变量目录、pm2 部署、连接池、迁移 runbook、CI、可观测性 | DevOps |
| 11 | [11-testing.md](./11-testing.md) | L1–L4 测试策略与工具 | 所有工程 |
| 12 | [12-roadmap.md](./12-roadmap.md) | 实施路线图与暂缓项 | PM、Lead |
| 14 | [14-chat-service-tech-design.md](./14-chat-service-tech-design.md) | Chat Service 技术架构（服务拆分、权限边界、热路径、存储/记忆、服务目录/协议/pm2） | Lead、后端 |
| 15 | [15-admin-operating-system-authority-adr.md](./15-admin-operating-system-authority-adr.md) | Admin v2 authority、命令/事件可靠性、渐进切换与回滚 ADR | Product、架构、后端、运营 |
| 16 | [16-character-asset-studio-authority.md](./16-character-asset-studio-authority.md) | Character Asset Studio 的生成、审核、草稿采用与 Release 发布权威 | Product、架构、后端、运营 |
| 17 | [17-deep-module-authority-boundaries.md](./17-deep-module-authority-boundaries.md) | Gen、Ledger、Admin mutation、状态变更、跨服务交换与 Character Journey 的深模块权威 ADR | Product、架构、后端、运营 |
| 18 | [18-character-soul-runtime-design.md](./18-character-soul-runtime-design.md) | Character Soul、Chat turn context、关系证据、场景状态与 Release/运行时一致性设计 | Product、架构、后端、运营 |
| 19 | [19-deepseek-harness-companion-runtime-migration.md](./19-deepseek-harness-companion-runtime-migration.md) | DSH/igrep Companion 执行内核；不拥有产品事实 | Product、架构、后端 |
| 20 | [20-local-file-chat-authority.md](./20-local-file-chat-authority.md) | Main 产品 Turn 权威、Chat 本地 AgentRun 与生成结算边界 | Product、架构、后端、运营 |
| 21 | [21-companion-chat-deep-runtime.md](./21-companion-chat-deep-runtime.md) | 单进程 Agent 运行、Main 驱动记忆投影与最小本地恢复证据 | Product、架构、后端、运营 |

> 实现状态（已落地/暂缓）以 [`CURRENT_FUNCTIONAL_COVERAGE.md`](../product/CURRENT_FUNCTIONAL_COVERAGE.md) 为唯一事实来源；剩余工作执行计划见 [`REMAINING_WORK_EXECUTION_PLAN.md`](../product/REMAINING_WORK_EXECUTION_PLAN.md)。
> 管理后台方案见 [ADMIN_CONSOLE_PLAN.md](../product/ADMIN_CONSOLE_PLAN.md)；生成（图片/视频/语音）契约见 [BackendFeatureSpec.md](../product/BackendFeatureSpec.md) §5.5。

## 2. 技术栈一览

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 24 | `.nvmrc=24`，`package.json engines.node>=24` |
| 框架 | Next.js 16.2.1（App Router, React 19.2） | **注意：Next 16 有破坏性变更**，middleware 已更名 **Proxy**，详见 01/02 |
| 语言 | TypeScript 5（strict, 禁 `any`） | `@/*` → `src/*` |
| ORM | Main 使用 Prisma 7.x（`prisma-client` 生成器） | Chat 不使用 ORM，详见 ADR-20 |
| 数据库 | Main 使用 PostgreSQL 保存产品 Turn 与计费；Chat AgentRun 使用本地文件 | `packages/chat` 不使用 PostgreSQL/Prisma，见 ADR-20 |
| 鉴权 | better-auth（email+password + session，Prisma adapter） | 备选 Auth.js v5，见 02-ADR-3 |
| 校验 | Zod | 系统边界强制校验（API 入参、env、provider 回调） |
| UI | shadcn/ui + @base-ui/react + Tailwind v4 | 既有，前端不在本目录范围 |
| 支付 | 抽象 `PaymentProvider`；**生产用加密货币**（推荐自托管 BTCPay Server，非托管/无 AUP 风险） | 见 02-ADR-4 |
| 异步 | Main/Gen 使用 Redis/BullMQ；Chat 是有界 HTTP AgentRun，Redis 只缓存 SSE；跨服务删除等命令使用 durable event/receipt | 见 06、14、17 |
| AI | 抽象 `ChatModel`/`ImageModel`/`VideoModel`/`Voice`/`Moderation` | Chat 使用自托管 OpenAI-compatible endpoint；Image/Video 使用 Gen workflow-native BackendRegistry（ComfyUI/Sdcpp/DrawThings），legacy external pipeline 已 deprecated，见 02-ADR-6 |
| 管理后台 | 独立 `@idream/admin` web/BFF + main `/api/v2/admin/*` authority；v1 仅兼容观测 | Today、Character、Creative、Incident、Case、Metrics、系统控制面，见 ADR-11 |
| 对象存储 | 抽象 `BlobStore`；S3 兼容（R2）/ 本地 fs（dev） | 签名 URL，见 02-ADR-8 |
| 限流 | DB 令牌桶 / Redis（prod 推荐） | 见 02-ADR-9 |
| 部署 | pm2 完整多进程拓扑（`ecosystem.config.js`）；Docker Compose 仅提供本地 PostgreSQL/Redis | 见 10 |
| 测试 | Vitest（L1/L2/L3）+ Playwright（L4） | 见 11 |
| 日志/监控 | pino 结构化日志 + Sentry + 自建 analytics 事件 | 见 09/10 |

## 3. 关键技术决策摘要（详见 02）

| ADR | 决策 | 一句话理由 |
| --- | --- | --- |
| ADR-1 | **monorepo + 按执行时间分级拆服务**：`main`（产品 Turn/计费权威）/ `chat`（Agent 执行，本地 run）/ `gen`（图片/视频 worker） | 慢负载从快 web 剥离；产品事实仍集中在 Main |
| ADR-2 | **Main PostgreSQL only**（dev=prod 同栈，无 SQLite 双库、无 `db-provider` 切换脚本） | Main 领域继续使用 PostgreSQL；Chat 存储由 ADR-20 取代 |
| ADR-3 | **better-auth** 自管 user/session/account 表，域字段（plan 等）外挂 | 现代、Prisma 原生、email+password+session+限流齐全 |
| ADR-4 | **支付抽象 + 加密货币**（BTCPay Server / NOWPayments 等）；付费访问按"一次性预付周期 + 到期后用户重新购买"建模 | 加密支付绕开卡组织成人内容限制；自托管非托管无 AUP 风险 |
| ADR-5 | **Main/Gen Redis/BullMQ + 常驻 PM2 worker；Chat 不建队列** | 生成任务需要 durable retry；Chat token 流需要直接 AgentRun/SSE |
| ADR-6 | **AI provider 全部抽象**；Chat 与媒体生成采用不同执行接口 | Chat 走 OpenAI-compatible endpoint；Image/Video 由 workflow descriptor 固定 backend/model/input slots，避免把 deprecated pipeline 当成运行权威 |
| ADR-7 | **年龄验证 provider 抽象**（Go.cam 等），按司法辖区/风险触发，状态进 `age_verifications` | 安全文档点名 Go.cam；UK OSA / 美国多州法律强制 |
| ADR-8 | **对象存储抽象 + S3 兼容(R2)/Vercel Blob(private)**，私有 + 签名 URL | 媒体资产私密、防盗链、成人 CDN 友好 |
| ADR-9 | **限流：dev DB 令牌桶 / prod Upstash Redis** | 鉴权/生成/聊天端点必须限流，防滥用与成本失控 |
| ADR-10 | **缓存：公开 SEO/目录用 Cache Components(`use cache`+`cacheTag`)，产品/鉴权 API 全动态** | Next 16 缓存模型；角色更新按 tag 失效 |
| ADR-11 | **Admin 是领域 authority 上的决策执行系统**：shared contract + fail-closed BFF + command/outbox + shadow/canary cutover | 状态、指标、权限、审计和回滚都可独立证明 |
| ADR-12 | **Character Asset Studio 复用现有生成、审核、草稿、Release 与 Serving authority** | 采用只改草稿，只有显式发布改变线上角色 |
| ADR-13 | **六个深 Module 吸收重复的可靠性协议**：Gen、Ledger、Admin mutation、聚合 transition、Durable Exchange、Character Journey | 每个高风险事实只有一个窄写入口；状态与部署配置不再漂移 |
| ADR-14（Proposed） | **Character Soul 是版本化结构化权威；SOUL.md 与 system prompt 都是派生产物** | Release 与 Chat 共享一个解释 Interface；静态人格不再与关系、记忆、场景混写 |
| ADR-19 | **DSH + official igrep 是唯一 Companion Agent 执行内核** | 统一 model/tool/memory loop，但不扩大为产品数据权威 |
| ADR-20 | **Main PG 是产品 Turn/计费权威，Chat 本地文件只保存 AgentRun** | Agent 运行与产品记录分离；Chat 删除数据库协调层但不复制 Main ledger |
| ADR-21 | **Chat 单进程执行；Main committed Turn 异步投影记忆** | 删除低价值 process seam、双状态机与同步记忆提交热路径 |

## 4. 不可妥协的合规底线（贯穿全文，P0）

这是一个 **18+ 成人 AI 产品**，下列项是**法律 / 平台政策强制**，不是可选优化（详见 07）：

1. **未成年内容零容忍**：输入与输出命中未成年内容即拦截、留证；角色年龄强制 `>= 18`。（涉未成年素材的自动检测管线与法定上报由**合规/法务侧独立负责，不在本产品/工程设计范围**。）
2. **年龄门槛 + 身份年龄验证**：成人内容前置 age gate；按司法辖区触发第三方身份验证后才能使用受限路由。
3. **深度伪造 / 真实人物 / 受版权 IP / 非自愿框架 / 规避尝试**：创建与生成阶段必须检测并拒绝。
4. **支付与模型供应商**：已定 **加密货币支付 + 自托管开源模型**；Chat 使用 OpenAI-compatible endpoint，Image/Video 使用 workflow-native backend。**MVP 阶段支付用 mock**；**第三方年龄验证暂缓为上线前 deferred TODO**（设计不弱化，见 12 暂缓项 / 07）。
5. **隐私**：聊天默认私密；敏感内容不进公开 feed；举报人身份不对被举报方披露。

## 5. 当前代码现状（基线）

本架构文档描述的工程方案**已基本落地**（早期"从静态前端起步"的基线已成历史）：

- monorepo 4+1 包：`@idream/{shared,main,chat,gen,admin}`；pm2 多进程（`ecosystem.config.js`）。
- `packages/main`：Next 16 全栈（`src/app` 前端 + `src/server` 后端，`/api/v1/[...resource]` catch-all → `dispatchV1`），Prisma + PostgreSQL，better-auth，计费/权益/生成/角色/admin。
- `packages/chat`：不连接 PostgreSQL；内嵌 DSH/official igrep，保存未决/失败 AgentRun 与 SSE 暂态；产品 Turn/附件/Scene/计费由 Main PostgreSQL 管理。
- `packages/gen`：图片/视频生成 worker（写 blob）。
- 实现状态（已落地/暂缓）以 [`CURRENT_FUNCTIONAL_COVERAGE.md`](../product/CURRENT_FUNCTIONAL_COVERAGE.md) 为准；路线图见 [12-roadmap.md](./12-roadmap.md)。

## 6. 验证闭环（贯穿实现）

```bash
bun run lint        # L1: turbo run lint
bun run typecheck   # L1: turbo run typecheck
bun run test        # L2/L3: turbo run test（vitest）
bun run build       # 产物构建
bun run check       # lint + typecheck + build
bun run check:launch # 上线就绪体检（launch-readiness）
```

E2E（Playwright）与各 `launch:probe:*` 探针见 11/10。DB 迁移由用户手工执行；旧 Chat Turn 导入 Main 及 Chat PG 退出顺序见 ADR-20。
