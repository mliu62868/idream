# Companion quality eval

这套评测用来复现角色扮演回复的质量，走的是**生产提示路径**。`eval/nsfw` 直接拼系统提示，这里不这样做，而是先把每个用例构造成 schema 合法的 Main 快照（`ChatExecutionSnapshot` 加 `ChatAuthoritySnapshot`），再交给生产代码处理：

1. `prepareCompanionTurn`，也就是 `buildContext` 再接 `compilePreparedTurn`。这一步包含 state block、偏好、reply cue、工具暴露和预算裁剪。
2. 真实的 `CompanionEngine`。装配方式与 `src/agent-runtime/runtime.ts` 一致，包括 Pi 循环、igrep 检索工具、媒体 extraction/body 两段和终态校验。
3. 假的 Main port：
   - 工具效果返回真实形状的 Main 回执。paid 模式返回 `accepted`；chat 模式返回 `awaiting_confirmation` 报价；resend 按 `recentMedia` 返回 `completed`，找不到 id 时返回 `failed`；edit 返回草稿。
   - commit 只截获终态候选，不写入任何地方。

默认在 `private` 记忆模式下执行，对应快照里的 `memoryEnabled=false`。用例里写 `"memoryEnabled": true` 时改走 normal 模式，此时 canonical 根目录是临时的空目录。所有 workspace 和 fence 根目录都建在系统临时目录里，运行结束后删除，不会碰 dev 服务的记忆目录。

igrep CLI 不可用时，执行器自动回退为 `direct-adapter`：把编译好的 PreparedTurn 消息直接交给真实的 `OpenAiCompatibleAdapter` 发送，不暴露工具。每一行结果的 `executor` 字段都会标明用的是哪种执行器。

## 用例

`cases/*.json` 里，每个文件是 `{ category, kind?, cases: [...] }` 的结构。字段定义见 `fixture.ts` 的 `TurnFixture` 和 `run.ts`。

| 类别 | 覆盖 |
|---|---|
| persona | 人设事实、被问是不是 AI、口癖与禁忌（emoji） |
| language | zh/en/ja/es 跟随用户语言、历史中途换语言、用中文要求英文回答 |
| length | 精确句数（en/zh/ja）、保存的 short 偏好、"至少 N 句" |
| group | 群聊里只以自己身份发言，不写其他成员的台词或 `Name:` 前缀 |
| recall | 召回历史中出现过的事实 |
| correction | 用户纠正后使用更正后的事实 |
| continuity | 故事时间、地点、已保存的 Scene 和未完成的线索 |
| media | 该调或不该调媒体工具；没有工具时不得承诺发图 |
| continue | "continue/继续"时接着往下写，不重复上文 |
| multi | 一条消息里的多个请求全部回应，包括媒体加文字 |
| scene | `scene-light` 资格验证（见下） |

确定性检查定义在 `checks.ts`，包括：语言（按文字系统比例，en/es 用停用词投票）、句数、字符数、禁用子串和正则、必需事实（任一命中即可）、工具是否被调用、不得逐字重复上文。

judge 只输出 JSON 标签，pass/fail 由代码比较标签和用例的 `expect` 后给出。每个用例都会额外检查 `brokeCharacter=false` 和 `refusedOrMoralized=false` 两个通用标签。

## Scene 资格验证

`kind: "scene"` 的用例会把一轮已提交的交换送进 `src/scene-light.ts` 的 `projectLightweightScene`，再和预期的 delta（location/time/participants/threads）对比打分。

- 不写 `assistant` 的用例，先跑一遍生产回复，用实际提交的回复做投影。
- 写了 `assistant` 的用例，直接用这段固定文本。

结果里记录字段准确率、degraded 次数和投影延迟。这一项只做评测，不接入生产，见 ADR-21 第 9 节。

## 运行

在 `packages/chat` 目录下运行，这样 bun 会加载 `packages/chat/.env`：

```sh
bun eval/companion/run.ts --dry-run                 # 只编译、校验所有 fixture，不调用模型
bun eval/companion/run.ts --samples 1               # 完整真实运行
bun eval/companion/run.ts --only media,recall-01    # 按类别或 id 前缀筛选
bun eval/companion/run.ts --no-judge                # 只跑确定性检查
bun eval/companion/run.ts --reply-cues off          # cue A/B 的 off 组
bun eval/companion/run.ts --rescore path/results.jsonl  # 用当前确定性检查和已存的 judge 标签重算，不调用模型
```

`--rescore` 会在输入文件旁写出 `rescored-summary.json`，其中列出判定发生变化的用例。原始结果文件不会被改动。

参数说明：

- 目标模型和 judge 默认都用 `CHAT_MODEL_*`。可用 `--base-url/--model/--api-key` 覆盖目标模型，用 `--judge-url/--judge-model/--judge-key` 覆盖 judge。
- `--min-pass` 默认 0.8，通过率低于它时以退出码 1 结束；fixture 或配置错误退出码为 2。
- `--out` 指定 JSONL 结果路径，默认是 `<repo>/.scratch/companion-eval/<时间>-<model>/results.jsonl`。同目录下还会写出 `summary.json` 和 `report.md`。
- 每行结果都带 `sourceRevision`（来自 `bun run source:revision`）、目标 provider/model、judge model、`productPromptVersion`、composition digest、igrep 版本、`replyCues`，以及该用例的标签、回复、工具调用、每次物理请求的 purpose/耗时/用量、首字耗时和总耗时。

### reply cue A/B

`--reply-cues off` 会把 `{ replyCues: false }` 作为第 4 个参数传给 `compilePreparedTurn`，同时把 `replyCues: false` 写进 `CompanionEngineOptions`。

harness 会做特性探测：分别编译带选项和不带选项的版本，比较两者的消息摘要。如果摘要相同，说明当前源码还没有实现这个开关，`summary.json` 里的 `replyCueOptionSupported` 会是 `false`，报告中也会注明。这种情况下 off 组的结果和 on 组没有区别，不能当作 A/B 证据。

做 A/B 时，在同一个 source revision 上分别跑 `--reply-cues on` 和 `--reply-cues off`，建议 `--samples 3` 以上，再按类别比较通过率。
