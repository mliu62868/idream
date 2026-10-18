# igrep 0.1.161 更新研究：Pi 接入、记忆权威与删除边界

日期：2026-10-17。范围：已发布的 igrep2 0.1.157 与 0.1.161 macOS wheel、当前安装包、官方源码固定快照，以及无模型、无网络的合成探针。本报告补充 [Pi runtime 研究](PI_RUNTIME_RESEARCH_2026-10-17.md)，不代表运行时迁移或生产验证已经完成。

## 结论

**0.1.161 改善了当前会话原文召回，没有把 Pi 插件变成可直接服务 iDream 的中立运行时适配器。** Pi bundle 仍绑定 `pi-coding-agent`，自动从 cwd 对应会话分支写记忆；其 ingest、maintain、wake、record 生命周期与 0.1.157 相同。若选择 `pi-durable`，应复用公开 `igrep mem` / `mem-api` 和 `search --stdin-format jsonl` 契约，保留由 Main 授权并确认交付后写入的边界，不能为使用现成插件而引入 coding-agent 的整套会话权威。

公开中立接口已经能承担记忆服务；宿主仍须负责身份、写入准入、交付顺序、删除撤销、错误语义和模型路由。`purge` 与 `source_seq` 都有明确但有限的保证：前者清除一个 principal 的 igrep store，后者去重不可变事件；它们不能自动完成产品全链路删除，也不能检测同键不同内容。两版均通过相同的 10 项记忆契约探针，这些能力不能记作 0.1.161 新增。

## 1. 版本与证据基线

| 对象 | 已核实事实 |
|---|---|
| 当前 CLI | `igrep --version` 为 `0.1.161`；当前 Pi bundle 与该 wheel 一致 |
| 0.1.157 macOS wheel | 2026-10-11 02:26:32 UTC 发布；SHA-256 `bcb44056698e755f7857c3d8645551fa15c841360f22acb66670df9f094c6777` |
| 0.1.161 macOS wheel | 2026-10-17 06:48:54 UTC 发布；SHA-256 `fd2dfb59ebb293467c1d4cec31452c903d2620c2069d9edbb6362051535704cd` |
| Pi bundle | `@igrep/pi-memory`，内部版本两版都为 `0.1.0`；peer 为 `@earendil-works/pi-coding-agent >=1.0.0` |
| Python | wheel 要求 Python `>=3.14,<3.15`；探针使用现有 igrep 环境的 Python 3.14.3 |
| 源码阅读基线 | 官方仓库固定 commit `4f987477570d170806b039a6bdbfc3e1798b1212`；时间早于 161 wheel 发布，但 wheel 元数据不能证明与此 commit 完全对应 |

发布元数据来自 [0.1.157 PyPI JSON](https://pypi.org/pypi/igrep2/0.1.157/json) 与 [0.1.161 PyPI JSON](https://pypi.org/pypi/igrep2/0.1.161/json)。wheel 只解压到临时目录，没有安装、降级 CLI 或安装 Pi 扩展。精确下载 URL、bundle 文件哈希见 [artifacts.json](evidence/igrep-update-2026-10-17/artifacts.json)。包内 Python 核心是编译扩展；不能把 JS bundle diff 当成全部内核变更，也不能把当前源码快照当成两版二进制差分。

**依赖应固定 wheel 版本及哈希，不能只固定 bundle 的 `0.1.0`。** 固定源码 URL 提供设计依据，已发布 wheel 的行为由探针单独证明。

## 2. 157 → 161 的实际适配器差异

### Pi：仅 README 与 session-recall 改动

| 项目 | 0.1.161 的变化 | 对 iDream 的含义 |
|---|---|---|
| 压缩后索引 | 最多 2,000 字符，每个 entry 一行；用户、失败工具、其他工具轮流取行，assistant 最后；每类按最新、最旧、第 2/4/8… 新抽样 | 索引更均衡，但仍只是有界导航，不能声称列出了全部历史 |
| 结果展示 | 排名决定进入页面的前缀，入页块按分支时间顺序展示 | 重复请求不会因排名顺序被误读为首次请求；不改变检索排序或做宿主补齐 |
| 结构字段 | chunk 增加 position/error，支持上述索引及展示 | 不是新增记忆数据源或持久化权威 |
| 未变化 | index、lifecycle、igrep-cli、compaction、handoff、package manifest 均未变化 | 自动写入、cwd 作用域及 coding-agent 耦合全部仍在 |

### DSH：compaction 与 session-recall 改动

DSH handoff 的报价目标从“比被替换 span 小”改为“尽量不超过 span 的一半”，通过收紧用户引用预算减少压缩后很快再次付费压缩的问题；这不是无条件的 50% 保证：引用已压到下限仍可能高于目标，小 span 也可能装不下固定框架。召回保留重复的 user/assistant occurrence、增加请求锚点与连续 chunk 分组、按历史顺序展示；工具重复内容仍有去重。OpenClaw bundle 没有此次差异。

项目 bootstrap 的兼容检查实测失败：`node scripts/setup-dsh-companion.mjs --check --json` 返回 `PLUGIN_PEER_RANGE_MISMATCH`，[原始结果](evidence/igrep-update-2026-10-17/bootstrap-check.json) 已保存。**157 与 161 的 DSH manifest 完全相同**，都要求 `dsh-llm`、`dsh-tools`、`dsh-spill-policy`、`dsh-compaction-basic` 为 `>=0.2.1-alpha.1 <0.3.0`；项目依赖与 setup 脚本的预期尚未对齐。因此这是已存在的版本漂移，不能归因于 161 首次引入，也不能只放宽版本字符串就认定兼容。这个结果证明 bootstrap 检查失败，未证明当前 PM2 中已加载的旧运行进程发生故障。

## 3. 中立记忆 API 能替换哪些胶水

官方 [MEM_HOST_GUIDE](https://github.com/piboye/igrep/blob/4f987477570d170806b039a6bdbfc3e1798b1212/docs/MEM_HOST_GUIDE.md) 与 [mem.py](https://github.com/piboye/igrep/blob/4f987477570d170806b039a6bdbfc3e1798b1212/src/igrep/mem.py) 明确给出以下边界。

| 能力 | 公开面 | 宿主必须保留的职责 |
|---|---|---|
| 查询长期记忆 | `mem-api memory-search`；或 `mem recall` | 提供可信地址；保留排序、warnings、failed 语义；不二次重排补满 |
| Agent 笔记 | `mem-api memory-record`，add/replace/remove | 它写 `MEMORY.md`，不是用户画像，不能替代 Main 已提交 Turn 权威；本方案不向陪伴模型暴露 |
| 状态 | `mem-api memory-status` / `mem doctor` | 校验 `schema: igrep.mem/1`；不可据状态字段绕过 mem 读接口直接打开内部文件 |
| 可见对话证据 | `mem ingest --rows -` 或 `--transcript PATH` | 从权威交付记录投影；顺序、幂等事件键、编辑/撤回策略由宿主决定 |
| 画像维护 | `mem maintain` | 排队、重试、取消、超时与状态跟踪；它可能调用模型，单 principal 的 deferred 可为退出码 0 |
| 常驻记忆 | `mem wake` | 按 principal 缓存与失效；失败时标明暂不可用，不能继续注入旧画像 |
| principal 删除 | `mem store purge` | 先撤销准入和重试队列，再协调 Main、运行日志、宿主 transcript、缓存、备份等其他副本 |

`mem-api` 只有 search/record/status 三个子命令。HTTP 另有 maintain，ingest 与 wake 仍仅有 CLI；所以改用 HTTP 不能消除全部子进程。HTTP control token 可访问所有 principal，没有用户级 ACL，不能直接暴露给终端用户。

记忆搜索默认 `ultra`；`fast` 是零模型路径，适合有延迟上限的预取；`normal` / `ultra` 依赖 embedding/rerank，ultra 还可能走 ask 路由。不能把“memory fast 零模型”推广到所有通用 `igrep search --mode fast` 行为。本次网络禁止探针验证的是 memory fast。

推荐保留一个窄的 Chat 宿主适配层：解析并校验 JSON 信封、绑定 trusted principal、注入冻结后的子进程环境、实施超时/取消与有界输出、将失败映射为产品可见状态。不要复制 igrep 的 profile 提取器、存储布局、检索排序器或缓存规则。若使用上游 JS runtime 的逻辑，应有明确版本归属；不能将 bundle 的内部文件当成稳定独立 npm SDK。

## 4. 权威、隔离与写入契约

### Main 的交付记录仍是输入权威

igrep ingest 接收 user/assistant 可见证据，不应接收模型推理、工具 trace、失败草稿或未交付的 assistant proposal。对于 iDream，`agent_end` 只说明执行结束，不代表 Main 已提交交付与额度结算。因此不能直接沿用 Pi 插件的自动 agent_end ingest。应从 Main 确认的不可变 Turn 快照生成证据，沿现有产品恢复链路投递。

`source_seq` 是不可变事件的去重键：每批必须全带或全不带，带时要求非负整数并严格递增；不同批可乱序。**同键不同内容不会报冲突，而是保留首次内容。** 两个 wheel 的实测均返回 `duplicateRows:1`、`newEvents:0`，canonical 保留旧文本。因此不能用它表达 edit、undo 或补写已交付内容，也不能将其等同于内容完整性校验。宿主必须保证事件内容不可变，并串行交付同一会话以保留语义顺序。

需要改写已交付历史时，`--transcript` 加 `--replace-history` 明确声明“这是完整权威会话”；实测旧 canonical 内容被替换，返回 `rebuilt:true`、`profileInvalidated:true`。不完整上下文、压缩窗口、截断日志不能这样提交。同一个 agent/session 不能随意切换 rows inbox 与外部 transcript 路径。

### 隔离依赖宿主地址映射

`--store ROOT --tenant T --user U` 将精确身份映射成私有 workspace；读路径不创建用户目录。它没有原生 character/relationship 维度。本期可保留现有关系 workspace 与发布协议，无需同时迁移 store；若以后采用 store，应由 Main/BFF 给出明确的关系标识，并用固定编码形成 principal，区分用户全局记忆与 user×character 关系记忆，不能由模型参数、session cwd 或内容推断身份。若两类记忆都需要查询，应在契约中定义范围，不能偷偷将两个 principal 的结果拼接重排。

单进程 cwd 只能说明文件位置，不能证明授权。Pi bundle 使用 `ctx.cwd`，没有面向本项目的 trusted tenant/user resolver，也没有可关闭全部自动生命周期的公开开关；DSH 的 memory-binding 则有宿主 resolve/admit/revoke 接缝，但仍需版本兼容与产品行为验证。目录隔离探针通过不代表 Main→Chat→工具的地址链路已正确。

### wake 与错误不可静默降级

record 成功、maintain 每次尝试（含 deferred/异常）、历史失效与 ingest 异常后都要刷新或使对应 wake 缓存不可用；只允许最新 generation 发布。不能保留可能已被 Forget 撤销的旧卡，不能退回另一个 principal 的缓存。`failed:true` 不论 HTTP 200 或退出码如何都是不可用；warnings 必须明确传给模型。输入错误的退出码 2 与成功空页不同，单 principal maintain 退出码 0 也不等于成功。

## 5. 当前会话原文召回与 durable 的接缝

Pi 的 `session_recall` 根据 `sessionManager.getBranch()` 与 `buildSessionProjection()` 比较当前分支原始 entry 和模型仍可见的消息，按需生成召回语料；只含已不再完整可见的 user、assistant 文本、工具参数与工具输出，排除 reasoning、插件注入和 recall 自己的结果。ID 为 `entry:<id>#<chunk>`，每块最多 2,000 Unicode 码点或 40 行，页面上限 8,000 字符；显式 ID 读取不调用模型，另一分支的引用会拒绝。

query 路径只发一次公开 `igrep search --stdin-format jsonl --mode ultra`，输入 `{id,ref,title,content}`，根据返回 ID 取宿主持有的完整原文块，校验未知/重复引用并保留不完整 warnings。该机制适合借鉴，但 **Pi 插件不是通用 durable 插件**：它依赖 coding-agent 的分支与投影 API；`pi-durable` 的 entries/documents/state 需要一个不同且很薄的只读适配。

建议由 durable 当前 conversation 的原始 entries 构造候选，用其当前 context 边界决定哪些条目已被压缩，稳定 ID 纳入 conversation 与产品授权范围。只把受允许的条目送入 stdin；用户删除、关系切换或 private session 禁止持久化时，原始 entries 本身也要遵守规则。不要把长期 `mem` corpus 当作当前会话工具原文 archive，也不要另建一套与 durable entries 并行的长期 archive。

通用 stdin 搜索会将 query/语料送给配置的检索模型，因而仍受缓存、路由与数据准入约束。上游 Pi recall 默认没有传 `--no-cache`，不能据“没有另建本地 archive”推断没有其他副本。

## 6. 删除与 private 需要端到端规则

### Store purge 的保证与限度

官方 [mem_tenancy.py](https://github.com/piboye/igrep/blob/4f987477570d170806b039a6bdbfc3e1798b1212/src/igrep/mem_tenancy.py) 以 tenant/principal generation 阻止 purge 之前已寻址的在途写复活；目录先移动到 `.purging` 再删除，中断清理由后续管理操作处理。purge 目标不存在也推进 generation。**purge 之后新发起的写仍会合法重建 principal**，所以 Main 的删除 tombstone、宿主准入、队列取消与回放过滤不可省略。这些并发保证来自静态源码，本次没有做竞态故障注入。

公开 purge 的粒度是 principal 或 tenant，不是任意 Turn/topic。`--replace-history` 能替换会话已发布证据，但不能据此承诺所有外部副本已物理清除；Forget 是语义撤回机制，也不等于物理删除。探针直接证明 purge 后记忆搜索为空，宿主在 store 外持有的 transcript 仍然存在。

### 共享缓存会绕过目录删除

当前源码中的 [rerank_cache.py](https://github.com/piboye/igrep/blob/4f987477570d170806b039a6bdbfc3e1798b1212/src/igrep/rerank_cache.py) 将版本、model、query、document 的完整 JSON key 与分数写进 Redis，TTL 为 7 天；[embed_cache.py](https://github.com/piboye/igrep/blob/4f987477570d170806b039a6bdbfc3e1798b1212/src/igrep/embed_cache.py) 保存含明文 query 的 key 与向量，idle TTL 为 30 天，命中可在后半期续期。两种 key 均无 tenant/user 维度。哈希槽位不代表原始内容已哈希隐藏，缓存值仍保留完整 key。

`IGREP_RERANK_CACHE=0` 只关闭 rerank，不能关闭 query embedding 或其他共享缓存。`IGREP_NO_CACHE=1` 经 [cache_db.py](https://github.com/piboye/igrep/blob/4f987477570d170806b039a6bdbfc3e1798b1212/src/igrep/cache_db.py) 在选择 Redis 后端之前生效；两版二进制探针均观察到 `backend:disabled`、`source:IGREP_NO_CACHE`。`memory-search` JSON 不接受 `no_cache` 字段；应对专用子进程显式设置该环境变量，通用 stdin 搜索另有 `--no-cache`。不要在共享服务中按用户动态修改全局进程环境。

这只证明今后的缓存读写旁路，不清除过去缓存，不保证 provider、日志、trace 或备份没有副本。不能在用户删除时执行全局 cache clear，因为它跨 tenant；若过去已使用共享缓存，需要单独的残留处理策略。本次未连接用户 Redis，未测试缓存服务器的删除。

### Private 的最小明确语义

若 private session 不允许长期保留，则在工具、自动 ingest、maintain 注册、proposal 回放、宿主 transcript、durable persistence 与日志各入口统一执行准入，并使重启后的重放也服从同一持久策略；仅隐藏 memory_search 或禁止 agent_end 远远不够。当前会话内是否允许临时召回可独立配置，但其检索子进程也应禁用持久缓存。运行时存储若没有公开物理删除接口，不能靠丢弃 UI 引用或 reset 就声称已清除。

### 自托管路由必须显式固定

161 包的 env.sample 与 [config.py](https://github.com/piboye/igrep/blob/4f987477570d170806b039a6bdbfc3e1798b1212/src/igrep/config.py) 允许 `IGREP_LLM_URL` 未设置时继承 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`，默认指向云端 API。Pi 的当前模型 registry 不会自动约束中立 memory 的检索/维护路由。iDream 的子进程配置须明确固定 embedding、rerank、LLM、ask endpoint/model，并防止用户全局配置意外改变路线；缺路由应报告不可用。`IGREP_NO_CACHE` 不能代替此约束。

## 7. 验证结果与复现

证据目录：[igrep-update-2026-10-17](evidence/igrep-update-2026-10-17)。两个发布 wheel 分别通过以下 10 项契约验证和 9 项 Pi adapter 合成验证，共 38 项。所有记忆数据均为临时 synthetic 数据；CLI 在 `sandbox-exec (deny network*)` 下运行，未请求 maintain、真实模型或用户记忆。Pi query 使用显式 stub，未启动 igrep 子进程。

| 契约验证 | 结果 |
|---|---|
| 合法空记忆返回成功空页；未知字段与显式 null 退出 2 | 两版通过 |
| fast 无网络取回 Agent note；另一 principal 查不到该 note | 两版通过 |
| 相同 source_seq 改内容仍保留首次内容、计 duplicate | 两版通过 |
| 全量 replace-history 移除旧 canonical 并报告 profile 失效 | 两版通过 |
| `IGREP_NO_CACHE=1` 实际关闭共享 backend | 两版通过 |
| purge 后搜索为空；外部 transcript 仍存在 | 两版通过 |
| 原文 archive 只含当前分支不再可见的文本，排除 reasoning/recall 输出；Unicode 分块无损 | 两版通过 |
| ID 读取不调用 igrep；未知或重复引用拒绝；query 使用公开 stdin；partial 可见 | 两版通过 |
| 展示顺序 | 157 按请求/排名；161 按分支时间顺序，已分别断言 |

复现需先下载并校验 [artifacts.json](evidence/igrep-update-2026-10-17/artifacts.json) 中的 wheel，再解压，使用现有 igrep 的 Python 环境。以下以 161 为例，`WHEEL_DIR` 指向解压目录：

```bash
python3 docs/research/evidence/igrep-update-2026-10-17/probe-memory-contract.py \
  --python /Users/kk/.local/share/uv/tools/igrep2/bin/python3 \
  --wheel "$WHEEL_DIR" \
  --output /tmp/igrep-0.1.161-contract.json
node docs/research/evidence/igrep-update-2026-10-17/probe-pi-recall.mjs \
  "$WHEEL_DIR/igrep/data/pi/igrep-memory" 0.1.161 \
  /tmp/igrep-0.1.161-pi-recall.json
```

结果文件记录版本、二进制或模块哈希与逐项输出：[161 memory](evidence/igrep-update-2026-10-17/igrep-0.1.161-contract.json)、[157 memory](evidence/igrep-update-2026-10-17/igrep-0.1.157-contract.json)、[161 recall](evidence/igrep-update-2026-10-17/igrep-0.1.161-pi-recall.json)、[157 recall](evidence/igrep-update-2026-10-17/igrep-0.1.157-pi-recall.json)。未验证真实语义召回质量、模型延迟/费用、画像维护、HTTP 授权链、并发删除、宿主崩溃恢复或生产流量；不能据此宣称完整接入或生产就绪。

## 8. 对实施方案的建议

1. **先固定现有事实。** 将 DSH bootstrap mismatch、当前 bundle 哈希、CLI/schema、模型路由列为 P0；保留当前运行进程与 bootstrap 失败之间的证据区别，不在研究任务中盲目升级服务。
2. **运行时选择与记忆接入分开验收。** 若采用 pi-durable，先以官方 MemoryStorage 做有界替换实验，仅验证 loop、context/compaction 与只读 entries recall，继续沿用 Main 与现有恢复协议。不要把 MemoryStorage 实验写成已经获得 durable 崩溃恢复，也不要同步新建第二个持久化权威。
3. **长期记忆只迁移到中立公开面。** 保持 Main 已交付 Turn → ingest 的唯一入口，不向陪伴模型暴露 memory_record。wake 是宿主的只读 hook，memory_search 是模型的只读检索工具。删除原先被替代的 DSH glue，而非长期并排运行两套生命周期。
4. **以有限门槛决定是否继续。** 用真实自托管模型验证工具流、压缩失败、预算、当前会话召回及关系隔离；再验证删除/private/重放。若 durable adapter 需要重建大量 scheduler、存储与协议才能接入，应停止该迁移路径，而不是为了 runtime 名称继续增加胶水。

这轮更新提升了召回质量与接入可用性，但没有改变 iDream 的基本判断：igrep 可以承接记忆实现，产品权威和生命周期约束必须留在宿主。
