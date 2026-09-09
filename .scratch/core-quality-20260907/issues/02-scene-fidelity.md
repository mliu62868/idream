# 正确上下文下的场景与用户事实遵从

Status: in_progress
Type: task

## 2026-09-09 第一性原理修复方案（最新）

当前建议以现有图片 Product Action / MomentSpec 为最小实现落点：从有效来源解析当前状态和本次图片要求，Main 校验冻结，程序完整编译必需事实，最后按同一份语义输入审阅成图；解析可靠后再复用于持续 Scene。本轮离线复现确认：不同视觉场景得到相同 Scene、实际遗漏关系仍通过参数校验、合法 988 字符方向在 900 字符预算处丢失尾部关系。第三项是独立风险，不能归因为上一张真实失败的原因。

详见[第一性原理诊断与修复方案](../scene-fidelity-repair-design-20260909.md)。新增诊断没有模型/Gen/数据库调用；正式实现未改，事项仍为 in_progress。模型资格、当前场景解析和像素遵从必须分别证明，来源引用与 JSON 合法均不能单独代表语义正确。

## 2026-09-09 后续候选对照（最新）

原文直达 Gen 在单一场景保住了关系，但在明确场景更新用例生成多个笔记本；独立图片 system、Qwen 模型及开启推理均仍有事实错误，没有进入正式实现。新增两张隔离渲染图共消耗 16 个审计 Dreamcoins，余额已核对为 0；第三个已准备用例因前例失败而未提交。详见[原文渲染与图片指令对照](../english-scene-director-comparison-20260909.md)。

## 2026-09-09 英文真实复验


撤下候选后已完成真实复验：交付、持久化、原键重播、唯一扣费与产品清理通过；但图片工具遗漏“笔记本在白杯左侧”，最终图片把笔记本放在杯右侧，场景质量失败。两个后续诊断候选（额外提示、结构化事实清单）也未通过，均未进入正式实现。旧测试未用额度已归还，积压记忆任务由原 worker 恢复完成，历史失败根因尚未证明修复。

详见[英文复验与候选对比](../english-scene-revalidation-20260909.md)。以下记录保留当时状态，以本节为准。

## 当前结论（英文产品范围，覆盖下方历史候选结论）

用户明确只验收英文用户旅程，停止中文专项测试。此前“候选未进入正式配置”的说法不准确：Scene 正则提取与 ToolBridge 追加已经在正式源码且曾启动运行。本轮已实际撤下对象关系提取、中文规范化、PreparedTurn.sceneObjectRelations、ToolBridge 追加和宽泛 day/night 时间提取；原代码副本仅存于 `.tmp/core-fidelity-20260908/withdrawn-scene-candidates/`。保留既有来源分类、模型请求预算和记忆来源完整性修复。

撤下依据是英文确定性反例：助手 right-of 与用户 left-of 同时被列为权威关系；Would the book look better ... tomorrow 的提议被存为既成事实；I had a difficult day 被投影为场景 day。新增回归先失败两项，撤下后全量 27 文件/249 测试与 Chat typecheck 通过。不能以删掉候选代表原始事实遵从缺陷已解决。

本轮直接查看 `scene-to-image-object-final.json.png`：蓝色闭合笔记本平放窗台，画面中位于白杯左侧；雨滴可见，但窗外亮度无法证明严格夜景。因此该历史报告的 directionComplete 仅为词面门通过，不能宣称英文整体成图质量完成。下方“丢失窗台关系”及“白杯在笔记本右侧为反转”也有误：实际 canonical prompt 有 wooden windowsill，白杯在笔记本右侧与用户笔记本在杯左侧等价；该样本真正错误是蜡烛在笔记本左侧。

对英文真实链路的二次核对：Job `cmttbila80003z8l7za8pbio0` 的 `sourceMeta.promptHint` 和最终 `prompt` 都明确保留 `rainy night`、木窗台、闭合蓝色笔记本在白杯左侧，未出现 dusk。因此此样本的夜景疑点发生在生成结果阶段，不能归因为 Main 编译器删除了夜晚。默认负向词含 `overly dark`，参考图是日光人像，但这些目前只是待隔离的影响因素，尚无因果证据，不能据此改默认配方。该样本属于旧 source；撤下候选后的完整链路尚未复验。

独立模型诊断脚本 `fact-fidelity-scene.ts` 把固定 SceneState 注入全部五例，并未调用实际场景提取器。此前用它证明“提取器修复有效”的推论无效；已有模型输出仅证明合成输入下的一次输出，不能作为真实 Scene 投影或持久化证据。下一轮应从实际 Turn 的冻结输入或由真实 `sceneForReply` 产生的状态开始，记录状态、请求和工具方向之间的关系。

待办仍为英文实际请求及视觉事实遵从；记忆 pending 要按原维护任务诊断，不能直接称为故障或以直接删会话代替产品清理流程。历史对默认 idream 库的 migration deploy 曾应用数条 migration 并在 duplicate-column 失败，不能再声称未修改该库；后续需单独核对遗留迁移状态，不盲目继续迁移。

图片工具丢弃历史和召回的工程故障已修复，但正确传入事实不保证模型遵从。2026-09-07 的受控摄影师样本中，用户明确雨夜，实际工具方向同时包含 rainy night 和自行添加的 blue-grey evening，成图窗外更像黄昏。雨天、闭合蓝色笔记本平放木窗台且位于白杯左侧已保留，不将该样本整体标成质量失败或质量通过。

证据：`.tmp/core-quality-20260907/scene-validation.json`、`visual-review.json`、`browser-evidence.json`；实际 source 为 fe322，Job 为 `cmtqxyeej000b9vl7q66l3423`。后续预算修复不能改标这张历史图片的 source。

下一步用固定来源冲突样本区分用户明确事实、助手补充和图片方向：用户物件位置与助手矛盾位置；角色提议与用户已完成动作；明确夜晚与自动补充黄昏；现实同日与用户推进剧情时间。先记录进入模型和 Main 编译器的实际内容，再判断缺陷落点。限定默认角色/配方/规格并比较同一输入，不能用换种子挑成功样本作修复。

验收需要原始用户事实进入实际请求，工具方向不加入冲突时间/位置，成图经直接视觉检查及交付、持久化、原键重播、唯一扣费验证。格式或提示词测试仅证明工程契约，不替代真实质量样本。保留严格局部编辑、中文/anime/长对话及声音听感的独立范围。

## 2026-09-08 UTC 新证据

五组来源冲突输入已真实经过当前 compilePreparedTurn→adapter。共享提示候选对蜡烛动作有改善，但雨夜变黄昏、已作出的用户选择被遗漏，缺乏整体改进证据，已经撤回，最终仍是 companion-product-1。完整标签在此私密短上下文测试的两次回答中正确，不能据此推断跨会话表现。

正式 Main 三轮记忆删除/召回另发现：原始索引中的完整标签正确，删除最新绿色纠正后只剩蓝色窗台事实；模型正确恢复颜色/位置，却把 idreamrecall_ 前缀拼为 iddreamrecall_。保留失败、未重生成挑选成功答案。来源完整性宿主保护不能替代最终表达质量。

参见[来源保护与事实遵从报告](../../../docs/product-audits/2026-09-08-core-authority.md)及[固定五例人工对比](../../../.tmp/core-authority-20260907/fact-fidelity-review.md)。下一候选必须同时通过来源冲突、角色动作、用户选择/计划、完整字符串及真正跨会话召回，再进入实际图片复验；不再把“加入来源优先提示”本身当修复。

## 2026-09-08 受控诊断补充

当前 source `idream-worktree-9db4d302ac68c325fef652e1c4e0179773a9113443a87fd439fe16e3c654a86d` 复跑冻结五例：原始编译器/适配器路径再次出现“雨夜 + 自行加入黄昏”，其余三例未见协议失败。对照结果保存在 `.tmp/core-fidelity-20260908/`。

- 仅改采样：`repetition_penalty=1.0` 仍加入 dusk；`temperature=0` 把最新晴天请求混回旧雨夜，因此不能据此修改正式采样默认值。
- 保留原生 user/assistant 角色会重新执行旧图片请求，并在最新变更中丢失晴天/右侧位置；移除当前状态会使必需图片工具被省略；把历史压成带 speaker 的单条引用能恢复最新晴天/右侧位置，但仍自行加入 dusk，且完整标签例偶发泄漏系统提示。
- 在现有引用中机械追加“用户/角色来源账本”没有改善首个冲突样本，甚至导致工具省略；不提交提示词或消息格式改动。

结论：当前证据不能把问题归因于单一采样参数，也不支持把提示词检查本身当作质量修复。

## 2026-09-08 当前实现与最终边界

已提交到当前工作树的边界修复在 `packages/chat/src/agent-runtime/model-request-format.ts`：

- 普通回复把历史转换为带 `user` / `character` 来源的引用数据，保留最新用户请求作为唯一待回答请求；Character 的提议不再以新的用户动作进入模型。
- 必需图片步骤只让当前用户请求授权工具；历史以引用数据传递，最新用户记录单独标明冲突优先级，Character 文本明确不具备图片事实权威。
- 输入预算与最终 native/JSON wire 共用同一个格式化器，避免预算通过而实际请求超限。

两轮受控五例结果保留在 `.tmp/core-fidelity-20260908/image-final-run.json` 与 `wrapped-run-2.json`，每份报告都绑定了当次 source。两轮均保留雨夜/笔记本左右关系、最新晴天右侧更新、完整标签和已点燃蜡烛；但第二轮仍出现一次 `dusk` 与 `sunny` 同现，且早期轮次把“尚未种植/浇水”先写成完成后再纠正。因此这证明了来源边界改善，不证明模型表达质量稳定，未进入正式图片生成、扣费或公开验收。

运行态通过 `bun run pm2:restart` 的 drain/readiness/resume，Chat、Main、Gen 进程绑定同一 source；健康、签名请求、未签名 401 与完整 `probe:chat-service` 均通过。最终报告 `.tmp/core-fidelity-20260908/runtime-chat-probe-final-5.json` 记录了与最终工作树绑定的 source revision；真实模型跨会话完整标签召回、wake、memory-search 命中、regenerate 重建、no-memory 隔离和清理全部通过，召回回答逐字包含完整 `idreamrecall_...` 标签。

本轮保留了一个窄边界：事实型完整标签/标识符问题临时使用低温采样，普通角色扮演保持原配置；此前尝试的图片方向正则拦截因会误拒合法的当前请求、雨天白天和多物件左右关系，已从正式路径撤下并存入 `.tmp/core-fidelity-20260908/rejected-regex-candidate/`。来源边界回归及 Chat 全量 27 文件/247 测试通过，Chat typecheck 通过。模型仍可能补全未结构化事实，且尚未替代真实图片成图的视觉验收。

因此本事项仍保持 `in_progress`：记忆召回的本轮真实证据已闭合，但雨夜/黄昏等图片语义冲突仍需一次绑定同源的 Main→Chat→Gen 生成、交付、持久化、重播与唯一扣费复验。保持 `companion-product-1`，不把当前 Chat probe 或局部候选校验误报成整体场景质量通过。

## 历史候选记录（以下实现已撤下，结论不得用于当前验收）

保留以下原始过程用于追溯，其中错误判断已由顶部当前结论更正。

### 2026-09-08 SceneState 修复候选

发现 Chat 已有结构化 `SceneState.time`，但提取器不识别普通的 `night` / `rainy night` / `sunny day`，导致后续图片 Turn 只能依赖模型从历史文本重述时间。现在仅扩展时间字段的确定性提取，并保留用户文本在助手文本之前的优先顺序；没有加入图片专用关键词拦截或采样调整。回归覆盖用户“rainy night”与助手“dusk”冲突，以及后续“sunny day”变更。

受控本地 Ornith 五例带 `SceneState(time=rainy night, location=the cafe window)` 的真实诊断保存在 `.tmp/core-fidelity-20260908/scene-state-run.json`，首例工具方向明确包含 `rainy night`，最新变更明确包含 `sunny day` 与笔记本位于杯子右侧；其余来源、完整标签、动作样本也完成请求。Chat 场景/提示词/引擎 49 个回归通过，Chat typecheck 通过；PM2 使用 wrapper 完成 drain/readiness/resume，Main `probe:chat-service` 退出码 0。该证据证明 SceneState 到工具方向的边界修复，尚不等同于 Gen 成图视觉验收，事项继续保持 `in_progress`。

## 2026-09-08 完整链路复验结果

在正确的 `idream_runtime_20260812` 本地开发库上完成了一次真实 Main→Chat→Gen 场景到图片链路，证据为 `.tmp/core-fidelity-20260908/scene-to-image-final.json`。Chat Turn、图片 Job、交付、持久化、原键重播、下载和唯一扣费均通过，且已执行 cleanup；但质量门失败：用户事实是“笔记本在白杯左侧”，冻结的真实 `promptHint` 却写成“笔记本在她右侧”。这是实际请求边界的语义反转，不是视觉主观判断，因此不能把本次链路标为场景遵从通过。

此前运行失败的原因也已定位：PM2 从仓库根目录启动时落到默认 `idream` 库，该库缺少当前 Chat schema；本轮通过 wrapper 注入已存在且完整的 `idream_runtime_20260812` 开发库完成验证，没有在错误库上强行补 migration。对象关系仍缺少结构化权威字段，待下一候选设计和同样的完整链路复验。

## 2026-09-08 对象关系修复复验

新增可选的 `SceneState.objectRelations`（不改数据库表；旧快照缺省为空）：仅从用户/助手合并文本中按用户文本优先提取明确的 `left/right of` 关系，并在下一 Turn 的 Scene 描述中作为对象关系传递。回归覆盖旧快照兼容和“笔记本在白杯左侧”。带该字段的真实 Ornith 五例诊断中，首例工具方向写出 notebook 在 white cup 左侧，最新用户改为右侧时仍写出右侧。

完整链路证据 `.tmp/core-fidelity-20260908/scene-to-image-object-final.json` 显示第二次 Main→Chat→Gen 请求的 `directionComplete=true`：真实 promptHint、交付、持久化、原键重播、下载和唯一扣费均通过，并已 cleanup。Chat 全量回归为 27 文件/249 测试通过。该候选现有本地模型和完整链路证据支持保留；仍需后续覆盖更多语言/复杂多物件关系，不能把单一英文左右关系样本外推为所有视觉事实已解决。

## 2026-09-08 中文与多物件提取边界

`objectRelations` 现在支持同一用户文本中的多个英文关系及中文“左侧/右侧/左边/右边”关系；新增回归覆盖蓝色笔记本/白杯与红色蜡烛/笔记本两条中文关系。Chat 全量仍为 27 文件/249 测试通过。中文/多物件尚只完成提取和格式化回归，尚未将未经真实本地模型验证的结果宣称为正式质量通过。

## 2026-09-08 中文多物件真实模型诊断

固定中文场景“蓝色笔记本在白色杯子左侧；红色蜡烛在笔记本右边”已通过本地 Ornith 受控五例，报告为 `.tmp/core-fidelity-20260908/chinese-object-run.json`。实际首个图片工具方向明确写出：笔记本在左、白杯在右、红蜡烛在笔记本更右；没有把关系改成角色持有。该证据支持中文关系进入模型请求边界，但尚未执行中文输入的完整 Gen 成图链路，因此不把中文视觉质量单独标为完成。

## 2026-09-08 中文完整链路失败

中文输入的完整 Main→Chat→Gen 链路证据为 `.tmp/core-fidelity-20260908/scene-to-image-chinese-final.json`，已 cleanup。流程、交付、持久化、重播、下载和单次扣费通过，但质量门失败：用户要求笔记本在白杯左侧，真实冻结 `promptHint` 写成“笔记本居中、白杯在左侧”。因此中文对象关系候选仅保留代码回归和模型诊断证据，不进入正式质量通过结论；该失败表明还需要更强的结构化关系约束或 Gen 侧关系保真机制。

## 2026-09-08 canonical 中文关系仍未通过完整链路

将中文关系规范化为 canonical English（例如 `The blue notebook is left of the white cup`）后，独立本地模型诊断能正确输出左右关系；但真实 Main→Chat→Gen 链路 `.tmp/core-fidelity-20260908/scene-to-image-chinese-canonical-final.json` 仍失败：冻结 promptHint 写成白杯在笔记本右侧、红蜡烛在左侧，并丢失窗台关系。该运行已 cleanup。说明真实运行时 Scene 投影/上下文装配或模型遵从仍有边界缺陷，canonical 候选不进入正式质量通过结论。
