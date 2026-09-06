# iDream 后台功能规格

更新日期：2026-09-05

## 1. 目的

本文档定义完整对标 OurDream 的目标后台契约：模块边界、产品实体、API、状态机、权限和 P0/P1 顺序。它不承担实现进度证明；目标态不得因写入本文就视为已落地。当前实现唯一事实来源是 `CURRENT_FUNCTIONAL_COVERAGE.md`，物理数据形状与运行行为最终以 `packages/main/prisma/schema.prisma` 和 `packages/*/src` 为准。

事实来源：

- `ProductFeatureMap.md`
- `PRD.md`
- `UserStory.md`
- `packages/main/src/server/modules/ourdream/service.ts`
- `packages/main/src/lib/ourdream-data.ts`
- `packages/main/src/components/ourdream/*`

产品分期与用户结果以 [PRD](PRD.md) 为准，跨域验收见 [用户故事](UserStory.md) 与 [对标矩阵](PRODUCT_PARITY_MATRIX.md)。六步 Create 表示历史竞品任务基线，允许完整能力等价的步骤组织；5 档同为 2026-09-01 历史参考，不是实时竞品目录。日常角色/素材通过基础自动检查后进入准备与显式发布，不新增人工批准；举报/申诉保留。本文中的状态、API 和实体是目标契约，不因本轮文档梳理而新增第二套实现。

## 2. 后台模块边界

| 模块 | 负责范围 | P0 |
| --- | --- | --- |
| Identity & Session | 注册、登录、会话、受保护路由、账号状态 | 是 |
| Age & Compliance Gate | 年龄确认、成熟内容访问门、后续年龄验证预留 | 是 |
| Age Verification | 司法辖区/风险触发的第三方身份年龄验证、provider 状态、复验 | P0/P1 |
| Character Catalog | 角色资料、标签、筛选、搜索、排序、统计 | 是 |
| Character Detail | 角色详情、启动聊天、举报入口、公开/私有状态 | 是 |
| Chat | Main-owned Turn/附件/Scene、跨会话记忆、Pinned Memory/Custom Instructions、5 档或功能等价 conversation profiles、最多 12 角色 Group Chat、Voice Call、Product Action、消息/语音 entitlement 与账号边界 | P0 基础 / P1 深度 |
| Creator | 六步 Style/General/Face/Body/Details/Image 创建：Gender/Style/外观/发型/体型、personality/Soul、Voice、Occupation、hobbies/fetishes、relationship type、custom details、视觉候选/anchor、私有使用与公开发布；Quick Start 仅为可选预填 | 是 |
| Generation Presets | built-in/user/community presets、custom preset 创建、preset 分类 | P1 |
| Generation | 图片/视频 Request/Attempt、Create/Edit/Enhance、reference lineage、多 scene/voice video、队列、服务端报价与 dreamcoin、preset payload、交付资产、失败恢复 | 是，先图片 |
| Media Gallery | Images/Videos/Liked、filter、manage、download、delete、like | 是，基础 |
| Paid Access & Entitlements | 一次性周期访问、checkout、webhook、Premium/Deluxe 权益与 append-only ledger | 是 |
| Dreamcoin Coin Store | 与访问计划分开的 top-up offers、quote、一次性 checkout、provider confirmation、幂等 ledger 与购买历史 | P1 |
| Trust & Safety | 输入/输出审核、举报、审核队列、申诉、政策原因 | 是 |
| User Library | P0 Recent/Characters/Created/Presets/Media 完整资产与任务入口；Group Chats/Packs 为 P1 对标目标，未获发布 authority 时默认隐藏新任务入口，既有深链说明不可用原因与返回路径 | P0/P1 |
| Profile & Account | 余额、预付访问状态/重新购买、兑换码、推荐奖励、账号管理；偏好/通知 P1，语言仅在真实 i18n 后启用 | P0/P1 |
| Feed & Community | Feed actions、leaderboard、creator profile/levels、Creator Studio、collections/Packs、Dreamcoin/现金创作者收益 | P1 |
| SEO Content | sitemap 内容、文章、比较页、metadata | P1 |
| Support | P0 基础帮助、工单回执/客户回复/解决与信息隔离；P1 扩展反馈与内容 | P0/P1 |
| Affiliate & Partnerships | 公开 RevShare/CPA 条款、申请/审核、归因链接、素材、dashboard、佣金与对账 | P1 |
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
| `characters` | `id`, `creator_id`, `name`, `age`, `description`, `system_prompt`, `visibility`, `status`, `style`, `gender`, `appearance_json`, `hair_json`, `body_json`, `personality_json`, `occupation`, `hobbies_json`, `fetishes_json`, `relationship_type`, `voice_id`, `opening_message`, `advanced_details`, `image_asset_id`, `created_at`, `updated_at`；最终角色可恢复全部 Create 字段 |
| `character_drafts` | `id`, `owner_id`, `step` (Style/General/Face/Body/Details/Image), `gender`, `style`, `appearance_json`, `hair_json`, `body_json`, `name`, `age`, `description`, `personality_json`, `voice_profile_ref`, `occupation`, `hobbies_json`, `fetishes_json`, `relationship_type`, `opening_message`, `advanced_details`, `preview_job_id`, `created_at`, `updated_at` |
| `character_option_catalogs` (P1 target) | `kind=personality/voice/occupation/relationship/hobby/fetish`, `option_key`, `definition_version`, `label`, `metadata_json`, `status`, `sort_order`；公开广度与 parity matrix 可对账 |
| `character_preview_jobs` | `id`, `draft_id`, `status`, `provider`, `result_asset_id`, `error_code`, `created_at`, `completed_at` |
| `character_visual_profiles` | `id`, `character_id`, `version`, `status`, `identity_prompt`, `negative_identity_prompt`, `face_traits_json`, `hair_traits_json`, `body_traits_json`, `signature_traits_json`, `anchor_asset_ids_json`, `reference_asset_ids_json`, `default_seed`, `adapter_refs_json`, `quality_score`, `consistency_score`, `created_from`, `created_at`, `updated_at` |
| `character_tags` | `character_id`, `tag_id` |
| `character_draft_tags` | `draft_id`, `tag_id`；提交时原子复制到 `character_tags` |
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

Chat product data is owned by Main PostgreSQL. Browser APIs enter Main; `packages/chat` receives an immutable execution snapshot and stores only local AgentRun evidence. Generic companion memory is derived from committed Turns by official igrep; it is not a product-message database.

| 实体 | 关键字段 |
| --- | --- |
| `RecentChat` | `sessionId`, `userId`, `characterId`, `status`, `memoryEnabled`, `contextRevision`, immutable content/Release pin |
| `ChatTurn` | user/assistant message identity、content/status、attempt、Scene、model/usage、terminal evidence、idempotency receipt |
| `ChatTurnAttachment` | current-attempt media effect、Generation/Media 引用、delivery status；Video 仅在显式 Chat capability 与 Product Action contract 发布后适用 |
| `ChatContextDirective` (P1 target) | `id`, `userId`, `characterId`/`sessionId`, `kind=pinned_memory/custom_instruction`, `content`, `status`, `version`, `createdAt`, `updatedAt`；由 Main 权威投影到 Turn context |
| `ChatExperiencePreference` (P1 target) | `sessionId`, `conversationProfile`, `responseLength`, `sceneGeneration`, `activeMessages`, `interactionIntensity`, `version`, `updatedAt` |
| `ChatParticipant` (P1 target) | `sessionId`, `characterId`, immutable content/Release/Voice pins, `role`, `sortOrder`, `status`；用于最多 12 角色的 Group Chat 编排 |
| `VoiceCall` (P1 target) | `id`, `sessionId`, participant/Voice pins, `status`, `startedAt`, `endedAt`, `durationSeconds`, `usage/settlement refs`, `terminalEvidence` |
| AgentRun files | `input.json`, append-only `events.jsonl`, immutable `terminal.json`；执行证据，不用于历史展示 |
| DSH workspace | normal canonical memory 与 private isolated memory；均从已提交 Turn 派生 |

Enums:

- session status: `active`, `archived`
- user status: `sent`, `blocked`
- assistant status: `pending`, `generating`, `sent`, `blocked`, `failed`, `cancelled`

### 3.4 Generation & Media

| 实体 | 关键字段 |
| --- | --- |
| `generation_presets` | `id`, `owner_id`, `scope`, `type`, `category`, `label`, `controls_json`, `visibility`, `status`, `created_at`, `updated_at` |
| `generation_jobs`（Request aggregate） | request identity、user/Character/Release/VisualProfile pins、accepted controls/brief、quote、idempotency、aggregate status；不是 provider execution 的唯一证据 |
| `generation_attempts` / `generation_attempt_events` | requestId、attemptNo、profile/workflow pins、terminal sequence/status、error taxonomy、terminalRecordRef 与 append-only attempt events |
| `generation_transport_executions` | attemptId、transportAttemptNo、providerRequestId、idempotencyKey、latency/cost/pricing、terminalRecordRef |
| `generation_artifacts` | attemptId、ordinal、providerRef、terminalRecordChecksum、validation/archive state、assetId |
| `generation_deliveries` | requestId、artifactId、targetType/targetId、delivery status/time |
| `generation_settlement_links` | requestId、ledgerEntryId、reserve/settle/refund kind；连接 Request 与 append-only ledger |
| `media_assets` | `id`, `owner_id`, `source_job_id`, `character_id`, `type`, `url`, `thumbnail_url`, `visibility`, `safety_status`, `metadata_json`, `created_at` |
| `media_likes` | `user_id`, `media_asset_id`, `created_at` |
| `media_collections` | `id`, `owner_id`, `name`, `visibility`, `created_at` |
| `media_collection_items` | `collection_id`, `media_asset_id`, `sort_order` |
| `content_packs` (P1 target) | `id`, `creator_id`, `character_id`, `title`, `description`, `catalog_version`, `price_dreamcoins`, `future_items_included`, `visibility`, `status`, `published_at` |
| `content_pack_items` (P1 target) | `pack_id`, `media_asset_id`, `ordinal`, `added_at` |
| `content_pack_purchases` (P1 target) | `id`, `pack_id`, `buyer_id`, `catalog_version`, `quoted_price`, `ledger_entry_id`, `status`, `purchased_at` |
| `comics` (P1 target) | `id`, `creator_id`, `title`, `description`, `visibility`, `status`, `published_at`, `updated_at` |
| `comic_episodes` (P1 target) | `id`, `comic_id`, `ordinal`, `title`, `status`, `published_at` |
| `comic_pages` (P1 target) | `episode_id`, `media_asset_id`, `ordinal`, `source_provenance_json` |

Enums:

- `generation_jobs.mode`: `image`, `video`
- `generation_jobs.status`: `queued`, `moderating_input`, `running`, `moderating_output`, `completed`, `failed`, `blocked`, `refunded`
- `generation_presets.scope`: `built_in`, `user`, `community`
- `generation_presets.type`: `background`, `pose`, `outfit`, `mode`
- `media_assets.type`: `image`, `video`, `voice`
- `media_assets.visibility`: `private`, `public_pack`, `unlisted`

### 3.5 Billing

| 实体 | 关键字段 |
| --- | --- |
| `plans` | `id`, `slug`, `name`, `billing_period`, `price_cents`, `currency`, `included_dreamcoins`, `features_json`, `active` |
| `dreamcoin_offers` (P1 target) | `id`, `slug`, `dreamcoins`, `price_cents`, `currency`, `definition_version`, `status`, `valid_from`, `valid_until`；与访问计划分开 |
| `subscriptions`（legacy 物理名） | `id`, `user_id`, `plan_id`, `provider`, `provider_customer_id`, `provider_subscription_id`, `status`, `current_period_end`, `cancel_at_period_end`；当前语义是一次性付费访问记录，不代表自动续订 |
| `entitlements` | `id`, `user_id`, `key`, `value_json`, `source`, `expires_at` |
| `dreamcoin_ledger` | `id`, `user_id`, `delta`, `balance_after`, `reason`, `source_id`, `created_at` |
| `checkout_sessions` | `id`, `user_id`, `purchase_kind=prepaid_access/dreamcoin_topup`, `offer_id`, immutable offer snapshot, `provider`, `provider_session_id`, `status`, `return_path`, `created_at` |

Ledger rules:

- Dreamcoin balance is derived from the ledger, not directly overwritten.
- Generation jobs reserve coins before provider work, then settle, refund, or mark blocked.
- Dreamcoin top-up uses a version-pinned offer snapshot and provider event idempotency; confirmation appends exactly one `topup` ledger entry and never creates, extends, or renews paid access.

### 3.6 Affiliate & Creator Economy（P1 目标）

| 实体 | 关键字段 |
| --- | --- |
| `affiliate_partners` | `id`, `user_id`, `status`, `compensation_model=revshare/cpa`, `terms_version`, `approved_at`, `created_at` |
| `affiliate_links` | `id`, `partner_id`, `code`, `target_path`, `campaign`, `status`, `created_at` |
| `affiliate_attributions` | `id`, `link_id`, `anonymous_id`, `user_id`, `source_event_id`, `first_touch_at`, `converted_at`, `status` |
| `affiliate_commissions` | `id`, `partner_id`, `attribution_id`, `kind`, `amount`, `currency`, `status`, `earned_at`, `approved_at`, `paid_at` |
| `affiliate_assets` | `id`, `title`, `media_asset_id`, `status`, `created_at`, `updated_at` |
| `creator_program_memberships` | `id`, `user_id`, `level`, `definition_version`, `status`, `qualified_at`, `reviewed_at` |
| `creator_earnings` | `id`, `user_id`, `source_type`, `source_id`, `dreamcoin_delta`, `cash_amount`, `currency`, `status`, `earned_at`, `settled_at` |

Rules:

- 前台 RevShare/CPA、Creator level 和 Pack 收益只能从当前已发布定义读取，不在文案中硬编码。
- attribution、commission/earning 与 payout 状态分开；任何重放不得重复计佣或重复结算。
- Creator Studio 只展示 canonical public-release、interaction、Pack purchase 与 ledger/settlement facts；数据不完时 fail closed，不伪造收益。

### 3.7 Trust & Safety

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

### 3.8 Admin/Ops

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
| `GET` | `/api/v1/tags` | Public | Explore facets, category chips, and public character counts |
| `GET` | `/api/v1/search/suggest` | Public after age gate | Search suggestions |

Character list query:

```text
q, gender, style, age_min, age_max, tags[], sort, period, cursor, limit
```

### 5.3 Creator

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/character-options` | User/Public after age gate | Versioned personality/voice/occupation/relationship/hobby/fetish Catalog and parity counts |
| `POST` | `/api/v1/character-drafts` | User | Create draft |
| `PATCH` | `/api/v1/character-drafts/:id` | Owner | Save draft fields |
| `POST` | `/api/v1/character-drafts/:id/preview` | Owner | Generate/update preview |
| `POST` | `/api/v1/character-drafts/:id/submit` | Owner | Submit for moderation/publish |
| `POST` | `/api/v1/character-drafts/:id/tags` | Owner | Add/remove draft tags |
| `POST` | `/api/v1/characters/:id/duplicate` | Owner | Duplicate existing character |
| `PATCH` | `/api/v1/characters/:id` | Owner/Admin | Edit character |
| `DELETE` | `/api/v1/characters/:id` | Owner/Admin | Archive/delete character |

### 5.4 Chat

Browser Chat APIs enter Main. Main owns `RecentChat`、`ChatTurn`、`ChatTurnAttachment`、Scene、entitlement/usage 与 Generation/Ledger 写入；它把不可变 PreparedTurn 快照交给 Chat Service 执行。Chat Service 只保存本地 AgentRun 恢复证据并回传执行结果，不拥有或直写产品聊天历史。下表描述面向浏览器的 Main API surface，内部执行端点可以不同。

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
GET  /api/v1/messages/:assistantMessageId/stream?attempt=:attempt
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

Generation request（浏览器 intent DTO 示例，不是持久化或 provider execution 权威；精确入参以当前 Zod contract 为准）：

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

Main 接受该 intent 后必须先锁定 exact Character/Release/VisualProfile、recipe/profile/workflow、服务端 quote 与 idempotency，再创建 Request aggregate 和 ledger reserve。Gen 随后通过 Attempt → TransportExecution → immutable TerminalRecord 执行，Main 只依据终态记录投影 Artifact → Delivery → Settlement；provider response 本身不能把 Job 直接标成已交付或已结算。

`POST /generation/jobs` 约束（目标行为；精确 Zod、费率与状态机分别以代码、`ECONOMY_AND_PRICING.md` 和 Generation deep module 为准）：

- `characterId` 与 `freeplay` 二选一；`prompt` / `negativePrompt` / premium model 服务端 entitlement gate；`outputCount` 首发 `1..4`（上限由所选 `GenerationModelProfile.maxCount` 约束，默认 profile = 4）。
- **报价/扣费**：服务端按当前 recipe/profile、数量、pricing version 与 entitlement 生成 quote；客户端不得自算 cost。接受后 reserve，只有已交付结果 settle，失败/拦截/未知终态按权威状态机 refund 或 fail closed。
- **幂等**：客户端传 `Idempotency-Key` header，按 `(userId, key)` 去重，重复请求返回同一 job，不双建不双扣。
- **在途并发**：用户非终态 job 数受 `MAX_INFLIGHT_JOBS_PER_USER`（config，默认 3；deluxe 提升到 6）限制，超限 `429 too_many_active_jobs`。
- **余额**：`balance ≥ cost` 校验与 `-cost` reserve 在同一事务内（ECONOMY §1.3）；不足 `402 insufficient_coins`，不入队。
- **video gate**：`video_gen` flag OFF 时 video 请求直接 402/403，不创建 job、不扣费。
- **retry**：仅 provider failed 可 retry（按当前费率新建 derived job，`derivedFromJobId` 关联）；`blocked` 任务不可 retry，返回 403。

### 5.6 My AI / User Library

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/library/recent` | User | Recent characters and sessions |
| `GET` | `/api/v1/library/characters` | User | Saved/private characters |
| `GET` | `/api/v1/library/group-chats` | User | Owned Group Chats with cursor/search and participant summary |
| `GET` | `/api/v1/library/packs` | User | Created/purchased Packs and ownership/access state |
| `GET` | `/api/v1/library/presets` | User | Presets |
| `GET` | `/api/v1/library/created` | User | Created characters |

### 5.7 Profile & Account

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/profile` | User | Profile settings, balance, prepaid-access summary |
| `PATCH` | `/api/v1/profile` | User | Display name/avatar/profile settings |
| `GET` | `/api/v1/profile/preferences` | User | Preferences and notifications |
| `PATCH` | `/api/v1/profile/preferences` | User | Update preferences and notifications |
| `PATCH` | `/api/v1/profile/language` | User | Reserved target; enable only after a real i18n dictionary layer exists |
| `POST` | `/api/v1/redeem-codes/redeem` | User | Redeem code to ledger/entitlement reward |
| `GET` | `/api/v1/referrals` | User | Referral code, progress, rewards |
| `POST` | `/api/v1/referrals/invite` | User | Create/share referral invite payload |
| `POST` | `/api/v1/account/sign-out-all` | User | Revoke sessions |
| `POST` | `/api/v1/account/delete-request` | User | Start account deletion flow |

### 5.8 Billing

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/plans` | Public | Monthly/yearly prepaid-term offers; period labels do not imply renewal |
| `GET` | `/api/v1/dreamcoin-offers` | Public/User | Active versioned coin-store offers and exact price/coin quote |
| `POST` | `/api/v1/billing/checkout` | User | Create checkout session |
| `POST` | `/api/v1/dreamcoins/checkout` | User | Create one-time top-up checkout from an exact offer version |
| `GET` | `/api/v1/dreamcoins/purchases` | User | Own top-up purchase/confirmation history |
| `POST` | `/api/v1/billing/portal` | User | Return current access/offer state; current provider contract has no renewal mutation |
| `POST` | `/api/v1/billing/webhooks/:provider` | Provider signed | Payment and paid-access lifecycle webhooks |
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
| `POST` | `/api/v1/admin/generation/model-profiles` | Admin/Ops | Engineering diagnostics only: create draft model profile; not exposed in default Admin product flow |
| `PATCH` | `/api/v1/admin/generation/model-profiles/:id` | Admin/Ops | Edit draft/disable profile; default Admin flow only operates seeded profiles |
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
| `GET` | `/api/v1/community/packs` | Public after age gate | Published Pack catalog with Character/creator/price/version summaries |
| `POST` | `/api/v1/community/packs` | Creator | Create Pack draft with exact Character and catalog version |
| `PATCH` | `/api/v1/community/packs/:id` | Owner | Edit own Pack metadata/items/price while draft |
| `POST` | `/api/v1/community/packs/:id/submit` | Owner | Submit Pack version for review/publication |
| `POST` | `/api/v1/community/packs/:id/purchase` | User | Quote-check and purchase exact Pack version with idempotent ledger settlement |
| `POST` | `/api/v1/admin/community/packs/:id/decision` | Admin/Moderator | Approve/reject/remove Pack version with audit |
| `GET` | `/api/v1/comics` | Public after age gate | Published Comics discovery cursor |
| `GET` | `/api/v1/comics/:id` | Public after age gate | Comic episodes/pages, creator and Chat/Remix provenance |
| `POST` | `/api/v1/comics` | Creator | Create Comic draft |
| `PATCH` | `/api/v1/comics/:id` | Owner | Edit Comic metadata and ordered episode/page manifest while draft |
| `POST` | `/api/v1/comics/:id/submit` | Owner | Submit exact Comic version for review/publication |
| `POST` | `/api/v1/admin/comics/:id/decision` | Admin/Moderator | Approve/reject/remove Comic version with audit |
| `GET` | `/api/v1/creator-studio` | Creator | Canonical performance, level, Pack earning and payout summaries |
| `POST` | `/api/v1/users/:id/follow` | User | Follow creator |
| `DELETE` | `/api/v1/users/:id/follow` | User | Unfollow creator |

### 5.12 Affiliate & Partnerships P1

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/affiliate/program` | Public | Current published RevShare/CPA terms and application state |
| `POST` | `/api/v1/affiliate/applications` | User | Submit an affiliate application against a terms version |
| `GET` | `/api/v1/affiliate/dashboard` | Approved affiliate | Links, attributed conversions, commissions and payout status |
| `POST` | `/api/v1/affiliate/links` | Approved affiliate | Create an attributable campaign link |
| `PATCH` | `/api/v1/affiliate/links/:id` | Approved affiliate owner | Update target/campaign or archive own link |
| `GET` | `/api/v1/affiliate/assets` | Approved affiliate | Published marketing assets |
| `GET` | `/api/v1/admin/affiliate/applications` | Admin | Review queue with terms-version evidence |
| `POST` | `/api/v1/admin/affiliate/applications/:id/decision` | Admin | Approve/reject application with audit |
| `POST` | `/api/v1/admin/affiliate/commissions/:id/approve` | Admin | Approve or reject calculated commission with reason |
| `POST` | `/api/v1/admin/affiliate/commissions/:id/settle` | Admin | Record idempotent payout settlement/reference |

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
| Packs/Comics | Published catalog/read | Purchase/read access | Manage own drafts/releases | Review/remove/settlement support |
| Billing | Plans only | Own checkout/portal | Own paid-access records | Support view |
| Dreamcoin top-up | Offers only | Own checkout/history | N/A | Support/ledger audit |
| Profile/account | None | Read/update own | N/A | Support view limited |
| Referral/redeem | None | Own code/redeem | N/A | Audit |
| Feed/community | Read after age gate | Like/share/remix/report | Own content only | Remove/review |
| Affiliate | Published program terms | Apply/read own state | Manage own links/assets view | Approve/settle/audit |
| Reports | Submit | Submit/read own | N/A | Triage/decision |
| Admin queue | None | None | None | Full |

## 7. Queue Workers

| Queue | Producer | Consumer | Notes |
| --- | --- | --- | --- |
| `moderation.input` | Main creator/chat/generation | moderation service | Blocks high-severity content before model/provider call |
| `age.verification.webhook` | verification provider | compliance worker | Updates verification status idempotently |
| `ai.image.generate` (`sourceType=character_preview`) | creator API via Generation dispatch Outbox | Gen image worker | Generates creator preview through the same Attempt/terminal authority as all images |
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
5. Creator 完整多步草稿、全部创建字段、Soul/视觉候选、选定 identity anchor、私有保存、My AI/Chat/Generate 交接与公开发布边界。
6. Main-owned RecentChat/ChatTurn/Attachment API with Scene, official igrep memory control, deterministic Product Action and history.
7. Generation image Request/Attempt/Delivery API with exact Character/Release/VisualProfile pins, dreamcoin reservation, settlement/refund and media gallery.
8. Billing plans, checkout session, webhook sync, Premium/Deluxe entitlements, dreamcoin ledger.
9. My AI 核心面：Recent、Characters、Created、Presets 和 Media 均提供真实数据、空态、搜索与后续操作。
10. Admin/Ops control plane for moderation, users, generation config, product config, billing/ledger search, queue health, and audit.
11. Profile P0：余额、预付访问状态/重新购买、兑换码、推荐与账号控制；偏好/通知可在 P1，语言仅在真实 i18n 后启用。
12. Analytics events for age gate, signup, character click, chat start, generation start/completion/failure, checkout, referral, report, appeal.

## 9. P0 Acceptance Criteria

- A first-time visitor must accept age gate before seeing adult Explore content or using Create/Generate/Chat.
- If identity age verification is required, the user cannot use gated routes until verification state is valid.
- An authenticated user can search/filter public characters and open a character detail page.
- An authenticated user can start a chat, send messages, refresh or return later, and continue the same Character/Soul/Scene/memory relationship from Main-owned history.
- An accepted explicit image/voice action has a truthful waiting/failure/delivery state, and replay/regenerate cannot duplicate execution or settlement.
- An authenticated user can complete the multi-step creator, recover every field, review visual candidates, select an identity anchor, save a private character into My AI, and continue to Chat or Generate; Quick Start may prefill but never replaces the full flow.
- An authenticated user can start an image generation job with selected character/Freeplay and presets, see status, and view completed media in Images.
- Premium/Deluxe-only controls are enforced server-side via entitlements.
- Dreamcoin changes are append-only ledger entries.
- Users can report characters, chat messages, and media; reports appear in an admin queue.
- Feed items expose report/share/remix/like APIs without leaking reporter identity.
- Underage, real-person likeness, deepfake, prohibited content, and evasion policy hits produce moderation events.
- 目标 revision 通过仓库既有 `bun run check` 与相关 backend/service focused tests；公开完成声明还需对应 runtime/browser probe。

## 10. 实施与证据边界

本文只定义目标后台契约，不维护逐项实现状态。当前代码、数据、运行证据和真实缺口分别以 [`CURRENT_FUNCTIONAL_COVERAGE.md`](./CURRENT_FUNCTIONAL_COVERAGE.md)、代码/数据库与 [`REMAINING_WORK_EXECUTION_PLAN.md`](./REMAINING_WORK_EXECUTION_PLAN.md) 为准。

任何目标域只有同时具备真实数据模型、权限、副作用、幂等/结算语义和同 revision 的 API/runtime/browser 证据，才能从 parity matrix 的 gap 升级为 `matched` 或 `equivalent`；本文件中的实体、API 或验收条目本身不构成完成声明。
