# 05 · 模块设计

更新日期：2026-06-28

下面各"模块"是**逻辑业务域**，不是独立目录。as-built：除 admin 外的所有产品域都内聚在单一 mega-module `src/server/modules/ourdream/service.ts`，由 `dispatchV1` 按 resource 段分发到对应 handler，handler **直接用 Prisma**（无独立 repository/schema/types 层；Zod 校验内联在 handler 里）。admin 在 `modules/admin/`（service.ts + characters/），chat 已拆为独立服务 `packages/chat`。本文件给每个逻辑域的**职责、关键流程、关键不变量**；端点签名见 `BackendFeatureSpec §5`，数据见 03，跨域通用机制见 04/06。

逻辑域依赖图见 01 §3。下面按 P0 顺序。

---

## 1. identity

**职责**：注册/登录/登出/会话（委托 better-auth）、`/me` 聚合、角色与状态、匿名身份合并。

**关键流程**：
- `auth/[...all]` 直接挂 better-auth handler；service 只读封装 `getAuthCtx()`（04 §6）。
- `GET /me`：聚合 user + plan（来自 billing）+ entitlements + dreamcoin 余额（ledger 派生）+ age gate/verification 状态。**一个请求给前端全部门控信息**，避免多次往返。
- **匿名合并**：用户注册时，把 cookie 中 `anonymousId` 关联的 age gate/分析事件回填到 `userId`（service `mergeAnonymous()`）。

**不变量**：session 只读不在业务层伪造；role 升级仅 admin 经审计操作。

---

## 2. compliance（age gate + age verification）

**职责**：记录 age gate 接受；按辖区/风险触发身份验证；维护验证状态与复验。

**关键流程**：
- `POST /age-gate/accept`：写 `age_gate_acceptances`（带 country/sourcePath/policyVersion），同时 set cookie（proxy 读它做乐观放行）。匿名也可接受。
- `GET /age-verification/status`：根据 `ctx`、`jurisdiction`（IP/账单地）、风险信号计算 `not_required|required|...`。
- `POST /age-verification/sessions`：调 `AgeVerificationProvider.createSession()`，返回跳转 URL；落 `age_verifications(status=pending)`。
- `POST /age-verification/webhooks/:provider`：验签 → 幂等 → 入队 `age.verification.webhook` → worker 更新状态（见 06）。

**门控**：`requireAgeVerified` 守卫 chat/generate/create/explicit 内容（04 §6）。**这是合规硬约束**（07 §2）。

---

## 3. catalog（角色目录）

**职责**：公开角色搜索/筛选/排序/分页、详情、标签 facets、like、统计。

**关键流程**：
- `GET /characters`：`listCharactersQuery`（04 §4）→ repository 按 `visibility=public AND status=approved` + filters + 排序键 + cursor。**搜索走 provider 感知 `nameMatch`**（03 §2）。
- 排序：`popular`→`stats.likesCount`+period 窗口；`newest`→`createdAt`；`for_you`→ MVP 用 popular 占位，P2 接推荐；`following`→ join `follows`（需登录）。
- `GET /characters/:id`：`toPublicDTO`（**剔除 `systemPrompt` 等内部字段**）；`after()` 自增 views（异步、去抖）。
- `POST/DELETE /characters/:id/like`：`CharacterLike` upsert/delete + `character_stats.likesCount` 增量（事务）。
- 缓存：列表/详情读模型用 `use cache` + `cacheTag('character:'+id)`/`'catalog'`；写操作 `revalidateTag`（ADR-10）。

**不变量**：私有/未审角色绝不出现在公开列表；DTO 不泄漏内部字段。

---

## 4. chat

**职责**：Chat Service（**独立服务 `packages/chat`**，独立 Postgres schema/视图）拥有聊天域完整能力：会话与消息、消息版本、上下文记忆、关系状态、聊天额度、输入/输出审核、重生成、历史、SSE/stream replay、chat outbox。主站经 `server/bff/chat-proxy` 签名 + 反向代理（`dispatchV1` 里 `chat`/`messages` resource → `proxyChatRequest`）。

**主站关系**：
- 主站拥有 `users`、`characters/girlfriends`、billing entitlement、age eligibility 的权威状态。
- Chat 可以只读 `chat_user_view`、`chat_character_view`、`chat_entitlement_view`、`chat_user_eligibility_view`。
- Chat 只写 chat domain 表，不写主站 core/billing/compliance 表。
- 主站可以代理 Chat API，也可以消费 Chat outbox；不再作为 chat finalizer。

**关键流程**（详见 01 §4.2、06 §7、`docs/product/CHAT_SERVICE_PRD.md`）：
- `POST /chat/sessions`：Chat 根据 userId + characterId 找或建 active session；从主站只读 view 断言用户 active、年龄/身份符合、角色可读且未下架。
- `POST /chat/sessions/:id/messages`：Chat 校验 owner、entitlement/usage、角色状态、输入审核 → 事务落 user message + assistant placeholder → 入 Chat 内部 `chat.generate` → 返回 `assistantMessageId + streamUrl`。
- Chat worker：拼 prompt（character persona + relationship + memorySummary + long-term memories + 最近 N 条）→ 调 `ChatModel`（流式）→ Redis Stream/SSE → 输出审核 → 事务落 assistant `Message` + `MessageVersion(selected)` → 更新 `lastMessageAt`、`chat_usage`、`memorySummary`、`companion_memories`、`relationship_states`、`chat_outbox_events`。
- `POST /messages/:id/regenerate`：新增 `MessageVersion`，**不改审计历史**。
- 删除会话 = 软删 `status=deleted`；删除消息/记忆后必须从后续 context 与 runtime index 中移除。

**不变量**：被审核拦截的消息返回安全错误但**保留会话**；user/assistant 内容都产生 chat moderation trace；额度由 Chat 服务端结合主站 entitlement view 判定；Chat outbox 事件按 event id 幂等消费。

**记忆策略**：滑动窗口 + 滚动摘要 + 长期记忆 + relationship state。Deluxe 3x memory = 更大窗口/更长摘要/更多 memory retrieval，由 entitlement view 配置。

---

## 5. creator

**职责**：多步草稿、tag 管理、预览生成、提交审核、发布/私有、编辑/复制/删除。

**关键流程**：
- `POST /character-drafts` + `PATCH :id`：按 `step` 渐进保存（gender→style→appearance→hair→body→name→advanced→tags），immutable 更新。
- `POST :id/preview`：入队 `character.preview` → image worker 生成预览图 → 回填 `previewJobId`/asset。
- `POST :id/submit`：**创建前校验**（年龄≥18、禁止内容、真实人物/IP/非自愿/规避，见 07 §3）→ 建 `Character(status=draft→pending_review)` + `CharacterSubmission` → 入队输入审核 → 私有可直接 `approved` 自用，公开需过审。
- `PATCH/DELETE /characters/:id`：`requireOwner`；删除=archive（软删）。

**不变量**：公开可见要求 `approved`；私有草稿可先存，但聊天/生成前仍需输入审核（spec 4.1）。

---

## 6. generation（图片/视频 + presets）

**职责**：异步生成任务、preset 库（built-in/user/community）、Premium prompt 门、dreamcoin 预留结算、结果资产。

**关键流程**（详见 06 §6）：
- `POST /generation/jobs`：校验 mode/character|Freeplay/controls → **Premium 门**（`custom_prompt`/`negative_prompt`/`video_gen` 需 entitlement）→ **dreamcoin 预留**（reserve，08 §4）→ 落 `GenerationJob(queued)` → 入队 `generation.image|video`。
- worker：输入审核 → 调 `ImageModel/VideoModel` → 输出审核 → 落 `MediaAsset`（私有 blob）→ **结算 dreamcoin**（settle/refund）→ job `completed`。
- `GET /generation/jobs/:id`：轮询状态/进度；失败给 `errorCode` + 是否可重试 + 是否已退款。
- presets：`GET /generation/presets?type=&scope=&category=&q=`；built_in 为 seed 数据，user/community 为 UGC（ADR-10 决策：二者第一天共存，`scope` 区分）。

**不变量**：先 reserve 再 running；release 资产仅在输出审核通过后；失败/拦截要 refund 或标记 blocked（不扣费）。video 为 P1（接口同构，按 entitlement 开）。

---

## 7. media（图库）

**职责**：Images/Videos/Liked 浏览、filter、bulk manage、download、delete、like。

**关键流程**：
- `GET /media?type=image|video&liked=1&cursor=`：`requireOwner`（只看自己的）；签名 URL 由 `BlobStore.signGetUrl` 现签（ADR-8）。
- `POST/DELETE /media/:id/like`、`POST /media/bulk`（批量删/改可见性/加 collection）、`DELETE /media/:id`（软删 + 异步清对象存储）、`GET /media/:id/download`（短时签名 URL）。

**不变量**：媒体私有；签名 URL 短 TTL；删除走软删 + 后台清理 job。

---

## 8. billing（订阅/权益/dreamcoin）

见 [08-billing-and-entitlements.md](./08-billing-and-entitlements.md)（独立成篇）。核心：plans → checkout → webhook 幂等 → subscription → entitlements 派生 → dreamcoin ledger。

---

## 9. safety（信任与安全）

见 [07-security-and-compliance.md](./07-security-and-compliance.md) §3–5。核心：审核事件、举报、审核队列、申诉、政策版本。

**模块职责**：暴露 `moderation.input/output()`（供 chat/creator/generation 调用）、`reports.submit()`、`appeals.submit()`、`admin.queue()`/`admin.decision()`。

---

## 10. library（My AI）

**职责**：聚合读模型，拼 `BackendFeatureSpec §5.6` 的各 tab。

**关键流程**：纯读聚合，**不拥有数据**，调其它模块 service：
- `recent` = 最近 `chat_sessions` + 最近角色。
- `characters` = 用户可见/自有角色。
- `created` = `creatorId=me`。
- `group-chats`/`packs` = P1（先返回空集 + Create CTA，UI 已具备空态）。
- `presets` = `generation_presets(ownerId=me)`。
- `media` 入口复用 media 模块。

**不变量**：library 只读；跨模块只调 service 不碰他人 repository（01 §3）。

---

## 11. profile & account

**职责**：资料、偏好、通知、语言、兑换码、推荐、账号管理（登出全部/删号）。

**关键流程**：
- `GET/PATCH /profile`、`/profile/preferences`、`/profile/language` → `user_preferences`。
- `POST /redeem-codes/redeem`：校验 `codeHash` + 未过期 + 未超限 + 该用户未兑换 → 事务写 `redeem_code_redemptions` + 入队 `reward.ledger`（发 dreamcoin/entitlement）。幂等（唯一约束）。
- `GET /referrals` / `POST /referrals/invite`：生成/读 `referrals` code 与进度；被邀请人转化时入队 `reward.ledger`。
- `POST /account/sign-out-all`：吊销该用户全部 session。
- `POST /account/delete-request`：进入删号流程（标记 + 宽限期 + 异步清理，隐私见 07 §6）。

**不变量**：奖励发放经 `reward.ledger` 队列**恰好一次**（06 §8）；兑换/推荐有防滥用限流。

---

## 12. feed & community（P1）

**职责**：推荐流 + 互动；榜单/创作者/collections。

**关键流程**：
- `GET /feed`（cursor）、`/feed/restart`、`feed/items/:id/{like,share,remix,report}`。remix → 起草草稿或生成流。
- `community/leaderboards`（dreamers/characters/collections，按 release/gender/style filter）、`community/collections`、`users/:id/follow`。

**MVP 取舍**（ADR-10 对照）：UI 视觉已具备；后台 P1 先实现 **API + 上报/分享/like 骨架**（不泄漏举报人），推荐与榜单算法 P2。

---

## 13. seo（路由内容）

**职责**：164 条静态路由的 metadata 与文章正文运营。

**关键流程**：`route_pages` 存 path/template/title/description/canonical/contentStatus/body；公开页 SSR + `generateMetadata` 读它；`use cache` + tag 失效。文章正文从"模板"升级为"published"是内容运营任务（PRD SE-06）。

---

## 14. analytics（埋点）

见 09 §可观测性。`events.track(name, props, ctx)` 经 `after()` 异步落 `analytics_events` 并/或外发；覆盖 PRD §9 全部核心事件。

---

## 15. admin（内部审核后台）

**职责**：审核队列、用户/内容/任务管理、人工决定、封禁/下架/退款、生成配置、角色 CMS、产品配置和运营排障。as-built：admin 是独立模块 `modules/admin/`（`service.ts` + `characters/`：official/templates/tags/review/assist），权限在 `server/admin`（permissions/effective-permissions/dev-login），经 `dispatchV1` 的 `admin` resource → `dispatchAdmin` 进入。完整产品方案见 [ADMIN_CONSOLE_PLAN.md](../product/ADMIN_CONSOLE_PLAN.md)。

**关键流程**：
- `GET /admin/moderation/queue`：按 `content_reports(status,priority)` 排序（未成年=优先级 1，可即时隐藏目标）。
- `POST /admin/moderation/:id/decision`：写 `moderation_reviews` + 改目标状态（角色→removed、媒体→blocked、用户→suspended）+ 记 policyCode + 审计。
- `GET /admin/generation/jobs/:id`：展示 generation job timeline、profile/template version、provider error、ledger/refund 和 media 状态。
- `POST /admin/generation/model-profiles/:id/publish`：发布模型 profile 新版本，写审计，触发 `generation/config` 读取新 active profile。
- `POST /admin/billing/adjustments`：人工补偿只能写 `dreamcoin_ledger` adjustment，不允许直接覆盖余额。
- 仅 `requireAdmin`/moderator/细粒度 permission；所有写操作进 `AdminAuditLog`。

**MVP**：admin 是受保护的内部 Route Handlers + `/admin` 极简页面。P0 目标是"举报能进队列、能被处置；生成任务能排障；模型 profile/prompt template/preset 能配置发布；用户、ledger、订阅能查询且高风险操作可审计"。Prisma Studio 只能作为本地开发辅助，不能作为处理真实用户和资金相关操作的生产后台。
