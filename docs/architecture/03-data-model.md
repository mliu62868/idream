# 03 · 数据模型与 Prisma Schema

更新日期：2026-06-28

本文件把 `BackendFeatureSpec.md §3` 的实体表落地为 **PostgreSQL-only**（dev = prod = Postgres，见 ADR-2）的 Prisma schema 参考，并给出索引、迁移与 seed 策略。**schema 文件本身是数据形状的 SSoT**，本文是其忠实参考，非逐字镜像。

> **多服务拆分**：schema 已按包拆分（见 ADR-2 / 14）：
> - `packages/main/prisma/schema.prisma` —— main 应用权威表（本文档主要覆盖范围）。
> - `packages/chat/prisma/schema.prisma` —— chat 服务权威表 + 跨库视图（multiSchema/views，见 §3.4）。

## 1. 设计约定

| 约定 | 规则 | 理由 |
| --- | --- | --- |
| 主键 | `String @id @default(cuid())` | URL/日志友好、不可枚举、无自增暴露 |
| 时间 | `createdAt DateTime @default(now())`，`updatedAt DateTime @updatedAt` | — |
| 枚举 | **不用 DB `enum`**，用 `String` + `// enum:` 注释 + Zod 校验 | 取值演进无需 DDL；权威列表在 `constants.ts`（SSoT） |
| 数组 | 关联表（强关系）或 `Json`（无需查询的集合） | 产品约定：可查询集合用关联表，不可查询用 `Json` |
| 复杂结构 | `Json`/`jsonb`（appearance、controls、features、metadata…） | Postgres `jsonb` |
| 金额 | `Int`（分/coins，整数） | 避免 Decimal/浮点误差 |
| 计数 | `Int`（派生/缓存计数另见 stats 表） | — |
| 命名 | model PascalCase 单数；表名用 `@@map("snake_case")` 对齐 spec | spec 用 snake_case 表名 |
| 软删除 | 关键实体加 `deletedAt DateTime?` | 审计/可恢复 |
| 钱/额度 | **派生自 ledger/usage，绝不就地覆盖余额** | 见 08 §4 |

> `// enum:` 是文档注释；真正的取值约束在 `*.schema.ts` 的 Zod（见 04 §4），数据库不强制。所有 enum 取值的权威列表也维护在 `src/server/lib/constants.ts`（SSoT）。

## 2. Postgres 特性使用（dev = prod = Postgres）

> 早期的「SQLite dev / Postgres prod 双库可移植子集」已废弃（见 ADR-2）。现 dev/prod 同为 Postgres，可放开使用全部 PG 特性。仍保留的产品约定（见 §1）：enum 用 `String`、可查询集合用关联表 —— 这是为了取值/结构演进无需 DDL，**不是 DB 限制**。

| 特性 | 用法 |
| --- | --- |
| `jsonb` | `Json` 字段直接 `jsonb`；需要时可建表达式/GIN 索引查询 |
| 大小写不敏感 `mode:'insensitive'` | 可用 |
| 全文检索 / `pg_trgm` | 可用；性能索引（`pg_trgm` GIN）放进迁移 SQL（§5） |
| `@@index`/`@@unique`/复合键 | 正常用 |
| 事务 `$transaction` | 正常用 |
| `cuid()` 默认值 | 用 `cuid()` |

**搜索策略**：基础用 Prisma `contains`；为性能在迁移里加 `pg_trgm` 扩展 + `GIN (name gin_trgm_ops)` 索引（见 §5）。dev/prod 同库，行为一致。

## 3. Schema 参考

> 下面按模块分块，是 `packages/main/prisma/schema.prisma` 的忠实参考（字段以实际文件为准）。chat 表见 §3.4，已物理迁至 `packages/chat/prisma/schema.prisma`。

### 3.0 头部 + 生成器 + 数据源

```prisma
// packages/main/prisma/schema.prisma
// url 由 prisma.config.ts 的 process.env.DATABASE_URL 注入（Prisma 7）。
// Postgres-only（见 docs/architecture/02 ADR-2）。

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

### 3.1 Identity（含 better-auth 托管表）

> `User/Session/Account/Verification` 的字段遵循 **better-auth** 约定，由 `npx @better-auth/cli generate` 生成到此 schema；我们在 `User` 上**追加域关系**。若改用 Auth.js，仅这 4 个 model 的字段名变化，业务表不变。

```prisma
model User {
  id            String    @id @default(cuid())
  email         String    @unique
  emailVerified Boolean   @default(false)
  name          String?
  image         String?
  // —— 域字段（应用维护，非 better-auth）——
  displayName   String?
  role          String    @default("user")   /// enum: user | moderator | admin
  status        String    @default("active")  /// enum: active | suspended | deleted
  anonymousId   String?   @unique             // 关联匿名期行为（age gate/漏斗）
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  deletedAt     DateTime?

  sessions             Session[]
  accounts             Account[]
  preferences          UserPreferences?
  ageGateAcceptances   AgeGateAcceptance[]
  ageVerifications     AgeVerification[]
  charactersCreated    Character[]          @relation("CharacterCreator")
  characterDrafts      CharacterDraft[]
  chatSessions         ChatSession[]
  generationJobs       GenerationJob[]
  mediaAssets          MediaAsset[]
  mediaLikes           MediaLike[]
  characterLikes       CharacterLike[]
  mediaCollections     MediaCollection[]
  presets              GenerationPreset[]
  subscriptions        Subscription[]
  entitlements         Entitlement[]
  ledgerEntries        DreamcoinLedger[]
  checkoutSessions     CheckoutSession[]
  redemptions          RedeemCodeRedemption[]
  referralsSent        Referral[]           @relation("Inviter")
  referralsReceived    Referral[]           @relation("Invitee")
  reportsMade          ContentReport[]      @relation("Reporter")
  appeals              Appeal[]
  followers            Follow[]             @relation("Followee")
  following            Follow[]             @relation("Follower")

  @@map("users")
}

model Session {
  id        String   @id @default(cuid())
  userId    String
  token     String   @unique
  expiresAt DateTime
  ipAddress String?
  userAgent String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("sessions")
}

model Account {            // better-auth：密码哈希 + OAuth 账号
  id                String    @id @default(cuid())
  userId            String
  providerId        String                       /// enum: credential | google | discord | ...
  accountId         String
  password          String?                      // credential 时存哈希（scrypt/argon2）
  accessToken       String?
  refreshToken      String?
  accessTokenExpiresAt  DateTime?
  scope             String?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  user              User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([providerId, accountId])
  @@index([userId])
  @@map("accounts")
}

model Verification {       // better-auth：邮箱/重置等一次性令牌
  id         String   @id @default(cuid())
  identifier String
  value      String
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  @@index([identifier])
  @@map("verifications")
}

model UserPreferences {
  userId               String   @id
  mutedTags            Json     @default("[]")   // string[]（tag slug）
  safeModeFlags        Json     @default("{}")
  notificationSettings Json     @default("{}")
  locale               String   @default("en")
  updatedAt            DateTime @updatedAt
  user                 User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@map("user_preferences")
}
```

### 3.2 Compliance（年龄门槛 + 身份验证）

```prisma
model AgeGateAcceptance {
  id            String   @id @default(cuid())
  userId        String?                       // 匿名期为 null，登录后回填
  anonymousId   String?                       // 与 cookie 中匿名 id 对应
  acceptedAt    DateTime @default(now())
  country       String?
  sourcePath    String?
  policyVersion String?
  user          User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  @@index([userId])
  @@index([anonymousId])
  @@map("age_gate_acceptances")
}

model AgeVerification {
  id                   String    @id @default(cuid())
  userId               String
  provider             String                        /// enum: gocam | yoti | persona | veriff | ...
  providerVerificationId String?
  status               String    @default("required") /// enum: required | pending | verified | failed | expired
  jurisdiction         String?
  requiredReason       String?
  verifiedAt           DateTime?
  expiresAt            DateTime?
  metadata             Json      @default("{}")
  createdAt            DateTime  @default(now())
  user                 User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, status])
  @@map("age_verifications")
}
```

### 3.3 Characters

```prisma
model Character {
  id            String    @id @default(cuid())
  creatorId     String?
  name          String
  age           Int                              // 不变量：>= 18（service + 审核强制）
  description   String
  systemPrompt  String?                          // roleplay 设定注入
  visibility    String    @default("private")    /// enum: private | unlisted | public
  status        String    @default("draft")      /// enum: draft|pending_review|approved|rejected|removed|archived
  source        String    @default("user")       /// enum: official | user — 官方角色由 admin CMS 生产，跳过用户审核但仍过 moderation
  style         String    @default("realistic")  /// enum: realistic | anime | hybrid | other
  gender        String    @default("female")     /// enum: female | male | trans
  relationship  String?
  voiceId       String?
  imageAssetId  String?
  appearance    Json      @default("{}")          // race/hair/body 等结构
  advancedDetails Json    @default("{}")
  vivid         Boolean   @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  deletedAt     DateTime?

  creator       User?            @relation("CharacterCreator", fields: [creatorId], references: [id], onDelete: SetNull)
  imageAsset    MediaAsset?      @relation("CharacterImage", fields: [imageAssetId], references: [id], onDelete: SetNull)
  tags          CharacterTag[]
  stats         CharacterStats?
  submissions   CharacterSubmission[]
  recentChats   RecentChat[]                      // chat 域已外迁，main 只保留 read projection（见 §3.4）
  generationJobs GenerationJob[]
  likes         CharacterLike[]

  @@index([visibility, status])
  @@index([source, visibility, status])
  @@index([creatorId])
  @@index([gender, style])
  @@index([createdAt])
  @@map("characters")
}

model CharacterDraft {
  id            String   @id @default(cuid())
  ownerId       String
  step          Int      @default(0)
  gender        String?
  style         String?
  appearance    Json     @default("{}")
  hair          Json     @default("{}")
  body          Json     @default("{}")
  name          String?
  advancedDetails Json   @default("{}")
  tags          Json     @default("[]")          // 草稿期 tag slug 列表；提交时落 CharacterTag
  previewJobId  String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  owner         User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  previewJobs   CharacterPreviewJob[]
  @@index([ownerId])
  @@map("character_drafts")
}

model CharacterPreviewJob {
  id            String    @id @default(cuid())
  draftId       String
  status        String    @default("queued")     /// enum: queued|running|completed|failed
  provider      String?
  resultAssetId String?
  errorCode     String?
  createdAt     DateTime  @default(now())
  completedAt   DateTime?
  draft         CharacterDraft @relation(fields: [draftId], references: [id], onDelete: Cascade)
  @@index([draftId])
  @@map("character_preview_jobs")
}

model Tag {
  id              String   @id @default(cuid())
  slug            String   @unique
  label           String
  category        String?                          /// enum: theme | body | ethnicity | relationship | kink | ...
  isSensitive     Boolean  @default(false)
  isMutedByDefault Boolean @default(false)
  characters      CharacterTag[]
  @@index([category])
  @@map("tags")
}

model CharacterTag {
  characterId String
  tagId       String
  character   Character @relation(fields: [characterId], references: [id], onDelete: Cascade)
  tag         Tag       @relation(fields: [tagId], references: [id], onDelete: Cascade)
  @@id([characterId, tagId])
  @@index([tagId])
  @@map("character_tags")
}

model CharacterStats {
  characterId    String   @id
  likesCount     Int      @default(0)
  chatsCount     Int      @default(0)
  viewsCount     Int      @default(0)
  lastActivityAt DateTime?
  character      Character @relation(fields: [characterId], references: [id], onDelete: Cascade)
  @@index([likesCount])
  @@index([chatsCount])
  @@map("character_stats")
}

model CharacterLike {
  userId      String
  characterId String
  createdAt   DateTime @default(now())
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  character   Character @relation(fields: [characterId], references: [id], onDelete: Cascade)
  @@id([userId, characterId])
  @@index([characterId])
  @@map("character_likes")
}

model CharacterSubmission {
  id           String    @id @default(cuid())
  characterId  String
  submitterId  String
  status       String    @default("pending")     /// enum: pending|approved|rejected
  reviewReason String?
  reviewerId   String?
  submittedAt  DateTime  @default(now())
  reviewedAt   DateTime?
  character    Character @relation(fields: [characterId], references: [id], onDelete: Cascade)
  @@index([status])
  @@index([characterId])
  @@map("character_submissions")
}

model CharacterTemplate {                          // admin CMS：建角色起步模板（见 admin 角色管理）
  id              String   @id @default(cuid())
  scope           String   @default("built_in")    /// enum: built_in | community
  name            String
  summary         String?
  gender          String?
  style           String?
  appearance      Json
  advancedDetails Json
  tags            Json                              // string[]
  coverAssetId    String?
  isActive        Boolean  @default(true)
  sortOrder       Int      @default(0)
  createdById     String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  coverAsset      MediaAsset? @relation("TemplateCover", fields: [coverAssetId], references: [id], onDelete: SetNull)
  @@index([isActive, sortOrder])
  @@map("character_templates")
}
```

### 3.4 Chat（已外迁至 Chat Service）

> **拆分已落地**（见 14）。chat 域权威表已**物理迁出** main schema，落在 `packages/chat/prisma/schema.prisma`（独立 `chat` schema，`chat_service` 角色连接）。main **不再**写 `chat_sessions`/`messages`，只通过 Chat API + outbox/inbox 事件交互。DDL 权威在 `db/sql/03_chat_tables.sql`（用户手工执行），Prisma schema 仅映射，不 `db push`。
>
> **重要变更**：`companion_memories` / `relationship_states` **不再是 PG 表**，已迁到 Chat Service 的**文件层**（`packages/chat/src/chat-fs.ts`，`CHAT_FS_ROOT` 下 `mem/{userId}/{charId}/memory.md`、`relationship.md`、`global/boundaries.md`，租户分区 + 原子重写）。记忆的增删改查走文件层（`memories.ts`），不进数据库。

**main 侧只保留一个 read projection**（由 chat→main outbox 投喂，永不是 source of truth）：

```prisma
// packages/main/prisma/schema.prisma
model RecentChat {                                 // 图库「最近」标签页用，单向派生自事件
  sessionId     String    @id
  userId        String
  characterId   String
  title         String?
  status        String    @default("active")       /// enum: active | deleted
  lastMessageAt DateTime?
  createdAt     DateTime  @default(now())
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  character     Character @relation(fields: [characterId], references: [id], onDelete: Cascade)
  @@index([userId, lastMessageAt])
  @@index([characterId])
  @@map("recent_chats")
}
```

**Chat Service 权威表 + 视图**（`packages/chat/prisma/schema.prisma`，`previewFeatures = ["multiSchema","views"]`，`schemas = ["chat","core","billing","compliance"]`）：

- **只读视图**（main 权威，最小暴露）：`ChatUserView`(core)、`ChatCharacterView`(core)、`ChatCharacterTagsView`(core)、`ChatEntitlementView`(billing)、`ChatUserEligibilityView`(compliance)。Chat Service 只读这些，不写 main 权威表。
- **chat schema 权威表**：`ChatSession`、`Message`、`MessageVersion`、`ChatUsage`、`ChatModerationEvent`，以及跨服务事件表 `ChatOutboxEvent`(`chat_outbox_events`) / `ChatInboxEvent`(`chat_inbox_events`)。

```prisma
// packages/chat/prisma/schema.prisma（节选；字段以实际文件为准）
model ChatSession {
  id              String    @id
  userId          String    @map("user_id")
  characterId     String    @map("character_id")
  title           String?
  status          String    @default("active")
  memoryEnabled   Boolean   @default(true) @map("memory_enabled")
  memorySummary   String?   @map("memory_summary")
  logExtractedSeq BigInt    @default(0) @map("log_extracted_seq")
  lastMessageAt   DateTime? @map("last_message_at")
  // ... createdAt/updatedAt/deletedAt
  @@map("chat_sessions")
  @@schema("chat")
}

model ChatOutboxEvent {                            // chat→main 投递（BullMQ+Redis 消费）
  id            String    @id
  eventType     String    @map("event_type")
  aggregateType String    @map("aggregate_type")
  aggregateId   String    @map("aggregate_id")
  payload       Json      @default("{}")
  status        String    @default("pending")
  attempts      Int       @default(0)
  nextRunAt     DateTime  @default(now()) @map("next_run_at")
  // ...
  @@index([status, nextRunAt], map: "chat_outbox_pending_idx")
  @@map("chat_outbox_events")
  @@schema("chat")
}
// ChatInboxEvent 对称（main→chat）。
```

### 3.5 Generation & Media

```prisma
model GenerationPreset {
  id          String   @id @default(cuid())
  ownerId     String?                              // built_in 时为 null
  scope       String   @default("user")            /// enum: built_in | user | community
  type        String                                /// enum: background | pose | outfit | mode
  category    String?
  label       String
  controls    Json     @default("{}")
  visibility  String   @default("private")          /// enum: private | public | unlisted
  status      String   @default("active")           /// enum: active | archived
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  owner       User?    @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  @@index([scope, type])
  @@index([ownerId])
  @@map("generation_presets")
}

model GenerationJob {
  id            String    @id @default(cuid())
  userId        String
  characterId   String?                             // null = Freeplay
  mode          String                               /// enum: image | video
  prompt        String?
  negativePrompt String?
  controls      Json      @default("{}")            // background/pose/outfit/orientation/model/count...
  presetIds     Json      @default("[]")
  model         String?
  orientation   String?
  outputCount   Int       @default(1)
  status        String    @default("queued")        /// enum: queued|moderating_input|running|moderating_output|completed|failed|blocked|refunded
  costDreamcoins Int      @default(0)
  provider      String?
  errorCode     String?
  createdAt     DateTime  @default(now())
  completedAt   DateTime?
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  character     Character? @relation(fields: [characterId], references: [id], onDelete: SetNull)
  assets        MediaAsset[]
  @@index([userId, createdAt])
  @@index([status])
  @@map("generation_jobs")
}

model MediaAsset {
  id           String    @id @default(cuid())
  ownerId      String
  sourceJobId  String?
  characterId  String?
  type         String                               /// enum: image | video
  url          String                                // 对象存储 key（私有，签名访问）
  thumbnailUrl String?
  prompt       String?
  visibility   String    @default("private")        /// enum: private | public_pack | unlisted
  safetyStatus String    @default("unknown")        /// enum: unknown|passed|flagged|blocked
  metadata     Json      @default("{}")
  liked        Boolean   @default(false)             // 拥有者快捷标记；多用户 like 见 MediaLike
  createdAt    DateTime  @default(now())
  deletedAt    DateTime?
  owner        User           @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  sourceJob    GenerationJob? @relation(fields: [sourceJobId], references: [id], onDelete: SetNull)
  likes        MediaLike[]
  collections  MediaCollectionItem[]
  characterImageOf Character[] @relation("CharacterImage")
  @@index([ownerId, type, createdAt])
  @@index([sourceJobId])
  @@map("media_assets")
}

model MediaLike {
  userId       String
  mediaAssetId String
  createdAt    DateTime @default(now())
  user         User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  mediaAsset   MediaAsset @relation(fields: [mediaAssetId], references: [id], onDelete: Cascade)
  @@id([userId, mediaAssetId])
  @@index([mediaAssetId])
  @@map("media_likes")
}

model MediaCollection {
  id         String   @id @default(cuid())
  ownerId    String
  name       String
  visibility String   @default("private")           /// enum: private | public | unlisted
  createdAt  DateTime @default(now())
  owner      User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  items      MediaCollectionItem[]
  @@index([ownerId])
  @@map("media_collections")
}

model MediaCollectionItem {
  collectionId String
  mediaAssetId String
  sortOrder    Int      @default(0)
  collection   MediaCollection @relation(fields: [collectionId], references: [id], onDelete: Cascade)
  mediaAsset   MediaAsset      @relation(fields: [mediaAssetId], references: [id], onDelete: Cascade)
  @@id([collectionId, mediaAssetId])
  @@map("media_collection_items")
}
```

### 3.6 Billing

```prisma
model Plan {
  id                String   @id @default(cuid())
  slug              String   @unique               /// enum: premium | deluxe
  name              String
  billingPeriod     String                          /// enum: monthly | yearly
  priceCents        Int
  currency          String   @default("usd")
  includedDreamcoins Int     @default(0)
  features          Json     @default("{}")         // images/videos/voiceMin/messages/models/memory...
  active            Boolean  @default(true)
  subscriptions     Subscription[]
  @@unique([slug, billingPeriod])
  @@map("plans")
}

model Subscription {
  id                     String   @id @default(cuid())
  userId                 String
  planId                 String
  provider               String                      /// enum: btcpay | nowpayments | cryptomus | coingate | ... (加密货币, ADR-4)
  providerCustomerId     String?
  providerSubscriptionId String?
  status                 String   @default("checkout_created") /// enum: checkout_created|checkout_completed|active|past_due|canceled|expired
  currentPeriodEnd       DateTime?
  cancelAtPeriodEnd      Boolean  @default(false)
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
  user                   User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  plan                   Plan     @relation(fields: [planId], references: [id])
  @@index([userId, status])
  @@index([providerSubscriptionId])
  @@map("subscriptions")
}

model Entitlement {
  id        String    @id @default(cuid())
  userId    String
  key       String                                  /// enum: unlimited_messages | custom_prompt | video_gen | premium_models | ...
  value     Json      @default("true")
  source    String                                  /// enum: subscription | redeem | promo | manual
  expiresAt DateTime?
  createdAt DateTime  @default(now())
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([userId, key])
  @@index([userId])
  @@map("entitlements")
}

model DreamcoinLedger {                              // append-only；余额 = SUM(delta)
  id           String   @id @default(cuid())
  userId       String
  delta        Int                                   // +充值/奖励 / -消费
  balanceAfter Int                                   // 写入时快照，便于审计/对账
  reason       String                                /// enum: signup_bonus|subscription_grant|generation_spend|refund|redeem|referral|admin_adjust
  sourceId     String?                               // generationJobId / subscriptionId / redeemId...
  createdAt    DateTime @default(now())
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId, createdAt])
  @@map("dreamcoin_ledger")
}

model CheckoutSession {
  id                String   @id @default(cuid())
  userId            String
  provider          String
  providerSessionId String?
  status            String   @default("created")     /// enum: created | completed | expired | canceled
  returnPath        String?
  createdAt         DateTime @default(now())
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId])
  @@map("checkout_sessions")
}
```

### 3.7 Trust & Safety

```prisma
model ModerationEvent {
  id         String   @id @default(cuid())
  targetType String                                  /// enum: message|character|media|draft|generation_job|user|feed_item
  targetId   String
  layer      String                                  /// enum: input|output|metadata_behavior|human_review|community_report
  status     String                                  /// enum: passed|flagged|blocked
  policyCode String?                                 /// 见 07 §4 政策码表
  confidence Float?
  details    Json     @default("{}")
  createdAt  DateTime @default(now())
  @@index([targetType, targetId])
  @@index([policyCode])
  @@map("moderation_events")
}

model ContentReport {
  id          String   @id @default(cuid())
  reporterId  String?                                // 可匿名
  targetType  String                                  /// enum: character|media|message|user|feed_item|copyright|other
  targetId    String
  category    String                                  /// enum: potential_underage_content|potential_deepfake_content|other_prohibited_content|incorrect_prohibited_content_flag|inaccurate_generation|other
  description String?
  status      String   @default("open")              /// enum: open|triaged|reviewing|actioned|no_violation|duplicate|escalated|appealed|closed
  priority    Int      @default(3)                    // 1 最高（未成年）→ 5
  createdAt   DateTime @default(now())
  reporter    User?    @relation("Reporter", fields: [reporterId], references: [id], onDelete: SetNull)
  reviews     ModerationReview[]
  @@index([status, priority])
  @@index([targetType, targetId])
  @@map("content_reports")
}

model ModerationReview {
  id         String   @id @default(cuid())
  reportId   String?
  reviewerId String
  decision   String                                  /// enum: actioned|no_violation|duplicate|escalated
  policyCode String?
  notes      String?
  createdAt  DateTime @default(now())
  report     ContentReport? @relation(fields: [reportId], references: [id], onDelete: SetNull)
  @@index([reportId])
  @@map("moderation_reviews")
}

model Appeal {
  id                 String    @id @default(cuid())
  userId             String
  targetType         String
  targetId           String
  originalDecisionId String?
  status             String    @default("open")       /// enum: open|reviewing|granted|denied|closed
  appealText         String
  reviewerId         String?
  createdAt          DateTime  @default(now())
  resolvedAt         DateTime?
  user               User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@index([userId])
  @@index([status])
  @@map("appeals")
}

model PolicyVersion {
  id          String   @id @default(cuid())
  slug        String                                  // age-verification / moderation / reporting ...
  version     String
  title       String?
  body        String?                                 // 本地镜像正文（见 07 §7）
  publishedAt DateTime @default(now())
  sourceUrl   String?
  @@unique([slug, version])
  @@map("policy_versions")
}
```

### 3.8 Profile · Referral · Redeem · Community

```prisma
model RedeemCode {
  id          String   @id @default(cuid())
  codeHash    String   @unique                        // 不存明文
  reward      Json     @default("{}")                 // dreamcoins / entitlement
  status      String   @default("active")             /// enum: active | disabled | exhausted
  maxRedemptions Int?
  expiresAt   DateTime?
  createdAt   DateTime @default(now())
  redemptions RedeemCodeRedemption[]
  @@map("redeem_codes")
}

model RedeemCodeRedemption {
  id           String   @id @default(cuid())
  redeemCodeId String
  userId       String
  rewardStatus String   @default("granted")           /// enum: granted | pending | failed
  createdAt    DateTime @default(now())
  redeemCode   RedeemCode @relation(fields: [redeemCodeId], references: [id], onDelete: Cascade)
  user         User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([redeemCodeId, userId])                     // 每码每人一次
  @@map("redeem_code_redemptions")
}

model Referral {
  id             String   @id @default(cuid())
  inviterId      String
  inviteeId      String?
  code           String   @unique
  status         String   @default("pending")         /// enum: pending | joined | converted | rewarded
  subscriptionId String?
  rewardStatus   String   @default("none")            /// enum: none | pending | granted
  createdAt      DateTime @default(now())
  inviter        User     @relation("Inviter", fields: [inviterId], references: [id], onDelete: Cascade)
  invitee        User?    @relation("Invitee", fields: [inviteeId], references: [id], onDelete: SetNull)
  @@index([inviterId])
  @@map("referrals")
}

model Follow {                                          // 社区关注（P1）
  followerId String
  followeeId String
  createdAt  DateTime @default(now())
  follower   User     @relation("Follower", fields: [followerId], references: [id], onDelete: Cascade)
  followee   User     @relation("Followee", fields: [followeeId], references: [id], onDelete: Cascade)
  @@id([followerId, followeeId])
  @@index([followeeId])
  @@map("follows")
}
```

### 3.9 基础设施（BullMQ / webhook 幂等 / 埋点 / 路由内容）

```prisma
// Queue state lives in Redis/BullMQ (see 06). The relational DB stores only
// authoritative business state and idempotency records.

model ProviderEvent {                                   // webhook 幂等（支付/验证）
  id            String   @id @default(cuid())
  provider      String
  providerEventId String
  type          String?
  payload       Json
  processedAt   DateTime?
  createdAt     DateTime @default(now())
  @@unique([provider, providerEventId])
  @@map("provider_events")
}

model AnalyticsEvent {                                  // 产品埋点（也可外发到分析平台，见 09）
  id          String   @id @default(cuid())
  userId      String?
  anonymousId String?
  name        String                                   // age_gate_accepted / chat_started / ...
  props       Json     @default("{}")
  createdAt   DateTime @default(now())
  @@index([name, createdAt])
  @@index([userId])
  @@map("analytics_events")
}

model RoutePage {                                       // SEO 路由内容/状态（对齐 PRD §7 RoutePage）
  path          String   @id
  template      String                                  /// enum: article|comparison|create|generator|library|marketing|profile|safety|terms|upgrade|home
  title         String
  description   String
  canonical     String?
  contentStatus String   @default("template")           /// enum: template | drafted | published
  body          Json     @default("{}")
  updatedAt     DateTime @updatedAt
  @@index([template])
  @@map("route_pages")
}
```

### 3.10 Admin 控制平面（后台管理）

> Admin Phase 2 落地的控制平面表（见 admin 模块）。审计、审批、特性开关、应用设置、生成模型/Prompt/路由/定价的可治理配置（草稿→发布→归档 + 版本），以及权限/支持授权/法务保留。多数带 `status (draft|active|archived)` + `version` 做可审计的配置变更。

```prisma
model AdminAuditLog {                              // 全量后台操作审计
  id         String   @id @default(cuid())
  actorId    String
  actorRole  String
  action     String
  targetType String
  targetId   String
  reason     String?
  before     Json?
  after      Json?
  requestId  String?
  ipHash     String?
  userAgent  String?
  createdAt  DateTime @default(now())
  @@index([actorId, createdAt])
  @@index([action, createdAt])
  @@index([targetType, targetId])
  @@map("admin_audit_logs")
}

model AdminActionRequest {                         // 高危操作双人审批（请求→批准/驳回）
  id            String    @id @default(cuid())
  requestedById String
  approvedById  String?
  permissionKey String
  action        String
  targetType    String
  targetId      String
  payload       Json
  status        String    @default("pending")      /// enum: pending | approved | rejected | canceled
  reason        String?
  createdAt     DateTime  @default(now())
  decidedAt     DateTime?
  @@index([status, createdAt])
  @@index([requestedById])
  @@map("admin_action_requests")
}

model FeatureFlag {                                // 特性开关（按角色/计划/百分比灰度）
  key            String   @id
  label          String
  description    String?
  enabled        Boolean  @default(false)
  rolloutPercent Int      @default(0)
  targetRoles    Json
  targetPlans    Json
  hardPolicy     Boolean  @default(false)
  version        Int      @default(1)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@index([enabled])
  @@map("feature_flags")
}

model AppSetting {                                 // 通用应用设置（可版本化/草稿）
  key       String   @id
  value     Json
  version   Int      @default(1)
  status    String   @default("active")            /// enum: draft | active | archived
  updatedAt DateTime @updatedAt
  @@index([status])
  @@map("app_settings")
}

model GenerationModelProfile {                     // 可治理的生成模型档案（runner/参数/灰度）
  id                  String    @id @default(cuid())
  profileKey          String
  label               String
  mode                String    @default("image")  /// enum: image | video
  runner              String    @default("sd_cpp") /// enum: pipeline | sd_cpp | mlx | comfyui | external
  pipelineModel       String
  sourceModelPath     String?
  convertedModelPath  String?
  modelFormat         String    @default("safetensors")
  runnerConfig        Json?
  defaultWidth        Int       @default(768)
  defaultHeight       Int       @default(1024)
  allowedOrientations Json
  steps               Int       @default(28)
  sampler             String    @default("dpmpp_2m")
  cfgScale            Float     @default(7)
  negativeTemplateId  String?
  costMultiplier      Float     @default(1)
  requiredEntitlement String?
  maxCount            Int       @default(4)
  concurrencyLimit    Int       @default(1)
  enabled             Boolean   @default(true)
  rolloutPercent      Int       @default(100)
  version             Int       @default(1)
  status              String    @default("draft")  /// enum: draft | active | archived
  dryRunSummary       Json?
  publishedAt         DateTime?
  archivedAt          DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  @@index([profileKey, status])
  @@index([mode, status])
  @@map("generation_model_profiles")
}

model GenerationPromptTemplate {                   // 可治理的生成 prompt 模板（含 negative）
  id            String    @id @default(cuid())
  templateKey   String
  label         String
  mode          String    @default("image")        /// enum: image | video | negative
  useCase       String    @default("character")    /// enum: character | freeplay | negative
  body          String
  negativeBase  String?
  presetOrder   Json
  safetyHints   Json
  sampleMatrix  Json
  version       Int       @default(1)
  status        String    @default("draft")        /// enum: draft | active | archived
  dryRunSummary Json?
  publishedAt   DateTime?
  archivedAt    DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  @@index([templateKey, status])
  @@index([mode, useCase, status])
  @@map("generation_prompt_templates")
}

model GenerationProviderRoute {                    // 生成 provider 路由/权重
  id          String   @id @default(cuid())
  profileKey  String
  provider    String
  endpointRef String?
  weight      Int      @default(100)
  enabled     Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([profileKey, enabled])
  @@map("generation_provider_routes")
}

model PricingRule {                                // 可治理的计费规则（baseCost × multiplier）
  id            String    @id @default(cuid())
  ruleKey       String
  label         String
  mode          String
  baseCost      Int
  multiplier    Float     @default(1)
  status        String    @default("draft")        /// enum: draft | active | archived
  version       Int       @default(1)
  effectiveFrom DateTime?
  publishedAt   DateTime?
  archivedAt    DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  @@index([ruleKey, status])
  @@index([mode, status])
  @@map("pricing_rules")
}

model AdminSavedView {                             // 后台列表的保存筛选视图
  id        String   @id @default(cuid())
  ownerId   String
  scope     String
  label     String
  filters   Json
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([ownerId, scope])
  @@map("admin_saved_views")
}

model AdminUserPermission {                        // 细粒度后台权限授予/回收
  id            String   @id @default(cuid())
  userId        String
  permissionKey String
  effect        String                             /// enum: grant | revoke
  reason        String
  createdById   String
  createdAt     DateTime @default(now())
  @@unique([userId, permissionKey, effect])
  @@index([userId])
  @@map("admin_user_permissions")
}

model SupportConsentGrant {                        // 用户授权客服访问私有数据（限时/限范围）
  id          String   @id @default(cuid())
  userId      String
  ticketId    String
  targetType  String
  targetId    String
  scope       Json
  expiresAt   DateTime
  createdById String?
  createdAt   DateTime @default(now())
  @@index([userId, targetType, targetId])
  @@index([ticketId])
  @@map("support_consent_grants")
}

model LegalHold {                                  // 法务保留（阻止删除/擦除）
  id           String    @id @default(cuid())
  targetType   String
  targetId     String
  caseNumber   String
  reason       String
  status       String    @default("active")        /// enum: active | released
  approvedById String
  createdById  String
  releasedById String?
  releasedAt   DateTime?
  createdAt    DateTime  @default(now())
  @@index([targetType, targetId, status])
  @@index([caseNumber])
  @@map("legal_holds")
}
```

## 4. 索引策略

- **Explore 列表**：`characters(visibility,status)`、`(source,visibility,status)`、`(gender,style)`、`(createdAt)`、`character_stats(likesCount)`/`(chatsCount)` 支撑排序（For You/Popular/Newest）。
- **聊天历史**：在 Chat Service 侧 `chat_sessions(userId,lastMessageAt)`、`messages(sessionId,createdAt)`；main 侧 `recent_chats(userId,lastMessageAt)`。
- **图库**：`media_assets(ownerId,type,createdAt)`。
- **队列**：状态在 Redis/BullMQ，不在关系库（见 06）；跨服务投递扫描 `chat_outbox_events(status,nextRunAt)`。
- **审核队列**：`content_reports(status,priority)`。
- **后台**：`admin_audit_logs(actorId,createdAt)`/`(action,createdAt)`；可治理配置普遍 `(<key>,status)`。
- **幂等**：`provider_events(provider,providerEventId)` 唯一。
- **全文检索性能**（迁移 SQL 里加）：`pg_trgm` GIN on `characters.name`/`description`；`analytics_events` 按时间分区（量大时）。

## 5. 迁移工作流（Postgres-only）

dev/prod 同为 Postgres（dev 用 `docker-compose.yml` 起本地 PG，见 10）。

| 环境 | 命令 | 说明 |
| --- | --- | --- |
| dev（应用内表） | `npm run db:push`（`packages/main/scripts/db-push.mjs` → `prisma db push` + `prisma generate`） | 快速同步 schema，无迁移文件 |
| dev（验证迁移） | `npm run db:migrate:dev`（`prisma migrate dev`） | 产生迁移文件 |
| CI / prod（应用内表） | `npm run db:migrate:deploy`（`prisma migrate deploy`） | **迁移文件是应用内表 DDL 的 SSoT** |
| **DB 边界（schema/role/grant/view/chat 表）** | `db/sql/*.sql`（`db/sql/apply-validate.sh`） | **由用户在 prod 手工执行**（见 10 §6），是跨服务库边界的 SSoT |

`package.json` 关键脚本（`packages/main`）：

```jsonc
{
  "db:generate": "prisma generate",
  "db:push": "node scripts/db-push.mjs",   // prisma db push + generate（dev）
  "db:migrate:dev": "prisma migrate dev",
  "db:migrate:deploy": "prisma migrate deploy",
  "db:seed": "tsx prisma/seed.ts",
  "db:studio": "prisma studio"
}
```

**性能索引**（如 `pg_trgm`）放进迁移 SQL：

```sql
-- packages/main/prisma/migrations/xxxx_search_indexes/migration.sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX characters_name_trgm ON characters USING gin (name gin_trgm_ops);
```

## 6. Seed 计划（`packages/main/prisma/seed.ts`）

幂等 upsert，dev 与 preview 可重复跑：

1. **Tags**：从 `src/lib/ourdream-data.ts` 的 `categoryFilters` 导入（含 `isSensitive`/`isMutedByDefault` 标记，如 BDSM/Teen 等需正确标注语义为 18+ young adult）。
2. **Characters**：从 `characterCards`（28 个）导入为 `approved`+`public`，`age` 解析为 Int（强制 ≥18），display 计数（"2.2k"/"2.2M"）解析进 `character_stats`，建一个系统 creator 用户。
3. **Plans**：Premium/Deluxe × Monthly/Yearly，价格与权益按 `ProductFeatureMap §5.5`（Premium $19.99/$9.99yr，Deluxe $59.99/$29.99yr，dreamcoins/images/videos/voice 额度）。
4. **GenerationPreset（built_in）**：background/pose/outfit/mode 各若干内置 preset。
5. **PolicyVersion**：从 `packages/main/src/lib/ourdream-safety-data.ts` 导入镜像政策。
6. **RoutePage**：从既有 164 条静态路由导入 path/template/title/description。
7. **Dev 账号**：一个 `admin`、一个普通 `user`（带 signup_bonus ledger 条目）。

> Seed 把现有静态数据"接管"为后台数据源，是 P0 里程碑 M2 的关键一步（见 12）。

## 7. 与 BackendFeatureSpec 的差异/补充

- 队列状态在 Redis/BullMQ（ADR-5），关系库只存权威业务态 + 幂等记录；新增基础设施表：`ProviderEvent`、`AnalyticsEvent`、`RoutePage`、`CharacterLike`、`Follow`，spec 未显式列出但实现必需。
- chat 域已外迁到 Chat Service（`packages/chat`，独立 `chat` schema + 视图）；main 仅保留 `RecentChat` read projection。`companion_memories`/`relationship_states` 已**不再是表**，迁到 chat 文件层（§3.4）。
- 新增 Admin 控制平面表（§3.10）：审计/审批/特性开关/应用设置/生成模型·prompt·路由·定价的可治理配置/权限/支持授权/法务保留。
- `Character.source`（official|user）区分官方 CMS 角色与用户角色；新增 `CharacterTemplate`（建角色起步模板）。
- `MediaAsset.liked` 保留为拥有者快捷标记，多用户点赞用 `MediaLike`。
- 余额不在 `User` 上存字段，**强制走 `DreamcoinLedger` 派生**（08 §4）。
- 认证表采用 better-auth 形态（`Account.password` 存哈希），替代 spec 里 `users.password_hash` / `sessions.token_hash` 的手写设想（ADR-3）。
