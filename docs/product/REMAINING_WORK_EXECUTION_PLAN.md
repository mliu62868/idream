# iDream 剩余工作执行计划

更新日期：2026-10-05（ASR仅英语；运行证据仍绑定原日期与源码）

本文件只维护当前未闭合的产品结果、依赖与退出条件。完整范围由 [PRD](PRD.md) 决定，已实施能力和历史失败由 [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md) 保存；按域映射见 [对标矩阵](PRODUCT_PARITY_MATRIX.md)。文档梳理没有产生新的功能验收。

最近记录的实施工作先完成本机与部署材料，目标环境尚未提供；支付、年龄检查、合规与 AF-03 收益/佣金/结算不在该轮实际验证范围。这是具日期的执行边界，不取消完整产品需求，也不将下一轮真实支付等动作视为已执行。

## 1. 按用户结果安排执行

| 顺序 | 用户或运营需要得到的结果 | 当前剩余事项 | 依赖与退出条件 |
| --- | --- | --- | --- |
| 1 | 角色记得正确的人物、事实和场景 | Scene 与长期记忆的真实语义质量、媒体任务遵从 | 保留原失败和评分；同源真实筛选与新样本达标后再取得产品资格 |
| 2 | 作品可靠交付、可找回、费用可核对 | 三场景旁白、失败重试及最新变化的同源集成/产品验证 | 验证真实 Gen/Voice/合成/持久化/下载/账本；修复不冒用旧全套结果 |
| 3 | 可以自然说英语并听到稳定角色声音 | 实体麦克风、英语口音/真实耳语/噪声、输入与 Call 独立质量 | 真实英语设备及材料齐备；Clip、Input、Call 分别验收，TTS语言范围独立 |
| 4 | 等待可解释、默认路线可持续使用 | 图片/视频延迟分布、同质量性能对照与容量等价性 | 区分排队与执行；保持规格/输入/模型可比，不以缩规格证明加速 |
| 5 | 完整平台目标均有真实能力与权利 | Catalog 等价性、未验收组合、付费 Packs、真实商业结算 | 按目标域逐项映射和真实验证；本轮之外的购买/结算另行进入执行范围 |
| 6 | 运营能按可信事实行动 | 指标成熟窗口、生产回放与质量认证 | WPCU 保持 official；内部/测试事实不混入经营结论 |
| 7 | 目标部署可以启动、恢复并公开服务 | 生产 bootstrap、目标 authority、恢复与公开旅程 | 获得目标环境，按 wrapper/full gate 与同源证据判断发布 |

1–4 是核心体验的当前重点，5 保持完整对标范围，6–7 支撑可信经营与发布。已实施能力只补尚缺的资格，不再重复列为待开发。

## 2. 人物、场景、记忆与媒体质量

- [Scene 已有来源核验与出入场的定向修复](CURRENT_FUNCTIONAL_COVERAGE.md#chat-与记忆)，但真实语义尚未合格；按实际源码重新绑定资格，不用策略编号代替质量证据。
- 按原 **13 → 47 → holdout 7** 的有界语义资格继续，保留预算、评分和首败材料。明确人物被误判 null/reference、人物离场后仍在场等已复现失败须被新版本独立关闭，不改 gold、不扩大预算掩盖失败。
- 记忆需要验证真实事实召回、用户纠正、Main 删除/修订后隔离及重建、跨会话/跨日连续性、10k recall 与首字性能。Main 已有来源保护与官方 fresh-ingest 恢复；上游授权/误撤回与全历史扫描问题需要可维护源码或已修复版本，不在 Chat 复制私有恢复协议。
- 图片/视频技术完成和任务质量分别判断。默认图/视频的原像素失败保持；新 Iris、edit、Animate 与 GN-19 成功样本只证明各自输入与版本，不能覆盖全部人物、构图或 Catalog。
- 主动消息的事实边界指令已有集成与有限真实复验，长期主动性、回复重复、声音听感、anime/长对话与真实回访仍需独立质量证据。
- **H3 保持禁用**；稳定视觉资格复验和显式合法版本发布是重新启用的前提，不能直接改历史 pins。

执行入口：[核心体验验证](CORE_EXPERIENCE_VALIDATION.md)、[Chat PRD](CHAT_SERVICE_PRD.md)、[图片系统](CHARACTER_IMAGE_GENERATION_SYSTEM.md)。原失败与各次候选归属保存在当前覆盖及其所引报告中。

## 3. 交付、恢复、持久化与费用

- 三场景旁白的帧数对齐、composition owner、已保存声音复用与缺失旁白提示已有定向/ffmpeg 证据；最新数据库复验当时因 connect EPERM 为零执行。补同源 Scene authority、VideoSequence 集成，以及第三条失败 → 重试 → 再打包 → 刷新 → 逐段/完整下载 → 账本的真实产品链。
- 已记录的最新定向批次中 Chat 全套有 7 个失败，须先按原失败和实际环境复验；不把更早 7343 测试或174项 Chrome 全通过继承给新代码。精确记录哪些文件改变、哪些证据仍适用。
- 对本批实际改变的 Turn admission、terminal exact replay、旧 attempt 拒绝、SSE 重连/Main ACK、附件选择、Generation settle/refund 和账号删除顺序补风险验证。未知结果先核对原请求；不能为检查成功吞错、重复执行或提前退款。
- 结果绑定 request/attempt/artifact/delivery/settlement、身份版本、provider/model/workflow、耗时与唯一用量。取消资格与执行阶段一致，失败状态和客服回执可恢复。

已完成的旧旅程与错误保持原 source。真实两场景旁白链不能代替三场景资格；fixture E2E 也不能代替真实 provider。

## 4. 语音输入、片段与双向通话

Mic → 可编辑草稿 → 明确 Send 的单聊/群聊实现已经存在；Voice Call 106 也已有受控 English recorded-upload → ASR → Chat → Pocket TTS → 播放/持久化及中断恢复。二者不再列为待实现，也不互相替代。

2026-10-05产品决策：ASR草稿输入与Call识别仅支持英语。希腊语、法语等历史失败保留在覆盖证据中，移出当前ASR发布阻塞项；TTS语言范围按声音provider独立判断。

尚需完成：

1. 核对并解决范围内的英语普通/带噪 ASR 关键意义错误。历史Parakeet/Whisper固定比较保留，不无因重复消费同一比较窗口或切默认。
2. 补足英语材料：至少三说话人、目标英语口音、真人普通/耳语/环境噪声、陪伴语境词汇与人工关键意义验收。公开朗读、数学衰减和人工加噪不代替真实材料。
3. 在桌面 Chrome/Firefox/Safari、iOS Safari/Android Chrome 验证真实权限、格式、暂停/中断、Done→draft 延迟及语音身份；录音上传和实体静音录音不证明真人人声质量。
4. 分别核对 Input 不消费消息/TTS/dreamcoin、Clip 的播放与缓存计量、Call 的时长/中断/quote/结算；补部署 RSS/持续负载及遥测出站策略。

完整发布门见 [声音发布清单](VOICE_RELEASE_CHECKLIST.md) 与 [声音证据](CURRENT_FUNCTIONAL_COVERAGE.md#声音)。

## 5. 性能、Catalog 与完整功能等价性

- 默认图片、身份图与 RedGraft 优先。多参考加速已有 [独立样本](CURRENT_FUNCTIONAL_COVERAGE.md#图片)；下一步需要同质量的排队、执行、端到端分布和容量，不把单次样本当作全站 SLA。
- Create 的五步与已扩展目录需按字段语义、恢复、预览与发布证明六步任务等价，不能按选项数量直接认定 matched。运行声音目录与创作者可选目录也须区分。
- CH-16、Group Chat、Pinned Memories/Instructions、主动消息、Advanced seed/model、精确 Chat context、gated Animate、Coin Store 和 AF-02 均已有实现；只补当前未取得的质量、权限变化/恢复、目录等价性与同版组合资格。
- 免费 Packs 已有私有副本/immutable Grant/撤下与封禁边界及领取闭环；**免费领取不证明付费 Pack 购买**。Comics、CMS 四族、合集、Support、Follow/Studio 等已有单域证据，剩余为库存/组合及最终版本资格，不重复列成空白功能。
- GN-19 已有1–3 scenes、参数与 composition lease 实现及两场景真实旁白链；其他参数组合、三场景及最新 source 资格按 §3 验收。
- 对标矩阵须下钻到每项用户任务和 Catalog 维度的 matched/equivalent/intentional_divergence，写理由与同版本证据，不能只统计路由/按钮。

## 6. 商业承诺、作品权利与支持

真实支付、付费 Pack、Coin Store 用户充值、创作者/联盟收益与 AF-03 结算属于独立后续验证范围。先把报价、已购权益和账目承诺在 [经济规格](ECONOMY_AND_PRICING.md) 固定，再按授权范围执行购买或资金动作；内部加币不算充值闭环。

该范围的退出条件包括：provider confirmation → 唯一入账/激活 → 原任务恢复、迟到/重复通知、expiry/repurchase；Packs 的价格/内容/Grant/退款边界；作者/来源/Remix 授权；佣金预计、确认、撤销与实付分开；支持有回执和解决结果。年卡等数值或窗口出现文档与实现冲突时，先明确差异，不能按 seed 静默改掉用户承诺。

站内公告已有用户与运营证据，邮件订阅尚未提供；站内通知不替代邮件能力。身份年龄验证与内容策略按其独立发布范围取得证据，`MODERATION_PROVIDER=mock`、保留但不启用 safety-gateway 及成年人底线不列为重新实施事项。

## 7. 经营证据

指标自动物化和只读诊断已有实现；尚需真实 eligible facts、成熟窗口、生产回放和 certified snapshot。**WPCU 保持 official**；WSCU/WPSCU/WSCrU/WSR 保持关系/创作诊断，不做北极星 cutover。

退出条件：定义与版本明确，测试/探针/internal facts 被排除，事实可归因，质量与成熟窗口达标，运营能从指标进入可行动对象。可显示数值不意味着可用于经营决策。

## 8. 目标环境、首次启动与恢复

目标主机、访问方式、HTTPS 主站与受保护 Admin、存储、监控等 authority 尚未提供，不能填假值。现有 launch CLI 的离线 prepare 已实施且不签发资格；受限 production bootstrap 与真实网络/origin 顺序仍需闭合。

- 按 [运维手册](../architecture/10-operations.md) 和 PM2 wrapper 发现实际 migration/队列/运行 ownership 后执行必要步骤；不绕过 drain/readiness。
- recovery producer/executor/launch gate 已为 schema2，包含 Main PG、AgentRun、DSH canonical/private、Blob 与 durable intent/receipt。本机完整恢复见 [覆盖记录](CURRENT_FUNCTIONAL_COVERAGE.md#部署与恢复) 所引原报告；新目标按实际差异重新取得资格。
- 每个新目标检查 source、迁移/checksum、角色/权限、存储根与queue、manifest SHA及有效期；按真实差异生成新名bundle，实际恢复/字节/ACL/账目核对后才绑定。旧本地bundle不能重标为新source或生产证明。
- **仅当目标仍有旧 Chat 数据时**按 [ADR-20](../architecture/20-local-file-chat-authority.md) 的维护窗执行备份、停止接纳/排空、必要 migration/导入、Turn/附件/Scene/费用数量与哈希对账、只读观察；当前本机不重复迁移。旧schema/roles不可逆删除另行批准。
- 生产配置与四服务source统一；完整gate、真实用户/运营/provider/恢复及观察窗共同决定公开Go/No-Go。支付/年龄在获准的独立范围补齐，不以本机development代替公开资格。

执行入口：[生产配置清单](PRODUCTION_SECRET_CHECKLIST.md)、[上线验收](LAUNCH_READINESS_AUDIT.md)。

## 9. 更新与完成规则

取得新证据后先更新当前覆盖，再删除或收窄此处已关闭的待办，并同步矩阵引用。每项实际结论至少记录：source revision、环境/验证时间、provider/model/workflow、request/attempt/artifact、费用与交付/持久化、失败和未执行范围。

完整产品完成须同时满足 PRD 的全部目标域、权限/费用/恢复契约与同源真实用户/运营结果；公开发布再满足目标环境gate。已有代码、mock、旧截图、单次样本或文档梳理都不能单独签发上述完成。

历史执行顺序与原失败归属见当前覆盖的具日期章节及所引原报告。本文件合并旧重复待办，没有改动那些原报告或将历史失败改为成功。
