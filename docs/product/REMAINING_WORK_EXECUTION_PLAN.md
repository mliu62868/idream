# iDream 剩余工作执行计划

更新日期：2026-09-07

本文件只保留尚未完成的工作。已完成能力与历史运行证据见 `CURRENT_FUNCTIONAL_COVERAGE.md`。

2026-09-02 起的多轮审计已实际完成 Create、单角色 Chat、图片、默认 RedGraft 视频、Admin 角色与客服运营的核心闭环。候选 `ab995512…` 的 4,955 条默认测试、146/146 Chrome、正式自然记忆与模型交付证据见 `CURRENT_FUNCTIONAL_COVERAGE.md`；最新增量验证及各版本归属见 `.tmp/product-audit-20260902/FINAL_REPORT.md` 和 `iteration3-validation.json`。H3 最新样本未通过视觉验收，已停用前台新选择，不能将其技术交付成功视为质量合格。支付、年龄检查与合规不在本轮范围。

分期统一见 [PRD §12](PRD.md#12-交付阶段与完整范围)。2026-09-06 用户已确认先集中完成核心体验、默认路线性能和可信运营数据；这调整工作顺序，不删除完整 OurDream 对标需求。当前实现与本轮验收入口见 [核心体验验证](CORE_EXPERIENCE_VALIDATION.md)。

## 下一工作顺序

1. **先修已复现的体验质量**：固定五角色工具与真实产物已建立，两个完整技术旅程和三个独立媒体范围分别有证据。强制图片工具丢弃历史/召回的确定性故障已修复，真实场景遵从需继续按版本验收。igrep误撤回已用原版 CLI 和隔离模型提议复现到实际删除；Main 来源保护已加入坏候选拒绝与官方 fresh-ingest 恢复，验证边界见[来源保护报告](../product-audits/2026-09-08-core-authority.md)。上游仍需可维护源码或已修复版本，在副作用前验证用户授权并解决 profile 语义；保留对话纠正和 Main 删除重建。精确事实与用户动作保真、改图附带重绘仍待质量修复；保持旧失败与独立新样本分开。声音全量听感、中文/anime/长对话与真实跨日回访仍未评，不再把“运行五个样本”本身列为未启动。

2. **默认生成速度与容量**：优先默认图片、身份图与 RedGraft。按版本分别记录实际排队、执行与端到端分布，保持模型、规格、输入和质量可比较；稳定参考缓存与性能分段已进入实现，实际收益以对照报告为准。共享设备串行等待与纯执行耗时分别处理，不用换模型或缩小规格掩盖原因。
3. **从工程可观测走向经营证据**：指标自动物化和只读诊断已实现；接下来补足真实 eligible facts、成熟窗口、有效定义与质量认证。WPCU 保持 official，本地 audit/internal 数据与未认证值不作真实留存或经营判断。
4. **按证据再扩展产品**：核心体验稳定后，继续完整平台中的账号、精确 Chat → Generate 上下文、创作者/社区、联盟、Pack/Comic、群聊与通话等缺口；商业化及公开生产按原有独立阶段验收。

前 3 项形成一个完整里程碑：用户愿意继续同一角色的互动，生成等待可解释且有实测改善，运营能看见可信且可行动的事实。H3 继续隔离，稳定复验是重新启用的前提；不把实验后端恢复置于默认用户体验之前。

## 当前状态

- 代码已把 Companion Chat 产品权威迁到 Main PostgreSQL：`RecentChat`、`ChatTurn`、`ChatTurnAttachment`。
- `packages/chat` 已移除 Prisma/PostgreSQL/BullMQ；其深模块内嵌执行 AgentRun、DSH/igrep，成功 run 在 Main ACK 后清理。
- 图片 ToolEffect 已进入 Main Generation/Ledger，不采用成功后普通 hook 扣费。
- Main migration 和旧 Chat 数据导入脚本已经存在，但本仓库修改不会替用户连接生产库执行。
- 2026-08-31 的实现审计已记录 Character/Admin 与 Companion 的当前证据；本文件不复述已完成项，任何运行态完成声明继续以 `CURRENT_FUNCTIONAL_COVERAGE.md` 和同 revision 验证为准。
- 2026-09-01 的产品决策是完整对标 OurDream；WPCU 保持 Metric Registry `official`，WSCU/WSCrU/WPSCU/WSR 保持诊断用途，不存在待执行的北极星切换。目标文档仍不能冒充已上线能力。

## 1. 收口完整 OurDream 对标缺口

H3 首帧叠影与构图跳变仍需稳定修复和质量复验；重新启用须按合法 recipe/profile 版本发布，不能直接修改历史 pins。默认 RedGraft 仍可用，但现有完整生产配置门禁要求的 H3 目前不满足。正式主机/访问、HTTPS 主站和受保护 Admin、对象存储及 Sentry 接入仍待提供；不能把本机 development、旧版本探针或一次正常 seed 当作完整生产验收。

1. 已建立 [域级对标矩阵](PRODUCT_PARITY_MATRIX.md) 和需求/用户故事映射；继续下钻到逐功能、逐 Catalog 项与同版本运行证据，覆盖 Explore、完整 Create、Chat、Generate、My AI/Profile、Feed/Community/Creator Economy、Upgrade、Affiliate、Support 与公开内容。每项绑定 OurDream 可验证契约、iDream 当前代码/运行证据、真实缺口和退出 Gate。
2. 区分“未实现空态”、“受 feature/provider/entitlement 条件限制”、“本地受控可用”和“公开生产已认证”，不用路由存在或历史截图代替能力证明。
3. Create 五步链及目录扩展已有实际证据：48 personality / 135 occupation / 29 relationship、运行声音目录 21 项；继续核对内容语义差异，不能只按总数认定 matched。沿用同一 Soul Markdown 与既有五步，Quick Start 只能预填这条链。
4. 将 Recent、Characters、Presets、Created 和 Media 共同作为 My AI P0 核心面；Group Chats/Packs/Comics 作为 P1 对标缺口，发布前只显示明确 unavailable 空态或不暴露入口。
5. Generate 的 Create / Edit / 独立 Enhance 2×、已发布 reference lineage 与单段视频已真实交付。第三轮 Preset 浏览/编辑与分类目录、Gallery 过滤和整页刷新后的独立原请求核对已通过统一 Chrome 与测试；最终版本的图片/两条视频真实报告仍按验收索引收口。继续核对 Advanced seed / 合格 model 选择、多 scene / 可选时长 / 比例 / 质量 / AI voice Video 及精确 Chat Product Action 上下文交接；固定配方的规格显示不等同于新增可选参数。历史 pins、quote、settlement/refund 和 replay 幂等保持。
6. Creator Profile 跨页可达、路线图分页投票、Admin feedback 状态运营、CMS 发布后的 Resources 发现与分页已补齐并有真实 Chrome 证据。第三轮公开合集详情、分页、作者管理和原生媒体播放已通过统一 Chrome 与测试；继续覆盖 Feed / Community / Creator levels / Studio、Pack / Comic、非支付 Affiliate 归因运营、Images / Videos / Glossary / Authors 与完整内容族的真实数据、副作用和权限；不因这些入口存在就推定完整能力。收益、充值和支付执行保留为后续独立范围。
7. Pinned Memories、Custom Instructions 与 session 级回复长度/表达风格已实现，真实模型验证了版本冻结、重生成、no-memory 与清除。末条操作遮挡、失败图片 Retry 入口和 50 条以后会话可达性已通过统一 Chrome 与测试；第三轮 Scene 与全局用户 persona 已在 `eb7b9bef…` 完成四次真实模型请求、历史版本与新 Turn 冻结核对，样本不构成全面模型质量证明。回忆输出校验和正式自然召回已在 `ab995512…` 通过；后续补主动消息、以 2026-09-01 五档历史基线评估的功能等价 profiles、最多 12 角色 Group Chat 和双向 Voice Call。继续保持 Main 历史权威、official igrep、角色身份及 Product Action 连续性。
8. **本轮不执行支付范围**。后续独立工作仍包括 Upgrade/Profile 的 provider checkout → activation → expiry → repurchase，以及 coin store 的 offer → quote → one-time checkout → provider confirmation → 幂等 topup ledger → 购买历史。既有历史/媒体访问与一次性预付承诺保持；本轮内部测试加币不算用户充值产品闭环。
9. WPCU 保持 `official`；WSCU/WSCrU/WPSCU/WSR 保持 shadow/directional 诊断。补生产回放、成熟窗口和质量认证，但不执行指标 cutover。

退出条件：parity matrix 中每个目标域都有明确状态、真实产品能力与同 revision 浏览器/运行证据；所有公开声明与当前实现状态一致；指标保持 WPCU official 与其他诊断指标的正确层级。

## 2. 执行数据库 cutover

以下是仍含旧 Chat 数据的目标环境切换计划，不是要求当前本机重复迁移：本轮运行库已核对 82 个 migration、checksum 和关键约束。正式目标先发现实际状态，再由用户/CI在受控维护窗执行必要步骤：

1. 备份 Main PostgreSQL、旧 Chat schema、Blob、`CHAT_FS_ROOT` 和 DSH workspace。
2. pause 新 Turn admission、Chat、Gen/finalizer，确认没有 active attempt 或未知 terminal。
3. 部署 Main migration `20260827120000_main_chat_turn_authority`。
4. 执行 `db/sql/2026-08-27-chat-turns-to-main.sql`。
5. 对账 session、Turn、selected reply、attachment、Scene、usage/billing 引用的数量与哈希。
6. 以新 Main history/BFF 启动；旧 Chat schema 保持只读观察。
7. 观察期后再单独批准旧 schema/roles 的不可逆删除。

## 3. cutover 后清理迁移兼容面

- production cutover 对账通过后再清理不再可恢复的旧 runtime trace；本轮不做不可逆删除。
- recovery producer/executor/launch gate 已升级为 schema 2；已核准的 Main PG + AgentRun + DSH canonical/private + Blob + queue receipt bundle 按目标数据库、迁移校验、存储/队列 authority、manifest SHA 和有效期验证。单纯应用 source 改变不要求重复同一恢复演练；authority、迁移、恢复格式或有效期不再满足时重新生成并核准。历史 schema-1 bundle 只保留历史证据。

这些代码在实际 cutover 前保留是迁移保险；cutover 后继续长期保留才是结构债。

## 4. 目标 revision 的完整再验证

历史闭环证据见 `CURRENT_FUNCTIONAL_COVERAGE.md`；任何产品/代码切换后，目标 revision 仍必须重新覆盖：

- 创建会话、发消息、刷新恢复、编辑、重生成、取消。
- terminal exact replay；冲突 replay/旧 attempt 被拒。
- Chat 重启、SSE 重连、Main ACK fence、normal/private memory。
- 图片 create/edit ToolEffect、同 call replay、参数冲突、当前 attempt 附件过滤。
- Generation 成功 settle；失败/取消 refund；UI 与 ledger 一致。
- 账号删除对 Main Turn、Blob、AgentRun、DSH workspace 的顺序和幂等 completion。

记录实际 provider/model、request/attempt/artifact/delivery/settlement、耗时和费用。mock 或静态页面不替代真实链路证据。

## 5. 发布门

- PM2 实际进程、端口和 full readiness，不以 `online` 代替。
- 生产 domain/secret/Redis/BullMQ prefix/Blob/provider/Sentry 全部绑定同一 source revision。
- 在生产数据上重新执行备份与隔离恢复；旧本地 bundle 只算历史证据。
- 完整 authenticated Chrome 用户/运营旅程与观察窗通过后，再判断 public Go/No-Go。

## 完成定义

1. Main 是产品 Turn、附件、Scene、计费和展示的唯一权威。
2. Chat 只有 AgentRun/DSH 派生数据，没有数据库、queue、余额或产品消息副本。
3. 生成工具的 reserve/settle/refund 在 Main durable state machine 中幂等闭环。
4. 迁移专用兼容面在实际 cutover 后删除，文档、env、readiness 与运行拓扑一致。
5. 同一 revision 的 test/typecheck/build/lint、真实进程和产品 E2E 证据全部通过。
