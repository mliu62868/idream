# 核对功能覆盖声明与当前代码权威

Type: grilling

Status: resolved

## Question

逐域对照 `CURRENT_FUNCTIONAL_COVERAGE.md`、`REMAINING_WORK_EXECUTION_PLAN.md`、产品／架构 SSoT、Prisma／手工 SQL、Shared contracts 与五个 package 的生产源码后，哪些“已落地／可用／暂缓／待上线”声明仍被当前代码权威支持，哪些已经过期、互相矛盾或缺少实现入口？产出可追溯的 claim → authority → status 矩阵，不用历史测试绿灯替代当前代码核对。

## Answer

### 审计锚点与口径

- revision：`master@1fb5d544fc8cd5630a8bcd33e1e8cc25cbb982cc`。
- 工作树：只有本次 `.scratch/current-implementation-audit/` 调查记录，没有将其他 WIP 混入结论。
- 本票使用产品／架构文档解释意图，但以 Prisma、手工 SQL、Shared contract 和生产源码判定实现事实。票 01 在同一 revision 已重跑全量 tests、lint、typecheck、production builds 与 PM2 配置；这只用于说明下表所指的代码在当前 revision 可通过仓库 gate，不用它代替 provider、数据库、浏览器或生产事实。

状态词的审计含义：

- **仓库支持**：当前 schema／contract／生产入口与测试边界存在且一致。
- **有边界地支持**：代码权威存在，但只能声明本地／受控 beta，不能声明公开上线。
- **意图缺口**：产品目标已写明，当前 milestone 明确 deferred；这不是“已实现回归”。
- **文档漂移**：当前文档仍把已退休路径、已删文件或旧产品语义写成现行事实。
- **未评估**：本票没有可用的当前运行／生产证据，不猜成功或失败。

### Claim → authority → status 矩阵

| 域／文档声明 | 当前仓库权威 | 判定 | 精确边界／漂移 |
| --- | --- | --- | --- |
| 年龄门禁、注册、登录、session、账号管理 | `packages/main/prisma/schema.prisma` 的 User/Session/AgeGateAcceptance/AgeVerification；`packages/main/src/server/modules/ourdream/`；Main 页面与 API contract | **仓库支持** | 本地 age gate 与账号链存在。Go.cam 真实身份验证是明确 deferred 的上线门，不是当前“可用”的一部分。 |
| Explore、角色详情、公开目录、Feed、Community | Character/Release/Serving/PublicCatalogQualification 数据权威；`public-release-authority.ts`、`public-catalog-qualification.ts` 及 Main 读模型 | **仓库支持** | 只有 dedicated renderer 或已发布 CMS 能发布通用公开路由。`CURRENT_FUNCTIONAL_COVERAGE.md:505` 仍称 Games、Romantasy 和泛 comparison 等路由“可用／无 404”，与同文档 468–473 的 correction 和当前 fail-closed 代码直接矛盾，属 **文档漂移**。 |
| Create → My AI、视觉身份、引用集 | CharacterDraft/PreviewJob/VisualProfile/ReferenceSetRevision；`image-generation-service.ts`；Main/Create UI | **仓库支持** | 草稿、preview anchor、active CVP 与后续生成引用链均有权威入口。历史 sd.cpp reference-conditioning 并非现行实现。 |
| Chat、记忆、关系、Scene、Character Soul | Shared `chat/persona.ts`、runtime policy/model profile；Main `character-soul.ts`；Chat `prepared-turn.ts`、`scene.ts`、`relationship*.ts`；ContentVersion/Release/Serving 固定字段 | **仓库支持** | 现行代码确实以 immutable ContentVersion／Release pin 生成 PreparedTurn，`SOUL.md` 不是独立运行时权威。`docs/architecture/README.md:97` 仍标 `ADR-14 (Proposed)` 已过期。文档中 Alexa Release #5 的具体 ID／Serving 现态本票未连开发库复验，仅属历史运行证据。 |
| 图片生成 | Shared generation payload/workflow contract；Main GenerationJob/Attempt 入场；Gen `BackendImageModel` + backend registry + ComfyUI workflow；terminal record/relay | **有边界地支持** | 当前代码权威是 `GEN_IMAGE_PROVIDER=backend` → `BackendImageModel` → ComfyUI；`pipeline` 仅保留回滚 adapter。`REMAINING_WORK_EXECUTION_PLAN.md:195–213,516,560,571,584` 仍把 pipeline/sd.cpp@8091 写成 active image runtime，属 **文档漂移**。生产容量、对象存储与当前 live canary 仍 **未评估**。 |
| 视频生成 | Shared exact LTX contract；Main quote/admission/profile；Gen `BackendVideoModel`、`ltx23-gtanimation-i2v` descriptor；专用 worker | **有边界地支持** | exact LTX 2.3 I2V 路由和 fail-closed 参数在代码中。`CURRENT...:493` 的“生产路由已启用”只能解读为仓库／本地路由可入场，不能外推生产部署；真 provider 容量与当前 MP4 闭环留给运行票。 |
| Voice | CharacterVoiceProfile/VoiceClipRequest/VoiceUsageFact；Main `fish-audio` adapter；Admin `CharacterVoicePanel`；PM2 Fish Audio 进程 | **有边界地支持** | 现行权威是 Fish Audio S2 Pro，而不是旧 Pocket/pipeline。文档已正确写明 prod cutover/canary 未执行、专用浏览器 voice journey 未评估；不应把历史 WAV 截图升格为当前 live 事实。 |
| Upgrade、billing、entitlement、dreamcoin | Subscription/Entitlement/Ledger；Shared/public DTO；`billing-checkout.ts`、`subscription-lifecycle.ts`、payment provider capabilities | **仓库支持，mock/BTCPay 均为 prepaid 语义** | 当前 UI/DTO 是 `benefitsEndAt` + no automatic renewal，renewal mutation fail closed。`CURRENT...:497,503` 仍把 Cancel/Resume/Renews 写成当前功能，与 468–471 correction 和代码矛盾，属 **文档漂移**。BTCPay adapter 存在不等于真实收款已上线。 |
| Report/moderation、Help Desk、appeal、profile/preferences | ContentReport/ModerationEvent/SupportRequest/Appeal/ProductFeedback 数据模型；Main 服务／UI；Admin queue/case 入口 | **仓库支持** | 当前实现入口与状态模型存在。文档里的历史 Chrome 记录只是旧证据，当前操作旅程由后续浏览器票重验。 |
| Admin v2、Character Workspace/Asset Studio、QA、Release、Serving | Shared admin contracts；Main `admin-v2/characters/*`、release executor/lifecycle/validation/serving projection；Admin `CharacterWorkspace`、`CharacterAssetStudio`、Soul/Voice/Release/Visual panels | **仓库支持** | 审核／批准、采用草稿、Release publish 与 Serving 仍是分离权威。`OfficialCharactersView.tsx` 已不存在，相关功能已在 CharacterWorkspace 系列中；旧文件名是 **文档漂移**，不是功能缺口。 |
| 生成可靠性与跨服务交换 | Prisma GenerationAttempt/TransportExecution 等；Shared durable payloads；Gen `transport-execution.ts`/`terminal-record.ts`；Main terminal relay/finalizer/Admin reconciliation；`packages/main/prisma/manual/` 与 `db/sql/` | **仓库支持** | Request → Attempt → TransportExecution → immutable TerminalRecord → Artifact/Delivery/Settlement 为现行边界。Gen 是图片／视频 provider 唯一执行者。生产 migration/backfill/canary 本票 **未评估**。 |
| 运行时版本政策 | `.nvmrc=24`；root/main/admin/chat/gen `package.json` 均是 `engines.node>=22` | **权威分裂** | `docs/architecture/README.md:62` 称 `.nvmrc` 与 `package.json` 都要求 `>=24`，与实际 manifest 矛盾。当前 revision 在 Node 22.22.0 通过全部仓库 gate；这不自动决定应收紧 manifest 还是改文档。 |
| 公开上线 | launch-readiness/probe 代码、production env templates 和部署 fence 存在 | **意图缺口／未评估** | 文档正确区分了当前 controlled beta 与 public launch；Go.cam、BTCPay live、R2/S3、Sentry 以及生产 migration/cutover/canary 是明确外部 Gate。不把它们记为本轮代码回归。 |
| Group Chats、Packs、真 i18n、更强个性化／搜索 | `ProductFeatureMap.md:187–194` 与当前无 CTA 空态 | **意图缺口，记录诚实** | 这些没有完整实现入口，但文档未宣称已落地，不属于状态漂移。 |

### 已确认的文档漂移清单

1. **图片运行时双重权威**：`CURRENT_FUNCTIONAL_COVERAGE.md:66–67,475–480,529` 和 `REMAINING...:34–35` 的 backend/ComfyUI 口径与代码一致；`REMAINING...:195–213,516,560,571,584` 仍要求 active pipeline/sd.cpp@8091，已失效。
2. **已删文件还被当作证据**：`CURRENT...:402,492` 及 `REMAINING...:387–388` 引用不存在的 `packages/gen/src/sdcpp-runtime.ts`、`sdcpp-runtime.test.ts`、`sdcpp-reference-images.test.ts`；`REMAINING...:375` 引用不存在的 `OfficialCharactersView.tsx`。`db/sql/2026-08-03-generation-model-profile-runner-retire-sd-cpp.sql` 明确记录 sd.cpp backend 已整体删除。
3. **billing correction 未回写到主矩阵**：468–471 已说明 prepaid/no-renewal，但 497 和 503 仍宣称 Cancel/Resume/Renews 为当前功能。当前 DTO、UI 和 mutation guard 支持 correction，不支持旧行。
4. **公开路由 correction 未回写到主矩阵**：468–473 与 `public-route-render-decision.ts` 要求 dedicated/CMS 发布权威，505 仍将 Games/Romantasy/泛 comparison 等路由写成可用。
5. **目标路由数被写成当前构建事实**：`ProductFeatureMap.md:26` 称 164 个非根路径由 `generateStaticParams` 生成；当前 `generateStaticParams()` 只会返回 `dedicatedStaticArticlePaths` 中的 3 个可信静态内容路径，其余受 CMS authority 管制。
6. **架构摘要落后**：`docs/architecture/README.md:62` 的 Node engine 口径与全部 package manifest 矛盾；`:97` 的 ADR-14 Proposed 与已落地的 Soul 权威链矛盾。
7. **快照数字与当前事实混居**：当前 Main migration 目录数是 67，最新为 `20260805213000_character_soul_release_evidence`。文档中明确标日期的 60/65 条历史 checkpoint 可保留作快照，但 `REMAINING...` 的“current local truth”与执行说明不能再沿用它们作当前计数。

### 总结论

1. **核心实现不是一组空声明**：Main、Chat、Gen、Admin、Shared 五包中都有与当前 schema 对应的生产入口，Character/Soul/Release、Chat、图片／视频生成、Voice、Billing、Admin v2 与 durable generation 的主权威链在当前 revision 是连通的。
2. **主要问题是“实现状态 SSoT 混入编年史”**：`CURRENT_FUNCTIONAL_COVERAGE.md` 顶部 correction 通常正确，但底部主矩阵仍保留旧语义；`REMAINING_WORK_EXECUTION_PLAN.md` 同时包含现行 backend/ComfyUI 事实与已退休 pipeline/sd.cpp 工作流。因此它们目前不能被机械地当作“每一行都是当前事实”的 SSoT。
3. **没有发现需要在本票立即修代码的新核心断链**。确定性差异主要是文档口径与证据指针；真正的运行缺口要由后续数据库／跨服务、provider 与浏览器票取得当前证据后才能判定。
4. **文档修复形式已可确定为“收敛现行摘要 + 隔离历史附录”，不是继续叠 correction 注释**。最终回写范围仍应等后续运行与用户旅程证据后在真相矩阵票一次确定。
