# iDream 全产品 Chrome 上线审计

审计日期：2026-08-11  
范围：Main、Admin、Chat、Image/Video/Voice、Create、Release、Community、Profile、Help/Case、运行编排与 Launch Gate；按本轮用户指令，支付、年龄验证和合规不参与结论  
浏览器：用户指定的 Chrome；真实登录态、真实本地模型与产品数据库

## 结论

**当前结论：NO-GO，不能签发公开上线。**

本轮已把本地核心产品链从“页面可点”推进到真实用户与运营闭环：注册、公开发现、SSE Chat、真实 RedMix3 图片、真实 LTX Video、Gallery、Demo Upgrade、四张 Create Preview、审核、三槽 Release 素材、Soul、QA、Release/Serving、公开消费、Community Follow、Support/Report/Appeal 及 Admin Ops 都有 Chrome 或不可变运行证据。最初的 8 个 Gen orphan 与历史 Video residue 已按受控流程收口；当前 Image/Video worker ownership 和 generation cutover 都为绿色。

仍然阻断上线的是明确的权威边界，而不是“再点几页”：

1. 产品数据库为 **67/71 migrations**。四条尚未由 operator 执行：Premium RedMix3 cutover、runtime schema reconciliation、Voice scene payload authority、Account Deletion terminal authority。
2. Product Config 仍因 active `seed-profile-image-premium-v1` 指向已删除 workflow 而失败；源码已 fail closed，迁移已产出，不能绕过或原地改写历史 v1。
3. 当前 Main `.env` 在固定 `LAUNCH_SCOPE=core` 下的 Launch Gate 为 **22 pass / 37 fail / 1 warn**；该可执行契约只排除支付与年龄验证，未知 scope 会失败关闭，合规按本轮范围不参与结论。新门禁已分别证明最近一次 Image/Video 从 Gen TerminalRecord 到 Main Job/Attempt/receipt/outbox/artifact/delivery/MediaAsset 的持久化投影，但范围内仍缺 production HTTPS/secrets、Redis/prefix、真实 Chat/Gen 产品环境、对象存储、四个 runtime 的 Sentry canary，以及 migration-71 三层恢复演练；失败的 Product Config 仍使 Gate 正确拒绝把独立的直接 Gen provider probe 当成当前产品配置的上线凭据。
4. 原有 48 条 `chat.image.failed` target-missing durable event 已闭合。处置前只读对账为 48 failed / 0 Chat receipt / 0 attachment target / 0 source outbox / 0 replayable；Chrome 通过双权限、Idempotency-Key、reason、exact confirmation 和 CAS snapshot 批量执行 `Record target missing`，结果为 `discarded_target_missing: 48`。处置后只读审计为 failed `0`，Chat terminal receipt `48`，Main audit `48`；没有 replay，也没有伪造用户效果。
5. Account Deletion 已有 30 天 grace、rollback-safe v2 Main→Chat 请求、精确 Chat completion、Blob lease/retry、Main hard-delete/匿名 ledger 和隔离 71-migration rehearsal；但产品库未执行迁移。Chrome 用一次性客户实际提交删除时，API 因 `public.account_deletions` 不存在返回 500/P2021，事务回滚、账号仍有效，直接证明当前部署尚不能完成该旅程。
6. Sentry runtime 接线不能替代真实 canary ingest/query；当前 71-migration 状态也没有新的 DB + Chat FS + Blob 一致性备份与独立 restore rehearsal。

因此本报告证明的是：**本地核心产品与运营流程已广泛闭环，多个真实缺陷已经修复；在明确排除支付、年龄验证与合规后，范围内的生产环境、四条 operator migration、历史 backlog 处置和恢复演练仍是公开上线 stop-ship。**

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

![Alexa Chat 回复](./09-chat-reply.png)

![刷新后历史](./10-chat-reload-persisted.png)

### 4. 图片生成、Freeplay 与 Gallery — 本地真实 ComfyUI 闭环

Chrome 角色生成经历 queued→completed；Freeplay 有显式模型选择；Gallery 可浏览、Like、筛选、下载。新版独立 probe 真实执行 `redcraft-krea2-redmix3-txt2img`，生成 832×832 PNG，并写入不可变 Attempt/TerminalRecord，耗时 122.9 秒。

![图片排队](./12-generate-image-queued.png)

![图片完成](./15-generate-image-completed.png)

![Premium Freeplay 模型](./16-premium-freeplay-models.png)

![Gallery Like 筛选](./21-gallery-liked-filter.png)

仍有 stop-ship：历史 Premium v1 数据尚未迁移；公开 selection/quote 已拒绝缺 descriptor 的 ComfyUI profile。

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

### 13. Profile 与 Account Deletion — 普通功能可用，终态代码完成、当前产品库未迁移

Profile、偏好、无效兑换反馈、账单展示可用。Account Deletion 现具备：30 天 grace、立即撤销 session/login、到期才发 `user.account_deletion.requested.v2`、Blob durable lease/retry、晚到 Generation 抑制、Main PII/media hard delete、最小匿名 ledger 和 completed receipt。已发布角色的 immutable Qualification/Release/Validation 证据不会被删除；finalizer 只做 one-way revoke、退役并匿名化 Project，避免 deferred database authority 在提交时回滚。v2 请求只走专属 capability route；Chat 在同一受控路径同步完成删除、写入 request-bound completion，并等待 Main 专属端点原子投影后才 ACK。generic ingress/dispatcher 拒绝 v2；Main 使用独立 receipt namespace，旧 Chat 将 inbox 标 consumed、file mutation 提交后中断、旧 Main 吞掉 legacy completion 三个整栈/混合版本回滚窗口都可在 forward deploy 后重驱。完整 71-migration fresh/upgrade/redeploy/rollback rehearsal已在隔离库通过并清理。

Chrome 使用独立的一次性客户真实输入 `DELETE` 并提交。由于产品库未执行 `20260811190000_account_deletion_terminal_authority`，Main 在插入 `public.account_deletions` 时返回 Prisma P2021/HTTP 500；事务回滚，未产生删除请求、未撤销该账号，也没有启动 Chat/Blob 清理。这条流程因此被当前部署事实阻断，不能签发为 production closed。

![账户删除被未应用迁移阻断](./88-account-deletion-migration-blocked.jpg)

### 14. Admin Chat Ops 与 durable backlog — 操作面与数据终态闭合

Admin 原先可见 48 条 failed Main→Chat event；live receiver authority 全部判定 `Expected target missing`，Replay 禁用，`Record target missing` 需双权限、Idempotency-Key、reason、exact confirmation 和 CAS snapshot。2026-08-11 的 Chrome operator flow 已完成该终态处置：UI 显示 `discarded_target_missing: 48`，随后空态；只读审计 failed `0`，Chat terminal receipt `48`，Main audit `48`。

![Main→Chat backlog](./31-admin-chat-outbox-backlog.png)

![Main→Chat backlog terminalized](./89-chat-backlog-terminalized.png)

![受控选择](./36-admin-main-chat-replay-selection.png)

![Target-missing operator UI](./61-chat-target-missing-operator-ui.jpg)

本轮执行的是只针对 48 条 `receiver_target_missing` 载荷的 audited terminal disposition，不是 replay；原 envelope 与无用户效果的终态证据保留，不能把它描述为消息已恢复。

### 15. Voice — provider probe 绿色，产品 Browser 全链仍受迁移阻断

Admin 已能生成 Alexa system voice preview。新的 Fish Audio probe 完成 clone→synthesize→delete，`fish-audio-s2-pro-8bit`、5.83 秒 WAV、514,222 bytes，确认 `voiceCloneVerified=true`。

补充 Chrome 在 390/768/1280 px 复验了当前 Alexa Voice 工作台：三种视口均为 page overflow `0`、可见图片 broken `0`。390 px 首轮发现 System Voice Defaults 操作按钮挤压说明文案，修复后操作入口独占下一行，说明恢复为正常两行；证据见 continuation `119`–`121`。浏览器控制的本地参考音频上传仍因 Chrome 扩展没有 file-URL access 而不可用，本轮没有绕过该权限边界。

![System voice preview](./38-admin-alexa-system-voice-preview.png)

但 Voice clip scene payload 的新 DB constraint migration 未应用；专属 clone candidate→试听→activate/publish→Chat 音频持久化/刷新播放不能在当前产品库被诚实签发。

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

- Chrome：真实双客户 + Admin，覆盖上述编号旅程；另用一次性客户实测 Account Deletion，准确暴露未应用迁移导致的 P2021/500，且事务回滚、没有误删账号。最新 Mara opening/回复/刷新导航没有 page error。Main/Admin production build 在两个开发服务保持在线时成功后，fresh Chrome 仍得到一致 SSR/client grid、0 warning/error、0 broken image、0 页面横向溢出，证据见 continuation `104`。最终 390/768/1280 px 复验覆盖 Explore、Mara detail、Admin Today、Chat Ops 与 Alexa Voice 共 15 个页面状态：全部 page overflow `0`、可见图片 broken `0`；前 12 个状态另有 console warning/error `0`，Voice 三视口完成可见布局与图片核验；键盘焦点证据见 continuation `117`–`118`，Voice 响应式证据见 `119`–`121`。
- Fresh Image probe：backend/ComfyUI、RedMix3 workflow v1、832×832 PNG、TerminalRecord succeeded。
- Fresh Video probe：backend/LTX workflow v1、固定 4 秒 recipe、TerminalRecord succeeded。
- Fresh Fish Voice probe：clone/synthesize/delete succeeded。
- Fresh web/catalog probes：PASS。
- Fresh Product Config probe：FAIL，仅明确指出 stale Premium v1。
- Fresh local launch Gate：`LAUNCH_SCOPE=core` 结果 22 pass / 37 fail / 1 warn；机器门禁只排除支付与年龄验证，合规不计入本轮判定；迁移 authority 明确 67/71，Main→Chat backlog authority 在受审计终态处置后为零并通过，最近一次 Image/Video 的 Main 持久化投影分别通过独立只读证据检查，Recovery authority 仍拒绝缺失的 migration-71 三层恢复演练。仓库现已补齐 `bun run recovery:rehearse` 的脱敏 plan、typed apply、PG16/Chat FS/local-or-versioned-remote Blob 隔离恢复、失败清理与 verifier round-trip，但本轮未对产品 DB/R2/PM2 执行 apply，不能把代码入口冒充成恢复证据。最新落盘 Gate 证据为 `.tmp/check-launch-2026-08-12-final-core.json`，响应式与键盘补充证据见 `../2026-08-11-launch-continuation/`。
- Disposable PostgreSQL 16：fresh 71/71 + seed 与 legacy Premium v1 → RedMix3 v2 upgrade 两种状态均通过 exact migration authority 和 Product Config；upgrade 保留 archived v1 的 Krea2 历史执行字段并创建 active Premium v2。PostgreSQL 14 的同一 checker 现在在读取 PG16-only catalog 之前结构化失败，不再崩溃。两类一次性数据库均已清理，没有执行产品迁移。
- Runtime ownership：PASS；Generation cutover：PASS。
- 根级 `bun run test`：6/6 Turbo tasks 成功；Shared 45 files / 250 tests；Admin 118 / 584；Chat 35 / 276；Gen 21 / 202；Main 310 passed files + 2 skipped / 2,381 passed tests + 3 skipped。五包合计 529 passed files + 2 skipped / 3,693 passed tests + 3 skipped；跳过项是显式 opt-in 的真实进程 chaos，不冒充已执行。
- 根级 `bun run check`：Main/Admin lint、五包 typecheck、Shared/Chat/Gen build 与 Admin/Main Next 16 production build 全部 PASS。
- PM2 config：74/74 PASS；`docker compose config --quiet` PASS；`git diff --check` PASS。
- Account Deletion 最新 request-bound v2 变更后：Chat durable outbox 7/7、rollback/reliability 18/18、P0 semantics 11/11；Main dedicated ingress 5/5、authority 8/8、event consumer 18/18。71/71 fresh/upgrade/redeploy/rollback rehearsal PASS，临时数据库清理为 0。

## 上线前必须完成的顺序

1. 部署当前 fail-closed 代码并暂停相关写入；由 DBA/operator 审阅并执行四条 pending Prisma migration。
2. 重跑 migration authority 与 Product Config；必须为 71/71，Premium v1 archived、Premium v2 RedMix3 active，Voice/Account Deletion constraint 存在。
3. 重跑 Main→Chat 只读审计并要求 failed/replayable/reconciliation-required 持续为零；若上线前出现新 failed row，只允许逐条按 receiver authority 重新分类，不能重复处置已终态化的 48 条历史记录。
4. 用 production HTTPS、secrets、Postgres/Redis/prefix、Chat/Gen/Fish、R2/S3、Sentry 配置运行 `LAUNCH_SCOPE=core` Gate；该固定 scope 只排除支付与年龄验证，合规继续不计入本轮判定。
5. 补齐范围内外部闭环：Blob write/sign/read/delete、四 runtime Sentry canary ingest/query。
6. 生成当前 71-migration 的 DB + Chat FS + Blob 一致性备份，并在独立环境完成 restore rehearsal。
7. 在 production-like revision 重跑 Image/Video/Voice/Chat fresh probes及完整 Chrome 客户/运营旅程，要求 unexpected console error 与网络 4xx/5xx 为 0。
8. 完成容量、错误预算观察窗口和 Product/Engineering/Release 明确签字后，才允许公开流量。

## 证据限制

- 截图证明的是当前 Chrome 可见状态，不等于生产容量、外部 SLA 或长期并发稳定性。
- 本地 mock Blob 不能替代对象存储；支付、年龄验证与合规没有参与本轮结论。
- 未执行产品 DB migration、production secret 写入、恢复 apply 或生产发布；48 条历史 target-missing carrier 的受审计终态处置已真实执行并在上文单列证据。
- 当前 Account Deletion 与 Voice 代码虽有隔离回归；Account Deletion 的 Chrome 提交已用 P2021/500 直接证明 Browser 终态被未应用迁移阻断，Voice Browser 终态同样尚未具备迁移前提。
