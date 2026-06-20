# 12 · 实施路线图

更新日期：2026-06-13

对齐 `BackendFeatureSpec §8 P0 顺序` 与 `PRD §12 MVP`。每个里程碑给**可验证交付物**与**退出标准**（闭环优先：写完就跑、CLI 验证）。

## 里程碑总览

```
M0 地基 → M1 鉴权+合规 → M2 目录+Explore → M3 角色详情+举报骨架
→ M4 创建器 → M5 聊天 → M6 图片生成+图库 → M7 计费+dreamcoin
→ M8 My AI → M9 审核后台 → M10 Profile → ── MVP 完成 ──
→ V1.1: 视频 / Feed / Community / 高级生成 / 内容运营
```

---

## M0 · 工程地基（无业务）
**交付**：Prisma 接入（双库脚本 03 §7）、`schema.prisma` 初版、`prisma.config.ts`、`lib/{db,env,errors,http,logger,constants}`、`providers` 骨架 + mock、`jobs/queue` 骨架、Vitest/Playwright 接入、CI 双库流水线、`.env.example`、eslint 边界规则。
**退出**：`npm run db:push`（SQLite）+ `db:seed` 成功；`npm run check` 绿；CI 双库测试空跑通过。

## M1 · 鉴权 + 年龄合规（spec P0 #1–2）
**交付**：better-auth 接入（user/session/account）、`GET /me` 聚合、`proxy.ts`（安全头 + age-gate 乐观重定向 + anonymousId）、age gate accept、匿名合并。
> **范围调整**：第三方**身份年龄验证（age verification, ADR-7）暂缓**——保留 `age_verifications` 表与 `requireAgeVerified` 守卫（默认 `not_required` 直通），不接 provider（见文末暂缓项）。简单 18+ age gate 仍做。
**退出**：注册/登录/登出闭环；未过 age gate 被乐观拦截 + 服务端 `requireAgeGate` 403；`/me` 反映 age/verification 状态。E2E 流 1–2。

## M2 · 角色目录 + Explore API（spec P0 #3）
**交付**：catalog schema + seed 导入 `characterCards`(28)/`categoryFilters`/plans/policy/route_pages（03 §6）、`GET /characters`（搜索/筛选/排序/cursor，双库 `nameMatch`）、`GET /tags`、`search/suggest`、like、缓存 + tag 失效。
**退出**：Explore 列表用真实 DB 数据、四种排序、筛选、分页可用；双库搜索测试通过。把现有静态首页接到该 API。

## M3 · 角色详情 + 举报入口（spec P0 #4）
**交付**：`GET /characters/:id`（DTO 不泄漏内部字段）、views 异步自增、`POST /characters/:id/report`、`reports` + `report.triage` 队列骨架、`moderation_events` 写入。
**退出**：详情页可用；举报落库进队列；举报人匿名。E2E 流 1（含详情）。

## M4 · 角色创建器（spec P0 #5）
**交付**：多步 `character-drafts` 保存、tag 管理、`character.preview` 队列 + image worker(mock)、`submit`（创建前校验 07 §3 + 输入审核 + 状态机 §4.1）、保存到 My AI、私有/公开。
**退出**：草稿→预览→提交→My AI 可见；age<18/禁内容被拒。E2E 流 4。

## M5 · 聊天（spec P0 #6）
**交付**：Chat Service 拥有 `chat/sessions` + `messages`、输入审核、内部 `chat.generate` worker + `ChatModel`(mock 流式)、输出审核、message versions/regenerate、memory summary、`chat_usage` 额度、SSE、chat outbox。
**退出**：发消息→流式回复→刷新历史在；免费额度限制生效；拦截消息返回安全错误且保留会话。E2E 流 3。

## M6 · 图片生成 + 图库（spec P0 #7）
**交付**：`generation/jobs`（dreamcoin reserve 06 §6）、`generation.image` worker(mock)、输入/输出审核、`BlobStore`(私有签名)、`MediaAsset`、`GET /media`、like/bulk/download/delete、presets（built-in seed + user）。
**退出**：选角色/Freeplay+preset→生成→完成媒体进 Images；失败退款；签名 URL 访问。E2E 流 5。

## M7 · 计费 + 权益 + dreamcoin（spec P0 #8）
**交付**：`plans`、`PaymentProvider` 抽象 + **mock 支付 provider**、checkout、`billing.webhook`/IPN（验签 + 幂等 08 §3）、subscriptions、entitlements 派生、dreamcoin ledger（reserve/settle/refund/grant）、`reward.ledger`。
> **范围调整**：**真实加密支付暂缓**（ADR-4 方向不变）。MVP 用 **mock 支付 provider**：模拟 createInvoice + 触发"已确认"IPN，把 checkout→IPN→entitlement→ledger 与计费逻辑跑通、可测；真实 BTCPay/处理器接入留 TODO（见文末暂缓项）。
**退出**：mock 发票→mock IPN 确认→entitlement 生效→生成可扣 coin；余额由 ledger 重算；Premium 门服务端强制。E2E 流 6（mock 支付）。

## M8 · My AI 库（spec P0 #9）
**交付**：`library/*` 聚合（recent/characters/created/presets/media；group-chats/packs 返回空态）。
**退出**：各 tab 真实内容；空态 Create CTA。

## M9 · 审核后台（spec P0 #10）
**交付**：`admin/moderation/queue`（按优先级，未成年=1 即时隐藏）、`admin/.../decision`（写 review + 改目标态 + 审计）、admin 鉴权、死信重放。
**退出**：举报/角色/消息/媒体能进队列并被处置；决定有 policyCode + 审计。E2E 流 7。

## M10 · Profile 基础（spec P0 #11）
**交付**：profile/preferences/language、redeem code、referral、account（sign-out-all/delete-request）、余额与订阅入口。
**退出**：偏好/语言保存；兑换/推荐发奖经 ledger 恰好一次；删号进流程。

## M-Analytics（贯穿，spec P0 #12，轻量）
**交付**：`events.track` + `analytics_events`，覆盖 PRD §9 事件；漏斗可 SQL 查询。
**退出**：关键事件可见（age gate/signup/chat/generation/checkout/report…）。

---

## ✅ MVP 完成判定（= PRD §12 MVP + spec §9 验收）
首访 age gate→explore/搜索/详情→注册→聊天（含历史）→创建（草稿/预览/提交/My AI）→图片生成（额度/dreamcoin/图库）→ upgrade（真实 sandbox 支付/权益/ledger）→ Safety/Report/Appeal 基础闭环。全程 `npm run check` 绿、L2/L3 双库通过、关键 E2E 通过、安全验收（07 §10）满足。

## V1.1（PRD §12 / spec P1）
视频生成 · Feed 的 Chat/Remix/Like/Share/Report · Community 榜单/创作者/collections · 高级 prompt 控制 · 生成资产下载/收藏/筛选/批量 · creator profile 公开发布 · profile referral/redeem/notification/language/account 完整 · 文章正文补齐与 SEO 内容运营。

## V2（PRD §13 / spec P2）
推荐算法与个性化（for_you/feed）· A/B 促销 · 多语言 · 高级 presets/packs/group chat 模板。

## ⚠️ 暂缓项（Deferred TODO，上线前必须补齐）

按当前决策，以下三项 **MVP 阶段用 mock / 占位推进**，但**在面向真实用户、承载真实内容上线前必须补齐**（合规与资金安全硬门）：

| TODO | MVP 现状 | 上线前必须 | 关联 |
| --- | --- | --- | --- |
| **真实支付** | mock 支付 provider 跑通计费链路 | 接真实加密处理器（BTCPay 等），testnet→mainnet | ADR-4 / 08 / M7 |
| **CSAM / 未成年检测 + NCMEC 上报** | 保留 moderation 接口/事件 + 角色 age≥18 硬规则 + 关键词 mock | 接专门 CSAM 哈希匹配（PhotoDNA/NCMEC）+ 分类器 + 法律上报 runbook（需法务） | 07 §3.2 |
| **第三方身份年龄验证** | 保留表/守卫，默认 `not_required` 直通 | 接 provider（Go.cam 等），按辖区触发 | ADR-7 / 07 §2.3 |

> 原则：**不删除、不弱化设计**——接口、数据表、守卫、moderation 事件、age 硬规则照常实现，只把"外部供应商对接 + 真实检测/扣款"留作开关、用 mock 顶上。保证后续接真实实现时**业务层零改动**，只换 provider + 打开门控。**面向公众上线前，本表必须清零。**

## 技术债（显式记录）
- **双库差异税**：长期建议本地切 Docker Postgres（保留 SQLite 作零依赖起步档），消除搜索/并发差异（ADR-2 权衡）。
- **队列升级**：规模上来把 `JobQueue` 从 DB 换 QStash/Vercel Queues（接口不变，ADR-5）。
- **供应商**：支付=加密货币（ADR-4，选 BTCPay/处理器并接 testnet）、AI=自托管开源模型流水线（ADR-6，需 GPU/推理集群就绪）方向已定；**仍待**：年龄验证 provider（ADR-7）、CSAM 检测+NCMEC 上报服务与法律 runbook（07 §3.2）。
- **CSAM 上报 runbook** 需法务确认具体义务与责任人（07 §3.2）。
