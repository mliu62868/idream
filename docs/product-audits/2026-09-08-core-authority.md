# Main 记忆来源保护与事实遵从验证 · 2026-09-08 UTC

状态：宿主记忆来源保护已完成受控本地验证；上游授权及最终事实表达质量仍未通过。保留先前 WIP、模型失败与历史媒体版本，没有提交、推送或公开发布。

## 从产品权威出发

Main 的有效已提交 Turn 是关系记忆来源；igrep 的 profile、索引与撤回注释是派生结果。错误模型提议不能获得删除原始事实的权力。仅拒绝坏候选也不足够：Main 的真实编辑/删除需要完成新投影，否则旧 canonical 可能一直保留被删来源，并阻塞后续修订。

因此在既有隔离 candidate 内验证官方 ingest 的对话来源，再做正常 maintain。来源数量、顺序、角色、完整正文、来源时间与 Main 输入必须一致；维护不能改变原始 dialogue 字节或文件集合，既有或新生成的撤回注释不能覆盖仍有效的 Main 事件。候选不满足约束时整体丢弃其 `.igrep`，使用先前固定的 Main 输入重新调用官方 ingest 一次。恢复后的完整来源必须再次校验并通过 doctor/status，才能继续既有 Main fence 与原子 promote。

这条恢复只接受“来源可用、派生被拒绝”，不会伪造已完成的 maintain、剥离坏结果中的标记或改写已安装 igrep。正常维护仍执行；恢复失败直接报错，不发布坏候选。日志记录无内容的 `companion_memory_derivation_rejected`。Main 外层超时预算包含最多两次完整 ingest，避免长关系在合法恢复途中被截断；总时限上限保持。

## 边界和代价

- 当前检查依赖固定 igrep 0.1.137 的 `igrep.mem.dialogue/1` 及撤回文件布局，是明确的版本兼容边界。源文件缺失、未知文件、格式漂移或路径越界不能被当作成功。
- 拒绝维护后，官方 fresh-ingest 索引可供检索，但没有该候选的 profile 摘要；pending 行和 lastMaintain 仍反映实际情况。下一次 Main 投影仍尝试正常维护。
- 只证明完整 Main 来源未被派生覆盖，不证明 Dream 的 profile Delete/Update 每项语义正确。上游授权 bug 仍未修复；对话纠正的模型回答质量也不能由文件完整性推出。
- Main 的消息编辑/删除、会话删除、clear-memory 与其 authority fence 保持原有契约。本次没有创建第二套手工 memory 数据库或领域事实抽取算法。

## 真实模型对照没有支持仅修改提示

同一个摄影师 Mira 的 Soul、五组输入、随机完整标签、clock、模型与采样固定；各组实际经 `compilePreparedTurn → OpenAiCompatibleAdapter` 调用当前本地 Ornith 一次。基线与新增来源优先提示候选各 5 次 HTTP，每次最多 512 输出 tokens，无兼容重试；没有 Main/DSH/igrep/Gen 请求、图片产物、产品扣费或业务数据库写入。

基线把用户的雨夜与助手的黄昏混合，另错误否认角色已点蜡烛。候选恢复了蜡烛动作，但雨夜完全变为黄昏，还漏掉用户已选择 basil 的事实。最新用户晴天/杯右、完整随机标签在这两次特定输出中保留。样本很小且没有随机种子控制，不能推出稳定胜率；候选不足以替换现行契约，已精确撤回。本轮最终仍使用 `companion-product-1`，不把提示存在视为质量修复。

基线 source `0955724b…`，候选 source `12e22c8d…`；两份完整请求正文、usage、responseId、SSE 和人工逐例评阅保留在 `.tmp/core-authority-20260907/fact-fidelity-*`。人工评阅入口：[五例对比](../../.tmp/core-authority-20260907/fact-fidelity-review.md)。旧 `fe322…` 场景图片与浏览器证据保持原版，不重新标记为本轮媒体验收。

## 验证记录

- 来源保护旧实现经实际 IgrepMemoryBuilder + 官方 CLI + 仅回环假模型复现：builder 返回成功，但保留 4 条错误撤回，Main 六条原文仍在，doctor 仍通过。红例：[outcome](../../.tmp/core-authority-20260907/builder-forget-fault-20260908T015016Z-b7ab0632/outcome.json)。
- 外层恢复预算回归先失败：单会话现有 410 秒小于两个子 ingest 与固定步骤的 440 秒。修复后 Shared 52 文件 / 373 测试通过。Main 来源权威与签名探针 2 文件 / 39 纯测试通过；这两项不是业务数据库或模型证明。
- 宿主保护最终代码通过 Chat 26 文件 / 239 测试及 typecheck。包括坏撤回、来源正文/文件/元数据变更、污染种子、来源路径链接、恢复失败不动 canonical，以及取消不继续恢复。
- 同一实际 builder + 官方 CLI 的错误 Forget 回归转绿：[最终 outcome](../../.tmp/core-authority-20260907/builder-forget-fault-20260908T020745Z-ed176ae6/outcome.json)。六条来源完整、无撤回注释、lastMaintain=null、sourceReady=true、derivation=rejected；真实模型0，业务库写入0，安装包未改。
- 根目录 `bun run check` 通过（5 个 build 任务成功），最终 Main 39 项纯测试通过。正常 PM2 wrapper 完成 drain/restart/readiness/resume，8 个核心进程绑定下述同一 source。

## 正式运行与真实剩余缺口

运行 source：`idream-worktree-eb659d7eb45db1f9c828a3a7d075cb9afdd3a36a854d425c6e24addebf958d06`；HEAD `cbf0499728be84a19d8b9b9ca13b679ce16babe4` 加当前 WIP。完整 Chat readiness 200/ok；独立 Lola signed probe 在 31.323 秒通过，覆盖 Main 签名、真实 DSH、normal/private、召回、regenerate、终态及清理。原始证据：[readiness](../../.tmp/core-authority-20260907/full-readiness.json)、[signed probe](../../.tmp/core-authority-20260907/signed-chat-probe.json)、[进程归属](../../.tmp/core-authority-20260907/runtime-processes.json)。

随后在同一冻结 Mira/Soul/Release 下，用既有 audit 账号完成三轮 Main 产品请求：

1. 会话 A 记录完整随机标签、蓝色本子在窗台。Main Turn `9be00ff3-32de-4619-8bfb-f016e3e1b07f`，Ornith request `chatcmpl-e5669ca0`；实际回复正确确认。
2. A 明确纠正为绿色、桌上。Turn `1c86081a-600a-40ae-90d1-4904cbf91f5d`，request `chatcmpl-01123d76`；实际回复正确确认。待投影完成后，通过正式 DELETE 删除这条最新纠正，保留第1轮；Main authority 推进到63、对应 destructive rebuild delivered。当前 API 只允许删除最新轮次，没有绕过限制去删除更早轮次。
3. 归档 A、新建 B，只问完整标签/当前颜色/位置；B 没有先前会话 transcript。Turn `ffb66400-0b6a-413b-881c-d94f6d76264e`，request `chatcmpl-df665de2`。独立官方 fast 检索只返回第1轮 user/assistant 原文、正确完整标签和 blue/windowsill，没有被删除的 green/table。实际 DSH 有1次 memory_search、1次命中、1个探针标记，无检索失败。

三轮均 Main sent、attempt1、SSE终态、原键重放不重复扣额度，33项技术检查通过。Chat 是当前 Ornith；官方维护仍用既有本地 `Qwen3.5-4B-MLX-4bit`，没有切换配置。三轮 Main 记录共5,286输入tokens、171输出tokens，无生成Job、无加币或Dreamcoin支出。常规按量/本机运行的法币成本没有可靠报价，未推算。

**最终表达仍失败**：B 回答恢复了 blue/windowsill，却把完整标签前缀 `idreamrecall_` 写成 `iddreamrecall_`，多了一个 d。提交前索引副本中的原文标签正确且没有 profile；实际 DSH 证据只提供命中计数，不保留最终输入正文，因此不能把独立查询伪称 B 的实际 wire。这里证明来源恢复和命中，不能据此批准精确事实质量，也没有继续换种子或重生成挑选成功答案。

本轮真实维护走正常路径，没有观察到 `companion_memory_derivation_rejected`。坏维护恢复由前述实际 builder + 官方 CLI 故障注入验收，不冒称真实模型本轮触发了该路径。

### 取证脚本修正与浏览器

提交 B 前的独立取证首次失败：直接搜索 canonical `.igrep` 符号链接时，官方 CLI 返回路径不在 `.igrep/mem` 子路径内。单独诊断保留同样错误；实际 Turn 本来就复制 canonical 为实体目录，因此只修改临时脚本，在隔离副本查询，并核对原 canonical pointer 与 Main authority 在复制/查询/提交前后稳定。没有改产品源码或重跑已完成Turn，使用原会话/原键 `--resume`。两次失败及成功查询均保留，正确区分索引观察与真实模型 wire。Bun 在临时 driver 退出时输出 tsconfig directory mismatch 内部警告；API、数据库与浏览器结果另行核验，不依赖零退出码推断业务通过。

390px 真浏览器刷新后 session 与 experience 均200，返回同一条 Main 回复，无 pageerror、无横向溢出。滚动后的页面确实显示错误拼写，原始截图与滚动截图分别保留；滚动检查沿用清理前已获取的页面，不冒称删除后重新取得会话200。[浏览器证据](../../.tmp/core-authority-20260907/browser-evidence.json)；[滚动后的截图](../../output/playwright/core-experience-20260906/memory-authority-20260908-mobile-scrolled.png)。

### 清理和归属

仅删除本轮 B→A 两个精确会话，分别GET404并等待Main重建 delivered；签名探针自己的两个会话也已清理。三条永久日额度事实保留。独立对账12项通过：四会话/本轮Turn已移除，canonical dialogue为空、profile不存在，无待处理/失败关系记忆事件，Dreamcoin账本逐条不变、余额0，无本轮新增媒体或临时登录。

对账最初把“该账号所有历史登录都必须不存在”作为条件，发现一条2026-08-31即已过期的旧Session；该条件超出本任务清理范围。旧记录被保留，修正后的检查明确以本轮runtime冻结时间及精确浏览器Session界定临时登录。旧失败结果保留在 `final-audit-overbroad-auth.json`，不是删除任务外记录以取得绿灯。

[三轮完整报告](../../.tmp/core-authority-20260907/memory-authority.json) · [最终独立对账](../../.tmp/core-authority-20260907/final-audit.json)。最后报告更新只改变文档，全部受版本管理及非忽略源文件的快照与差异保存在 `runtime-source-files.json` / `final-handoff.json`，不将完整工作树hash变化藏掉。

## 下一步

优先处理完整来源已经到达模型后的事实遵从：场景时间、说话人、用户选择/未来提议/已完成动作需要同时通过互相制约的固定样本。只有确实改进的模型或输入方案，才进入 Main → Chat → Gen 正式媒体复验；不使用按样本词语编写的修补规则。上游撤回授权与 profile 语义修复继续独立跟踪，不与本轮来源保护合并宣布完成。
