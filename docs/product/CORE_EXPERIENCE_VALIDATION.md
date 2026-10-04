# 核心体验与运营验证

更新日期：2026-10-04

本文定义角色/媒体质量、生成等待与经营事实的验证方法。完整目标与旅程见 [PRD](PRD.md) 和 [主站清单](MAIN_SITE_HEALTH_CHECKLIST.md)；实际结果和未关闭失败见 [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md)，下一步见 [剩余工作](REMAINING_WORK_EXECUTION_PLAN.md)。

## 验证契约

| 需要回答的问题 | 必需输入 | 可观察结果与退出条件 |
| --- | --- | --- |
| 角色互动是否成立 | 固定身份、原始用户选择/事实、允许的上下文，跨会话盲问和真实回访 | 角色可区分、用户自主权与事实正确、能自然推进；Main 历史、记忆召回和最终回答分别核对 |
| 媒体是否表达同一故事 | 同一角色/Scene、原图、明确局部编辑方向、声音文本与报价 | 图像身份/场景、局部保真和听感满足预先判据；真实交付、下载、来源和唯一结算成立 |
| 等待是否改善 | 同模型/版本、规格、输入/seed、设备竞争与冷暖状态，可比较的前后样本 | 分开解释产品排队、模型准备/执行、持久化与交付；报告样本和分布，不用缩规格替代提速 |
| 经营判断是否可信 | canonical eligible facts、定义版本、真实 dataClass、成熟观察窗和质量证据 | 指标能对账且 decisionReady；audit/fixture、未认证值与未成熟留存不能作为经营成绩 |

执行前固定 source/service revision、受控 audit 账号及 owner、开发/测试连接、角色/Soul/Release/视觉/声音 pins、权益/余额与目标能力。按 [用户故事](UserStory.md) 同时记录正常、失败/未知、取消、恢复、权限、成本与持久化。源代码变化形成新证据范围；恢复原请求可以跨版本，但不能拼成同版本完整资格。

## 固定角色体验

使用现有 Main 产品 API；Main 产品 Turn、交付与计费仍是权威。五个成年 realistic 样板包括航海、摄影、社交、园艺、水彩任务型人格，绑定各自受控 audit 账号。角色、Soul、Release、视觉引用及声音版本被保存并在运行前重验。换环境时显式提供合格角色/账号，不把真实客户改标为 audit。

完整命令、固定场景、恢复和清理见 [质量工具说明](../../packages/main/src/scripts/character-quality/README.md)。从根目录执行：

```bash
bun run --filter @idream/main quality:characters pin --manifest ../../.tmp/character-quality/baseline.json
bun run --filter @idream/main quality:characters run \
  --manifest ../../.tmp/character-quality/baseline.json \
  --output ../../.tmp/character-quality/navigator-full.json \
  --case navigator --media
```

逐角色串行执行，原请求未知时沿用原命令和输出加 `--resume`，不自动重生成已经终态失败的 Turn 或 Voice request。先用文本样本定位问题，再用独立输出执行最低充分完整媒体样本；不能把完成的文本报告改成 `--media` 以伪造一次完整旅程。角色 pins 改变时重新 pin 和新建报告，保留旧报告。

自动检查覆盖版本冻结、Main 终态、DSH 记忆来源、原键重放、图片编辑来源、唯一用量和声音原资产重播。媒体先观察原 Job 的持久化证据，工具规定的等待窗结束仍不成立就停止，不能越过它消费下一阶段。评估提示版本和完整标签以工具 README/`suite.ts` 为准；旧失败报告不因检测器或提示修复变为通过。

产品质量由实际审阅补齐；[工具的六个审阅维度](../../packages/main/src/scripts/character-quality/suite.ts)各自从 pending 开始：

| 维度 | 必须实际判断 |
| --- | --- |
| 角色区分度 | 从具体措辞、行为和任务区别五个角色，不以不同名字代替人格区别 |
| 事实与用户自主权 | 完整标签、物件/位置、选择和边界正确；没有替用户行动或编造共同过去 |
| 自然度与推进 | 具体、可回应且自然推进；重复总结、机械提问、说教如实记录 |
| 视觉身份与局部编辑 | 对照 pins、原图和编辑图，分别看身份、要求改动及非目标保留 |
| 声音匹配 | 实际听完整音频，对照文本/声音版本，检查错读、截断、停顿和角色气质 |
| 等待与回访价值 | 真实浏览器回找历史、自然继续；记录愿意继续或放弃的具体原因 |

每个审阅项记录审阅人、时间、原输入/产物和具体观察。`summary.execution=completed` 仅表示请求范围自动事实成立，`fullExperienceComplete` 不代表 `productQualityApproved`。非空文本、模型自评或下载成功不足以证明自然度、身份/场景保真或声音合适。

检查工具步骤保留有来源的对话/召回，当前用户才是动作发起者；编辑使用正确原图和完整冻结方向，超预算不静默截尾；正文等待/完成话术与实际交付一致。上下文、完整指令与像素遵从分别验收，模型自评不作为视觉评分。新编辑保留独立 source/请求/结果，不覆盖原失败。

这组英文 realistic 基线不能签发中文/anime、长对话、真实隔日/D7、群聊、独立 Input、Voice Call、Chat Animate、自然语言视频或 Generate Video。各自按主站清单独立验证；Clip 播放不能代验 Input/Call，即时跨会话召回不代表 D7 留存。

## 记忆来源与派生质量

Main 有效产品 Turn 是来源，official igrep 是派生召回。来源删除、修订或清除后，验证重建及隔离期：Chat 可继续产生 Turn，但长期记忆不能召回尚未收敛的旧内容。关闭记忆不等于删除本会话当前可见原文，验证时应使用适当的新会话与明确时间边界。

验证分开记录：Main 有效原文、官方索引中实际可检索来源、DSH 本轮命中证据和模型最终回答。坏派生不能覆盖仍有效原文；拒绝、等待维护和恢复失败保留真实状态。正确索引不证明最终回答正确；删除/清除需授权成功回执与实际不再召回的证据。

## 生成耗时

Gen 将已观察性能写入原有 terminal accounting，Main `ai_usage_facts.usage.performance` 持久化。ComfyUI 参考图片以内容 SHA-256 命名；同字节可稳定复用 LoadImage 输入，不同字节不覆盖排队中的旧引用。缓存存在与实际提速分别证明，不把某样本的效果外推全体请求。

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

诊断只读，按 dataClass、sourceType、用途、profile/workflow 版本与 model 分组，输出样本数和 p50/p95；重试的 Job 端到端只计一次。exit 0 表示选定窗口未被 limit 截断，exit 2 表示截断，exit 1 表示执行失败；零退出码不证明性能达标。诊断读取当前权威和窗口内请求，不是可控模型基准或历史状态重建；不同配置、冷暖状态和输入复杂度不能直接合并成“模型提速百分比”。字段和 CLI 的实现入口见 [诊断脚本](../../packages/main/src/scripts/generation-diagnostics.ts)。

## 指标物化与可信度

记录定义版本、数据时间和实际刷新范围，核对指标定义、质量判断与物化使用一致事实快照。刷新入口见 [refresh](../../packages/main/src/server/modules/admin-v2/metrics/refresh.ts) 和 [query](../../packages/main/src/server/modules/admin-v2/metrics/query.ts)；配置周期不能证明运行时持续刷新，失败与过期数据须显式报告。

```bash
bun run --filter @idream/main metrics:refresh --check
bun run --filter @idream/main metrics:refresh
```

`--check` 只读；去掉该参数才写物化记录。exit 0 表示 official 指标满足 decisionReady，exit 2 表示可读取但存在认证阻断，exit 1 表示执行错误。输出包含每个指标的具体原因、定义版本、数据时间、成熟与未成熟样本量。

WPCU 保持 official；其他诊断指标保持原层级。刷新不会自动认证定义、将 audit/internal 改成 customer、制造收入或把未成熟窗口写成零留存。指标的有效定义、真实 eligible facts 与成熟观察窗仍是使用它做经营决策的必要条件。

## 结果与结束条件

报告至少包含：用户目标/故事/用例、source/service revision、环境/账号/角色 pins、原输入与预先判据、provider/model/workflow、request/Turn/attempt/artifact/delivery、报价/净扣/退款、各耗时及产物/浏览器/持久化证据。分别报告自动事实、质量、等待比较和指标可信度；未执行、失败与条件限制不能折算为通过。

证据充分后停止重复验证；后续新增变化按明确风险补证。清理走工具 README 的正式 API 和本轮对象归属，保留既有用户历史、必要账本、媒体证据与原失败。尚在执行、结果未知或费用异常先停止新的消费并核对原请求。公开上线另受目标环境 readiness 约束。
