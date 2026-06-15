# 02 · 关键技术决策（ADR）

更新日期：2026-06-13

本文件逐条解决 `BackendFeatureSpec.md §10 Known Gaps`。每条 ADR 给出：决策、理由、备选、权衡、影响。**当本文件与其它文档冲突，以本文件为准。**

格式约定：状态 = 已采纳 / 待复核 / 需法务确认。

---

## ADR-1 · 后台形态：模块化单体（Next Route Handlers + 分层）

**状态**：已采纳

**决策**：用 Next.js App Router 的 Route Handlers 暴露 `/api/v1/*`，内部按 `route → service → repository` 分层，模块化单体单仓单部署。重活异步化（job worker）。

**备选**：
- (A) 独立 API 服务（NestJS/Fastify）+ Next 仅前端 —— 多一个部署、多一套鉴权与类型同步成本，YAGNI。
- (B) 纯 Route Handlers 无分层 —— 业务逻辑散落、无法测试、违反 SSoT。
- (C) **模块化单体分层（采纳）**。

**理由**：前端已是 Next 16；Vercel Fluid Compute 支持完整 Node 后端；分层让业务逻辑可单测、可复用、可在未来按模块边界拆服务。

**权衡**：单体在超大规模下需要拆分；通过严格模块边界 + 事件解耦把拆分成本前置降低。serverless 超时通过"同步路径短 + 重活入队"规避。

---

## ADR-2 · 双数据库：单一可移植 schema + provider 切换

**状态**：已采纳（核心约束，全员必读）

**背景硬限制**（已用 Prisma 7.6 文档确认）：
- Prisma `datasource` 的 **`provider` 不能用 `env()`**，只有 `url` 能。
- **SQLite 不支持 `enum`、不支持标量数组 `String[]`、不支持 `@db.*` native type、不支持 `mode:'insensitive'`**。
- SQLite 与 Postgres 的迁移 SQL 不通用。

**决策**：
1. **单一 `prisma/schema.prisma` 作为"形状 SSoT"，只用双库都支持的特性子集**（见 03 §2 的可移植规则）。
2. **provider 行按环境切换**：用一个 prebuild 脚本 `scripts/db-provider.mjs` 依据 `DB_PROVIDER`（`sqlite|postgresql`）改写 datasource 的 `provider`，再 `prisma generate`。`url` 由 `prisma.config.ts` 的 `env('DATABASE_URL')` 注入。
3. **迁移策略分环境**：
   - **dev（SQLite）**：`prisma db push`，不产生迁移文件，库可随时删档重建（配合 seed）。
   - **prod（Postgres）**：`prisma migrate dev/deploy`，迁移文件是 **prod DDL 的 SSoT**。
4. **Postgres-only 性能特性放进 Postgres 迁移 SQL**：全文检索（`pg_trgm`/`tsvector` + GIN 索引）、partial index、`citext` 等，写在 prod 迁移里手工 SQL，**不进可移植 schema**，因此不影响 SQLite dev。

**备选**：
- (A) 两个 schema 文件（`schema.sqlite/postgres.prisma`）—— 重复维护、易漂移。
- (B) **Postgres everywhere（dev 用 Docker/Neon 分支）** —— Prisma 故事最干净、能用全部 Postgres 特性，但**违背用户"sqlite dev"诉求**。
- (C) **采纳：单 schema + provider 切换 + 分环境迁移。**

**权衡 / 代价（如实说明）**：
- 失去 DB 级 enum、数组、原生全文检索（dev 侧）。enum → `String` + TS 常量 + Zod；数组 → `Json` 或关联表。
- dev 的搜索用 `LIKE`（SQLite `LIKE` 对 ASCII 默认大小写不敏感）；prod 可在迁移里加 `pg_trgm` GIN 提升。两边行为有差异，需在测试中覆盖。
- **建议**：团队若能接受，长期把本地也切到 Docker Postgres（保留 SQLite 作为"零依赖快速起步"档），可消除差异。这是性价比最高的演进方向，记录在 12-roadmap 的技术债。

**影响**：03 全文、scripts、CI（见 10）。

---

## ADR-3 · 鉴权：better-auth（自管表）+ 域字段外挂

**状态**：已采纳（库选型待团队复核）

**决策**：用 **better-auth** 处理 email+password 注册/登录、session（DB-backed、cookie）、密码哈希（scrypt/argon2）、登录限流、邮箱验证、OAuth（后续）。它自管 `user/session/account/verification` 表（映射 spec 的 `users`+`sessions`）。我们的**域字段不塞进 user**：
- 计划/权益 → `subscriptions`/`entitlements`（08）
- 余额 → `dreamcoin_ledger` 派生
- age gate/verification → `age_gate_acceptances`/`age_verifications`（07）
- 偏好 → `user_preferences`

**备选**：
- (A) **Auth.js v5（NextAuth）+ Prisma adapter** —— 最广为人知；Credentials provider 做 email/password 稍繁琐，session 模型可用。作为**保守备选**。
- (B) 纯手写 password_hash + session（spec 原始设想）—— 自己管 crypto/限流/CSRF 风险高，YAGNI。
- (C) **better-auth（采纳）**：Prisma 原生、email+password+session+ratelimit+plugin 开箱，DX 好，owns its tables。

**理由**：把"安全敏感的认证原语"交给经过审计的库；自己只写业务授权（RBAC/ownership，见 04 §6、07 §1）。

**权衡**：引入一个相对年轻的库；通过把会话模型设计成可替换（service 只依赖 `getSession(ctx)` 抽象）降低锁定。若团队更信任 Auth.js，切换面仅限 `lib/auth/*`。

**影响**：03（认证相关表以库为准）、04 §6、07 §1。

---

## ADR-4 · 支付：抽象 `PaymentProvider` + 加密货币（已定）

**状态**：已采纳（方向）；**MVP 用 mock 支付 provider，真实加密处理器接入暂缓**（见 12 暂缓项）

**决策**：
1. 定义 provider 无关接口 `PaymentProvider`（创建发票、查询状态、IPN/webhook 验签 + 解析）。
2. **生产用加密货币支付**，规避卡组织（Visa/MC）与 Stripe/PayPal AUP 对成人内容的封禁。
3. 推荐 **BTCPay Server**（自托管、非托管、开源、无第三方 AUP/KYC 风险，最契合成人 + 隐私场景）；托管备选 NOWPayments / Cryptomus / CoinGate（集成快，但有第三方依赖）。

**加密支付特性（影响计费建模，见 08）**：
- **无卡式自动续费**：钱包不能被"拉"扣款 → 订阅按"预付周期 + 到期续费提醒"建模（08 §2）。
- **天然异步**：需等区块确认，完美契合 job 队列 + IPN/webhook。
- **汇率**：`plans` 存 USD 分；下单按当时汇率生成等值加密发票，处理器锁价一个时间窗。
- dreamcoin 充值 = 一次性加密付款，直接好用。

**决策含义**：
- `subscriptions`/`entitlements`/`dreamcoin_ledger` 与具体处理器解耦。
- 工程用处理器 testnet/sandbox（BTCPay testnet 等）打通 invoice→IPN→权益→ledger 全链路。

**权衡**：UX 比刷卡重（跳钱包/等确认）；无自动续费靠续费提醒维持留存；需处理欠付/超付/发票过期。换处理器只改 `providers/payment/<impl>` 与 IPN 适配。

**影响**：08 全文、providers/payment、03（billing 表 provider 中立）。

---

## ADR-5 · 异步队列：DB 表驱动 + Vercel Cron + `after()`（抽象 `JobQueue`）

**状态**：已采纳

**决策**：MVP 不引入 Redis/Kafka。用 `jobs` 表作为持久队列：
- 入队 = 插一行 `queued`。
- worker = `app/api/internal/worker/route.ts`，由 **Vercel Cron**（每分钟）触发，认领（claim）一批待处理 job 执行。
- 轻量 fire-and-forget（埋点）用 Next 16 `after()`。
- 用接口 `JobQueue { enqueue, claim, complete, fail }` 封装，便于换实现。

**认领并发安全**：
- Postgres：`SELECT ... FOR UPDATE SKIP LOCKED`（迁移里用 raw SQL 的 worker 查询）。
- SQLite（dev 单 worker）：事务内 `UPDATE jobs SET status='running',locked_by=? WHERE id IN (SELECT id ... WHERE status='queued' LIMIT n)`，单 worker 不竞争。

**重试**：`attempts`/`max_attempts` + 指数退避（`next_run_at`）；超限 → `failed` + 死信留存。幂等键 `dedupe_key` 防重复入队。

**备选**：
- (A) QStash / Vercel Queues（beta）/ Inngest / BullMQ(Redis) —— 更专业，但引入外部依赖与成本，MVP YAGNI。
- (B) 仅 `after()` —— 不持久、不可重试、随实例回收丢任务，**不可用于生成/支付**。
- (C) **DB 队列 + Cron（采纳）**：零额外依赖、持久、可重试、可观测（job 表即仪表盘）。

**权衡**：Cron 最小粒度通常 1 分钟，生成类需要更快反馈 → 入队后**同一请求用 `after()` 立即异步触发一次 worker drain**（best-effort），Cron 作为兜底，二者幂等共存。规模上来再换 QStash/Queues，接口不变。

**影响**：06 全文、03（`jobs` 表）、10（Cron 配置）。

---

## ADR-6 · AI 供应商：全部抽象；自托管开源模型 + 内部流水线 API（已定）

**状态**：已采纳

**决策**：定义稳定接口并全部抽象：
- `ChatModel`（流式 roleplay 文本）
- `ImageModel` / `VideoModel`（角色图/视频生成）
- `Voice`（TTS，Premium 语音额度）
- `Moderation`（输入/输出审核 + 未成年/CSAM/深伪检测）

**决策细化**：生产实现统一对接**内部自托管的开源模型流水线 API**：
- 文本：自托管开源模型（Llama/Qwen/Mistral 等的 roleplay/NSFW 微调，vLLM/TGI 部署），暴露 **OpenAI 兼容** chat completions（流式）。
- 图像/视频：自托管 SD/Flux/视频模型，经流水线 API 的生成端点。
- 接入：`PIPELINE_API_URL` + `PIPELINE_API_TOKEN` + 模型名参数化，一个内部网关后挂多模型。

**优势**：规避公有 API（OpenAI/Anthropic/Google）对露骨内容的禁令；prompt/产物**不出内网**，数据保留/训练授权自主可控（天然满足 07 §6）；成本/吞吐自控。

**但审核（Moderation）相反**：未成年/CSAM/深伪检测应使用**最强的安全分类与哈希匹配**（见 07 §3），这部分可用合规的安全检测服务（PhotoDNA/NCMEC 哈希、专用 CSAM 分类器），与"生成"供应商分离。

**接口要点**：
- 全部支持超时、重试、熔断；返回错误码与是否可重试。
- dev 提供 **mock provider**（确定性假数据），本地无需真实模型即可跑通全链路与测试。
- 流水线 API 应有内部鉴权 + 限流 + 排队；后台 worker 经 `JobQueue` 控制并发，避免打爆推理集群。

**审核例外**：未成年/CSAM/深伪检测**不能只靠通用开源模型**——文本/图像安全分类可跑同一流水线，但 **CSAM 哈希匹配（PhotoDNA/NCMEC）+ 法律上报**是专门能力、独立服务/密钥（见 07 §3，仍待落实）。

**权衡**：自托管 GPU/运维成本与可用性自负；接口不变，必要时可临时切 NSFW 友好托管兜底。

**影响**：06 §5–7、07 §3、providers/*。

---

## ADR-7 · 年龄验证：provider 抽象，按辖区/风险触发

**状态**：方向已定；**实现暂缓**——MVP 保留表/守卫（默认 not_required 直通），provider 接入留 TODO（见 12 暂缓项）

**决策**：
- age **gate**（自填 18+ 确认）与 age **verification**（第三方身份年龄验证）**分离存储**（`age_gate_acceptances` vs `age_verifications`）。
- 定义 `AgeVerificationProvider`（创建验证会话、查状态、webhook 验签）。安全文档点名 **Go.cam**；备选 Yoti / Persona / Veriff / Incode / AU10TIX。
- **触发策略可配**：按 `jurisdiction`（如 UK Online Safety Act、美国 LA/UT/TX 等州法、EU 部分）+ 风险信号触发；未通过则受限路由（chat/generate/create/explicit 内容）不可用。
- webhook 幂等更新状态；过期需复验（`expires_at`）。

**理由**：合规是硬约束且法律随辖区变化；抽象 + 配置化让接入/切换/扩辖区低成本。

**影响**：07 §2、03（compliance 表）、proxy.ts（仅做"是否需要验证"的乐观重定向）。

---

## ADR-8 · 对象存储：抽象 `BlobStore` + S3 兼容(R2)/Vercel Blob(private)，私有 + 签名 URL

**状态**：已采纳

**决策**：
- 接口 `BlobStore { putPrivate, signGetUrl, delete }`。
- 参考实现：**Cloudflare R2（S3 兼容）** 或 **Vercel Blob（已支持 private）**。
- 所有用户媒体**私有**，通过**短时签名 URL**访问（防盗链、可吊销）。CDN 缩略图。
- 媒体记录在 `media_assets`，bytes 在对象存储，二者用 `url`/key 关联。

**理由**：媒体是成人内容 + 私密，必须私有 + 访问控制；S3 兼容便于换云、规避单云 AUP 风险（部分云对成人内容存储/CDN 有限制，R2/bunny.net 相对友好）。

**权衡**：签名 URL 需要在每次展示时签发，给读路径加一步；用合理 TTL + 客户端缓存缓解。

**影响**：05(media)、06(generation 产物落库)、07 §6。

---

## ADR-9 · 限流：dev DB 令牌桶 / prod Upstash Redis

**状态**：已采纳

**决策**：接口 `RateLimiter`：
- **dev**：DB 表令牌桶（零依赖）。
- **prod**：**Upstash Redis（Vercel Marketplace）**（`@upstash/ratelimit`，sliding window），共享、低延迟、serverless 友好。
- 必限端点：auth（防爆破）、search/suggest、chat 发送、generation 创建、report、age-verification、webhook（按来源）。
- 维度：user / ip / anonymous_id；超限返回 `429` + `Retry-After`（见 04 §7）。

**理由**：成人产品滥用与成本风险高，限流是 P0 防线；Redis 是 serverless 共享计数的标准答案。

**权衡**：dev DB 限流不反映分布式真实行为；可接受（dev 单实例）。也可让 dev 直连 Upstash dev 实例做高保真。

**影响**：04 §7、10（env）。

---

## ADR-10 · 缓存：公开内容 Cache Components，产品 API 全动态

**状态**：已采纳

**决策**：
- **公开 SEO 页 / 角色目录读模型**：用 Next 16 Cache Components（`use cache` + `cacheLife` + `cacheTag`）。角色/标签更新时 service 调 `revalidateTag('character:'+id)` / `'catalog'` 失效。
- **鉴权产品 API、聊天、生成、计费、个人数据**：全动态（`dynamic = 'force-dynamic'` 或访问 request API 自然动态），**绝不缓存**用户私有数据。
- 短时只读热点（如 plans、tags facets）可用 Vercel Runtime Cache / `use cache` 带 tag。

**理由**：SEO 页要可预渲染、快首屏；私有数据缓存=越权泄露风险，必须动态。

**影响**：01 §5、04、05(catalog/seo)。

---

## 决策对照（回填 BackendFeatureSpec §10）

| Spec §10 Gap | 本文件决策 |
| --- | --- |
| backend stack 形态 | ADR-1 模块化单体 |
| database & migration tool | ADR-2 Prisma 双库 + 分环境迁移 |
| auth provider | ADR-3 better-auth |
| payment provider & webhook | ADR-4 抽象 + 加密货币（BTCPay 等），订阅预付周期 |
| queue implementation | ADR-5 DB 队列 + Cron |
| model providers（chat/image/video）+ 数据保留 | ADR-6 抽象 + 自托管开源模型/内部流水线 API；prompt 不出内网 |
| identity age verification | ADR-7 provider 抽象（Go.cam 等） |
| `/chat/` robots vs authenticated | 见 04 §1：`/api`、`/chat/` 子路径 robots-disallow，但鉴权产品可访问；SSR 私有不索引 |
| safety 政策本地镜像 vs 外链 | 见 07 §7：政策正文版本化存 `policy_versions`，Safety Center 关键页本地镜像 + 外链权威源 |
| Feed/Community 是否入 MVP | 见 12-roadmap：P1（MVP 仅留 API/上报骨架，UI 视觉已具备） |
| presets 来源 | 见 05(generation)：built-in 为产品 seed 数据 + user/community UGC，二者从第一天共存（scope 字段区分） |

> ✅ ADR-4（加密货币）、ADR-6（自托管开源模型/流水线 API）已定。仍待敲定：ADR-7 年龄验证 provider（Go.cam 等）、CSAM 检测 + NCMEC 上报的专门服务与法律 runbook（07 §3.2，需法务）。工程侧先用抽象 + mock/testnet 推进，不阻塞。
