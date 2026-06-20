# 03 · 数据模型与 Prisma Schema

更新日期：2026-06-13

本文件把 `BackendFeatureSpec.md §3` 的实体表落地为**可在 SQLite(dev) 与 PostgreSQL(prod) 同时运行**的完整 Prisma schema，并给出双库兼容规则、索引、迁移与 seed 策略。**schema 是数据形状的 SSoT。**

## 1. 设计约定

| 约定 | 规则 | 理由 |
| --- | --- | --- |
| 主键 | `String @id @default(cuid())` | 跨库一致、无自增差异、URL/日志友好、不可枚举 |
| 时间 | `createdAt DateTime @default(now())`，`updatedAt DateTime @updatedAt` | 双库支持 |
| 枚举 | **不用 `enum`**，用 `String` + `/// enum:` 注释 + Zod 校验 | SQLite 无 enum（见 §2） |
| 数组 | **不用 `String[]`**，用关联表（强关系）或 `Json`（无需查询的集合） | SQLite 无标量数组 |
| 复杂结构 | `Json`（appearance、controls、features、metadata…） | 双库支持；SQLite 以字符串存 |
| 金额 | `Int`（分/coins，整数） | 避免 Decimal 跨库差异 |
| 计数 | `Int`（派生/缓存计数另见 stats 表） | — |
| 命名 | model PascalCase 单数；表名用 `@@map("snake_case")` 对齐 spec | spec 用 snake_case 表名 |
| 软删除 | 关键实体加 `deletedAt DateTime?` | 审计/可恢复 |
| 钱/额度 | **派生自 ledger/usage，绝不就地覆盖余额** | 见 08 §4 |

> `/// enum:` 是文档注释；真正的取值约束在 `*.schema.ts` 的 Zod（见 04 §4），数据库不强制。所有 enum 取值的权威列表也维护在 `src/server/lib/constants.ts`（SSoT）。

## 2. 双库兼容规则（必读，违反即 dev/prod 行为分裂）

| 特性 | SQLite | Postgres | 我们的做法 |
| --- | --- | --- | --- |
| `enum` | ❌ | ✅ | 一律 `String`（§1） |
| 标量数组 `T[]` | ❌ | ✅ | 关联表 / `Json` |
| `Json` 类型 | ✅(存为 text) | ✅(jsonb) | 用 `Json`；**不做 DB 内 JSON 查询**，读出来在应用层处理 |
| `@db.*` native type | ❌ | ✅ | 不使用 |
| 大小写不敏感 `mode:'insensitive'` | ❌ | ✅ | 见下"搜索策略" |
| 全文检索 / `pg_trgm` | ❌ | ✅ | **仅 prod 迁移里加**，不进 schema |
| `@@index`/`@@unique`/复合键 | ✅ | ✅ | 正常用 |
| `FOR UPDATE SKIP LOCKED` | ❌ | ✅ | 队列认领：prod raw SQL，dev 用简单事务（见 06） |
| 事务 `$transaction` | ✅ | ✅ | 正常用 |
| `cuid()`/`uuid()` 默认值 | ✅ | ✅ | 用 `cuid()` |

**搜索策略（差异最大处，显式处理）**：

- **dev（SQLite）**：`WHERE name LIKE '%q%'`（SQLite `LIKE` 对 ASCII 默认大小写不敏感）。
- **prod（Postgres）**：基础同样可用 `contains`；为性能在 **prod 迁移**里加 `pg_trgm` 扩展 + `GIN (name gin_trgm_ops)` 索引，并在 repository 用一个 **provider 感知的搜索方法**（`lib/db/search.ts` 暴露 `nameMatch(q)`，按 `DB_PROVIDER` 选实现）。
- 这样可移植 schema 不含 Postgres-only 语法，dev/prod 行为差异被收敛到一个文件，并在 11-testing 里两库都测。

**provider 切换机制**（`scripts/db-provider.mjs`，见 §7）：唯一被改写的就是 `datasource db { provider = ... }` 这一行。

## 3. 完整 Schema

> 下面是 `prisma/schema.prisma` 的设计稿。按模块分块（实际文件可用 Prisma 多文件特性 `prisma/schema/*.prisma` 拆分，便于多人协作）。

### 3.0 头部 + 生成器 + 数据源

```prisma
// prisma/schema.prisma
// 形状 SSoT。datasource.provider 由 scripts/db-provider.mjs 按 DB_PROVIDER 改写。
// url 由 prisma.config.ts 的 env('DATABASE_URL') 注入。
// 只用 SQLite+Postgres 双方都支持的特性（见 docs/architecture/03 §2）。

generator client {
  provider = "prisma-client-js"   // Prisma 7 亦可用新 "prisma-client" 生成器，迁移见 03 §7
}

datasource db {
  provider = "postgresql"          // ← prod 默认（SSoT）；dev 由脚本改为 "sqlite"
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
  chatSessions  ChatSession[]
  generationJobs GenerationJob[]
  likes         CharacterLike[]

  @@index([visibility, status])
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
```

### 3.4 Chat

> 目标归属：以下 chat 表由 Chat Service 权威拥有。当前主站 Prisma schema 中保留这些模型，是为了单仓/同库过渡和本地测试；迁移完成后，主站只能通过 Chat API / outbox / read model 使用这些数据，不直接写 `chat_sessions`、`messages`、`companion_memories`、`relationship_states`。
>
> Chat Service 可以只读主站 `User`、`Character`、`Entitlement`、`AgeVerification` 的最小 view，但不写这些主站权威表。

```prisma
model ChatSession {
  id            String    @id @default(cuid())
  userId        String
  characterId   String
  title         String?
  status        String    @default("active")     /// enum: active | archived | deleted
  memorySummary String?                            // 滚动上下文摘要
  lastMessageAt DateTime?
  createdAt     DateTime  @default(now())
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  character     Character @relation(fields: [characterId], references: [id], onDelete: Cascade)
  messages      Message[]
  @@index([userId, lastMessageAt])
  @@index([characterId])
  @@map("chat_sessions")
}

model Message {
  id           String    @id @default(cuid())
  sessionId    String
  role         String                              /// enum: user | assistant | system | tool
  content      String
  model        String?
  status       String    @default("pending")      /// enum: pending|moderating_input|blocked|generating|moderating_output|sent|failed|deleted
  tokenCount   Int?
  safetyStatus String    @default("unknown")       /// enum: unknown|passed|flagged|blocked
  createdAt    DateTime  @default(now())
  session      ChatSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  versions     MessageVersion[]
  @@index([sessionId, createdAt])
  @@map("messages")
}

model MessageVersion {
  id        String   @id @default(cuid())
  messageId String
  content   String
  model     String?
  selected  Boolean  @default(false)
  createdAt DateTime @default(now())
  message   Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  @@index([messageId])
  @@map("message_versions")
}

model ChatUsage {
  id          String   @id @default(cuid())
  userId      String
  sessionId   String?
  messagesUsed Int     @default(0)
  periodStart DateTime
  periodEnd   DateTime
  @@unique([userId, periodStart])
  @@index([userId])
  @@map("chat_usage")
}
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

## 4. 索引策略

- **Explore 列表**：`characters(visibility,status)`、`(gender,style)`、`(createdAt)`、`character_stats(likesCount)`/`(chatsCount)` 支撑排序（For You/Popular/Newest）。
- **聊天历史**：`chat_sessions(userId,lastMessageAt)`、`messages(sessionId,createdAt)`。
- **图库**：`media_assets(ownerId,type,createdAt)`。
- **队列**：`jobs(status,queue,nextRunAt)`（认领扫描）。
- **审核队列**：`content_reports(status,priority)`。
- **幂等**：`provider_events(provider,providerEventId)` 唯一。
- **prod 专属**（迁移里加，不进 schema）：`pg_trgm` GIN on `characters.name`/`description`；`tags`/`character_tags` 视情况；`analytics_events` 按时间分区（量大时）。

## 5. 迁移工作流

| 环境 | DB | 命令 | 迁移文件 |
| --- | --- | --- | --- |
| dev | SQLite | `npm run db:push`（`db-provider sqlite && prisma db push`） | 不产生，库可删档重建 + `db:seed` |
| dev（验证 prod 迁移） | Docker Postgres | `npm run db:migrate:dev` | 产生迁移文件 |
| CI / prod | Postgres | `npm run db:migrate:deploy`（`prisma migrate deploy`） | **迁移文件是 prod DDL 的 SSoT** |

**Postgres-only 性能迁移**：在生成的迁移目录里手工追加（或单独 migration）原生 SQL，例如：

```sql
-- prisma/migrations/xxxx_search_indexes/migration.sql （仅 Postgres）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX characters_name_trgm ON characters USING gin (name gin_trgm_ops);
```

这些**不会**出现在 SQLite 流程（dev 用 `db push` 跳过 migrations）。

`package.json` scripts（建议）：

```jsonc
{
  "db:provider": "node scripts/db-provider.mjs",     // 按 DB_PROVIDER 改写 datasource
  "db:generate": "npm run db:provider && prisma generate",
  "db:push":     "DB_PROVIDER=sqlite npm run db:provider && prisma db push",
  "db:migrate:dev":    "DB_PROVIDER=postgresql npm run db:provider && prisma migrate dev",
  "db:migrate:deploy": "DB_PROVIDER=postgresql npm run db:provider && prisma migrate deploy",
  "db:seed": "tsx prisma/seed.ts",
  "db:studio": "prisma studio"
}
```

## 6. Seed 计划（`prisma/seed.ts`）

幂等 upsert，dev 与 preview 可重复跑：

1. **Tags**：从 `src/lib/ourdream-data.ts` 的 `categoryFilters` 导入（含 `isSensitive`/`isMutedByDefault` 标记，如 BDSM/Teen 等需正确标注语义为 18+ young adult）。
2. **Characters**：从 `characterCards`（28 个）导入为 `approved`+`public`，`age` 解析为 Int（强制 ≥18），display 计数（"2.2k"/"2.2M"）解析进 `character_stats`，建一个系统 creator 用户。
3. **Plans**：Premium/Deluxe × Monthly/Yearly，价格与权益按 `ProductFeatureMap §5.5`（Premium $19.99/$9.99yr，Deluxe $59.99/$29.99yr，dreamcoins/images/videos/voice 额度）。
4. **GenerationPreset（built_in）**：background/pose/outfit/mode 各若干内置 preset。
5. **PolicyVersion**：从 `docs/research/ourdream-safety-docs.json` 与 `src/lib/ourdream-safety-data.ts` 导入镜像政策。
6. **RoutePage**：从既有 164 条静态路由导入 path/template/title/description。
7. **Dev 账号**：一个 `admin`、一个普通 `user`（带 signup_bonus ledger 条目）。

> Seed 把现有静态数据"接管"为后台数据源，是 P0 里程碑 M2 的关键一步（见 12）。

## 7. provider 切换脚本（`scripts/db-provider.mjs`）

思路：读 `prisma/schema.prisma`，把 `datasource db { ... provider = "..." }` 那一行按 `DB_PROVIDER` 替换，幂等可重入。

```js
// scripts/db-provider.mjs
// SPEC: 按 DB_PROVIDER(sqlite|postgresql) 改写 schema 的 datasource.provider 行
// INTENT: 用一行替换支撑"单 schema 双库"，不维护两份 schema
// INVARIANTS: 只改 provider 行，其余字节不动；默认 postgresql（prod SSoT）
import { readFileSync, writeFileSync } from "node:fs";

const provider = process.env.DB_PROVIDER ?? "postgresql";
if (!["sqlite", "postgresql"].includes(provider)) {
  throw new Error(`Invalid DB_PROVIDER: ${provider}`);
}
const file = "prisma/schema.prisma";
const src = readFileSync(file, "utf8");
const next = src.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"(sqlite|postgresql)"/s,
  `$1"${provider}"`,
);
if (next !== src) writeFileSync(file, next);
console.log(`[db-provider] datasource.provider = ${provider}`);
```

> 注：Prisma 7 也可改用新的 `prisma-client` 生成器与 `prisma.config.ts`。本设计与生成器无关，切换只需改 `generator client { provider = "prisma-client" output = "../src/generated/prisma" }` 并调整 import 路径，不影响数据建模。

## 8. 与 BackendFeatureSpec 的差异/补充

- 新增基础设施表：`Job`、`ProviderEvent`、`AnalyticsEvent`、`RoutePage`、`CharacterLike`、`Follow`，spec 未显式列出但实现必需。
- `MediaAsset.liked` 保留为拥有者快捷标记，多用户点赞用 `MediaLike`（spec 二者都暗示）。
- 余额不在 `User` 上存字段，**强制走 `DreamcoinLedger` 派生**（08 §4）。
- 认证表采用 better-auth 形态（`Account.password` 存哈希），替代 spec 里 `users.password_hash` / `sessions.token_hash` 的手写设想（ADR-3）。
