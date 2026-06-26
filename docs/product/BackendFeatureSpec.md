# Ourdream.ai Backend Feature Specification

更新日期：2026-06-13

## 1. 目的

本文档把当前 Ourdream.ai 静态 clone、线上抽样、产品功能图、PRD、用户故事和 safety 文档转成后台开发规格。后续实现后台功能时，以这里的模块边界、数据模型、API、状态机、权限和 P0 顺序作为工程拆分依据。

事实来源：

- `ProductFeatureMap.md`
- `PRD.md`
- `UserStory.md`
- `docs/research/SITEMAP_ROUTES.md`
- `docs/research/ONLINE_PRODUCT_SURVEY.md`
- `docs/research/CHROME_PRODUCT_EXPLORATION.md`
- `docs/research/ourdream-safety-docs.json`
- `src/lib/ourdream-data.ts`
- `src/components/ourdream/*`

当前本地 clone 是静态前端。后台 MVP 的目标不是继续复制视觉，而是让 Explore、Create、Chat、Generate、My AI、Upgrade、Safety/Report 形成最小可用闭环。

## 2. 后台模块边界

| 模块 | 负责范围 | P0 |
| --- | --- | --- |
| Identity & Session | 注册、登录、会话、受保护路由、账号状态 | 是 |
| Age & Compliance Gate | 年龄确认、成熟内容访问门、后续年龄验证预留 | 是 |
| Age Verification | 司法辖区/风险触发的第三方身份年龄验证、provider 状态、复验 | P0/P1 |
| Character Catalog | 角色资料、标签、筛选、搜索、排序、统计 | 是 |
| Character Detail | 角色详情、启动聊天、举报入口、公开/私有状态 | 是 |
| Chat | 会话、消息、上下文摘要、额度、安全拦截 | 是 |
| Creator | 多步角色草稿、tag、preview generation、创建、编辑、发布、审核状态 | 是 |
| Generation Presets | built-in/user/community presets、custom preset 创建、preset 分类 | P1 |
| Generation | 图片/视频任务、队列、额度、preset payload、结果资产、失败重试 | 是，先图片 |
| Media Gallery | Images/Videos/Liked、filter、manage、download、delete、like | 是，基础 |
| Subscription & Entitlements | 计划、checkout、webhook、Premium/Deluxe 权益、dreamcoin | 是 |
| Trust & Safety | 输入/输出审核、举报、审核队列、申诉、政策原因 | 是 |
| User Library | My AI tabs、最近角色、Created、Group Chats、Packs、Presets | 是，基础 |
| Profile & Account | 余额、订阅入口、兑换码、推荐奖励、偏好、语言、账号管理 | P0/P1 |
| Feed & Community | Feed actions、leaderboard、creator profile、collections | P1 |
| SEO Content | sitemap 内容、文章、比较页、metadata | P1 |
| Support | helpdesk、工单或外部支持映射 | P1 |
| Analytics | 产品事件、漏斗、风控指标 | P0 轻量 |
| Admin/Ops | 审核后台、用户/内容/任务管理、生成配置、产品配置、计费排障、审计 | P0 内部 |

## 3. 核心实体

### 3.1 Identity

| 实体 | 关键字段 |
| --- | --- |
| `users` | `id`, `email`, `password_hash`, `display_name`, `avatar_url`, `status`, `created_at`, `updated_at`, `deleted_at` |
| `sessions` | `id`, `user_id`, `token_hash`, `expires_at`, `ip_hash`, `user_agent`, `created_at` |
| `age_gate_acceptances` | `id`, `user_id`, `anonymous_id`, `accepted_at`, `country`, `source_path`, `policy_version` |
| `age_verifications` | `id`, `user_id`, `provider`, `provider_verification_id`, `status`, `jurisdiction`, `required_reason`, `verified_at`, `expires_at`, `created_at` |
| `user_preferences` | `user_id`, `muted_tags`, `safe_mode_flags`, `notification_settings`, `locale` |
| `redeem_codes` | `id`, `code_hash`, `reward_json`, `status`, `expires_at`, `created_at` |
| `redeem_code_redemptions` | `id`, `redeem_code_id`, `user_id`, `reward_status`, `created_at` |
| `referrals` | `id`, `inviter_id`, `invitee_id`, `code`, `status`, `subscription_id`, `reward_status`, `created_at` |

Notes:

- 匿名用户也需要 `anonymous_id`，用于 age gate、搜索筛选和转化漏斗。
- Chrome Safety Center 提到 Go.cam 身份验证；第三方验证状态应进入 `age_verifications`，不要把强验证字段塞进 `users`。

### 3.2 Characters

| 实体 | 关键字段 |
| --- | --- |
| `characters` | `id`, `creator_id`, `name`, `age`, `description`, `system_prompt`, `visibility`, `status`, `style`, `gender`, `relationship`, `voice_id`, `image_asset_id`, `created_at`, `updated_at` |
| `character_drafts` | `id`, `owner_id`, `step`, `gender`, `style`, `appearance_json`, `hair_json`, `body_json`, `name`, `advanced_details`, `preview_job_id`, `created_at`, `updated_at` |
| `character_preview_jobs` | `id`, `draft_id`, `status`, `provider`, `result_asset_id`, `error_code`, `created_at`, `completed_at` |
| `character_tags` | `character_id`, `tag_id` |
| `tags` | `id`, `slug`, `label`, `category`, `is_sensitive`, `is_muted_by_default` |
| `character_stats` | `character_id`, `likes_count`, `chats_count`, `views_count`, `last_activity_at` |
| `character_submissions` | `id`, `character_id`, `submitter_id`, `status`, `review_reason`, `reviewer_id`, `submitted_at`, `reviewed_at` |

Enums:

- `visibility`: `private`, `unlisted`, `public`
- `status`: `draft`, `pending_review`, `approved`, `rejected`, `removed`, `archived`
- `style`: `realistic`, `anime`, `hybrid`, `other`

Safety rules:

- Character age must be `>= 18`.
- Reject underage appearance cues, real-person likeness, prohibited IP/celebrity likeness, non-consent framing, and evasion attempts.

### 3.3 Chat

Chat data is owned by Chat Service. The main site may proxy these APIs and consume chat outbox events, but it does not directly write chat sessions, messages, memories, or relationship state.

| 实体 | 关键字段 |
| --- | --- |
| `chat_sessions` | `id`, `user_id`, `character_id`, `title`, `status`, `memory_summary`, `last_message_at`, `created_at` |
| `messages` | `id`, `session_id`, `role`, `content`, `model`, `status`, `token_count`, `safety_status`, `created_at` |
| `message_versions` | `id`, `message_id`, `content`, `model`, `created_at`, `selected` |
| `chat_usage` | `id`, `user_id`, `session_id`, `messages_used`, `period_start`, `period_end` |
| `companion_memories` | `id`, `user_id`, `character_id`, `session_id`, `scope`, `type`, `text`, `confidence`, `status`, `source_message_ids`, `created_at`, `updated_at` |
| `relationship_states` | `id`, `user_id`, `character_id`, `stage`, `summary`, `signals_json`, `boundaries_json`, `version`, `updated_at` |

Enums:

- `chat_sessions.status`: `active`, `archived`, `deleted`
- `messages.role`: `user`, `assistant`, `system`, `tool`
- `messages.status`: `pending`, `sent`, `blocked`, `failed`, `deleted`

### 3.4 Generation & Media

| 实体 | 关键字段 |
| --- | --- |
| `generation_presets` | `id`, `owner_id`, `scope`, `type`, `category`, `label`, `controls_json`, `visibility`, `status`, `created_at`, `updated_at` |
| `generation_jobs` | `id`, `user_id`, `character_id`, `mode`, `prompt`, `controls_json`, `preset_ids_json`, `model`, `orientation`, `output_count`, `status`, `cost_dreamcoins`, `provider`, `error_code`, `created_at`, `completed_at` |
| `media_assets` | `id`, `owner_id`, `source_job_id`, `character_id`, `type`, `url`, `thumbnail_url`, `visibility`, `safety_status`, `metadata_json`, `created_at` |
| `media_likes` | `user_id`, `media_asset_id`, `created_at` |
| `media_collections` | `id`, `owner_id`, `name`, `visibility`, `created_at` |
| `media_collection_items` | `collection_id`, `media_asset_id`, `sort_order` |

Enums:

- `generation_jobs.mode`: `image`, `video`
- `generation_jobs.status`: `queued`, `moderating_input`, `running`, `moderating_output`, `completed`, `failed`, `blocked`, `refunded`
- `generation_presets.scope`: `built_in`, `user`, `community`
- `generation_presets.type`: `background`, `pose`, `outfit`, `mode`
- `media_assets.type`: `image`, `video`
- `media_assets.visibility`: `private`, `public_pack`, `unlisted`

### 3.5 Billing

| 实体 | 关键字段 |
| --- | --- |
| `plans` | `id`, `slug`, `name`, `billing_period`, `price_cents`, `currency`, `included_dreamcoins`, `features_json`, `active` |
| `subscriptions` | `id`, `user_id`, `plan_id`, `provider`, `provider_customer_id`, `provider_subscription_id`, `status`, `current_period_end`, `cancel_at_period_end` |
| `entitlements` | `id`, `user_id`, `key`, `value_json`, `source`, `expires_at` |
| `dreamcoin_ledger` | `id`, `user_id`, `delta`, `balance_after`, `reason`, `source_id`, `created_at` |
| `checkout_sessions` | `id`, `user_id`, `provider`, `provider_session_id`, `status`, `return_path`, `created_at` |

Ledger rules:

- Dreamcoin balance is derived from the ledger, not directly overwritten.
- Generation jobs reserve coins before provider work, then settle, refund, or mark blocked.

### 3.6 Trust & Safety

| 实体 | 关键字段 |
| --- | --- |
| `moderation_events` | `id`, `target_type`, `target_id`, `layer`, `status`, `policy_code`, `confidence`, `details_json`, `created_at` |
| `content_reports` | `id`, `reporter_id`, `target_type`, `target_id`, `category`, `description`, `status`, `priority`, `created_at` |
| `moderation_reviews` | `id`, `report_id`, `reviewer_id`, `decision`, `policy_code`, `notes`, `created_at` |
| `appeals` | `id`, `user_id`, `target_type`, `target_id`, `original_decision_id`, `status`, `appeal_text`, `reviewer_id`, `created_at`, `resolved_at` |
| `policy_versions` | `id`, `slug`, `version`, `published_at`, `source_url` |

Report categories from safety docs:

- `potential_underage_content`
- `potential_deepfake_content`
- `other_prohibited_content`
- `incorrect_prohibited_content_flag`
- `inaccurate_generation`
- `other`

Moderation layers:

- `input`
- `output`
- `metadata_behavior`
- `human_review`
- `community_report`

### 3.7 Admin/Ops

完整设计见 `docs/product/ADMIN_CONSOLE_PLAN.md`。后台配置和审计可以分期落库，但下列实体是 P0/P1 的目标形态：

| 实体 | 关键字段 |
| --- | --- |
| `admin_audit_logs` | `id`, `actor_id`, `actor_role`, `action`, `target_type`, `target_id`, `reason`, `before_json`, `after_json`, `request_id`, `ip_hash`, `user_agent`, `created_at` |
| `admin_action_requests` | `id`, `requested_by`, `approved_by`, `action`, `target_type`, `target_id`, `status`, `reason`, `payload_json`, `created_at`, `resolved_at` |
| `feature_flags` | `key`, `status`, `rollout_percent`, `rules_json`, `updated_by`, `updated_at` |
| `app_settings` | `key`, `value_json`, `version`, `status`, `updated_by`, `updated_at` |
| `generation_model_profiles` | `id`, `mode`, `label`, `runner`, `pipeline_model`, `params_json`, `cost_multiplier`, `required_entitlement`, `rollout_percent`, `version`, `status`, `updated_by`, `updated_at` |
| `generation_prompt_templates` | `id`, `mode`, `template_json`, `negative_template_json`, `version`, `status`, `updated_by`, `updated_at` |
| `pricing_rules` | `id`, `scope`, `rule_json`, `version`, `status`, `updated_by`, `updated_at` |
| `admin_user_permissions` (P1) | `id`, `user_id`, `permission_key`, `effect`(grant/revoke), `reason`, `created_by`, `created_at` |
| `support_consent_grants` (P1) | `id`, `target_user_id`, `granted_to`, `scope`, `ticket_id`, `reason`, `expires_at`, `created_by`, `created_at` |
| `legal_holds` (P1) | `id`, `target_type`, `target_id`, `case_ref`, `reason`, `status`, `created_by`, `released_by`, `released_at`, `created_at` |

Rules:

- 后台写操作必须追加 `admin_audit_logs`；`before_json`/`after_json` 只记 targetId + 元数据，禁写明文 prompt/chat/媒体。
- `generation_jobs` 应保存当次使用的 profile/template version，保证事后可解释。
- `feature_flags` 不能覆盖硬安全政策。
- `pricing_rules` 只能影响新请求，不能回写历史 ledger。
- 明文 prompt/chat 查看须命中有效 `support_consent_grants`（有时限）或 `legal_holds`（显式解除，不自动过期）；每次查看写 `admin_audit_logs`（详见 `ADMIN_CONSOLE_PLAN §13`）。

## 4. Required State Machines

### 4.1 Character Lifecycle

```text
draft
  -> pending_review
  -> approved -> public/private active use
  -> rejected -> draft edits -> pending_review
  -> removed -> appeal_pending -> approved | removed
  -> archived
```

Rules:

- Private draft characters can be saved before public review, but still require input moderation before chat/generation use.
- Public visibility requires `approved`.
- Any report can push `approved` content to `removed_pending_review` if severity is high.

### 4.2 Chat Message Lifecycle

```text
pending
  -> moderating_input
  -> blocked
  -> generating
  -> moderating_output
  -> sent
  -> failed
```

Rules:

- User message and assistant output both produce `moderation_events`.
- Blocked messages should return a safe product error and preserve the session.
- Regeneration creates `message_versions`; it must not mutate audit history.

### 4.3 Generation Job Lifecycle

```text
queued
  -> moderating_input
  -> blocked/refunded
  -> running
  -> moderating_output
  -> completed
  -> failed/refunded
```

Rules:

- Reserve dreamcoins before `running`.
- Release assets only after output moderation.
- Failed provider jobs should record provider error code and retry eligibility.

### 4.4 Report Lifecycle

```text
open
  -> triaged
  -> reviewing
  -> actioned | no_violation | duplicate | escalated
  -> appealed
  -> closed
```

Rules:

- Underage reports are highest priority and may immediately hide target content.
- Reporter identity is not disclosed to the reported user.
- Every final decision needs a policy code and audit log.

### 4.5 Subscription Lifecycle

```text
checkout_created
  -> checkout_completed
  -> active
  -> past_due
  -> canceled
  -> expired
```

Rules:

- Entitlements are updated only from trusted provider webhooks or verified backend actions.
- UI should not trust client-side plan state for premium gates.

## 5. API Surface

Use `/api/v1` for product APIs and keep public SEO pages server-rendered separately.

### 5.1 Auth & Session

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/auth/signup` | Public | Create user and session |
| `POST` | `/api/v1/auth/login` | Public | Login with email/password |
| `POST` | `/api/v1/auth/logout` | User | Revoke current session |
| `GET` | `/api/v1/me` | User | Current user, plan, entitlements, age gate |
| `PATCH` | `/api/v1/me/preferences` | User | Muted tags, notifications, locale |
| `POST` | `/api/v1/age-gate/accept` | Public/User | Store age gate acceptance |
| `POST` | `/api/v1/age-verification/sessions` | User | Start third-party identity age verification if required |
| `GET` | `/api/v1/age-verification/status` | User | Current verification requirement/status |
| `POST` | `/api/v1/age-verification/webhooks/:provider` | Provider signed | Verification provider callback |

### 5.2 Explore & Characters

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/characters` | Public after age gate | Search, filter, sort, paginate public characters |
| `GET` | `/api/v1/characters/:id` | Public after age gate | Character detail |
| `POST` | `/api/v1/characters/:id/like` | User | Like character |
| `DELETE` | `/api/v1/characters/:id/like` | User | Unlike character |
| `POST` | `/api/v1/characters/:id/report` | User/Public optional | Report character |
| `GET` | `/api/v1/tags` | Public | Explore facets and category chips |
| `GET` | `/api/v1/search/suggest` | Public after age gate | Search suggestions |

Character list query:

```text
q, gender, style, age_min, age_max, tags[], sort, period, cursor, limit
```

### 5.3 Creator

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/character-drafts` | User | Create draft |
| `PATCH` | `/api/v1/character-drafts/:id` | Owner | Save draft fields |
| `POST` | `/api/v1/character-drafts/:id/preview` | Owner | Generate/update preview |
| `POST` | `/api/v1/character-drafts/:id/submit` | Owner | Submit for moderation/publish |
| `POST` | `/api/v1/character-drafts/:id/tags` | Owner | Add/remove draft tags |
| `POST` | `/api/v1/characters/:id/duplicate` | Owner | Duplicate existing character |
| `PATCH` | `/api/v1/characters/:id` | Owner/Admin | Edit character |
| `DELETE` | `/api/v1/characters/:id` | Owner/Admin | Archive/delete character |

### 5.4 Chat

Served by Chat Service or by a main-site BFF that proxies to Chat Service. Chat Service reads main-site User/Character/Entitlement/Eligibility views but owns all chat-domain writes.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/chat/sessions` | User | Start or resume chat for a character |
| `GET` | `/api/v1/chat/sessions` | User | List user sessions |
| `GET` | `/api/v1/chat/sessions/:id` | Owner | Session detail and messages |
| `POST` | `/api/v1/chat/sessions/:id/messages` | Owner | Send message and stream/return assistant reply |
| `POST` | `/api/v1/messages/:id/regenerate` | Owner | Regenerate assistant message |
| `DELETE` | `/api/v1/messages/:id` | Owner | Delete message |
| `DELETE` | `/api/v1/chat/sessions/:id` | Owner | Archive session |

Streaming can use SSE:

```text
POST /api/v1/chat/sessions/:id/messages
GET  /api/v1/chat/streams/:assistantMessageId
```

### 5.5 Generation & Media

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/generation/jobs` | User | Create image/video generation job |
| `GET` | `/api/v1/generation/jobs/:id` | Owner | Poll job status |
| `POST` | `/api/v1/generation/jobs/:id/retry` | Owner | Retry eligible failure |
| `GET` | `/api/v1/generation/presets` | User/Public after age gate | Presets by `type`, `scope`, `category`, `q` |
| `POST` | `/api/v1/generation/presets` | User | Create user preset |
| `PATCH` | `/api/v1/generation/presets/:id` | Owner/Admin | Edit user/community preset |
| `DELETE` | `/api/v1/generation/presets/:id` | Owner/Admin | Archive user preset |
| `GET` | `/api/v1/media` | User | Gallery with `type=image|video`, `liked=1`, cursor |
| `POST` | `/api/v1/media/:id/like` | Owner/User | Like media |
| `DELETE` | `/api/v1/media/:id/like` | Owner/User | Unlike media |
| `POST` | `/api/v1/media/bulk` | Owner | Bulk delete/visibility/collection operations |
| `DELETE` | `/api/v1/media/:id` | Owner/Admin | Delete media |
| `GET` | `/api/v1/media/:id/download` | Owner | Signed download URL |

Generation request（扁平形状为准；详见 `IMAGE_GENERATION_SERVICE_PLAN.md §5.3`）：

```json
{
  "mode": "image",
  "characterId": "char_...",
  "freeplay": false,
  "prompt": "optional premium prompt",
  "negativePrompt": "optional premium negative prompt",
  "controls": {
    "backgroundPresetId": "preset_...",
    "posePresetId": "preset_...",
    "outfitPresetId": "preset_...",
    "orientation": "4:5",
    "model": "image-default"
  },
  "presetIds": ["preset_..."],
  "outputCount": 2
}
```

`POST /generation/jobs` 约束（权威定义在 `IMAGE_GENERATION_SERVICE_PLAN.md §5.3`，此处只记契约要点）：

- `characterId` 与 `freeplay` 二选一；`prompt` / `negativePrompt` / premium model 服务端 entitlement gate；`outputCount` 首发 `1..4`。
- **幂等**：客户端传 `Idempotency-Key` header，按 `(userId, key)` 去重，重复请求返回同一 job，不双建不双扣。
- **在途并发**：用户非终态 job 数受 `MAX_INFLIGHT_JOBS_PER_USER`（config，默认 3）限制，超限 `429 too_many_active_jobs`。
- **余额**：`balance ≥ cost` 校验与 `-cost` reserve 在同一事务内（ECONOMY §1.3）；不足 `402 insufficient_coins`，不入队。
- **retry**：仅 provider failed 可 retry（按当前费率新建 derived job，`derivedFromJobId` 关联）；`blocked` 任务不可 retry，返回 403。

### 5.6 My AI / User Library

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/library/recent` | User | Recent characters and sessions |
| `GET` | `/api/v1/library/characters` | User | Saved/private characters |
| `GET` | `/api/v1/library/group-chats` | User | Group chats |
| `GET` | `/api/v1/library/packs` | User | Packs |
| `GET` | `/api/v1/library/presets` | User | Presets |
| `GET` | `/api/v1/library/created` | User | Created characters |

### 5.7 Profile & Account

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/profile` | User | Profile settings, balance, subscription summary |
| `PATCH` | `/api/v1/profile` | User | Display name/avatar/profile settings |
| `GET` | `/api/v1/profile/preferences` | User | Preferences and notifications |
| `PATCH` | `/api/v1/profile/preferences` | User | Update preferences and notifications |
| `PATCH` | `/api/v1/profile/language` | User | Update locale |
| `POST` | `/api/v1/redeem-codes/redeem` | User | Redeem code to ledger/entitlement reward |
| `GET` | `/api/v1/referrals` | User | Referral code, progress, rewards |
| `POST` | `/api/v1/referrals/invite` | User | Create/share referral invite payload |
| `POST` | `/api/v1/account/sign-out-all` | User | Revoke sessions |
| `POST` | `/api/v1/account/delete-request` | User | Start account deletion flow |

### 5.8 Billing

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/plans` | Public | Monthly/yearly plan data |
| `POST` | `/api/v1/billing/checkout` | User | Create checkout session |
| `POST` | `/api/v1/billing/portal` | User | Create billing portal session |
| `POST` | `/api/v1/billing/webhooks/:provider` | Provider signed | Subscription/payment webhooks |
| `GET` | `/api/v1/dreamcoins` | User | Current balance and ledger page |

### 5.9 Trust & Safety

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/v1/reports` | User/Public optional | Report character, media, chat, user, or issue |
| `GET` | `/api/v1/reports/:id` | Reporter/Admin | Report status |
| `POST` | `/api/v1/appeals` | User | Appeal a moderation decision |
| `GET` | `/api/v1/policies` | Public | Current policy versions |
| `GET` | `/api/v1/admin/moderation/queue` | Admin | Review queue |
| `POST` | `/api/v1/admin/moderation/:id/decision` | Admin | Record review decision |

### 5.10 Admin/Ops Control Plane

完整后台产品方案见 `docs/product/ADMIN_CONSOLE_PLAN.md`。P0 后台不能只覆盖审核，还要覆盖生成配置、用户/账单排障、产品开关和审计。

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/admin/dashboard` | Admin/Ops | Product, queue, generation, billing, safety summary |
| `GET` | `/api/v1/admin/users` | Admin/Support | Search users |
| `GET` | `/api/v1/admin/users/:id` | Admin/Support | User, plan, entitlement, age, ledger summary |
| `POST` | `/api/v1/admin/users/:id/status` | Admin | Suspend/restore user with audit reason |
| `POST` | `/api/v1/admin/users/:id/role` | Admin | Change user role with audit reason (P1) |
| `GET` | `/api/v1/admin/generation/jobs` | Admin/Ops/Support | Search generation jobs |
| `GET` | `/api/v1/admin/generation/jobs/:id` | Admin/Ops/Support | Job timeline, provider error, ledger/refund, media |
| `POST` | `/api/v1/admin/generation/jobs/:id/requeue` | Admin/Ops | Requeue eligible dead-letter/failed job with audit |
| `POST` | `/api/v1/admin/generation/jobs/:id/discard` | Admin/Ops | Discard dead-letter job with reason (no refund replay) (P1) |
| `GET` | `/api/v1/admin/generation/model-profiles` | Admin/Ops | List model profiles |
| `POST` | `/api/v1/admin/generation/model-profiles` | Admin/Ops | Create draft model profile |
| `PATCH` | `/api/v1/admin/generation/model-profiles/:id` | Admin/Ops | Edit draft model profile |
| `POST` | `/api/v1/admin/generation/model-profiles/:id/publish` | Admin | Publish active profile version |
| `POST` | `/api/v1/admin/generation/model-profiles/:id/rollback` | Admin | Roll back to prior active version |
| `GET` | `/api/v1/admin/generation/prompt-templates` | Admin/Ops | List prompt template versions |
| `POST` | `/api/v1/admin/generation/prompt-templates` | Admin/Ops | Create draft prompt template |
| `PATCH` | `/api/v1/admin/generation/prompt-templates/:id` | Admin/Ops | Edit draft prompt template |
| `POST` | `/api/v1/admin/generation/prompt-templates/:id/publish` | Admin | Publish prompt template version |
| `POST` | `/api/v1/admin/generation/prompt-templates/:id/rollback` | Admin | Roll back to prior template version |
| `GET` | `/api/v1/admin/billing/ledger` | Admin/Support | Ledger search and reconciliation |
| `POST` | `/api/v1/admin/billing/adjustments` | Admin | Append-only dreamcoin adjustment |
| `GET` | `/api/v1/admin/feature-flags` | Admin/Ops | List feature flags |
| `PATCH` | `/api/v1/admin/feature-flags/:key` | Admin/Ops | Update flag with audit |
| `GET` | `/api/v1/admin/audit-log` | Admin/Moderator/Support/Ops | Query admin audit log（脱敏，`before/after` 不含明文） |

Rules:

- Admin writes must use domain services and create `AdminAuditLog`.
- 上表 `Auth` 列为 P0 粗粒度 role；细粒度 **permission key 映射**（如 `generation.config.write`、`billing.ledger.adjust`）的 SSoT 在 `ADMIN_CONSOLE_PLAN.md §3.2`，API 层统一用 `requirePermission(key)`。
- Dreamcoin balance cannot be overwritten; adjustments append ledger entries.
- Hard safety policies cannot be disabled by feature flags or model profiles.
- `AdminAuditLog.before/after` 只记 targetId 与元数据，**禁止写入明文 prompt/chat/媒体**，防止 `audit.read` 成为绕过明文查看门控（`ADMIN_CONSOLE_PLAN §13`）的后门。
- 明文 prompt/chat 查看须经 support consent 或 legal hold 流程（`ADMIN_CONSOLE_PLAN §13`），每次查看写审计。
- Production secrets are not editable from admin.

### 5.11 Feed & Community P1

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/feed` | User/Public after age gate | Recommended feed cursor |
| `POST` | `/api/v1/feed/restart` | User/Public after age gate | Reset recommendation cursor |
| `POST` | `/api/v1/feed/items/:id/like` | User | Like feed item |
| `DELETE` | `/api/v1/feed/items/:id/like` | User | Unlike feed item |
| `POST` | `/api/v1/feed/items/:id/share` | User/Public after age gate | Create/share link and log share |
| `POST` | `/api/v1/feed/items/:id/remix` | User | Start remix draft or generation flow |
| `POST` | `/api/v1/feed/items/:id/report` | User/Public optional | Report feed item |
| `GET` | `/api/v1/community/leaderboards` | Public after age gate | Dreamers/Characters/Collections rankings |
| `GET` | `/api/v1/community/collections` | Public after age gate | Public collections |
| `POST` | `/api/v1/users/:id/follow` | User | Follow creator |
| `DELETE` | `/api/v1/users/:id/follow` | User | Unfollow creator |

## 6. Authorization Matrix

| Resource | Public | User | Owner | Admin/Moderator |
| --- | --- | --- | --- | --- |
| Public route content | Read | Read | Read | Manage |
| Age gate acceptance | Create anonymous | Create user-bound | N/A | Audit |
| Age verification | None | Create/read own status | N/A | Audit provider status |
| Public characters | Read after age gate | Read/like/report | Edit own if creator | Remove/review |
| Private characters | None | None | CRUD | Review if escalated |
| Character drafts | None | Create | CRUD own | Review if submitted/escalated |
| Chat sessions | None | Create | Read/write/delete own | Review only if flagged/legal |
| Media assets | Public assets only | Own gallery | CRUD own | Remove/review |
| Generation presets | Built-in/community read | Create user preset | CRUD own preset | Manage built-in/community |
| Billing | Plans only | Own checkout/portal | Own subscription | Support view |
| Profile/account | None | Read/update own | N/A | Support view limited |
| Referral/redeem | None | Own code/redeem | N/A | Audit |
| Feed/community | Read after age gate | Like/share/remix/report | Own content only | Remove/review |
| Reports | Submit | Submit/read own | N/A | Triage/decision |
| Admin queue | None | None | None | Full |

## 7. Queue Workers

| Queue | Producer | Consumer | Notes |
| --- | --- | --- | --- |
| `moderation.input` | Chat Service, creator, generation | moderation service | Blocks high-severity content before model/provider call |
| `age.verification.webhook` | verification provider | compliance worker | Updates verification status idempotently |
| `character.preview` | creator API | image worker | Generates creator preview before final submit |
| `chat.generate` | Chat Service API | Chat Service worker | Internal Chat queue; writes assistant message versions, usage, memory, relationship, and outbox |
| `chat.outbox.deliver` | Chat Service DB | Chat Service worker | Delivers chat events to main-site consumers idempotently |
| `generation.image` | generation API | image worker | P0 worker |
| `generation.video` | generation API | video worker | P1 worker unless required earlier |
| `moderation.output` | model workers | moderation service | Releases or blocks generated assets/messages |
| `billing.webhook` | provider webhook | billing worker | Idempotent by provider event ID |
| `reward.ledger` | referrals, redeem codes, signup bonus | ledger worker | Applies reward entries exactly once |
| `analytics.events` | product APIs | analytics sink | Fire-and-forget with retry |
| `report.triage` | reports API | trust queue | Priority by category |

## 8. P0 Development Order

1. Auth/session foundation and `/api/v1/me`.
2. Age gate persistence, route-level gating, and age verification status model.
3. Character catalog schema, seed import from `characterCards`, and Explore API.
4. Character detail route/API and report entry point.
5. Creator multi-step draft save, tag manager, preview job, submit with input moderation status.
6. Chat session/message API with basic moderation and history.
7. Generation image job API with preset payload, dreamcoin reservation and media gallery.
8. Billing plans, checkout session, webhook sync, Premium/Deluxe entitlements, dreamcoin ledger.
9. My AI library tabs for recent, characters, created, presets, and media.
10. Admin/Ops control plane for moderation, users, generation config, product config, billing/ledger search, queue health, and audit.
11. Profile basics: balance, subscription link, redeem code, referral, preferences/language/account management.
12. Analytics events for age gate, signup, character click, chat start, generation start/completion/failure, checkout, referral, report, appeal.

## 9. P0 Acceptance Criteria

- A first-time visitor must accept age gate before seeing adult Explore content or using Create/Generate/Chat.
- If identity age verification is required, the user cannot use gated routes until verification state is valid.
- An authenticated user can search/filter public characters and open a character detail page.
- An authenticated user can start a chat, send messages, refresh the page, and keep history through Chat Service.
- An authenticated user can create a multi-step private character draft, generate preview, submit it, and see it in My AI.
- An authenticated user can start an image generation job with selected character/Freeplay and presets, see status, and view completed media in Images.
- Premium/Deluxe-only controls are enforced server-side via entitlements.
- Dreamcoin changes are append-only ledger entries.
- Users can report characters, chat messages, and media; reports appear in an admin queue.
- Feed items expose report/share/remix/like APIs without leaking reporter identity.
- Underage, real-person likeness, deepfake, prohibited content, and evasion policy hits produce moderation events.
- Build remains green with `npm run build`, and backend code has type checks/tests for service-level logic.

## 10. Known Gaps To Resolve Before Implementation

- Choose backend stack: Next route handlers only, separate API service, or hybrid.
- Choose database and migration tool.
- Choose auth provider or implement password/session internally.
- Choose payment provider and webhook model.
- Choose queue implementation.
- Choose model providers for chat/image/video and define data retention rules.
- Choose identity age verification provider integration shape; Safety Center currently names Go.cam.
- Decide whether `/chat/` remains robots-disallowed but authenticated-product-accessible.
- Decide how much of safety.ourdream.ai policy content is mirrored locally versus linked externally.
- Decide whether Feed/Community actions are P1 visual-only or included in MVP.
- Decide whether generation presets are product-owned seed data, user-generated content, or both from day one.
