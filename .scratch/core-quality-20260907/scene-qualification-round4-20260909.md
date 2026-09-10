# Scene 解释器资格验证：第四轮原件复核 · 2026-09-09

Status: partial / qualification not passed。七次调用已经停止；本轮没有可接入产品的语义候选。不能把“未取得资格”改写为“模型不可能理解场景”。

结论按错误类型拆分：3 次通过 schema / 引用范围检查，但真实语义不合格；2 次 nullable-container 类型错误受已复现的 oMLX / Qwen 原生 parser 缺陷干扰；1 次缺必填字段；1 次复写 schema 并在 1024 tokens 截断，没有形成可评估语义候选。不能把这七次合计为七次纯模型语义失败。`core_02` 的持续 STORY 保持不变是正确结果，不能因最终 IMAGE 错误而一并判成 scope 理解全错。

## 1. 范围、消费与固定条件

- 当前唯一 route：`openai-compatible-v1` → `http://127.0.0.1:8061/v1`，本机 oMLX `0.6.4`，模型 `Ornith-1.5-35B-A3B-Abliterated-MLX-4bit`。使用正式 `OpenAiCompatibleAdapter` 流式调用，`chat_template_kwargs.enable_thinking=false`。
- 每个原件恰好 1 次模型 HTTP；共 **7 次，输入 13,543 / 输出 2,189 / 合计 15,732 tokens**。逐调用客户端耗时合计 **32.725 秒**，不含两次调用之间的人工分析。六次 `finish_reason=tool_calls`，一次 `length`；HTTP 200 仅代表传输响应，不代表合格。
- 输出上限始终 1024，`top_p=0.95`、`repetition_penalty=1.05`。前六次温度 0.9；第七次使用当前既有 structured 温度 0.2，没有新增 route / 配置。最后两次请求体剔除 `temperature` 后逐字段完全一致，candidate hash 相同，是温度单变量对照；单样本不构成稳定性或因果概率估计。
- **0 Gen 调用、0 工具执行、0 业务数据库写入、0 生产 semantic caller 接入、0 安装版 parser 修改。** 没有生成图片、创建 Generation Request / Job / attachment、扣减 dreamcoins、充值或支付。provider 报告了上述本地 token 用量；未提供货币费用，不把它写成已验证的美元成本。
- 本轮运行前每次 provider preflight 都为 `active=0 / waiting=0 / loading=0`。统一一请求上限、首 token / 空闲界限和诊断终止期限，没有错误后无限重试。
- 仅实际运行 `core_01` 与 `core_02`；**core_03–05 和全部 3 个 holdout 均未运行**，也没有像素、持久化、交付、重播、唯一扣费或公开生产验收。主任务的 Main / Shared v1 Scene authority 确定性修复与本资格实验独立；它们不证明当前自然语言 Scene 解析正确。

## 2. 已冻结输入与资格门

[八例 fixture](../../.tmp/architecture-continuation-20260909/scene-qualification-fixtures.ts) 在模型运行前写定：5 core + 3 holdout；先验事实均有 record 0 支持，记录顺序 / 唯一 ID / 当前用户索引完整。实际请求只传 `prior` 或其无损展开 `facts`、`records`、`currentUserIndex`、`needImage`；人工 `expected`、case key 和 tier 没有进入模型输入。七份保存输入、实际 wire input 及人工预期已与冻结 fixture 逐项核对一致，未事后放宽断言。

核心前门不是词袋得分：`core_01` 要把剧情更新成晴天、同一本闭合蓝本在白杯右侧，保留木窗台 / 白杯 / 未点燃红蜡烛，移除 Mina，同时保留 calm / 选火车待办；`core_02` 要保持咖啡馆雨夜左侧 STORY，只让 IMAGE 使用海边晴朗早晨右侧、完整衣着半身及所有未变物件属性。缺一项关键义务、加入冲突事实或无来源动作即未合格。

[当前诊断 harness](../../.tmp/architecture-continuation-20260909/scene-interpretation-qualification.ts) 不是生产 caller。完整快照方案由模型返回完整 STORY / IMAGE；targeted edits 方案由 host 保留未编辑事实、按稳定 fact ID 原位替换或清除，`new:*` 仅添加真新事实。IMAGE 先继承更新后的 STORY 的地点 / 时间 / 可见事实，再应用 imageEdits，最后追加 framing；不能靠追加“右侧”覆盖仍存在的“左侧”。

Fixture SHA-256：`28cb54772b35fffb22c02afa8d3b786b7e648eb8c7cdd2530dfaf94d102798aa`。复核时 harness SHA-256：`78a1e218a7ad0381d4bb2314f20d9e225c696df6a174e835ef3f6c26328a2e38`；harness 在实验间有协议改动，历史实际 system / schema / 请求体以每份原件为准，不能用当前文件冒充当时源码。

## 3. 七次调用逐类型结果

时间为客户端 `elapsedMs`；tokens 为 provider 实报输入 / 输出。所有链接指向保留原始请求体、SSE、adapter chunks、finish、usage、source revision 与错误的本机原件。

| # | 原件 / response ID | 候选、用例、温度 | tokens / 时间 | 协议与真实语义 |
| --- | --- | --- | --- | --- |
| 1 | [ddf87dd5](../../.tmp/architecture-continuation-20260909/scene-interpretation-core_01-ddf87dd5-9991-441d-9d8c-1c3a3395a335.json) · `chatcmpl-5c19b871` | full-state-refs-v1；core_01；0.9 | 2312 / 211；4.281s | Native / schema / 引用范围通过；晴天、右侧和笔记本属性正确。但 Mina 未移除，反增隐含 companion；完整快照漏掉红蜡烛；复合旧属性来源只写当前 record 1。语义未过。 |
| 2 | [b7fd6241](../../.tmp/architecture-continuation-20260909/scene-interpretation-core_02-b7fd6241-1a1a-4342-a097-d442512daf17.json) · `chatcmpl-af7a4607` | full-state-refs-v1；core_02；0.9 | 2311 / 290；4.483s | `imageFacts` 为 string，schema 拒绝；anyOf 缺陷构成确定性混杂因素。STORY 与 prior 完全一致，隔离正确。可读图片载荷加入 holding notebook，与平放窗台冲突，并漏未点燃状态；不能归为只有协议问题。 |
| 3 | [371c961e](../../.tmp/architecture-continuation-20260909/scene-interpretation-targeted-fact-edits-v1-core_01-371c961e-41a3-4389-8586-2cc79ded381a.json) · `chatcmpl-26860bd3` | targeted-fact-edits-v1 / native；core_01；0.9 | 1902 / 99；3.128s | 仅有 storyEdits，缺必填 imageEdits / framing / unresolved；不是已证明的 anyOf 字符串问题。晴天与 Mina 删除正确；未输出右移 edit，按 missing=keep 会仍取旧左侧；额外重复未变选火车事实。未生成合法完整候选。 |
| 4 | [47a09739](../../.tmp/architecture-continuation-20260909/scene-interpretation-targeted-fact-edits-v1-core_02-47a09739-254d-4ccd-8dca-c3833e6af654.json) · `chatcmpl-da9af1ec` | targeted-fact-edits-v1 / native；core_02；0.9 | 1901 / 189；3.391s | imageEdits / framing 为 string，schema 拒绝；anyOf 混杂。storyEdits=[] 正确。可读 edit 把 beach / morning 合入 location，未替换 time；把既有笔记本等作为 new:visibleFacts，未替换旧左侧；衣着未保留。不可接纳。 |
| 5 | [2121b4f0](../../.tmp/architecture-continuation-20260909/scene-interpretation-targeted-fact-edits-v1-json-core_01-2121b4f0-054c-4d5b-924b-a32d530ac813.json) · `chatcmpl-5439d107` | targeted-fact-edits-v1 / plain JSON；core_01；0.9 | 1403 / 1024；10.713s | 实际请求省略 tools / tool_choice，在 system 放相同 schema。输出从 fenced JSON 的 `$schema/type/properties` 开始复写 schema，最终 length；未生成事实候选。是输出指令 / 协议及预算终态失败，**不得记作场景语义失败**，也不证明所有普通 JSON 协议均不可用。 |
| 6 | [63ba1e4e](../../.tmp/architecture-continuation-20260909/scene-interpretation-targeted-fact-edits-v1-native-typed-core_02-63ba1e4e-7312-4d28-aaa6-c437b62a822e.json) · `chatcmpl-0bf459a5` | targeted edits / native-typed；core_02；0.9 | 1857 / 239；3.842s | 顶层容器显式 type，native / schema / 引用范围通过。STORY 完整保留，IMAGE 地点与时间正确替换；但 new:* 追加右侧仍留旧左侧，重复杯 / 蜡烛；framing 漏 fully clothed。语义未过。 |
| 7 | [6b18cf65](../../.tmp/architecture-continuation-20260909/scene-interpretation-targeted-fact-edits-v1-native-typed-core_02-6b18cf65-ccee-4d86-bde8-8ed7c9016425.json) · `chatcmpl-3c838b48` | 与 #6 同候选 / schema / 输入，仅温度 0.2 | 1857 / 137；2.887s | native / schema / 引用范围通过。storyEdits=[] 正确；imageEdits 也为空，海边 / 晴朗早晨 / 右侧全放 framing。实际 host IMAGE 仍同时含 cafe / rainy night / left 与 beach / sunny morning / right。完整衣着已表达，但冲突未消除，语义未过。 |

### 不可混淆的判断边界

- #2 的 STORY 完整快照与 prior 逐字段一致；#4、#6、#7 的空 storyEdits 符合 picture-only 规则；#6、#7 的实际 host STORY 也与 prior 完全一致。这不是“模型把图片场景写坏持续剧情”的证据。
- #6 真实 `interpretation.imageFacts` 同时存在 prior 的 `to the left of the white cup` 与新增 `to the right of a white cup`。#7 则把新场景写进 framing，却没有替换继承的旧地点 / 时间 / 关系。二者即使 JSON 合法、所有 source index 在范围内，最终画面仍矛盾。
- #4 因 schema 已拒绝，没有合法 host interpretation；对可读 edit 的问题描述是按其合同的静态后果分析，不是宣称实际执行或修补成功。#2 的可读 imageFacts 字符串还带异常尾部 `]}}`，不能强行修复后当作合法数组；本轮没有对其做多重 unescape / 修补接纳。
- #6、#7 的最终 IMAGE 仍继承了 prior 的未点燃蜡烛、平放等属性。不能因为新增短句或 framing 省略词语，就声称最终 IMAGE 已经丢掉该属性；真正的反例是已展示的冲突关系 / 场景，及 #6 的衣着缺失。
- Host 合并旧 refs 与新 refs 仅保留**来源沿革**，不是证明其中每条记录都支持新值：例如 #6 的 beach / sunny morning 含 `[0,1]`，record 0 实际只支持旧 cafe / rainy night。不得标为 verified 或“所有 refs 已语义通过”。复合属性的当前支持与历史来源需要清楚区分；本轮只检查了索引范围 / 重复引用，不存在通用语义校验器。

## 4. oMLX / Qwen 原生 anyOf 缺陷：离线独立反例

[可重跑 Python 脚本](../../.tmp/architecture-continuation-20260909/omlx-anyof-parser-repro.py) 与 [完整可读 proof](../../.tmp/architecture-continuation-20260909/omlx-anyof-parser-repro.md) 仅保存在本机 ignored `.tmp`，不是仓库分发依赖。脚本直接加载安装版源码，不加载模型、不开服务、不访问网络、不写安装文件；仅用进程内 marker / parser 适配对象和恢复式 fallback 计数包装观察真实调用链。

```bash
/Applications/oMLX.app/Contents/Resources/Python/cpython-3.11/bin/python3.11 -B .tmp/architecture-continuation-20260909/omlx-anyof-parser-repro.py
```

实际复跑退出 0，反例与对照均通过：

| 同一合法 XML 内容 | storyEdits | imageEdits | framing | 实际 fallback 次数 |
| --- | --- | --- | --- | --- |
| native + anyOf nullable 容器 | list | str | str | 0 |
| 相同 schema，仅 fallback 路径 | list | list | dict | 1 |
| native + 明确非 nullable 容器 type | list | list | dict | 0 |
| native + anyOf，值为字面 null | list | None | None | 0 |

原生源码 `/Applications/oMLX.app/Contents/Resources/Python/framework-mlx-base/lib/python3.11/site-packages/mlx_lm/tool_parsers/qwen3_coder.py`，SHA-256 `32de6d9f7472a1f00a2acfaacaf13e0e0864cfc19adebbff688ac5004b8ecc25`：第 36–49 行只读取顶层 type，没有则默认 string；不会展开 anyOf。

oMLX `/Applications/oMLX.app/Contents/Resources/omlx/api/tool_calling.py`，SHA-256 `9b770f83fa8b0019ae536f7476365826cced9acfd21fb95ebd11c3552469d6c8`：第 1593 行先调 native，第 144 行 `_build_tool_call` 序列化正常返回的对象；第 1650 行的 XML fallback 只在 native 抛错后有机会执行。anyOf 场景静默返回 string，故 fallback 未调用；第 258 行 fallback coercion 自己的一次 JSON parse 能正确处理这份合法 XML，但不会纠正未抛错的 native 结果。

`type: [object, null]` 也不是可靠替代：它落入 `ast.literal_eval`，遇到合法 JSON `true` / `null` 抛 `ValueError`。不能用简单对象偶然成功掩盖这个分支。

七份原件的 `rawSse` 是 oMLX 解析后的 OpenAI-compatible 输出，不是原始模型 XML / token 流；其中 arguments 与 adapter `block-end` arguments 已逐字核对相同，没有发现客户端二次改写。外层 artifact JSON、SSE JSON、arguments JSON 与字符串字段各自带转义，不能从反斜杠数量倒推历史 XML。反例证明有确定性协议缺陷，不证明历史每一处异常都只由该缺陷造成；#1 / #3 / #6 / #7 的具体语义反例也不会被该发现消除。

## 5. Source revision 绑定与复核

所有调用的正式 adapter SHA-256 均为 `9789904cbdec59db6f6e805649fb5a13279bba256cba17ee2470823410179db9`。各调用绑定各自完整 worktree revision，不能用后续 authority 修复的 revision 覆盖旧结果。

| 调用 | 保存的 sourceRevision | 保存的 candidateSha256 |
| --- | --- | --- |
| #1–2 | `idream-worktree-5757632a4a99df86dede553a4ec28f3b712d1e0691e48edd8447c8afa33acfe9` | `a4db594f43cd896181d57e637cc4fbb979ada40d90f22bfded9bb048e3e0030a` |
| #3–4 | `idream-worktree-273c18972d3741d4a0fed356d0770ebb834d5e55585dc4c3877ed13ab06ae464` | `f72a916a26f875baca6605181be7f0612816e3c1fb2ed3dc0b30e0e730a29e1f` |
| #5 | `idream-worktree-daef72e7ec1ee5a28416d93dbb9641804ace6c1af2f2651552edaac8991866c4` | `a8e8988312a0f87ba8dc6c11b2a65a003d0914766b4fffc45a2e0d45ccd9fb80` |
| #6 | `idream-worktree-8dc287a297888bfe91d58eee518015ea976d709b84ef6f356f08a79b22249898` | `a6303193d48074e1fbd7843781c72ec7bd5da510aae7a23dea5d2789cabbdf16` |
| #7 | `idream-worktree-31b06419902de7b71ff576a5e596f1351d7e94ef2f25c43d5bada25b75e9e949` | `a6303193d48074e1fbd7843781c72ec7bd5da510aae7a23dea5d2789cabbdf16` |

已执行的只读复核：逐份 JSON parse；七份 frozen input / expected 与实际 wire 投影深比较；SSE arguments 与 adapter arguments 逐字比较；#6 / #7 请求体排除 temperature 后深比较；usage 求和；STORY 与 prior 对照；真实 parser 离线脚本及 schema 类型反例；报告本地链接与 diff / 空白检查。未为写报告触发全仓构建、数据库套件、额外模型或真实生成。

## 6. 为什么提前停止，以及尚未证明什么

当前前门已经显示会漏真实更新、遗留相反关系或把图片改变塞入 framing，而不是按合同替换继承事实。继续发送 core_03–05 或 holdout 不能补救这个已知前门失败，也会提前消耗独立未见例，因此本轮停在 7 次，不为凑齐矩阵继续消费。

这不等于后续用例不重要：条件 / 将来式、合法 Character 已完成动作、否定与较晚错误复述、中文组合、显式清除 / 未知状态、未来计划与已执行动作隔离都仍然未获真实模型证据。全部 8 例及原预期保留，不减少产品要求，不把未运行计为通过或失败。

产品仍不接入本候选语义 caller；没有为了通过而删 Scene、堆固定地点词库、无条件拒绝所有图片、解码修补任意字符串或覆盖 oMLX 安装文件。后续若重新开启资格验证，应先定义一个有证据支持且可证伪的候选差异，再通过核心前门、冻结候选后运行未见例，最后单独证明真实图片链路。普通 JSON 的这一次失败只约束当前提示 / 预算，不证明协议方向整体不可行；本轮不继续追加提示、预算或模型消费。
