# iDream 全产品 Chrome 上线审计

审计日期：2026-08-11，最终复核 2026-08-14
范围：Main、Admin、Chat、Image/Video/Voice、Create、Release、Community、Profile、Help/Case、运行编排与 Launch Gate；按本轮用户指令，支付、年龄验证和合规不参与结论  
浏览器：用户指定的 Chrome；真实登录态、真实本地模型与产品数据库

## 结论

**当前结论：NO-GO，不能签发公开上线。**

本轮已把本地核心产品从“页面可点”推进到真实用户、运营与服务闭环证据：注册、公开发现、SSE Chat、真实 RedMix3 图片、真实 LTX Video、Gallery、Demo Upgrade、四张 Create Preview、审核、三槽 Release 素材、Soul、QA、Release/Serving、公开消费、Community Follow、Support/Report/Appeal 及 Admin Ops 都有 Chrome 或不可变运行证据。最初的 8 个 Gen orphan 与历史 Video residue 已按受控流程收口；当前 Image/Video worker ownership、generation cutover、Chat readiness 与 fresh service/model probe 都为绿色。

仍然阻断上线的是明确的权威边界，而不是“再点几页”：

1. 本地 runtime 数据库已从 **67/71** 受控迁移到 PostgreSQL 16 **71/71**；迁移前有 checksummed Main PostgreSQL + Chat FS + Blob snapshot，迁移后 exact catalog authority、fresh/upgrade/redeploy/rollback rehearsal 均通过。
2. Product Config 已通过：legacy Premium v1 archived，两个 RedMix3 v2 profile active，并与真实 RedMix3 provider probe 和 Main persistence evidence 对齐。
3. 最新 Gate `.tmp/check-launch-2026-08-14-final-user-journeys.json` 为 **44 pass / 23 fail / 0 warn / 67 total**，scope 为 `core`，支付与年龄验证不参与结论。JSON 自带 `generatedAt`、expected source revision、probe evidence digest 与脱敏 environment digest。Gate resolver 分别绑定 Main、Admin、Chat、Gen env，检查 APP_ENV、internal/BFF authority、BullMQ prefix 与 source revision 等值，并禁止 Chat/Gen 从 Main 或 ambient process 回退。四运行时以及 Chat/Image/Video/Voice/Admin-text/Persistence probes 已统一绑定最终 worktree revision；四包 Sentry probes 也以同一 revision 记录当前无外部凭据时的明确失败，所以 source-revision authority 通过。Main migration 71/71、Main→Chat backlog 0、Generation cutover 与 Image 2/2/Video 1/1 ownership 绿色；23 个失败项均为 public HTTPS、生产 secrets/Redis/prefix、non-mock Blob 与 Sentry production-envelope 检查。
4. 原有 48 条 `chat.image.failed` target-missing durable event 已闭合。处置前只读对账为 48 failed / 0 Chat receipt / 0 attachment target / 0 source outbox / 0 replayable；Chrome 通过双权限、Idempotency-Key、reason、exact confirmation 和 CAS snapshot 批量执行 `Record target missing`，结果为 `discarded_target_missing: 48`。处置后只读审计为 failed `0`，Chat terminal receipt `48`，Main audit `48`；没有 replay，也没有伪造用户效果。
5. Account Deletion 的历史 Chrome P2021/500 发生在迁移前且事务安全回滚。当前 revision 的 run-owned Playwright destructive browser canary 已完成；随后用户明确授权删除专用一次性客户，真实 Chrome 在当前产品 runtime 提交 DELETE 并跳转到带 `accountDeletionGraceEndsAt` 的登录页，重新登录得到 `Account is not active`。原 30 天 grace 事实保留；仅该 actor 的 AccountDeletion 与 request Outbox 在一个精确 CAS 事务内推进到期，真实 Main→Chat HTTP、Chat PG/FS 清除、request-bound completion、2 条 Blob receipt 与 Main hard-delete 全部终态。匿名 AccountDeletion receipt 保留，用户、媒体、订阅、权益、请求 Outbox 与两段 Voice WAV 均被清除，未触碰其他用户数据。
6. 当前本地 Recovery 已真实完成：权威 bundle 为 `.tmp/recovery-bundles/idream-recovery-local-20260814-final-user-journeys`；完成时间、master manifest digest 与 source authority 由 checksummed bundle 和结构化 Gate JSON 机器校验，tracked 审计不复制一次性 digest。PostgreSQL 16 migration 71/71 isolated restore、Chat FS、local mock Blob、DB/queue authority 全部 exact。维护窗只阻断 in-flight，稳定 durable backlog原样保留并逐项相等。该项已通过本地 Gate；仍需补的是 production non-mock Blob 与 Sentry 四 runtime canary 等 production envelope，不是再伪造一个本地恢复文件。

因此本报告证明的是：**代码、同一 source revision 的运行 probes、Voice/Account Deletion 当前 Chrome 证据与历史编号旅程覆盖本地核心产品、运营、Chat 服务与三权威 Recovery，迁移与历史 backlog 已收口；但完整 authenticated Chrome 编号旅程尚未作为一套在最终 revision 上重跑，23 个 production-envelope 检查仍使公开上线保持 NO-GO。**

## 编号用户旅程

### 1. 首访、年龄门与 Explore — 本地闭环

未登录 Explore 可浏览目录；受保护 API 在未接受年龄门时明确返回 `age_gate_required`。注册后 Explore、搜索、筛选和角色详情可用。

![首访 Explore](./01-explore-signed-out.png)

![登录后 Explore](./05-explore-signed-in.png)

![搜索 Alexa](./07-explore-search-alexa.png)

### 2. 注册、登录与回到原任务 — 修复后闭环

Chrome 首次注册暴露了 auth partial-commit：核心账号/Session 已提交，analytics 失败却返回 500。修复后 signup 的账号、匿名归属与 canonical evidence 在同一事务；非关键 telemetry 不再把成功翻成失败；login/age-gate 同样不被 telemetry 阻断；8 路同邮箱并发收敛为 1×200 + 7×409。

![修复前注册失败](./04-signup-internal-error.png)

![修复后注册成功](./06-signup-success.png)

### 3. Chat SSE、截断与刷新 — 本地真实模型闭环

Alexa 与 Mara 都完成用户消息→SSE partial→terminal reply→刷新持久化。`finish_reason=length` 不再被冒充 done；生成中 partial 文本保持 typing，Play/Regenerate 只在终态出现。

2026-08-12 Chat boundary 恢复后又以用户指定的真实 Chrome 重跑 Alexa：从角色页进入新会话，opening message 首屏可见；发送唯一验收消息后先出现 `Assistant is typing`，终态前 Send 与消息动作保持禁用/隐藏，真实模型返回两句中文后 Play/Regenerate 才出现；刷新同一 session 后用户消息与 assistant reply 均持久。Chrome 网络证据中 document、session、relationship、voice 均为 HTTP 200，console warning/error 为 0。证据汇总及截图位于 `.tmp/chrome-launch-evidence-2026-08-12/`。

最终 readiness 权限/新鲜度门禁加载并重启 Chat 后，同一 Chrome session 再发送「请用一句话确认顶层甲板之后，你会带我去哪里」；页面先显示 typing 且禁用 Send，随后真实模型返回「主舱。我想看看是谁在酒醒之前，谁在酒精之后。」；刷新后该轮仍持久，Admin Chat Ops 仍显示 connected、0 failed delivery，两个页面新增 console warning/error 均为 0。该轮与最终 runtime artifact 已追加到同目录 `summary.json`。

时间边界：上述完整 authenticated 客户/Admin Chrome 旅程发生在最终后端补丁之前。补丁与 Recovery 重启后，当前 Chrome 复验 public character detail 的 1280 与 390×844 响应式状态、可见 Tab 焦点和 Chat CTA 的 401→signup 认证边界；Browser Back 的注入 `pageshow` 证据为 `persisted=true`，恢复后 `checking=false`、heading=`Mara Vale Launch`、`documentWidth=innerWidth=390`，无横向溢出。完整登录旅程没有再次执行；当前 signed Chat probe 是完整 authenticated runtime 证明，但不能冒充 Chrome。

![Alexa Chat 回复](./09-chat-reply.png)

![刷新后历史](./10-chat-reload-persisted.png)

### 4. 图片生成、Freeplay 与 Gallery — 本地真实 ComfyUI 闭环

Chrome 角色生成经历 queued→completed；Freeplay 有显式模型选择；Gallery 可浏览、Like、筛选、下载。新版独立 probe 真实执行 `redcraft-krea2-redmix3-txt2img`，生成 832×832 PNG，并写入不可变 Attempt/TerminalRecord，耗时 122.9 秒。

![图片排队](./12-generate-image-queued.png)

![图片完成](./15-generate-image-completed.png)

![Premium Freeplay 模型](./16-premium-freeplay-models.png)

![Gallery Like 筛选](./21-gallery-liked-filter.png)

历史缺陷已闭合：Premium v1 已归档，两个 executable RedMix3 v2 profile active；公开 selection/quote 继续拒绝缺 descriptor 的 ComfyUI profile。当前剩余边界是 production object storage / secrets / public deployment envelope，不再是该数据迁移。

### 5. Upgrade 与 Billing — Demo 闭环；本轮不参与上线判定

Chrome 完成 Demo Deluxe 激活、returnTo 和 Profile billing 展示；文案明确 prepaid、无自动续费。

![Demo Upgrade](./14-upgrade-demo-active.png)

![Profile Billing](./22-profile-billing.png)

支付终态按用户指令不在本轮验收范围内；这里仅保留已观察到的 Demo UI 事实。

### 6. Video — 本地真实 LTX 闭环

Deluxe 用户提交真实 I2V，作业完成后 Gallery 显示 MP4，并在 Chrome 中实际播放。独立 launch probe 也验证固定 LTX recipe、source SHA、Blob asset 与不可变 terminal record。

![Video 排队](./59-video-user-job-queued.jpg)

![Video 完成](./62-user-video-gallery-completed.jpg)

![Video 播放](./63-user-video-playing-3.jpg)

历史 failed Bull row未删除；operator acknowledgement 保留原 row，并由 cutover 每次重验精确 DB/ledger/transport/artifact 事实。当前 cutover `ok=true`、active/in-flight/pending terminal 均为 0，该 row 位于 `ignoredHistory`。

### 7. Create Preview — 四候选与响应丢失恢复闭环

旧实现 60 秒客户端 timeout 小于现场单 job 约 90 秒，造成 UI 假失败与重复扣费风险。修复后采用 12 分钟 batch deadline、AbortSignal、稳定 Idempotency-Key、刷新/离开恢复、逐张展示和响应丢失复用；Chrome 完成四张候选并提交审核。

![旧 Preview 假超时](./25-create-preview-timeout.png)

![恢复同一批次](./48-create-resumed-one-of-four.png)

![四张候选完成](./56-create-four-candidates-complete.jpg)

![提交审核](./57-create-submitted-for-review.jpg)

### 8. 客户角色审核与 publication preparation — 权威分层闭环

Mara 审核通过后曾仅为 approved，没有 Project/Release/Serving，owner 可见但公众不可见。修复没有放宽 public predicate，也没有伪造 Release：审批在同一事务幂等创建/补齐 Project、固定 Revision 与 inactive Serving；历史角色可通过受权限、reason、typed confirmation 的命令进入 Asset Studio。

![审核通过](./64-admin-character-review-approved.jpg)

![客户侧 awaiting publication](./71-my-ai-awaiting-publication.jpg)

![Publication workspace](./73-approved-character-publication-prep-assets.jpg)

### 9. 三槽资产、Soul、QA、Release 与 Serving — 真实运营闭环

Admin 分别真实生成、审核并选入 `character_cover`、`character_hero`、`character_chat` 三个独立槽位；Soul v2 固定 ContentVersion；QA 7/7；Release #1 经 propose→review→approve→validate→publish，Serving 最终为 live。

![Cover 审核](./74-mara-release-cover-review.jpg)

![Hero 审核](./75-mara-release-hero-review.jpg)

![Chat 槽审核](./76-mara-release-chat-review.jpg)

![三槽预览](./77-mara-launch-preview-three-slot-pack.jpg)

![QA 通过](./79-mara-launch-qa-passed.jpg)

![Release published / Serving live](./80-mara-release-published-serving-live.jpg)

### 10. 新角色公开消费与固定开场白 — Chrome 闭环

客户 Explore 搜索可见 Mara，公开详情使用发布后的 hero；第二客户创建全新 Chat 时立即显示 Release 固定开场白，随后真实模型回复并在刷新后完整保留。opening 的 Voice Play 保留，无 user source 的 Regenerate 已隐藏；消息操作区按真实动作数留白，不再覆盖文本。

![公开 Explore](./81-customer-explore-mara-public.jpg)

![公开详情](./82-customer-mara-public-detail.jpg)

![真实客户 Chat](./83-customer-mara-live-chat.jpg)

![固定开场白与刷新持久化](./86-mara-opening-message-persisted.jpg)

### 11. Community 与 Follow — 双账户闭环

Official 角色只显示 Official，不再有不会发请求的假 Follow。第二客户对 `Chrome Launch Audit` 完成 Follow→刷新仍 Following→Unfollow；原创作者自己的 Dreamer 卡不再显示自关注按钮。

![Official 无假 Follow](./60-community-official-no-follow.jpg)

![第二客户 Following](./84-community-following-mara-creator.jpg)

![自己的卡无 Follow](./85-community-own-creator-no-follow.jpg)

### 12. Help、Support、Report、Appeal 与 Cases — 用户反馈闭环

用户可提交 support/report/appeal；Admin 可搜索、裁决并关联 Case；客户刷新 Help Desk 后能看到自己的历史、终态 outcome 和 report↔appeal 双向关联。`.test` fixture 用户仍按 operational dataClass 隔离，这是数据分区而非丢单。

![客户 Support](./68-customer-support-ticket-received.jpg)

![Admin Support resolved](./69-admin-support-ticket-resolved.jpg)

![Admin Report/Appeal upheld](./70-admin-report-appeal-upheld.jpg)

![客户历史与结果](./78-customer-support-report-appeal-history.jpg)

Cases/Support 的 SSR 首帧已与浏览器一致，mount 后恢复 URL view；Support 14 列通过横向滚动保持可读。

Appeal overturn 现在绑定原 moderation decision 的当前 effect ownership：后续 decision、owner archive 或 legacy 无因果 authority 的状态都会 409 并保持 Appeal open；Media 按不可变 before/after snapshot 做 CAS 恢复。Character 恢复事件只激活由该 removal 归档且仍由它持有的 Chat session，用户主动归档、后续 removal 和批准后新建的替代 active session都不会被误改。

### 13. Profile 与 Account Deletion — 普通功能可用，终态实现完成、current-runtime Chrome 待签发

Profile、偏好、无效兑换反馈、账单展示可用。Account Deletion 现具备：30 天 grace、立即撤销 session/login、到期才发 `user.account_deletion.requested.v2`、Blob durable lease/retry、晚到 Generation 抑制、Main PII/media hard delete、最小匿名 ledger 和 completed receipt。已发布角色的 immutable Qualification/Release/Validation 证据不会被删除；finalizer 只做 one-way revoke、退役并匿名化 Project，避免 deferred database authority 在提交时回滚。v2 请求只走专属 capability route；Chat 在同一受控路径同步完成删除、写入 request-bound completion，并等待 Main 专属端点原子投影后才 ACK。generic ingress/dispatcher 拒绝 v2；Main 使用独立 receipt namespace，旧 Chat 将 inbox 标 consumed、file mutation 提交后中断、旧 Main 吞掉 legacy completion 三个整栈/混合版本回滚窗口都可在 forward deploy 后重驱。完整 71-migration fresh/upgrade/redeploy/rollback rehearsal已在隔离库通过并清理。

Chrome 使用独立的一次性客户真实输入 `DELETE` 并提交。截图中的操作发生在迁移前：由于当时 runtime 未执行 `20260811190000_account_deletion_terminal_authority`，Main 在插入 `public.account_deletions` 时返回 Prisma P2021/HTTP 500；事务回滚，未产生删除请求、未撤销该账号，也没有启动 Chat/Blob 清理。这张截图只保留为历史失败与回滚正确性的证据。当前 revision 先在 run-owned Playwright 浏览器环境重跑 destructive terminal canary，再由用户授权的产品 Chrome disposable actor 完成 Main→Chat→Blob→Main 终态；后者的登录撤销、30 天 grace 事实、精确到期 CAS、Chat PG/FS 清理、2 条 Blob receipt 与匿名 completed receipt 均已核对。

![账户删除被未应用迁移阻断](./88-account-deletion-migration-blocked.jpg)

### 14. Admin Chat Ops 与 durable backlog — 操作面与数据终态闭合

Admin 原先可见 48 条 failed Main→Chat event；live receiver authority 全部判定 `Expected target missing`，Replay 禁用，`Record target missing` 需双权限、Idempotency-Key、reason、exact confirmation 和 CAS snapshot。2026-08-11 的 Chrome operator flow 已完成该终态处置：UI 显示 `discarded_target_missing: 48`，随后空态；只读审计 failed `0`，Chat terminal receipt `48`，Main audit `48`。

2026-08-12 真实 Chrome 硬刷新 `/admin/ops/chat` 后显示 `Chat Service connected`、failed delivery 空态、model HTTP 200 / listed=true；overview、provider health、failed outbox、sessions、usage、moderation-events 六个 Admin API 全部 HTTP 200，console warning/error 为 0。对应截图为 `.tmp/chrome-launch-evidence-2026-08-12/admin-chat-ops-connected.png`。

2026-08-12 的后续审计发现普通 Chat Vitest 曾可解析 ambient Main ingest URL。测试入口现已限制为带 run id、派生 Redis prefix 和显式 Playwright 标记的 run-owned 环境；精确泄漏 fixture 已清理，当前只读复核的 failed、replayable、reconciliation-required 均为 `0`。

![Main→Chat backlog](./31-admin-chat-outbox-backlog.png)

![Main→Chat backlog terminalized](./89-chat-backlog-terminalized.png)

![受控选择](./36-admin-main-chat-replay-selection.png)

![Target-missing operator UI](./61-chat-target-missing-operator-ui.jpg)

本轮执行的是只针对 48 条 `receiver_target_missing` 载荷的 audited terminal disposition，不是 replay；原 envelope 与无用户效果的终态证据保留，不能把它描述为消息已恢复。

### 15. Voice — Admin 候选制作、激活与客户 Chat 播放已签发

Admin 已能生成 Alexa system voice preview。新的 Fish Audio probe 完成 clone→synthesize→delete，`fish-audio-s2-pro-8bit`、5.83 秒 WAV、514,222 bytes，确认 `voiceCloneVerified=true`。

补充 Chrome 在 390/768/1280 px 复验了当前 Alexa Voice 工作台：三种视口均为 page overflow `0`、可见图片 broken `0`。390 px 首轮发现 System Voice Defaults 操作按钮挤压说明文案，修复后操作入口独占下一行，说明恢复为正常两行；证据见 continuation `119`–`121`。最终 revision 另在 Mara Vale Launch 上完成了本地 MP3 参考音频选择、Fish candidate version 1 创建、15.117664 秒预览完整播放（`ended=true`、无 media error）、填写激活审计理由并明确启用；页面权威状态变为 `Voice version 1 / Character override / Sensual`，且成功提示明确新 Chat speech 使用该声音。

![System voice preview](./38-admin-alexa-system-voice-preview.png)

Voice clip scene payload constraint 已随本地 PostgreSQL 16 runtime 升到 71/71，并由 exact catalog postcondition 验证。Admin 的 clone candidate→试听→activate 已签发。随后使用专用一次性客户按真实 Demo Upgrade HTTP authority获得 Voice 权益，在 Mara 会话生成 opening 与真实模型 reply 两段 clip；两段分别播放到自然结束，刷新后仍可重播，且 clip 固定 active CharacterVoiceProfile version 1。没有猜测密码、手改 Subscription/Entitlement 或伪造完成状态。该客户随后按 Account Deletion authority 清除，两段音频 Blob 同步删除。

### 16. Runtime、部署与恢复 — 本地运行绿色，生产 envelope 缺失

当前三源 ownership probe：Image 2/2、Video 1/1，PM2/OS/Redis runId/slot/pid/db 一一对应，0 issues。Generation cutover：active requests 0、in-flight Bull 0、pending terminal outbox 0、0 issues。Web probe：Main/Generate 200，分别 24/31 assets；Admin dev wall 200/50 assets；age API 403、Admin API 401。Catalog probe：17 public characters、2 creators、3 collections、3 feedback、17 distinct images、0 issues。

Docker app 假拓扑已移除，Compose 只保留本地 Postgres+Redis。PM2 production 入口现在 fail-closed 检查 launch env，pause/drain，双媒体 ownership，fresh delete/recreate exact definitions，再 readiness 后 resume；development/current 同样不绕过 Generation 围栏。

### 17. Incident correlation failed delivery — 操作面闭环

瞬时失败最多自动尝试 8 次；耗尽行在独立 Admin 面板中可见。GET/POST 分别要求双权限；Replay 固定 `eventType + payloadHash + status/attempts/updatedAt` CAS、Idempotency-Key 和审计，HTTP 只把原 envelope 放回 worker，不直接伪造 Incident。当前 Chrome 验证了真实 failed row、精确 confirmation 与权限化操作面；未为演示执行 replay。

![Incident correlation failed delivery](./87-admin-incident-correlation-failed-row.jpg)

## 本轮关键缺陷与修复

- Auth partial-commit、并发邮箱唯一冲突、login/delete race。
- Create Preview 假 timeout、POST response lost 重复创建、GET 无 deadline、跨测试队列污染。
- Chat partial 被当终态、`finish_reason=length` 被当 done、固定 opening 不持久、opening 死 Regenerate、动作覆盖文本。
- Community official 假 Follow、用户 creator follow 状态不持久、自关注按钮。
- Admin Cases/Support hydration 假状态、Review 动态路由误命中、Support 表不可读。
- Main/Admin 生产构建与运行中的 Next 开发服务曾共用 `.next`，会让生产 build 覆盖开发 SSR 产物并触发 React hydration mismatch；开发产物现固定隔离到 `.next-development`，生产仍独占 `.next`。
- 审核通过却无 publication workspace；严格 public Release/Serving 链保持不放宽。
- Premium missing descriptor fail-closed、RedMix3 non-destructive migration。
- Generation orphan ownership、Video historical residue、PM2 definition/env drift、production queue resume 假绿。
- Main→Chat failed replay 的 scope/hash/cursor/权限/CAS 与 target-missing 无用户效果终态。
- Account Delete 的跨 Main/Chat/Blob authority、晚到 Generation、登录竞态，以及 migration 后整体/混合版本回滚时的新请求吞没风险；现以专属同步 v2 capability route、request-bound completion、独立 Main receipt namespace 与可重驱 transport 收口。
- Chat DB canonical constraint/index/role/grant 验证、Prisma migration authority、CI/Playwright 端口与 DB ownership。

## 当前验证证据

- Chrome：完整 authenticated 双客户 + Admin 编号旅程及历史截图仍按各自记录 revision 有效。最终后端补丁与 Recovery 重启后，当前真实 Chrome 复验 public character detail：1280 桌面与 emulated 390×844 均可用；Tab 后 Explore 获得可见焦点；Chat CTA 先得到预期 `POST /api/v1/chat/sessions` 401，再进入 `/signup?next=%2Fcharacters%2Fcmsozhlsn0023i2l7m71veczu`。Browser Back 捕获 `pageshow.persisted=true`，回到角色页后 `checking=false`、heading=`Mara Vale Launch`、`documentWidth=innerWidth=390`，无横向溢出。另有一次性客户在 Chrome 完成 Mara opening/reply Voice 自然结束播放、刷新持久化，以及 Account Deletion 浏览器提交→登录拒绝→Main/Chat/Blob/Main 终态与派生数据清理。结构化页面、DB/FS/Blob 证据与 focused 回归承担可重复验证。这仍不是全部编号 authenticated Chrome 套件在一个 revision 的整套重跑；signed Chat probe 是可重复的 authenticated transport 证据。
- Fresh Image probe：backend/ComfyUI、RedMix3 workflow v1、832×832 PNG、TerminalRecord succeeded。
- Fresh Video probe：backend/LTX workflow v1、固定 4 秒 recipe、TerminalRecord succeeded。
- Fresh Fish Voice probe：clone/synthesize/delete succeeded。
- Fresh web/catalog probes：PASS。
- Fresh Product Config probe：PASS；两个 RedMix3 v2 profile active，17/17 public character prompts 完整。
- 当前 local launch Gate：`.tmp/check-launch-2026-08-14-final-user-journeys.json` 在 `LAUNCH_SCOPE=core` 下为 44 pass / 23 fail / 0 warn / 67 total；支付、年龄验证不参与结论。Main→Chat backlog、Recovery、Generation、Admin text、产品证据与 source-revision authority 通过；23 个 production-envelope 检查全部保留在结构化 JSON 中，仍阻止公开上线。
- PostgreSQL 16：当前本地 runtime 已是 71/71；fresh+seed、legacy Premium v1→RedMix3 v2 upgrade、redeploy/rollback-forward-fix 均通过 exact migration authority。upgrade 保留 archived v1 的 Krea2 历史执行字段并创建 active Premium v2；迁移前 snapshot 已完成 PostgreSQL isolated restore，临时 rehearsal 数据库均已清理。Chat operator apply 入口以 runtime `node-pg` parser 拒绝 `CHAT_DATABASE_URL` query 的 target/credential 覆盖和多前导 `/` database path，拒绝可被 `psql -d` 解释成 conninfo/URI 的 `DB`、逗号分隔 multi-host `PGHOST` 与 ambient `PGHOSTADDR` / `PGSERVICE` / `PGSERVICEFILE` / `PGDATABASE` / `PGUSER` / `PGOPTIONS`；入口发现 shell xtrace 会在 DDL 前 fail fast，调用者也不得把 secret 放入 Bash 在首条命令前展开的 `PS4`。部署与 Chat test provision 的所有 `psql` 都固定使用 `-X` 并拒绝 ambient target override；测试角色密码只经 `psql` stdin 输入，不进入 argv 或异常文本。任何 `DROP DATABASE` 前必须用双角色真实 credential 分别认证为 `chat_service` / `chat_projector`，测试库重建持有 cluster/database advisory lease。任一 Chat runtime URL 已配置就禁止 bootstrap；只有显式确认的非 runtime disposable cluster 才能在 cluster advisory transaction lock 内重查姿态并只创建缺失角色，既有角色绝不 `ALTER ROLE` 或轮换密码。Chat Vitest config 显式加载包内 `.env`，使 Turbo root entry 使用同一 authority；Turbo 的 `@idream/chat#test` 固定 `cache:false`。
- Chat boundary operator 事故边界：首次执行误用旧默认，目标是 native PostgreSQL 5432 的 `idream`，不是产品 runtime；事前快照为 `.tmp/product-db-snapshots/idream-before-chat-boundary-20260812T1444Z.dump`，SHA-256 `37d871b7c6daab28efdead8623cfb7be00b6492b12c51eef6bbf2588a084f27a`。该次 apply 只建立/规范 Chat boundary schema/roles，没有删除客户数据，因此未回滚，也不能记录成产品 runtime 变更。实际 runtime `localhost:5433/idream_runtime_20260812` 另有事前快照 `.tmp/product-db-snapshots/idream-runtime-20260812-before-chat-boundary-20260812T1448Z.dump`，SHA-256 `cfded071fb51b0c30927bf6ba175a7592a07878435f353ec3c5c33d27e605f50`；随后使用显式 host/port/database target 成功 apply 并验证。
- Runtime ownership 与 Generation cutover 在 Recovery 重启后重新确认：Image 2/2、Video 1/1，queues resumed，0 ownership issue。
- 最后一次 post-Recovery 宿主观测：10 个 iDream PM2 app 实例均 online；Main `/` 为 200、Admin `/` 为预期 307 redirect、Chat `/readyz` 为 200。Generation ownership `issues=[]`；cutover 为 active requests 0、in-flight Bull rows 0、pending terminal outboxes 0、1 条 `ignoredHistory`、`issues=[]`。该运行态早于当前 source-bound revision；不存在 Main/Admin readiness 路径，此前对不存在路径的 404 不是服务停机证据。
- 五包最新全量测试：Shared 46 files / 254 tests；Gen 21 / 202；Main 315 passed files + 2 skipped / 2,479 passed tests + 3 skipped；Chat 37 / 348；Admin 118 / 586。五包合计 537 passed files + 2 skipped / 3,869 passed tests + 3 skipped；Turbo test tasks 6/6 通过，Chat 因 `cache:false` 强制真实执行，跳过项是显式 opt-in 的真实进程 chaos，不冒充已执行。
- 根级验证：typecheck 6/6、lint 2/2、production build 5/5 全部 PASS。
- PM2 config：78/78 PASS；`git diff --check` PASS。
- AgeGate bfcache 回归：`pageshow.persisted` 会推进恢复 epoch 并重新执行权威 `restoreAgeGateAuthority()` POST；成功前受限内容保持 `inert`，失败则回到 blocked，cookie/localStorage 只作为恢复提示，不能自行提升为接受权威。focused 2 files / 18 tests、Main typecheck 与 scoped lint PASS。
- Account Deletion 最新 request-bound v2 变更后：Chat durable outbox、rollback/reliability、P0 semantics 及 Main ingress/authority/event consumer 聚焦测试通过；run-owned destructive browser canary 与用户授权的产品 Chrome disposable actor 都通过 Main→Chat→Blob→Main 全链并清理派生资源。匿名 terminal receipt 保留，产品用户与派生资产已确认不存在。

## 上线前必须完成的顺序

1. 在生产环境复用本轮受控顺序：部署 fail-closed 代码、暂停相关写入、生成三层 checkpoint，再审阅并执行当前 71-migration chain；不得把本地 runtime 迁移当成生产执行证据。
2. 重跑 migration authority 与 Product Config；必须为 71/71，Premium v1 archived、Premium v2 RedMix3 active，Voice/Account Deletion postcondition 精确通过。
3. 重跑 Main→Chat 只读审计并要求 failed/replayable/reconciliation-required 持续为零；若上线前出现新 failed row，只允许逐条按 receiver authority 重新分类，不能重复处置已终态化的 48 条历史记录。
4. 用 production HTTPS、secrets、Postgres/Redis/prefix、Chat/Gen/Fish、R2/S3、Sentry 配置运行 `LAUNCH_SCOPE=core` Gate；该固定 scope 只排除支付与年龄验证，合规继续不计入本轮判定。
5. 补齐范围内外部闭环：Blob write/sign/read/delete、四 runtime Sentry canary ingest/query。
6. 在生产维护窗按已通过的本地合同生成 production DB + Chat FS + non-mock Blob 一致性 checkpoint，并对 production 独立 recovery authority 重做 restore；本地 71/71 bundle 不替代生产数据与对象存储证据。
7. 在 production-like revision 重跑 Image/Video/Voice/Chat fresh probes及完整 Chrome 客户/运营旅程，要求 unexpected console error 与网络 4xx/5xx 为 0。
8. 完成容量、错误预算观察窗口和 Product/Engineering/Release 明确签字后，才允许公开流量。

## 证据限制

- 截图证明的是当前 Chrome 可见状态，不等于生产容量、外部 SLA 或长期并发稳定性。
- 本地 mock Blob 不能替代对象存储；支付、年龄验证与合规没有参与本轮结论。
- 已执行本地 runtime DB migration、canonical Recovery publish/isolated restore 和 48 条历史 target-missing carrier 的受审计终态处置；尚未执行生产环境迁移、production secret/non-mock Blob 写入或生产发布。本地 Recovery 证据不能替代 production authority。
- Account Deletion 的 P2021/500 是迁移前历史证据；迁移后的 run-owned Browser canary与用户授权的产品 Chrome current-runtime destructive 终态均已通过。Voice 的 Admin 上传、候选完整试听、明确激活与专用 entitlement 客户 Chat 音频生成、自然结束播放、刷新持久化均已通过。二者仍需在 production release/authority 上重复，不能把本地证明升级为生产签发。
