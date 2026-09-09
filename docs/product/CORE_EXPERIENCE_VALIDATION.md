# 核心体验与运营验证

更新日期：2026-09-07

这份操作说明服务于当前工作方向：固定五个角色的完整体验，改善默认生成等待，让运营判断建立在可追溯事实之上。当前实施和运行结果在 [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md)，未完成项在 [剩余工作](REMAINING_WORK_EXECUTION_PLAN.md)。

## 固定角色体验

使用现有 Main 产品 API；不写另一份 Chat、记忆或媒体权威。五个成年 realistic 样板包括航海、摄影、社交、园艺、水彩任务型人格，绑定各自受控 audit 账号。角色、Soul、Release、视觉引用及声音版本被保存并在运行前重验。

完整命令、固定场景、恢复和清理见 [质量工具说明](../../packages/main/src/scripts/character-quality/README.md)。从根目录执行：

```bash
bun run --filter @idream/main quality:characters pin --manifest ../../.tmp/character-quality/baseline.json
bun run --filter @idream/main quality:characters run \
  --manifest ../../.tmp/character-quality/baseline.json \
  --output ../../.tmp/character-quality/navigator.json \
  --case navigator --media
```

逐角色串行执行，原请求未知时沿用原键 `--resume`，不自动重生成已经终态失败的 Turn。自动检查覆盖版本冻结、Main 终态、DSH 记忆来源、原键重放、图片编辑来源、唯一用量和声音原资产重播。非空回复或成功下载不足以证明角色自然、图片身份稳定或声音适合；具体内容审阅及浏览器回访另留证据。跨会话即时召回不代表真实 D7 留存。

首轮真实样本发现完整标签在 Chat 的 320 字符记忆摘录中被截断。当前保留每条最多 2,000 字符、六条最多 12,000 字符的常规原文；超长摘录不切断末尾标识符，并明确要求检索完整事实。当前执行策略版本为 8，另保留图片 JSON 兼容调用的真实 provider 请求归属；编辑入口识别 “the picture you just sent” 这样的已交付图片引用；否定匹配不跨句或独立分号，避免“Do not change anything else. Make the edited picture now.”误取消，真实图片取消仍有效。评估提示版本 2 使用既有 Gate E 标记格式，旧失败报告不能恢复成新版本样本。异步持久化最多观察原 Job 30 秒，恢复不创建新的生成请求。

强制图片工具步骤现在保留已准备的对话与召回：旧消息按来源和 user/assistant 角色作为引用数据交付，当前用户请求仍是唯一动作。原生工具和 JSON 兼容路径共用这条规则，旧工具协议不作为新调用重放。PreparedTurn 与适配器共用请求格式，预算包含引用封装、工具 schema 和 JSON 兼容说明，并沿既有规则移除最旧完整对话；固定内容或后加运行上下文仍使完整请求超限时，在访问 provider 前拒绝。有限 Scene 摘要不能替代雨天、物件位置等原文证据。上下文保留的结构回归与真实图片质量分别验收；`MomentSpec.confidence` 等来源声明不是视觉遵从评分。

真实质量失败继续保留：完整证据被模型回答改写、依赖维护误判用户撤回、未真正调用编辑工具等，均不能以 HTTP 成功或后续独立媒体通过来覆盖。隔离验证可以复用已交付的原图并发起新的受控编辑，但应记录各自 source、原失败和独立范围，不能拼接签发完整旅程。

明确的Chat编辑现在由Main采用该Turn已冻结的用户文本，继续经过既有身份规范化；模型不能再添加原图不存在的服装、发型或场景细节。旧requesting/accepted附件保留原先冻结指令及重播行为，新图的Agent场景方向不受此变更影响。新编辑若完整方向超过既有预算（包括系统衣着前缀），在创建附件或扣费前明确拒绝，避免静默截掉末尾限制；普通Chat文字长度契约不变。实际图像是否遵从这条正确指令，仍由独立视觉样本评估。

## 记忆来源与派生质量

Main 有效 Turn 是完整来源。Chat 在隔离候选中校验官方 ingest 的 dialogue，再运行 maintain；坏派生不能覆盖仍有效原文。发生撤回注释或来源变更时，只整体重建该候选的官方索引一次，明确记录 `companion_memory_derivation_rejected`，保留真实 pending / lastMaintain。恢复失败继续报错，不能发布坏候选。

验证分开记录：Main 删除后的剩余原文、官方索引中实际可检索来源、DSH 本轮命中证据和模型最终回答。索引有正确事实不等于模型回答正确；无 profile 的来源恢复也不等于上游 Forget 授权已修复。细节及证据见[来源保护报告](../product-audits/2026-09-08-core-authority.md)。

## 生成耗时

Gen 将已观察性能写入原有 terminal accounting，Main `ai_usage_facts.usage.performance` 持久化。没有新增数据库表或另一条统计写入通道。ComfyUI 参考图片以内容 SHA-256 命名，同字节稳定命中 LoadImage 输入，不同字节不会覆盖排队中的旧引用。

| 字段 | 实际含义 |
| --- | --- |
| `resourceWaitMs` | 等待本机共享加速器 lease；未获得则未知 |
| `runnerPreparationMs` | 获得 lease 后，释放竞争 runner 模型等准备工作 |
| `requests[].prepareMs / submitMs` | 工作流/引用图片准备，以及提交请求 |
| `requests[].waitMs` | ComfyUI 排队、执行和轮询合计等待 |
| `requests[].providerExecutionMs` | 同一 ComfyUI history 的 execution_start 到 execution_success，包含模型装载；缺时间戳为 null |
| `requests[].downloadMs / validationMs` | 下载输出，以及图片校验或视频解码验证 |
| `requests[].cachedNodeCount` | provider 明确报告的缓存节点数量；缺证据为 null |
| `totalMs` | adapter 从申请 lease 到结果返回的总观察时长，尚不含产物持久化和 Main 交付 |
| `artifactPersistenceMs` | provider 返回后 Gen 保存、规范化产物的时间 |

`waitMs` 已包含 `providerExecutionMs`，不可相加。失败保留已完成分段，不推算缺失的 provider 时长；这些值不能分离纯推理和模型装载。产品排队和端到端时间由 Main Job/Attempt/Transport/Usage 的持久时间计算，历史样本缺新字段时不补零。

```bash
bun run --filter @idream/main generation:diagnostics --hours 168
bun run --filter @idream/main generation:diagnostics --hours 24 --data-class audit
```

诊断只读，按 dataClass、sourceType、用途、profile/workflow 版本与 model 分组，输出样本数和 p50/p95；重试的 Job 端到端只计一次。范围被 limit 截断时返回 exit 2，执行失败 exit 1。不同配置、冷暖状态和输入复杂度不能直接合并成“模型提速百分比”。

## 指标物化与可信度

现有 Main event-consumer 启动及每 15 分钟物化指标；一个进程内不重叠运行，失败写日志，下个周期重试，关闭时等待当前事务结束。首次与后续刷新都读取当前事实，不复用上次快照的数值。管理端读取当前定义的最新快照，定义、质量判断和物化使用一致数据库快照。

```bash
bun run --filter @idream/main metrics:refresh --check
bun run --filter @idream/main metrics:refresh
```

`--check` 只读；去掉该参数才写物化记录。exit 0 表示 official 指标满足 decisionReady，exit 2 表示可读取但存在认证阻断，exit 1 表示执行错误。输出包含每个指标的具体原因、定义版本、数据时间、成熟与未成熟样本量。

WPCU 保持 official；其他诊断指标保持原层级。刷新不会自动认证定义、将 audit/internal 改成 customer、制造收入或把未成熟窗口写成零留存。指标的有效定义、真实 eligible facts 与成熟观察窗仍是使用它做经营决策的必要条件。
