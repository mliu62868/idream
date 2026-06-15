# 07 · 安全与合规

更新日期：2026-06-13

这是一个 **18+ 成人 AI 产品**。本文件的多数条目是**法律 / 平台政策强制**，不是可选优化。对齐 `BackendFeatureSpec §3.6/§4.4` 与 `PRD §6.1/§6.9`。

> ⚠️ 法律免责：本文档给出工程实现框架，不构成法律意见。CSAM/年龄验证/数据保护的具体义务因司法辖区而异，**上线前必须经法务确认**。

## 1. 认证（AuthN）

- 委托 **better-auth**（ADR-3）：email+password、session（DB-backed、httpOnly+Secure+SameSite cookie）、密码哈希（scrypt/argon2）、邮箱验证、登录限流。
- session 校验在 service 层 `getAuthCtx()`（04 §6），**不在 proxy**（Next 16 官方明确 proxy 不做完整鉴权，01 §5）。
- 敏感操作（改密、删号、登出全部）二次确认；`sign-out-all` 吊销全部 session。
- 不自己实现 crypto；密钥见 §5。

## 2. 授权（AuthZ）+ 年龄合规门控

### 2.1 授权
`BackendFeatureSpec §6 授权矩阵`落地为 04 §6 的 guards（`requireUser/Admin/Owner/Entitlement/AgeGate/AgeVerified`）。原则：**资源载入后判 ownership**；**Premium 服务端判 entitlement**；**客户端 plan 不可信**。

### 2.2 年龄门槛（age gate）
- 首次访问成人内容前必须确认 18+（AG-01）。接受写 `age_gate_acceptances` + cookie（AG-02）。
- proxy 做**乐观重定向**：无 age-gate cookie → 重定向到确认页（不是最终鉴权，真正校验在 service `requireAgeGate`）。
- 未确认不得见成人角色/生成器/聊天（AG-03）。门槛链接 Terms（AG-04）。

### 2.3 身份年龄验证（age verification）
> **实现状态**：**暂缓** TODO（见 12 暂缓项）。MVP 保留 `age_verifications` 表与 `requireAgeVerified` 守卫（默认 `not_required` 直通），不接 provider。
- 按 `jurisdiction` + 风险触发第三方身份验证（AG-05），与 age gate **分开存储**（`age_verifications`）。provider 抽象（ADR-7，安全文档点名 **Go.cam**）。
- 受限辖区（如 UK Online Safety Act、美国多州、EU 部分）未验证 → `requireAgeVerified` 阻断 chat/generate/create/explicit 内容。
- webhook 幂等更新；`expires_at` 到期复验。

## 3. 内容审核流水线（P0，安全核心）

**五层**（对齐 spec moderation layers）：

| 层 | 时机 | 实现 |
| --- | --- | --- |
| `input` | 用户输入（聊天消息、生成 prompt、角色设定/草稿）进模型/provider **之前** | `Moderation.checkText` 同步快路径 + 异步深检 |
| `output` | 模型产物（assistant 文本、生成图/视频）释放**之前** | `Moderation.checkText/checkImage`；**未释放不展示** |
| `metadata_behavior` | 行为信号（频次、规避模式、批量） | 风控规则 + 限流 |
| `human_review` | 举报/高危/申诉 | admin 队列（05 §15） |
| `community_report` | 用户举报 | `content_reports` → `report.triage` |

每次判定写 `moderation_events`（target/layer/status/policyCode/confidence），**不可变留证**。

### 3.1 绝对禁止内容（命中即拦截 + 留证 + 按法律上报）
对齐 `PRD §6.2/SF-05`、safety docs：

1. **未成年 / 未成年外观（CSAM）**：最高优先级。角色 `age >= 18` 强制；"Teen" 等分类语义必须是 **18+ young adult**，禁止任何未成年或未成年外观内容。
2. **真实人物深度伪造（deepfake）/ 真实人物肖像**。
3. **受版权 IP / 名人肖像**。
4. **非自愿（non-consent）框架**。
5. **违法内容**。
6. **规避尝试（evasion）**：拼写变体、绕过提示词等。

### 3.2 CSAM 专项（法律强制，最高优先级）
> **实现状态（2026-06-13）**：真实检测/上报**暂缓**为 TODO（见 12 暂缓项）。MVP 保留接口、moderation 事件、角色 age≥18 硬规则与关键词 mock；**面向公众上线前必须补齐真实检测 + NCMEC 上报**。设计不弱化。
- **检测**：图像走 **哈希匹配（PhotoDNA/NCMEC 已知 CSAM 哈希）** + 专用未成年分类器；文本走未成年情境分类。
- **生成与审核 provider 分离**（ADR-6）：生成可用 NSFW 托管，但 CSAM 检测用最强安全服务，独立密钥。
- **命中处置**：立即拦截、保全证据（不可删）、冻结相关账户、**按法律向 NCMEC 等机构上报**（美国 18 U.S.C. §2258A 等义务，按辖区）。建立内部上报 runbook 与责任人。
- 这条**不可因 MVP 简化而跳过**。即使用 mock provider，未成年硬规则（年龄字段、关键词）也必须生效。

### 3.3 创建前校验（CR-09）
角色 submit 时校验：年龄≥18、禁止内容、真实人物、现有 IP、非自愿、规避。未过 → `rejected` + policyCode，可改后重交（状态机 spec §4.1）。

## 4. 政策码（policyCode）表

稳定机器码，贯穿 `moderation_events`/`moderation_reviews`/拦截错误 `CONTENT_BLOCKED.details.policy`：

`UNDERAGE` · `CSAM_HASH_MATCH` · `DEEPFAKE` · `REAL_PERSON_LIKENESS` · `IP_INFRINGEMENT` · `NON_CONSENT` · `ILLEGAL` · `EVASION_ATTEMPT` · `PROHIBITED_OTHER` · `SELF_HARM` · `VIOLENCE_EXTREME`。

## 5. 举报与申诉

- `content_reports`（可匿名）→ `report.triage`（按 category 定 priority，**未成年=1 可即时隐藏目标**）→ admin 审核 `moderation_reviews`（decision+policyCode+审计）。
- 举报类别（safety docs）：`potential_underage_content` / `potential_deepfake_content` / `other_prohibited_content` / `incorrect_prohibited_content_flag` / `inaccurate_generation` / `other`。
- 申诉 `appeals`：对审核决定申诉，二次人工复核。
- **举报人身份不对被举报方披露**（spec §4.4，feed 同理）。
- 一切用户可见内容（角色/媒体/消息/feed）必须可举报且能进队列（01 §8 不变量 4）。

## 6. 隐私与数据保护

- **聊天默认私密**；敏感内容不进公开 feed（PRD §10）。
- **媒体私有 + 短时签名 URL**（ADR-8）。
- **删号**：`account/delete-request` → 宽限期 → 异步删除/匿名化个人数据（聊天、媒体、PII）；**审计/法律留证（CSAM 证据、ledger）按法律保留**，不随删号清除。
- **AI 数据保留**：provider 抽象暴露保留/训练授权配置（ADR-6）；默认**不**把用户聊天/生成内容用于训练，除非显式同意；与 provider 的数据处理协议（DPA）落实。
- **PII 最小化**：日志不记明文密码/token/敏感内容；`ip`/`userAgent` 按需留存并设保留期。
- 合规框架按辖区：GDPR（EU）、CCPA（加州）、各成人内容法。

## 7. 政策内容（本地镜像 vs 外链）

ADR-10 对照决策：

- 权威政策源仍是 `safety.ourdream.ai`（外链）。
- 关键政策正文**版本化镜像**进 `policy_versions`（slug+version+body），供 Safety Center 本地页、age gate、举报流引用，保证产品内可读且可追溯版本。
- 16 个 `/safety/*` 镜像路由（已存在）由 seo 模块从 `policy_versions` 渲染。

## 8. 应用安全（Web）

- **输入校验**：系统边界全 Zod（04 §4）；不信任何外部数据（API/用户/provider 回调）。
- **注入**：Prisma 参数化天然防 SQLi；raw SQL（队列/搜索）必须参数化。
- **XSS**：用户内容渲染默认转义；富文本经 sanitize。
- **CSRF**：状态变更用 SameSite cookie + better-auth CSRF 防护；webhook 用验签而非 cookie。
- **SSRF**：provider/图片 URL 拉取走白名单 + 禁内网地址。
- **限流**：auth/搜索/聊天/生成/举报/验证全限流（04 §7，ADR-9）。
- **安全响应头/CSP**（proxy 统一加）：`Content-Security-Policy`、`Strict-Transport-Security`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`；媒体走独立私有域。
- **审计日志**：审核决定、申诉、ledger、provider 事件、role 变更、删号——不可变、带时间与操作者。

## 9. 密钥管理

- 一律环境变量 / secret manager，**绝不硬编码**（见 typescript/security 规则）。
- env 启动时 Zod 校验存在性（10 §2）；缺失即 fail-fast。
- 分环境密钥；provider 密钥分离（生成 vs 审核 vs 支付 vs 存储）。
- 疑似泄漏立即轮换；webhook 签名密钥、INTERNAL_TOKEN、CRON_SECRET 定期轮换。

## 10. 安全验收（P0，对齐 spec §9）

- [ ] 首访必过 age gate 才见成人内容 / 用 Create·Generate·Chat。
- [ ] 受限辖区需身份验证通过才能用受限路由。
- [ ] 未成年/真人肖像/深伪/禁内容/规避命中都产生 `moderation_events`。
- [ ] CSAM 检测 + 上报 runbook 就位（即便其余 MVP 简化）。
- [ ] 角色 age 强制 ≥18。
- [ ] 所有用户内容可举报、进队列、可处置；举报人匿名。
- [ ] Premium 门服务端 entitlement 强制；客户端 plan 不可信。
- [ ] 聊天私密；媒体私有签名访问；删号清 PII 留法律证据。
- [ ] 密钥无硬编码，env 启动校验。
