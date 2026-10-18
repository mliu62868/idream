# Pi 执行内核与 pi-durable 调研（2026-10-17）

> 后续补充：本报告第 5 节记录的是当时的 igrep 0.1.157 快照。0.1.161 的逐文件差异、宿主契约与隔离探针见 [igrep 更新研究](IGREP_UPDATE_RESEARCH_2026-10-17.md)；结合两轮证据的完整迁移提案见 [Companion Chat 改进方案](../../.scratch/pi-igrep-chat-runtime/PRD.md)。后者建议先验证 Durable + MemoryStorage，不将新增持久 checkpoint 作为本期迁移要求。

## 结论

**可以将 Pi 列为 DSH 的替代方向，但最新版本要求重新比较 `pi-agent-core` 与 `pi-durable` 两种方案。上一轮直接倾向于 `pi-agent-core + pi-ai`，尚不足以覆盖现在的产品分层。**

- `pi-agent-core` 是模型与工具循环。适合宿主继续拥有完整执行、恢复与上下文管理的场景。
- `pi-durable` 是包含会话、模型请求、工具、任务状态机、持久化进度和压缩的另一套执行内核。若迁移目标包括删除自研通用恢复代码，它是更完整的候选，而不是给 `agent-core` 加上的存储插件。
- Durable 可以可靠记录“准备执行什么”和“已观察到什么结果”，但不能让外部图片生成、交付、扣费自动获得 exactly-once。Main 的业务幂等与未知结果对账仍然需要保留。
- 是否更简洁，应按最终删除的 DSH 装配、执行与恢复代码，减去新增的宿主适配、存储、版本迁移成本判断。依赖包数量不能代替这一判断。

本机 `igrep 0.1.157` 还已提供原生 `@igrep/pi-memory`，因此需要把“Coding Agent SDK + 原生 igrep 扩展”列入比较；不过它的自动 ingest 与当前 Main 记忆权威冲突，不能直接照默认配置上线。详见第 5 节。

以上选型结论属于基于官方契约、当前项目源码及隔离存储探针的工程判断，尚不是已在 iDream 生产链路完成验证的结论。

## 1. 版本与证据范围

检索日期为 **2026-10-17（America/New_York）**。同时核验 GitHub release、tag、npm registry 的 `dist-tags` 和对应 tag 源码，避免把 `main` 上的新 API 当成已发布能力。

| 项目 | 核验结果 |
| --- | --- |
| 当前官方仓库 | `earendil-works/pi` |
| GitHub 最新正式 release | `v1.3.0`，发布于 `2026-10-15T19:17:33Z` |
| `v1.3.0` 指向的 commit | `71023aec1546d6d677a65669c5665c0927ce0dd0` |
| 本次看到的 `main` | `8efd314fa3d3232ce197d8d7a6a5660530b9d83e`，commit 时间 `2026-10-16T20:53:00Z`，领先正式 tag 16 个 commit |
| npm 当前正式命名空间 | `@earendil-works/*` |
| 旧 `@mariozechner/pi-agent-core` | npm `latest` 仍为 `0.73.1`，发布时间 `2026-05-07T14:45:01Z`；不能用它判断当前 Pi 能力 |

来源：[正式 release][release]、[固定 tag commit][tag-commit]、[本次 main commit][main-commit]、[旧包 npm metadata][old-registry]。

本次核验的下列包，npm `latest` 均为 **1.3.0**，`engines.node` 均声明 **`>=22.19.0`**：

| 包 | 与本任务的关系 |
| --- | --- |
| `pi-ai` | 模型 API、provider、上下文消息、用量、图片与分类接口 |
| `pi-agent-core` | 内存中的 Agent 状态、模型与工具循环、事件 |
| `pi-durable` | 持久化会话、任务、模型与工具执行、恢复、压缩 |
| `chord` | Durable 使用的上下文取消与文档状态能力 |
| `pi-coding-agent` | 面向开发工具的 CLI/SDK，包括会话与编码工具 |
| `pi-mcp` | 独立 MCP 客户端 |
| `pi-codemode` | 执行工具调用脚本的沙箱组件 |
| `pi-env` | Durable 的远程执行环境 |
| `pi-telemetry` | 独立遥测契约 |

来源：[官方包索引][root-readme]、[pi-ai metadata][ai-registry]、[agent-core metadata][agent-registry]、[durable metadata][durable-registry]、[coding-agent metadata][coding-registry]、[Chord metadata][chord-registry]、[MCP metadata][mcp-registry]、[codemode metadata][codemode-registry]、[env metadata][env-registry]、[telemetry metadata][telemetry-registry]。npm 的 `latest` 是查询时快照，不是永久固定版本；下文可复核的实现结论均以 `v1.3.0` 为准。

### 正式版与 main 的差别

以下变化已在本次 `main` 的 `Unreleased` 中，**不属于 1.3.0**：

- `settings.compaction.modelOverrides`：按精确 `provider/modelId` 设置压缩阈值。
- `HarnessOptions.models` / `settings` 接受函数，以便运行时替换配置。
- `ToolControl.terminate` 的类型从 `true` 扩展为 `boolean`。
- README 更正 `StorageRequestError` 描述：只有读取异常可局部失败，`commit()` / `mintId()` 抛出它仍使整个 Harness 失败。此处是正式版说明不够准确，1.3.0 的规范已经明确写出该边界。

来源：[固定 main 的 Durable changelog][main-durable-changelog]、[正式版 Storage 失败规范][storage-spec]。实施时应锁定完整版本组与 lockfile，不能复制 `main` 示例后安装 `1.3.0`，也不能因某个新 API 方便就隐式追随 main。

## 2. 当前产品分层

最重要的历史变化发生在 **1.0.0（2026-10-01）**：官方从 `pi-agent-core` 删除实验性 harness、sessions/storage、durable runtime、compaction、skills、prompt templates 等，仅保留 `Agent`、agent loop、proxy stream 和相关类型，并明确指向 `pi-durable` 承接 durable sessions。[agent-core changelog][agent-changelog]

实际依赖关系是：

```text
业务宿主 → pi-agent-core → pi-ai

业务宿主 → pi-durable → pi-ai
                      → chord
                      → pi-codemode 等内部依赖

pi-coding-agent → pi-agent-core + pi-ai + pi-mcp + pi-tui + 编码工具
```

1.3.0 的 `pi-coding-agent` 并不依赖 `pi-durable` 或 `chord`，因此不能因为 Pi CLI 已经成熟，就推断新 Durable 内核具有同样长的运行历史。反过来，也不能因为 Durable 标注 Experimental 就忽略它已经提供的执行契约。[Durable package.json][durable-package]、[Coding Agent package.json][coding-package]

| 需求 | agent-core | pi-durable |
| --- | --- | --- |
| 一次模型请求与工具循环 | 提供 | 提供自己的 built-in generation/tool tasks |
| 可取消流式事件 | 提供 | 提供，外显进度先持久化 |
| 重启后接续执行 | 宿主负责 | task checkpoint、submission、ownership、恢复调度 |
| 持久化上下文与压缩 | 宿主负责 | entries、head/reset、compaction task |
| 业务交付、额度、支付幂等 | 宿主负责 | 仍由宿主负责 |
| 既有 PreparedTurn 作为外部权威上下文 | 接入较直接 | 需要明确它与 Durable transcript 的职责与同步边界 |

这里不存在已核实的“所有新聊天应用必须用 Durable”的官方硬性规则。官方的明确分工是：需要 durable sessions 时使用 Durable；选择最小 loop 时仍有 agent-core。iDream 应按要交给内核的责任选型。

## 3. Durable 实际保证什么

### 3.1 持久化对象与权威

一个 Session 串行化其所有 commit；一次 commit 可以原子写入 conversation、immutable entry、task、submission 和 document。内建文档包括 agent 配置、provider session identity、进行中的模型与工具状态、inbox、usage。工具是独立 task，模型请求也是 task；任务拥有关系和 wait 状态可跨重启恢复。[规范：不变量与核心对象][core-spec]

这意味着 Durable 不是“只替换一个 AgentRun JSON 文件”。默认 Harness 同时拥有自己的执行 transcript、上下文截断与 summary、任务状态和结果 receipt。Main 仍可保持产品 Turn、交付与计费权威，但必须设计 Durable transcript 与产品历史的边界，防止两个系统各自认定最终答案或下一轮上下文。

可行的产品边界推断是：Main 持有用户可见 Turn 与账本；Durable 持有本次执行的模型/工具记录、checkpoint 和未提交 proposal；只有 Main ACK 后，宿主才发布产品终态。需要通过故障测试证明该映射，而不是把 Durable 的 `submission done` 直接当成产品已交付。

### 3.2 外部效果：effect sandwich，不是 exactly-once

官方规定的基本流程为：

```text
commit 执行意图 → 执行外部动作 → commit 结果或下一阶段
```

恢复时如果停在 intent phase，外部动作可能已经发生。phase handler 必须安全重试、凭外部 handle 查询，或者记录 interruption。框架不会替外部系统生成可证明的“未发生”结论。[规范 §5.2][effect-spec]

`pi.tool` 默认 `replay: "unsafe"`。意图与最终参数在 execute 前持久化；崩溃后，只有持久化策略和当前工具声明都为 `safe` 才重执行。否则生成 `interrupted` 工具结果。nested tool calls 能按稳定 key 找回已完成的调用与结果，但规范明确否认这等于 exactly-once execution。[工具状态机][tool-spec]、[nested tools 规范][nested-spec]

**对图片生成的直接含义：**若 Gen 已接受生成但 ACK 丢失，只存一个 checkpoint 仍不足以确定结果。必须先持久化稳定业务 actionKey，再向 Main 发送同一 actionKey，由 Main 查询或幂等复用既有结果。Durable 可以负责调度“继续对账”阶段，并将 Main ACK 记录下来；不能替代 Main 的动作收据、额度归属或已发生效果的判定。若没有外部幂等/查询能力，把工具标成 `safe` 会造成重复生成风险；标为 `unsafe` 仅代表不自动重复，并不证明没有生成。

官方 recovery 示例使用 durable memo 防止重复打印，但 memo 落盘和外部打印之间仍有崩溃窗口。这种演示不能直接照搬为扣费或图片交付的 exactly-once 实现。[recovery 示例][recovery-example]

### 3.3 模型恢复与费用

中断的普通流式请求不会从最后一个 token 接续：Durable 将已保存 partial 转成 aborted assistant entry，然后按保存的模型、参数和上下文重新请求；具有 deferred handle 的 provider 则可以进入 poll phase。`beforeRequest` 在恢复时会重新运行，因此需要固定的动态输入应进入 memo/checkpoint，而不能每次读取变化中的外部状态。[Generation 规范][generation-spec]

`pi.usage` 汇总已记录模型响应和工具回报，包括有响应记录的失败与取消。它不是所有实际 provider 费用的绝对权威：压缩请求若在响应提交前被 abort 或 crash，规范明确说该次用量不会计入。模型/SDK 内部重试与 Harness generation 重试也是两层独立策略，需防止叠加导致超预算。[Usage 与 Compaction 规范][usage-spec]、[重试设置类型][harness-types]

因此 iDream 仍需保留每次物理 provider 请求/attempt 的可核验记录及 Main 结算逻辑。Pi 的汇总可用于运行观察，但不能未经核验就取代产品账本。

## 4. Storage、Bun 与部署约束

正式提供 Memory、SQLite、JSONL、Cloudflare Durable Object SQLite。Memory 不持久化；SQLite Node adapter 使用 `node:sqlite`，默认 WAL + `synchronous=NORMAL`；JSONL 可启用 `fsync`，但还会将全部历史保留在内存，因此官方建议长时间运行的 agent 采用 SQLite。[Storage README][storage-readme]、[Node SQLite adapter][sqlite-node]

不能把 JSONL 的 `fsync: true` 解读为完整掉电持久性：1.3.0 规范明确说它先 flush sidecar，再写 main marker，普通提交不会显式 flush `main.jsonl`，所以已确认的尾部 commit 在主机故障时仍可能丢失。它主要保证存活的 marker 不会越过相应 sidecar。SQLite 的默认 NORMAL 同样区分进程崩溃与机器故障；本次探针只测前者。[JSONL publication 规范][jsonl-durability]

**一个 storage 同时由一个进程拥有，官方没有跨进程锁。** 这不是一个可直接多副本争抢同一 queue 的分布式执行器。宿主必须解决 storage 分片、owner、drain、故障接管与同一执行实例互斥；换成 PostgreSQL 并不会自动改变单 owner 的 Session 语义。

`Storage` 是公开接口，允许自建 backend；但它要求原子 batch、全局递增 ID、历史 document materialization、conversation ancestry、task/submission 查询、requestId 查重等语义，不是只实现 `get/set`。官方提供 `registerStorageConformance()`。1.3.0 自带 backend 中没有 PostgreSQL；实现它会增加实质维护成本。[Storage 完整契约][storage-spec]、[Storage conformance 源码][storage-conformance]

官方说明 portable SQLite / JSONL core 可以在 Bun 等环境运行，前者使用异步 `SqliteDatabase` facade，后者使用 `FileSystem`。未发现随 1.3.0 提供的专用 Bun SQLite adapter。**本次实测 `openNodeSqliteStorage()` 已能在 Bun 1.4.2 下创建并关闭存储**，所以不应直接推断需要自己写 Bun adapter；但这只是 smoke，尚未证明完整 SQLite conformance 或项目固定的 Bun 1.4.0 兼容性。JSONL 在 Bun 1.4.2 的实际跨进程恢复结果见第 8 节。

Storage 的错误处理很严格：除取消的读取或非法读取等明确例外外，任何 storage error 都使 Session 失败并关闭，恢复需重新 open；瞬时失败的 retry 属于 backend 内部责任。commit 报错后是否已经落盘可能不确定，重新提交必须复用 `requestId`。关闭会等待执行代码协作返回，不会强行终止无视取消信号的扩展。[Storage failure 规范][storage-spec]

`requestId` 只提供提交身份去重，不提供完整 payload 冲突检测：1.3.0 的 `admitSubmission()` 找到既有记录后只检查 `type` 一致就返回旧 ID，不比较输入内容。宿主仍应校验 PreparedTurn / proposal 的 revision 或 digest；不能将相同 requestId 被接受理解为“重试内容与首次一致”。[submission 实现][submissions-source]

### 数据保留与擦除是实际选型约束

1.3.0 的公开 `Storage` / `StorageWrite` 没有 conversation/entry 删除接口；reset/head 只改变上下文可见范围，不删除原文。任务 terminal 后可回收 checkpoint/memos，但仍保留 receipt 和 conversation owner 关系。`retireDoc()` 不是 transcript 擦除。[Storage 类型][storage-types]、[历史可见性规范][entry-retention]

对 iDream 来说，每个 attempt 使用独立 storage、Main 确定终态后由宿主 drain/close 再销毁整个存储，是一个可评估的方向；还须覆盖 SQLite sidecar、备份和迟到写入。若多个用户共用一份长期 storage，当前公开接口不足以直接实现按用户物理擦除，需要额外 backend 管理接口、离线重建或上游功能。这些成本必须计入方案，不能用 reset/abort 冒充删除，也不能直接在运行中的库里删 entries。该销毁方案本次尚未实测。

## 5. 与聊天相关的能力和最佳实践

### 模型接入

新代码使用 `createModels()` / `createProvider()`，显式注册实际使用的 provider，避免旧 `compat` 全局 API 和 `providers/all`。自托管 OpenAI-compatible 模型需要声明真实 `contextWindow`、`maxTokens`、tool 能力和兼容选项；常见 vLLM/Ollama 等服务可能需要关闭 `supportsDeveloperRole` 或 `supportsReasoningEffort`。不能因 HTTP 协议兼容就假设 reasoning/tool/usage 行为相同。[pi-ai 自定义 provider 与打包说明][ai-readme]

版本控制使用精确 `1.3.0` 与完整 lockfile。1.3.0 专门修复了内部 Pi 依赖不精确导致混装不兼容版本的问题，说明只锁顶层包不足以获得可复现行为。[正式 release][release]

### 工具与取消

两套内核都支持 sequential / parallel；默认 parallel。产品要求每轮有副作用工具串行时要显式配置，而不是依赖当前工具只有一个。工具权限应在宿主注册与参数校验边界落实；不要因使用 Pi 而给聊天角色默认加载 coding tools、shell 或远程环境。[Agent README][agent-readme]、[Durable 工具设置类型][harness-types]

将查询类、幂等写入类、不确定外部副作用类区分开，逐个确定 replay policy。稳定 actionKey、已使用的外部 handle 和 PreparedTurn revision 应保存到 durable 数据中。普通 hook 可能报错后被报告并跳过；对安全或产品正确性必须成功的逻辑，不能仅依赖允许继续的 observer hook。[Hooks 规范][hooks-spec]

具体而言，`beforeRequest` 的普通错误默认 report 后继续；`beforeTool` 的错误才会阻止工具执行。Main 权限、过期 attempt、不可变输入来源等必须失败即停的约束，应在宿主 admission/执行边界或明确的 task 逻辑中保证，不能仅靠 `beforeRequest` 抛异常。[Generation 实现][generation-source]、[HookRunner 实现][scheduler-source]、[Tool 实现][tool-source]

### 上下文、压缩与记忆

Durable 原文 entry 在压缩后仍保留；压缩是新 `pi.compaction` entry/head 改变模型可见范围。支持后台、手动、阈值阻塞及 overflow 恢复；失败的阻塞压缩会停止 generation。它可以减少我们自研压缩调度，但 **并不提供 igrep 的语义记忆、角色归属或 private 隔离策略**。[Compaction 规范][compaction-spec]

默认 summary prompt 来自 coding-agent 的结构化 checkpoint 模板，并会省略 system/thinking、截断工具结果文本。聊天产品应通过 `beforeCompact` 等入口定义和验证适合人物、关系、场景的压缩内容，继续保证原文可检索。不能把默认代码任务摘要直接视为长对话记忆方案。

### 已存在的 igrep 原生 Pi 接入

本机 `igrep --version` 返回 `0.1.157`；`igrep setup pi --dry-run --json` 找到官方随 CLI 分发的 `@igrep/pi-memory@0.1.0`，peer dependency 是 `@earendil-works/pi-coding-agent >=1.0.0`。本次只执行 dry-run 和读取 bundle，没有安装 extension 或修改用户 Pi settings。[版本、bundle 路径与文件哈希](evidence/pi-runtime-2026-10-17/igrep-integration.json)

已读该 bundle 的 README、index、compaction 和 session-recall 源码，确认：

- 已有 `memory_search`、`memory_record`、`session_recall`；压缩接 `session_before_compact`，调用 Pi Coding Agent 原生 `compact()`，召回依据 `SessionManager.getBranch()` / `buildSessionProjection()`。
- 它接的是 Coding Agent ExtensionAPI。`pi-agent-core` 与 `pi-durable` 不直接提供上述宿主接口，不能把这个扩展当成两者现成可加载的插件。
- 默认 `agent_end` 会投影 active branch 并 ingest，`session_shutdown` 会再 ingest/maintain；模型还能通过 `memory_record` 写笔记。本项目当前只允许 Main 已提交 Turn 驱动长期记忆投影，默认行为不符合这一契约。
- 当前导出入口没有接收关闭 ingest/maintain/record 的产品配置；仅使用临时 cwd 能隔离文件，但不能解决重复维护成本和记忆写入权威。需提供受支持的宿主配置或专用接入，并保留 normal/private、群聊角色归属及已提交来源校验。
- 本机 CLI 也公开 `igrep mem-api memory-search` 等 provider-neutral JSON 接口，为 Durable 接入长期记忆提供现成调用面；它本身不替代会话压缩原文 archive。

因此，上一轮把 igrep 迁移一概描述为重新适配不够准确：**Coding Agent 方向已有官方实现可复用；Durable 方向仍需宿主适配。** 本次未运行该扩展与 Pi 1.3.0 的 live suite，不能把 peer version 范围当作本项目兼容性证明。

### Coding Agent SDK 的正确嵌入方式

若选择 Coding Agent，应使用同进程 TypeScript SDK、显式 `cwd`、工具集合、resource loader、模型与 settings；可选 `SessionManager.inMemory()` 避免引入它的长期 session 文件。SDK 默认会发现工作目录资源、settings、credentials 与默认工具，不适合不加配置直接嵌入陪伴聊天。外部历史必须写入 `SessionManager`；只修改 `session.agent.state.messages` 不会替换其权威 context。产品完成也不应监听低层 `agent_end`，因为自动恢复或排队还可能继续；SDK 的 `agent_settled` 才代表不会自动续跑，之后仍须等 Main ACK。[SDK 文档][coding-sdk]

官方关联的 `pi-chat` 当前是把 Discord/Telegram 连接到 Coding Agent session 的扩展，使用 Gondolin VM 和 tmux。它提供可参考的集成，但不是可直接证明 iDream 服务端 Durable 架构成熟度的样板。[pi-chat README](https://github.com/earendil-works/pi-chat#readme)

### 其它新包如何取舍

`pi-mcp` 是独立 MCP 客户端；有实际 MCP 工具需求时再接。`pi-codemode` 让模型在 QuickJS/WASM 中组合已注入工具；当前只有少量图片与检索工具，尚无证据证明引入代码执行会让陪伴聊天更简单。`pi-env` 为 Durable 工具提供远程执行环境，不负责 iDream 的 Gen workflow/provider/交付；不能用它替代现有 Gen 服务契约。`pi-telemetry` 可作为可观测性接入面，产品计费权威仍在 Main。[MCP][mcp-readme]、[Codemode][codemode-readme]、[环境][env-readme]、[遥测][telemetry-readme]

### 事件与交付

Durable 的进度先提交再外显，默认约 100 ms 合并一次。观察者重连从当前 snapshot 开始，不会重放完整事件历史；慢消费者存在有界缓冲。由此推断，iDream 需将它投影到现有 SSE/reconnect 协议，不能把 Pi 的 events 当成既有消息投递日志。[watch / event 实现][views-source]、[事件规范][events-spec]

断开客户端等待不等于取消任务；应区分用户取消、连接丢失、进程关闭。Main 交付成功的 ACK 与 Durable 执行结束应分别表达，避免客户端看到完成后 Main 还没有落盘。

### 升级与成熟度

Durable 首次 npm 发布于 **2026-09-19**；1.3.0 README 仍明确标注 Experimental，API 可跨 release 无通知变化。1.1/1.2 已调整 Storage 查询、tool result、error 与 execution environment 契约。与此同时，上游已有正式规范、conformance suite、恢复/子任务/压缩/热重载示例，以及 cycle detection、压缩失败和 scheduler 性能修复。正确解读是“能力已经值得验证，接口与升级成本仍需承担”，而不是“不可用”或“已证明生产成熟”。[npm metadata][durable-registry]、[Durable README][durable-readme]、[Durable changelog][durable-changelog]

升级应固定任务 definition version、显式迁移旧 checkpoint，并覆盖尚未完成的工具、submission、compaction。不能只跑新建会话成功用例。对于线上部署，还要验证单 owner 交接与旧进程完全 drain 后才接管。

## 6. 对 iDream 的选型判断

| 方案 | 实际收益 | 仍需承担的责任 |
| --- | --- | --- |
| `pi-agent-core + pi-ai` | 去掉 DSH/Cordis 装配；较小的内核接入面；PreparedTurn 可继续直接作为请求权威 | 现有 AgentRun、压缩、恢复、终态 proposal/ACK 等大部分宿主代码仍保留 |
| `pi-durable + pi-ai` | 有机会替换执行 checkpoint、模型/工具恢复与压缩调度；另提供 inbox、持久化进度等能力 | transcript 边界、Main 幂等与交付对账、storage/owner、实际 Bun 版本认证、升级迁移、igrep 接入 |
| `pi-coding-agent` SDK + igrep 原生扩展 | 已有 SessionManager、压缩与 igrep 原文召回，值得比较实际迁移成本 | 须关闭默认资源发现和无关工具，并解决扩展自动 ingest/maintain/record 与 Main 权威冲突；不等同于 Durable 的任务恢复 |

**优先验证 Durable 能否真正替换现有本地执行责任；若只能叠加第二套状态机，则选择 agent-core 更合理。** 这不是因为现有 ADR 禁止变化而排除新设计：如决定将执行恢复职责迁给 Durable，应同步修订 ADR，删除被替换的 canonical 路径，避免长期并行维护两套“任务是否完成”的结论。

Durable 可承接执行 checkpoint、请求重试/backoff、工具子任务等待/取消和压缩调度。其待处理输入 inbox 与 partial 持久化属于可以新增的能力，不能计入当前 Chat 已有代码的删除收益：当前 Main 负责接纳，Chat 只在 Redis 暂存流式文本，成功后删除本地 run。最不应直接删除的是 Main action identity/receipt、额度与交付账本、终态 ACK 协议、未确定外部效果的 reconcile、角色/private 隔离和跨请求记忆策略。

本次核对的 iDream HEAD 是 `7e26cea97a26ca7a5703077f4dbdd607e808023f`；工作区包含其它任务改动，以下判断只针对实际读取的 Chat/Main 文件，不代表整个工作区已通过运行验证。

| 当前实现证据 | 对迁移的含义 |
| --- | --- |
| [agent-runner.ts](../../packages/chat/src/agent-runner.ts)：`executeAgentRun` 发现 proposal 时只重放终态；未有 proposal 才重新进入模型执行 | Durable 的主要新增价值是在模型/工具中间阶段恢复；已有最终 proposal 的 exact replay 必须保持 |
| [agent-run-store.ts](../../packages/chat/src/agent-run-store.ts)：`writeAgentRunProposalUnlocked` 拒绝不同字节覆盖已有 proposal | Pi requestId 去重不足以替代这个不变量 |
| [agent-runner.ts](../../packages/chat/src/agent-runner.ts)：`settleTerminalProposal` 在 Main ACK 后才发布 SSE done；`executeMainTool` 用同一 identity 对不确定 ACK 再查询/提交 | Pi execution settled 与产品完成必须保持区分；恢复不应越过 Main |
| [tool-effect.ts](../../packages/main/src/server/modules/chat/tool-effect.ts)：图片 action receipt、相同用户原文跨 attempt 复用、实时权益与参数校验 | 不能把 Pi taskId/callId 单独当成业务去重身份；regenerate 与编辑的语义由 Main 负责 |
| [turn-ledger.ts](../../packages/main/src/server/modules/chat/turn-ledger.ts)：冻结 Scene anchor、当前 attempt CAS、完整终态内容对比、额度结算与投影调度 | Durable transcript 不自动成为用户历史；业务持久化仍需该提交契约 |
| [ADR-21](../architecture/21-companion-chat-deep-runtime.md)：单进程、最小本地恢复证据、Main 驱动记忆、内容最小化 | Durable 会扩大本地持久执行内容，需要显式修改这一决策、定义保留/擦除策略，而不是静默叠加 |

图片工具可以封装成明确的 durable phase：保存 actionKey → 请求/查询 Main → 持久化 Main receipt → 返回工具结果。完成回答也可使用同样思路：保存不可变 proposal → 幂等提交 Main → 保存 ACK → 外显产品完成。这是可行设计方向；尚未证明它比当前宿主实现代码更少、更稳。

## 7. 实施前最低验证集

以下是为后续迁移提出的验收条件，不代表本次已全部执行：

1. **运行时**：实际 Bun 版本可导入精确包组；storage reopen、单 owner、取消与关闭行为符合契约。
2. **真实模型**：自托管 provider 的工具调用、reasoning、usage、超时与中断表现；每次物理请求可以归属到产品 Turn/attempt。
3. **故障注入**：请求发出前后、工具 intent 后、Gen 已接受但 ACK 丢失、tool result commit 前后、proposal 写入后、Main ACK 后逐点终止进程并恢复。
4. **副作用不重复**：重启与重复请求不新增重复图片、不重复扣费、不重跑已保存终态 proposal 对应的模型调用。
5. **上下文与记忆**：长对话压缩、原文召回、角色/场景一致性、private 与群聊隔离；对比同一输入 snapshot 的模型上下文；证明取消/删除后本地原文及备份按产品规则清理，迟到恢复不复活。
6. **交付**：客户端断线重连、慢消费、取消、SSE 终态与 Main 持久化顺序。
7. **升级恢复**：旧版本未完成 task 与 summary 在新版本恢复的行为，迁移失败可观察且不会产生额外效果。

这组验证通过后，才能确定替换范围和删除清单。仅成功 import、一次对话、包数减少或单元测试通过，不能证明完整迁移成立。

## 8. 本次研究的实际边界

本报告完成了 registry/release/tag/main 差异核验、固定 tag 下的规范/源码/changelog/示例阅读，以及当前 iDream 权威与恢复路径核对。

另在独立 OS 临时目录安装精确 `1.3.0` 的 `pi-durable`、`pi-agent-core`、`pi-ai`、`chord`，使用 `npm install --ignore-scripts --no-audit --no-fund`，未修改项目依赖或 lockfile。Bun **1.4.2 / macOS arm64** 实测结果：

| 探针 | 观察结果 |
| --- | --- |
| core / durable / ai 导入 | 成功 |
| JSONL `fsync: true`，保存 task checkpoint 后 `process.exit(73)`，不调用 Harness.close | 新进程仍读到同一 conversation 和 checkpoint；任务从已保存阶段完成 |
| 相同 requestId / 相同 write payload | 返回同一 submission，只有一条原始 entry |
| 相同 requestId / 不同 write payload | 仍返回原 submission，不报 payload conflict；原始 entry 未被修改 |
| `openNodeSqliteStorage()` 在 Bun 中创建并关闭 | 成功；未执行完整 SQLite conformance |

首次探针错误地预期 reopen 后 task status 仍是 `running`；实际为 `pending`。核对上游 `TaskScheduler.open()` 明确将遗留 running 转为 pending、保留 checkpoint 后，修正该探针断言，再完成恢复验证。未修改库源码或放宽 checkpoint/result 断言。

证据：[探针代码](evidence/pi-runtime-2026-10-17/probe.mjs)、[结果与 SHA256](evidence/pi-runtime-2026-10-17/result.json)、[精确包配置](evidence/pi-runtime-2026-10-17/package.json)、[探针 lockfile](evidence/pi-runtime-2026-10-17/package-lock.json)。复现需复制代码与包文件到新的独立临时目录，`npm ci --ignore-scripts --no-audit --no-fund`，先运行 `bun probe.mjs crash`（预期 exit 73），再运行 `bun probe.mjs resume`（预期 exit 0）。不要在已有 probe 数据上重复执行 crash。

本次模型请求 **0**、外部模型费用 **0**。未启动或切换 iDream 服务、未迁移产品数据库、未替换业务代码。项目锁定的是 Bun 1.4.0，本次 1.4.2 探针不能代替该版本认证；也未验证真实 provider、图片/计费、igrep live 集成、压缩质量、多进程 owner、机器断电或生产部署。这里的恢复结果只证明固定包组在指定环境中的受控存储行为。

## 来源

[release]: https://github.com/earendil-works/pi/releases/tag/v1.3.0
[tag-commit]: https://github.com/earendil-works/pi/commit/71023aec1546d6d677a65669c5665c0927ce0dd0
[main-commit]: https://github.com/earendil-works/pi/commit/8efd314fa3d3232ce197d8d7a6a5660530b9d83e
[old-registry]: https://registry.npmjs.org/@mariozechner%2Fpi-agent-core
[ai-registry]: https://registry.npmjs.org/@earendil-works%2Fpi-ai
[agent-registry]: https://registry.npmjs.org/@earendil-works%2Fpi-agent-core
[durable-registry]: https://registry.npmjs.org/@earendil-works%2Fpi-durable
[coding-registry]: https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent
[chord-registry]: https://registry.npmjs.org/@earendil-works%2Fchord
[mcp-registry]: https://registry.npmjs.org/@earendil-works%2Fpi-mcp
[codemode-registry]: https://registry.npmjs.org/@earendil-works%2Fpi-codemode
[env-registry]: https://registry.npmjs.org/@earendil-works%2Fpi-env
[telemetry-registry]: https://registry.npmjs.org/@earendil-works%2Fpi-telemetry
[root-readme]: https://github.com/earendil-works/pi/blob/v1.3.0/README.md
[main-durable-changelog]: https://github.com/earendil-works/pi/blob/8efd314fa3d3232ce197d8d7a6a5660530b9d83e/packages/durable/CHANGELOG.md
[agent-changelog]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/agent/CHANGELOG.md
[durable-package]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/package.json
[coding-package]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/package.json
[core-spec]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#1-terms-and-invariants
[effect-spec]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#52-effect-sandwich
[tool-spec]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#84-tool
[nested-spec]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#73-tools
[recovery-example]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/test/examples/13-recovery.ts
[generation-spec]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#83-generation
[usage-spec]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#86-usage
[harness-types]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/types.ts
[storage-readme]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md#storage
[sqlite-node]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/storage/sqlite/node.ts
[storage-spec]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#10-storage-contract
[storage-conformance]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/testing/storage-conformance.ts
[jsonl-durability]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#L5163-L5175
[storage-types]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/types.ts#L732-L748
[entry-retention]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#L257-L265
[ai-readme]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/README.md
[agent-readme]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/agent/README.md
[hooks-spec]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#72-hooks
[compaction-spec]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#87-compaction
[views-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/view.ts
[submissions-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/submissions.ts
[generation-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/generation.ts
[tool-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/tool.ts
[scheduler-source]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/scheduler.ts
[coding-sdk]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/sdk.md
[mcp-readme]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/mcp/README.md
[codemode-readme]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/codemode/README.md
[env-readme]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/env/README.md
[telemetry-readme]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/telemetry/README.md
[events-spec]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#94-agent-events-experimental
[durable-readme]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md
[durable-changelog]: https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/CHANGELOG.md
