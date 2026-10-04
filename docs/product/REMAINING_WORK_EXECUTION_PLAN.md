# iDream 剩余工作执行计划

更新日期：2026-10-03

本文件以最新状态列出尚未完成的工作，保留带日期的历史结果。已实施能力与证据见 [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md)。用户已确认先完成本机与部署材料，目标环境尚未提供；本轮排除支付、年龄检查、合规及 AF-03 收益/佣金/结算。

## 2026-10-03 16:07 UTC Scene 与三场景旁白剩余验收

工作树已落地 Scene policy27 的人物身份/关系来源核验、user checkpoint 保留，以及三场景旁白按真实帧数对齐、owner 保护失败状态、已完成语音复用与界面提示。源码 `d4817328…` 的定向 Chat242/Main23 全通过，三场景 ffmpeg 已核验画面顺序、尾音和帧数；[完整证据与限制](../../.scratch/scene-three-narration-20261003/REPORT.md)单独绑定，不重标历史真实失败。

1. 在授权运行环境恢复可用连接后，执行同源 Main Scene authority / VideoSequence 集成。当前最终复验因 PostgreSQL connect EPERM 为 0 执行；新增第三条旁白失败、缺失条重试、再次打包与持久化/下载/账本回归尚未获得最终数据库通过记录。Chat 全套 703 项中 7 项仍失败，须在可监听环境复验，保留原失败。
2. 对同源 Scene 按原 13 → 47 → holdout 7 执行真实模型语义资格，保持原评分、请求/资源预算和首败材料。来源身份核验的离线通过不证明实际抽取或 classifier 能力；明确名字误判 null/reference 等历史质量失败仍未关闭。
3. 完成真实三场景 Gen、固定 Pocket voice、合成、刷新持久化、逐段/完整下载、额度对账及失败恢复，记录实际 provider/model/workflow、request/attempt/artifact 与耗时。当前服务探测未连接且 PM2 控制 EPERM，未绕过 wrapper；已有两场景证据与本轮三场景 ffmpeg fixture 不替代这项完整产品验收。

## 2026-10-03 04:58 UTC 当前执行顺序

冻结434f8d/6610e59e已完成五包7343标准测试、coverage四门槛、全仓check及PM2177；后续3113700e/9494dfe0仅5文件增量，五包check与安装版Google Chrome built Main/Admin原174套件全部首次通过，0失败/重试通过/跳过，333.222秒。新旧证据独立绑定，原预算保持，自有资源已清。以下继续按真实剩余依赖推进，下面03:07及更早内容保留各自历史时点：

1. Feed侧栏清除聚焦状态已修复，原回归和整套174项Chrome首次通过；旧两次失败保留。后续canonical仍按精确文件差异维护资格，不无因重复全仓验证。[新完整Chrome证明](../../.scratch/full-product-audit-2026-10-01/verification/source-checkpoint-20261003T0445Z/e2e-native-chrome-built-20261003/RESULT_BINDING.json)。
2. Scene85e14原13真实筛选再次1PASS/1FAIL/11未执行，明确命名的人物被verifier判null/reference。保留原SSE/评分/身份检查/预算，在私有候选做最小诊断和回归，达标后才整合canonical与真实产品复验。
3. Parakeet12及固定Whisper8实际对照都已结束且quality RED，不启默认滤镜/切模型。25语言、真人低声与实体麦克风仍待独立材料/现场输入，不重复消费已闭合窗口。[真实Whisper结果](../../.scratch/full-product-audit-2026-10-01/asr-acoustic-review/paired-six/WHISPER_FIXED_CONTRAST_EXECUTION.md)。
4. 原launch CLI prepare已实现且177回归与完整gate差分通过，prepared永不签发资格；受限production bootstrap和目标网络/origin未闭合。最终gate已补同一四服务env参数，旧分析标历史。[部署材料](../../.scratch/full-product-audit-2026-10-01/verification/deployment/README.md)。
5. 最终canonical按精确差异补同源构建、运行与恢复绑定；媒体容量对标及目标DNS/TLS/存储/监控/公开Chrome资格仍待。支付/年龄/合规排除，完整需求保持；旧同边界恢复不重标为新source。

## 2026-10-03 03:07 UTC 执行状态补充

用户确认先完成本机与部署材料，公开目标未提供；支付、年龄与合规不在本轮范围。完整需求不因当前缺口缩减。

已闭合新的不可变 `60e814ce…` 五包7268测试/四原coverage门槛/五包check/PM2177；后续 `f494f22a…` 10文件增量check、Chat600、Main78+4、110迁移authority及14演练通过。其完整174 fixture E2E为168通过/2失败/4重试后通过，原完整结果保留，不能写成全通过。免费角色Moment preset与Admin Soul预览已补真实Chrome；Changelog两轮发布/权益隔离/撤下及只读清理、Webpack真实HMR与正式wrapper恢复均完成。证据入口为[本轮报告](../../.scratch/full-product-audit-2026-10-01/REPORT.md)。

按实际剩余依赖继续：

1. 逐条诊断上述fixture原trace，补Help Desk普通客户fixture的定向首轮证明；CMS组合超时、Create预览4/2及其他flake须有原请求/Job时序证据，不能直接扩大timeout或吞403。
2. 私有Scene统一原人物/指代/任务权限协议，保留原32与失败样本、预算/评分；完成私有冻结与只读审查后重新按原32GiB准入真实原13筛选，达标后再整合canonical与受控产品验证。原默认/27B/9B失败仍保留。
3. 12个新的Parakeet原音频/固定降噪HTTP已完成：噪声改善但clean回归，EL/FR仍RED，不启默认。固定Whisper候选仅准备最少8个新增对照，必须与Scene窗口串行、原decoder/gold/质量/资源阈值不变；25语及母语/实体听感继续待验。[实际报告](../../.scratch/full-product-audit-2026-10-01/asr-acoustic-review/paired-six/EXECUTION_RESULT.md)。
4. 完成原launch CLI离线prepare阶段，明确prepared与launchQualified=false，原完整gate不变；首次production完整循环仍需受限bootstrap、启动前待执行工作核验和真实网络隔离。域名/设施未提供时不编造隔离receipt、origin或新PM2 daemon来签发资格。[独立复审](../../.scratch/full-product-audit-2026-10-01/verification/deployment/cold-bootstrap-independent-review-20261003/REVIEW.md)。
5. 最终canonical稳定后按实际差异补检查与运行绑定，保留全部旧snapshot/恢复/probe标签；完成图片/视频容量matched/equivalent/divergence及目标DNS/TLS/存储/监控/公开Chrome资格。既有e4bc完整恢复只证明其原source，不自动继承。

## 2026-10-02 当前待办

CH-16 profile、Voice Call 106、AF-02 107、免费 Packs 108 和 GN-19 109 已实施；CMS 四族 10 个发布路由、Comics 发布→游客阅读→真实 Remix→撤下、合集撤回、Support 和 Create CAS 已有真实 Chrome 单域证据。不要重复将这些列为待开发，也不能据此签发整个新 source。具体范围和证据见 [2026-10-02 覆盖记录](CURRENT_FUNCTIONAL_COVERAGE.md#2026-10-02-当前实施单域证据与未取得的资格)。

1. **质量资格**：canonical Scene policy18仍未通过；私有20、21、22和固定9B模型比较均保存真实首败及未执行case，不合入候选、不放宽原47/root7断言。默认Redux及turbo的部分语言/带噪ASR未通过；完整large-v3原7输入/评分不变的有界比较已结束且仍RED，不切默认，25语言、真人低声/噪声和物理麦克风尚未验收。默认图/视频历史像素失败保持，新的Iris素材及GN-19两场景有具体成功样本，不推及所有构图和Catalog组合；H3仍禁用。
2. **剩余真实用户资格**：恢复码、Roadmap、Follow/Following、Studio暂停与同Release恢复、worker主动消息的交付/未读/不重发/关闭均已完成。新事实边界指令经59项标准集成与一次真实worker有限复验，未再编造用户偏好；回复重复与长期质量仍待。保存Look、聊天图片与v7 Animate真实生成/播放/下载/扣费已对账；My AI副本管理、Feed Comic阅读/精确Remix、客服三消息/运营结案、Community作者/筛选/两Campaign轮播CTA及站内公告接收/关闭/停用也已补齐。A七条临时权益已精确清除，指令恢复；发布测试内容正常撤回/暂停。视频取消DB12/12+mounted10/10与麦克风24界面/10集成已绿，实体Mac静音录音保留/Discard/End已实测，真人人声质量仍待。邮件订阅明确尚未提供；站内通知不替代邮件。最终复验针对新变化与仍缺的质量，不重复已闭合入口。
3. **统一版本收尾**：最新受控CI至05e58c/a92e860，7145pass/0fail/4opt-in skip，全Main fresh coverage四门槛、全仓check/五包build、PM2 174/174和110 migration/14 rehearsal均通过；完整fixture E2E保留173passed+1flaky，修正账号测试旧Login导航竞争后原完整单例首次通过。两处最终夹具改动各有全文件hash关联，旧RED/原trace保留，不重标旧运行。主动消息指令增量另有59/59标准集成、Main类型/lint与真实worker证据；最终source/runtime及构建关联以[独立封存](../../.scratch/full-product-audit-2026-10-01/verification/FINAL_SOURCE_BINDING.md)和实际恢复记录为准，不重复将已通过的全仓检查列为未执行。
4. **本机恢复与部署材料**：完整Main PG+Blob+AgentRun+official DSH canonical/private+queues/ACL已在50f、d838两独立新名bundle真实quiesce/恢复/hash/ACL/cleanup，并经官方wrapper重启/11在线/source/Sentry/ownership验证。后续增量的最终新名bundle与runtime绑定见[实际执行记录](../../.scratch/full-product-audit-2026-10-01/verification/deployment/full-recovery-local/EXECUTION_RESULT.md)，不能重标旧bundle。目标环境未提供，本机演练不代表公开上线；部署模板、TLS/邮件/声音authority与首次启动步骤按实际契约交付，生产HTTPS、对象存储、监控和负载须在目标环境另验。wrapper生产首次冷启动仍有launch gate依赖已运行服务的确定性顺序缺口，最小实施计划已交付但未修复；真实入口隔离须先获目标配置，不能添加绕过门禁的参数冒充启动资格。

2026-10-01 已按源码将 Group Chat、主动消息、Advanced seed/model、精确 Chat 生成上下文、Comics、Coin Store 和 Affiliate 已发布条款/用户 UI 从“待开发”改为“已有实现、资格单独验收”。本轮只清理状态，不继承历史报告的通过结论，也不预先签发尚待执行的完整质量验证。

2026-10-01 的历史 Scene runner 为16个真实样本、4通过/12失败；当时 nullable delta、来源绑定编辑与纯净传输候选未获 provider 质量资格、未接入产品。失败断言和日志保持；后续policy14属于历史，当前policy18状态以上方2026-10-02记录及[交接](../../.scratch/full-product-audit-2026-10-01/scene-current-relations-handoff-20261002.md)为准，冻结快照/锚点保护不等于语义合格。

2026-09-02 起的多轮审计已实际完成 Create、单角色 Chat、图片、默认 RedGraft 视频、Admin 角色与客服运营的核心闭环。候选 `ab995512…` 的 4,955 条默认测试、146/146 Chrome、正式自然记忆与模型交付证据见 `CURRENT_FUNCTIONAL_COVERAGE.md`；最新增量验证及各版本归属见 `.tmp/product-audit-20260902/FINAL_REPORT.md` 和 `iteration3-validation.json`。H3 最新样本未通过视觉验收，已停用前台新选择，不能将其技术交付成功视为质量合格。支付、年龄检查与合规不在本轮范围。

分期统一见 [PRD §12](PRD.md#12-交付阶段与完整范围)。2026-09-06 用户已确认先集中完成核心体验、默认路线性能和可信运营数据；这调整工作顺序，不删除完整 OurDream 对标需求。当前实现与本轮验收入口见 [核心体验验证](CORE_EXPERIENCE_VALIDATION.md)。

## 2026-09-30 语音输入发布资格

Mic → draft → 明确 Send 的单聊/群聊实现及受控真实链路已完成，见当前覆盖及 `.scratch/chat-voice-input/VERIFICATION.md`；不再把按钮、ASR gateway 或免费输入计费隔离列为待实现，也不把这项能力当作双向 Voice Call。

固定 Parakeet Redux 的本次真实质量筛选失败：希腊语普通 WER 36.34%，法语 / 德语白噪声样本超门槛，法语含方向意义错误。下一步须解决这些已复现误差并补齐其余 19 语、每语至少三说话人、真实耳语及真实环境噪声、陪伴情境词汇与人工关键意义验收；完整材料要求见 `.scratch/chat-voice-input/PRD.md`。公开 FLEURS 朗读和数学衰减 / 加噪不替代上述材料。还须验证实际桌面 Chrome / Firefox / Safari、iOS Safari / Android Chrome 的权限、录音格式、中断与 Done→draft p95，以及目标部署的 RSS / 持续负载和 Photon usage 遥测出站策略。当前真实 gateway p95 与两次虚拟输入浏览器延迟不签发这些发布门禁。

## 下一工作顺序

2026-09-09 已完成账号/凭证、已购权益、生成接纳、角色素材和 Voice 同意的确定性架构修复，见 实施与验收。不要继续把这些已实施项列为待启动。场景已修复跨说话者上下文被重排、合法首响应被丢弃重采样及流式首字/idle 混用，Main 也已守住统一 Scene v1 形状和冻结锚点的一次推进；正式 1024 token 样本仍有完整输出中的关系遗漏，不能盲目扩预算或强制拒绝全部图片关闭事项。持续 Scene 已做完整快照/局部变更、native/JSON 与低温的 7 次隔离资格；确认了上游 nullable-container 解析缺陷，但排除该问题后仍未通过核心语义例，后续样例与未见例未消费。下一步需要有针对性的语义能力证据，再做新增调用失败/取消/成本以及旧 Scene→语音格式的完整切换，不继续堆正则或把已失败接口直接上线。记忆 64KiB 缓冲已保留官方恢复且逐会话字节一致，10,002 条完整投影单次 A/B 仅 13.41→13.11s；主瓶颈已定位为上游全历史 secret-shield 扫描，需可维护的上游源码或已修复版本，不在 Chat 复制私有恢复协议或跳过保护。10k 真实 recall/首字、跨平台与长期质量仍需独立验证。

1. **先修已复现的体验质量**：固定五角色工具与真实产物已建立，两个完整技术旅程和三个独立媒体范围分别有证据。强制图片工具丢弃历史/召回的确定性故障已修复，真实场景遵从需继续按版本验收。igrep误撤回已用原版 CLI 和隔离模型提议复现到实际删除；Main 来源保护已加入坏候选拒绝与官方 fresh-ingest 恢复，验证边界见来源保护报告。上游仍需可维护源码或已修复版本，在副作用前验证用户授权并解决 profile 语义；保留对话纠正和 Main 删除重建。精确事实与用户动作保真、改图附带重绘仍待质量修复；保持旧失败与独立新样本分开。声音全量听感、中文/anime/长对话与真实跨日回访仍未评，不再把“运行五个样本”本身列为未启动。

2. **默认生成速度与容量**：优先默认图片、身份图与 RedGraft。按版本分别记录实际排队、执行与端到端分布，保持模型、规格、输入和质量可比较；稳定参考缓存与性能分段已进入实现，实际收益以对照报告为准。共享设备串行等待与纯执行耗时分别处理，不用换模型或缩小规格掩盖原因。
3. **从工程可观测走向经营证据**：指标自动物化和只读诊断已实现；接下来补足真实 eligible facts、成熟窗口、有效定义与质量认证。WPCU 保持 official，本地 audit/internal 数据与未认证值不作真实留存或经营判断。
4. **按证据完成资格**：CH-16 profiles、双向 Call、免费 Packs、AF-02 与 GN-19 已实施，按最新待办补实际尚缺的质量和同版旅程资格。Comics 等单域闭环保留原 source；Pack 购买、Coin Store 真实支付、创作者/联盟收益结算属于后续独立范围，本轮不执行。

前 3 项形成一个完整里程碑：用户愿意继续同一角色的互动，生成等待可解释且有实测改善，运营能看见可信且可行动的事实。H3 继续隔离，稳定复验是重新启用的前提；不把实验后端恢复置于默认用户体验之前。

## 当前状态

- 代码已把 Companion Chat 产品权威迁到 Main PostgreSQL：`RecentChat`、`ChatTurn`、`ChatTurnAttachment`。
- `packages/chat` 已移除 Prisma/PostgreSQL/BullMQ；其深模块内嵌执行 AgentRun、DSH/igrep，成功 run 在 Main ACK 后清理。
- 图片 ToolEffect 已进入 Main Generation/Ledger，不采用成功后普通 hook 扣费。
- Main migration 和旧 Chat 数据导入脚本已经存在，但本仓库修改不会替用户连接生产库执行。
- 2026-08-31 的实现审计已记录 Character/Admin 与 Companion 的当前证据；本文件不复述已完成项，任何运行态完成声明继续以 `CURRENT_FUNCTIONAL_COVERAGE.md` 和同 revision 验证为准。
- 2026-09-01 的产品决策是完整对标 OurDream；WPCU 保持 Metric Registry `official`，WSCU/WSCrU/WPSCU/WSR 保持诊断用途，不存在待执行的北极星切换。目标文档仍不能冒充已上线能力。

## 1. 收口完整 OurDream 对标缺口

H3 首帧叠影与构图跳变仍需稳定修复和质量复验，当前保持禁用；重新启用须按合法 recipe/profile 版本发布，不能直接修改历史 pins。默认 RedGraft 的技术交付与像素质量分别验收，GN-19 v7的两场景真实资格已取得，其他组合与最终统一source仍待。用户尚未提供目标环境，先完成本机与可执行部署材料；正式主机/访问、HTTPS 主站和受保护 Admin、对象存储及 Sentry 等生产 authority 不能填假值。本机 development、旧探针或正常 seed 不代表完整生产验收，也不放宽既有 launch gate。

1. 已建立 [域级对标矩阵](PRODUCT_PARITY_MATRIX.md) 和需求/用户故事映射；继续下钻到逐功能、逐 Catalog 项与同版本运行证据，覆盖 Explore、完整 Create、Chat、Generate、My AI/Profile、Feed/Community/Creator Economy、Upgrade、Affiliate、Support 与公开内容。每项绑定 OurDream 可验证契约、iDream 当前代码/运行证据、真实缺口和退出 Gate。
2. 区分“未实现空态”、“受 feature/provider/entitlement 条件限制”、“本地受控可用”和“公开生产已认证”，不用路由存在或历史截图代替能力证明。
3. Create 五步链及目录扩展已有实际证据：48 personality / 135 occupation / 29 relationship、运行声音目录 21 项；继续核对内容语义差异，不能只按总数认定 matched。沿用同一 Soul Markdown 与既有五步，Quick Start 只能预填这条链。
4. 将 Recent、Characters、Presets、Created、Media、Group chats 与免费 Packs 作为实际资产入口核对。免费 Pack 108 已完成私有副本、immutable Grant、撤下/封禁边界及原生领取/下载/播放闭环；不可将其写成普通合集或 Pack 购买完成。Comics 已有发布→游客阅读→真实 Remix→撤下单域证据，各域仍须完成新 source 的组合资格与对标判定。
5. Generate 的 Create / Edit / 独立 Enhance 2×、reference lineage 与单段视频已有真实交付。Advanced seed/model、精确 Chat context 和 gated Chat Animate 已实现。GN-19 109 已实现 1–3 scenes、时长/比例/质量选择、可选英文 voice 与 composition lease；当前v7/workflow4已有两场景真实生成/旁白/合成/下载/ledger证据；其他组合和最终统一source仍待。默认图/视频像素失败继续处理；历史 pins、quote、settlement/refund 和 replay 幂等保持。
6. Images / Videos / Glossary / Authors 四族已有 10 个实际发布路由及 Chrome index/detail/CTA 证据，Comics、合集撤回与 Support 也已有单域闭环。继续核对其余内容库存、Feed / Community / Creator levels / Studio 与同版组合资格。AF-02 107 已实施；同 IP/UA 独立客户修复的 Chrome F scoped proof 已成功、E RED 保留，新 whole-source wrapper 资格待取。AF-03 与 Pack 购买本轮排除；2026-09-13 审批报告保留原日期与范围。
7. Pinned Memories、Custom Instructions、主动消息与 Group Chat 已实施，继续补权限变化、调度恢复、角色/记忆隔离与真实媒体资格。CH-16 Catalog 及偏好/Turn 快照、Voice Call 106 已实施；Call 仅已有本机受控 English recorded-upload 和恢复证据，physical mic/欧洲 25 语未 qualified。Scene canonical policy18仍未语义qualified，私有20/21/9B原失败保留，未切默认。保持 Main 历史权威、official igrep 和 Product Action 连续性。
8. **本轮不执行支付范围**。Upgrade/Profile 的预付访问及 Coin Store 独立 offer / checkout / provider-confirmed 幂等 topup / 购买历史已有实现；后续独立验证真实支付确认、唯一入账/激活、原任务恢复、迟到/重复通知、expiry / repurchase。既有历史/媒体访问与一次性预付承诺保持；内部测试加币不算用户充值产品闭环。
9. WPCU 保持 `official`；WSCU/WSCrU/WPSCU/WSR 保持 shadow/directional 诊断。补生产回放、成熟窗口和质量认证，但不执行指标 cutover。

退出条件：parity matrix 中每个目标域都有明确状态、真实产品能力与同 revision 浏览器/运行证据；所有公开声明与当前实现状态一致；指标保持 WPCU official 与其他诊断指标的正确层级。

## 2. 执行数据库 cutover

以下是仍含旧 Chat 数据的目标环境切换计划，不是要求当前本机重复迁移。旧轮核对 82 个 migration 的证据保留历史范围；2026-10-02本机已执行并核对110条名称/checksum 与新增表 app-role 权限，见[恢复准备材料](../../.scratch/full-product-audit-2026-10-01/verification/deployment/full-recovery-local/README.md)。正式目标尚未提供，后续先发现实际状态，再在受控维护窗执行必要步骤：

1. 备份 Main PostgreSQL、旧 Chat schema、Blob、`CHAT_FS_ROOT` 和 DSH workspace。
2. pause 新 Turn admission、Chat、Gen/finalizer，确认没有 active attempt 或未知 terminal。
3. 部署 Main migration `20260827120000_main_chat_turn_authority`。
4. 执行 `db/sql/2026-08-27-chat-turns-to-main.sql`。
5. 对账 session、Turn、selected reply、attachment、Scene、usage/billing 引用的数量与哈希。
6. 以新 Main history/BFF 启动；旧 Chat schema 保持只读观察。
7. 观察期后再单独批准旧 schema/roles 的不可逆删除。

## 3. cutover 后清理迁移兼容面

- production cutover 对账通过后再清理不再可恢复的旧 runtime trace；本轮不做不可逆删除。
- recovery producer/executor/launch gate 已升级为 schema 2；Main PG + AgentRun + DSH canonical/private + Blob + queue receipt bundle 必须按目标数据库、迁移校验、存储/队列 authority、manifest SHA 和有效期验证。本机110同边界完整演练尚未执行；实际 dump/restore、文件字节/路径/ACL、owner/grants、queues 和安全清理均需 proof，不能只证明 PG 计数。authority、迁移、恢复格式或有效期变化时重新生成并核准；历史 schema-1 和 PG-only 证据保留原范围。

这些代码在实际 cutover 前保留是迁移保险；cutover 后继续长期保留才是结构债。

## 4. 目标 revision 的完整再验证

历史及本次单域证据见 `CURRENT_FUNCTIONAL_COVERAGE.md`；当前源码新增与 merge 后尚未最终冻结，全量 runner 继续等待最终 source。目标 revision 必须重新覆盖以下风险，不能把旧 `57adf7f…` 媒体或跨 source 的视频组合成全通过：

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
