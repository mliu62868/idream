# iDream 当前功能覆盖

运行证据截至：2026-10-03。文档整理：2026-10-04；本次未新增功能验收。

本页按产品领域保留最后可用的实施与运行证据及其限制。完整需求见 [PRD](PRD.md)，未闭合工作仅在 [剩余计划](REMAINING_WORK_EXECUTION_PLAN.md) 维护。不同 source 的成功不能拼成当前工作树全通过；本机 development、fixture 和有限样本也不签发公开生产。

核心用户/运营链和完整恢复已有受控本机证据；Scene、记忆、图片/视频及 ASR 仍有质量失败。目标生产环境尚未提供，真实支付、身份年龄验证和商业结算未由这些记录关闭。

## 身份与账号

登录、注册、退出、账号恢复、删除与跨账号隔离已有实现。10月2日完成真实恢复码消费、旧会话/旧密码/已消费码拒绝、替换码再次消费及原资产/会话恢复；删除和账号旅程另纳入所测版本的完整 fixture 检查。

证据：[10月1–3日真实产品记录](../../.scratch/full-product-audit-2026-10-01/REPORT.md)。自助 age gate 与第三方身份年龄验证分别判断，真实年龄 provider 未在该轮执行。

## 发现与公开内容

Explore 搜索/筛选、详情、Following、公开/链接可见边界与 CMS 内容发布已有实现。10月2日 Images/Videos/Glossary/Authors 四族的 10 个发布路由及 index → detail 已在真实 Chrome 检查；Changelog 的运营发布、会员读取、免费/匿名隔离和撤下在10月3日完成受控复验。

证据：[四族路由](../../.scratch/full-product-audit-2026-10-01/browser/cli/cms-real-chrome-ten-routes.txt)、[逐族导航](../../.scratch/full-product-audit-2026-10-01/browser/cli/cms-real-chrome-family-click-through.txt)、[Changelog 持久化](../../.scratch/full-product-audit-2026-10-01/changelog-second-cycle-final-db-proof-20261003.json)。这些样本不证明全部内容库存、搜索相关性或公开目标环境；未发布页面不能以模板占位。

## 角色创建与发布

完整创建、可恢复草稿、视觉/声音候选、私有使用、Release/Serving 和编辑管理已有实现。10月2日两标签草稿 CAS、客户 preview → 运营素材 → Hero/Chat 真实生成 → 发布 → 独立发现/聊天 → 暂停/恢复已形成受控链；Follow/Studio、My AI 复制/编辑/私有恢复/删除另有单域记录。

证据：[草稿竞争](../../.scratch/full-product-audit-2026-10-01/browser/draft-two-tabs-cas.txt)、[发布与运营记录](../../.scratch/full-product-audit-2026-10-01/REPORT.md)。五步创建须按完整字段、恢复、预览与发布证明六类任务等价；目录数量不等于语义对标。创作交接与独立发布界面的完整分离仍需实际操作证明。Hero 的 full-body 请求产出腰上构图，保留为质量限制。

## Chat 与记忆

| 能力 | 最后记录的实施/证据 | 限制 |
| --- | --- | --- |
| 产品 Turn 与修订/恢复 | Main 保存 Turn、选中 attempt、附件与用量；Chat 只执行 AgentRun。发送/刷新/编辑/停止/重生成和原键恢复已有受控证据 | 后续源码按实际差异重新绑定，执行成功不证明人格、场景和事实质量 |
| 控制与群聊 | Pinned Memories、Custom Instructions、表达偏好、Scene 控制、2–12 角色群聊和版本化 conversation profiles 已实施 | 每档表达质量、群聊身份/记忆隔离、媒体与费用恢复及 Catalog 等价性仍分别验收 |
| 主动消息 | 单聊 opt-in 与调度已实施；10月2日事实边界修复后，正常 Chrome 设置/正式 worker/刷新/唯一用量有有限真实复验 | 原回复编造偏好保留；修复样本仍复用上一回复，不证明长期主动性；受控推进不等于六小时墙钟观察 |
| Scene | 10月3日记录 policy27 来源核验、人物身份/出入场及 user checkpoint 的定向修复 | 真实语义未 qualified；原命名人物被误判 null/reference、在场漏抽和离场人物仍在场的失败未被协议测试关闭 |
| 关系记忆 | Main 来源完整性、编辑/删除隔离、异步重建与官方 fresh-ingest 恢复已实施 | 上游误撤回/授权、精确事实表达、全历史扫描成本、10k recall、首字及长期质量未关闭 |

证据：[完整运行记录](../../.scratch/full-product-audit-2026-10-01/REPORT.md)、[主动消息原失败与有限复验](../../.scratch/full-product-audit-2026-10-01/proactive-fact-boundary-20261002.md)、[Scene/媒体原失败](../../.scratch/core-quality-remediation-20261001/REPORT.md)、[9B 资格失败](../../.scratch/core-quality-remediation-20261001/scene-model-candidate/RESULT.md)、[Scene 最新定向修复](../../.scratch/scene-three-narration-20261003/REPORT.md)。上游误撤回的原独立故障注入材料当前不在工作区，须补充材料并核验新版本，不能把旧文字记录当作当前复验。

Scene 后续仍按有界筛选与独立 holdout 取得资格，不改 gold 或用新版本标签覆盖旧失败。Prompt、缓存与执行策略的实时值由实际源码和运行身份证明，本页不重复维护。

## 图片

Character/Freeplay、Image Edit、Enhance、Presets/Look、参考来源、冻结上下文、请求核对、交付、下载及扣退已有实现与受控样本。技术交付和像素任务分别判断：

| 具日期样本 | 技术/费用 | 任务质量 |
| --- | --- | --- |
| 10月2日默认图 | 交付、唯一 5 coin 扣费通过 | 温室任务变成晴天游艇，FAIL |
| 10月2日单源 edit / 双参考 identity edit | 交付通过 | 指定修改/身份与来源场景保留通过；不代表逐像素不变或完整局部编辑资格 |
| 10月3日源图＋身份参考加速 | 同图/指令/seed，832×1024；原生执行 479.118 → 81.536 秒 | 所测人物、衣着、杯子、姿势与构图保持，仅为该样本 |
| 10月3日身份锚＋补充参考 | 原生执行 84.520 秒，两张参考实际进入编码/采样 | 本机所测路线有效，不代表全部人物、风格或生产容量 |

证据：[原媒体审阅](../../.scratch/core-quality-remediation-20261001/REPORT.md)、[Look 与产品交付](../../.scratch/full-product-audit-2026-10-01/REPORT.md)、[多参考对照](../../.scratch/qwen21-multi-acceleration-20261003/REPORT.md)。等待分布、同质量性能/容量及全面身份/编辑质量仍需独立证据。

## 视频

Chat Animate 与 Generate GN-19 是独立能力，均已有实现；自然语言视频工具仍须独立 Product Action 契约与发布。已授权的历史视频不因新能力关闭被锁回。

| 范围 | 最后受控证据 | 未关闭的资格 |
| --- | --- | --- |
| Chat Animate | 10月2日已交付图片 → 报价/确认 → 真实视频 → 刷新/播放/下载，唯一 100 coin；所测角色/衣着/阳台及动作保持 | 新 source、其他人物/输入及完整质量/容量 |
| GN-19 两场景旁白 | 真实 Chrome 完成 RedGraft-LTX2.5、Pocket Anna 旁白、合成/播放、逐段及完整下载，精确两次 100 coin | 仅证明所测两场景和参数，不证明三场景或全部 Catalog |
| 三场景修复 | 10月3日按解码帧数对齐、composition owner、复用已保存声音及缺失提示有定向/真实 ffmpeg 证据 | 数据库集成当时因 connect EPERM 零执行；真实模型/Pocket/Gen 三场景完整链未运行 |
| 默认 RedGraft / H3 | 原默认视频请求完成且唯一扣费，但像素任务失败；H3 历史视频出现双脸叠影后已停用新选择 | 默认视频执行跨源码 merge，不能签发统一 source 资格；H3 重新启用须独立稳定视觉复验与显式发布 |

证据：[视频产品记录](../../.scratch/full-product-audit-2026-10-01/REPORT.md)、[两场景旁白回读](../../.scratch/full-product-audit-2026-10-01/gn19-narration-asr-actual-20261002.md)、[三场景定向修复](../../.scratch/scene-three-narration-20261003/REPORT.md)、[像素失败](../../.scratch/core-quality-remediation-20261001/REPORT.md)。H3 保持禁用。

## 声音

| 链路 | 最后记录的实施/验证 | 未取得的资格 |
| --- | --- | --- |
| Mic 输入 → 草稿 → Send | 单聊/群聊已实施；9月30日 native MediaRecorder → Main/ffmpeg/Redux → 草稿及手动发送有受控 Chrome/PG/用量证据 | 虚拟真人音频输入不代替实体麦克风；设备/语言/真实耳语独立验收 |
| Voice Clip | Pocket/Fish 身份、Play、原 attempt 缓存、恢复及唯一用量已有实现和短样本 | 声音全量听感、全部角色身份和部署容量；片段不证明通话 |
| Voice Call | English recorded-upload → ASR → Chat → Pocket → 播放/持久化、中断 resume 与自然过期 quote 恢复有10月2日本机证据 | 实体人声、目标浏览器/手机、欧洲语言和连续会话质量 |

证据：[输入与费用隔离](../../.scratch/chat-voice-input/VERIFICATION.md)、[通话恢复](../../.scratch/full-product-audit-2026-10-01/browser/call-recovery-final.json)、[自然 quote 过期](../../.scratch/full-product-audit-2026-10-01/call-quote-real-chrome-natural-expiry-green.json)、[整轮声音记录](../../.scratch/full-product-audit-2026-10-01/REPORT.md)。实体 Mac 25秒静音保留/丢弃与零 Turn/TTS/扣费仅证明权限和资源边界，不证明真人人声质量。

**ASR 质量仍 RED**：希腊语普通、法语及部分带噪语义未达标；Parakeet/Whisper 固定比较已结束且未切默认。数学衰减、公开朗读和人工加噪不替代真实耳语材料；25语、每语说话人广度、关键意义人工验收及 Safari/Firefox/手机仍缺资格。证据：[原语言质量](../../.scratch/chat-voice-input/qualification/REPORT.md)、[Whisper 与材料核验](../../.scratch/full-product-audit-2026-10-01/asr-whisper-evaluation/materials-and-next-candidate-readonly.md)、[固定请求对照](../../.scratch/full-product-audit-2026-10-01/asr-acoustic-review/paired-six/EXECUTION_RESULT.md)、[独立音频/decoder 复核](../../.scratch/full-product-audit-2026-10-01/asr-acoustic-review/paired-six/ASR_DECODER_INPUT_REVIEW.md)。

## 资产与社区

My AI/媒体搜索与稳定分页、下载、收藏、删除、Presets、Collections、Comics、Creator Profile/Studio、Follow 与免费 Packs 已实施。10月2日 Comics 发布 → 游客阅读 → Remix → 撤下、合集撤回保留私有成果、免费 Pack 发布 → 独立领取/下载/播放 → 撤下保权 → Admin block 保 receipt/拒内容均有单域真实 Chrome 记录。

证据：[出版与阅读](../../.scratch/full-product-audit-2026-10-01/browser/publication-complete.json)、[合集权利](../../.scratch/full-product-audit-2026-10-01/browser/collection-retraction-fixed.json)、[免费 Pack](../../.scratch/full-product-audit-2026-10-01/packs-native-chrome-20261002.md)。免费领取不证明付费 Pack 购买；单域样本不签发全部库存和最终同版组合资格。

## 经济与联盟

预付访问、不可变 offer、权益派生、Coin Store 独立 checkout/topup、报价、账本和扣退已有实现。一次性访问不自动续订，到期保留既有历史/媒体。真实支付、用户充值、付费 Packs 及 AF-03 创作者/联盟收益和结算未在10月1–3日验证范围内。

AF-01 用户申请/回执/结果、条款版本与 dashboard 已实施；AF-02 链接/素材及不可变归因也已实施。原 Chrome E 归因失败保留；修复后 Chrome F 完成真实 landing/click/signup、private recovery/Continue、PG 唯一归因与唯一 signup grant，但仍是原 scope/source 的证据。

证据：[AF-02 修复与回归](../../.scratch/full-product-audit-2026-10-01/affiliate-browser-identity-handoff-20261002.md)、[原归因失败](../../.scratch/full-product-audit-2026-10-01/affiliate-real-chrome-e-attribution-red.json)、[F 归因](../../.scratch/full-product-audit-2026-10-01/affiliate-native-signup-f-observation.json)、[账本核对](../../.scratch/full-product-audit-2026-10-01/affiliate-real-chrome-f-ledger-green.json)。运行的 offer、价格和资格以目标环境 authority 为准；内部加币不算充值。

年卡语音月度承诺与默认字段/滚动窗口存在待核验差异；首次年付促销尚缺独立兑现证据。具体口径统一见 [经济规格](ECONOMY_AND_PRICING.md)。

## 支持与运营

真实工单回执、客户补充/运营回复、状态/关闭与 Case 导航已有实现和10月2日受控用户/运营闭环；Roadmap 提交/投票/状态同步、站内公告发布/接收/关闭/停用亦有记录。邮件订阅尚不可用，站内公告不代替邮件。

角色、素材、生成、Case/Incident、权限/审计和配置操作由 Main 领域命令承接。日常角色/素材没有人工评分或批准关卡；创作与发布分开，只有显式 publish 改 Serving。`MODERATION_PROVIDER=mock` 保留基础未成年拦截，safety-gateway 保留但不启用；政策分类不代表机器完整覆盖。

证据：[工单闭环](../../.scratch/full-product-audit-2026-10-01/browser/support-complete.json)、[Case 导航恢复](../../.scratch/full-product-audit-2026-10-01/browser/admin-case-navigation-pending-green.txt)、[运营与公告](../../.scratch/full-product-audit-2026-10-01/REPORT.md)。当前独立发布界面、公开政策版本/联系渠道及 SLA 仍需实际证据。

## 经营指标

WPCU 保持 official；WSCU/WPSCU/WSCrU/WSR 是关系/创作诊断。指标物化、周期单飞刷新、只读诊断与显式认证入口已有实现；有数值不等于可用于经营。

9月13日开发认证拒绝不合格事件并因证据不足返回退出码 2。真实 eligible facts、成熟窗口、生产回放、certified snapshot 及完整现金/退款成本仍缺资格，内部/测试事实不能充当真实留存。证据：[经营与运营续修](../../.scratch/admin-operations-20260912/continuation-20260913.md)。定义见 [PRD](PRD.md)与[后台规格](BackendFeatureSpec.md)，验证见[核心体验](CORE_EXPERIENCE_VALIDATION.md)。

## 部署与恢复

Main PG 持有产品事实；Chat 无数据库。recovery producer/executor/launch gate 已使用 schema2，统一 Main PG、AgentRun、official DSH canonical/private、Blob 与 durable intent/receipt。10月2日 migration110 边界的两轮独立新名 bundle 已真实恢复并核对字节/hash/ACL/receipt、隔离清理和 wrapper ownership，证据绑定各自 source。

证据：[最终源码封存](../../.scratch/full-product-audit-2026-10-01/verification/FINAL_SOURCE_BINDING.md)、[完整本机恢复](../../.scratch/full-product-audit-2026-10-01/verification/deployment/full-recovery-local/EXECUTION_RESULT.md)。不重复已完成的本机迁移，不把旧 bundle 重标为新版本或生产证明。

离线 launch prepare 已实施并保持 `launchQualified=false`；受限生产首次启动仍有 bootstrap/网络/origin 顺序缺口。目标主机、HTTPS、受保护 Admin、生产存储与监控 authority 尚未提供。证据：[冷启动分析](../../.scratch/full-product-audit-2026-10-01/verification/deployment/cold-bootstrap-analysis.md)。操作按[运维手册](../architecture/10-operations.md)、[生产配置](PRODUCTION_SECRET_CHECKLIST.md)和[上线验收](LAUNCH_READINESS_AUDIT.md)。

## 验证范围与限制

| 记录日期与 source | 实际检查 | 原证据与限制 |
| --- | --- | --- |
| 10月3日04:05冻结 / source `6610e59e…` | 五包7343通过、0失败、4原 opt-in 跳过；原 coverage、lint/type/build 与PM2通过 | [汇总](../../.scratch/full-product-audit-2026-10-01/verification/source-checkpoint-20261003T0405Z/SUMMARY.json)，只属于该 source |
| 10月3日04:45冻结 / source `9494dfe0…` | lint/type/build通过；built Main/Admin 上原生 Chrome 174/174首次通过 | [与测试源的5文件差异](../../.scratch/full-product-audit-2026-10-01/verification/source-checkpoint-20261003T0445Z/DELTA_BINDING.json)、[Chrome/清理绑定](../../.scratch/full-product-audit-2026-10-01/verification/source-checkpoint-20261003T0445Z/e2e-native-chrome-built-20261003/RESULT_BINDING.json)；fixture不证明真实provider质量 |
| 10月3日16:07 / 源码摘要 `d4817328…` | Scene/三场景定向与ffmpeg通过；Chat全套尝试696通过/7失败 | [原报告](../../.scratch/scene-three-narration-20261003/REPORT.md)；Main最终DB集成零执行，真实三场景链未运行 |

后续工作树变化不能继承上述全套通过。每条新证据至少绑定 source、时间/环境、实际动作、provider/model/workflow、request/attempt/artifact、交付/持久化与费用结果，并记录失败和未执行范围。

已完成或被取代的过程日志、旧 schema/runner 方案不再保留在产品目录；原记录从 git 历史追溯。本地 `.scratch/` 链接是本机证据入口，跨环境审查须显式交付原材料，不能只凭文件名认证。
