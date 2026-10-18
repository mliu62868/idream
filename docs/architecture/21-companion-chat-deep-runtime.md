# ADR-21：单进程 Companion Chat 与 Main 驱动的记忆投影

> 状态：Accepted
>
> 取代：ADR-19 的独立 `chat-agent` process/interface、同步 commit-ACK 后 workspace promotion；ADR-20 的完整本地 AgentRun 状态机。2026-10-17 起执行内核由 Pi/igrep 取代 DSH/igrep；Main 产品 Turn 权威与本地精确终态候选仍有效。

Companion Chat 只有两个需要独立生命周期的 module：Main 持有产品 Turn、修订、接纳、终态与工具效果；Chat 在一个 Bun 进程内执行 Agent 运行。Pi/igrep 是 Chat 内部 implementation，不再通过 HTTP/NDJSON/token/readiness seam 组成第二个应用，也不保留第二 adapter、双 runtime 或兼容回退路径。

Agent 运行只在 Main ACK 未确定时保存完整且不可变的终态候选；Main accepted、duplicate accepted 或明确永久拒绝后即可清理。运行轨迹不是状态机：成功轨迹提交后清理，失败或未决轨迹最多保留七天。Main 的 lease、attempt、权威快照和终态 CAS 是唯一 durable job state。用户取消先提交 Main 终态，再由同一事务写 durable Main→Chat cancel intent；同步 HTTP 只是低延迟快路，outbox 重试负责最终写入 Chat attempt tombstone。Main 接受 failed/cancelled 终态后，SSE `error` 就结束该 attempt；重新生成是新的产品命令，不是流连接自行重试。

新消息、编辑与重新生成都由 Main 在用户与会话锁内确认执行资格。单聊会话或整个群聊同时最多有一个可执行回复；较新的 blocked Turn 不得绕过仍在执行的旧回复。每个可执行 Turn 在启动前持有唯一额度 fact，首次可执行的编辑创建预留，失败后重试先恢复预留并核验剩余额度，已经计量的修订不再花一份额度。proactive 仍不消耗用户主动发送额度，fact 沿用 Turn 的 UTC 产品日。新的修订 attempt 重新核验公共 Serving 权威，固定 Release 不能保留已撤销的执行资格；已接纳 attempt 的终态仍由原快照与 CAS 完成。

跨日修订核验实际恢复的原 Turn 产品日额度桶。额度 fact 的 `consumedAt` 独立记录已消费事实：成功回复或已接纳的取消一旦消费，后续 attempt 失败或未接纳取消都不能清除它；回复统计不承担取消的消费记账。Chat 首次接纳时固定并持久化 deadline，重复接纳与恢复重放同一时间；接纳回执绑定 Turn/attempt 并将该截止时间交给 Main。Main 在实际截止时间加终态提交宽限之后回收，不从另一个进程的配置或普通行更新时间猜测新运行的期限。没有该字段的历史 generating 行沿用旧回收政策，发布按既有 drain/cutover 流程隔离旧运行。

assistant message id 在不同 attempt 间复用，不能独自标识执行。Chat 清理旧 attempt 只删除仍指向它的本地索引；浏览器的文本缓存、停止标记与 EventSource 也绑定 attempt，观察到新 attempt 后撤销旧来源。传输断开只重连同一 attempt：CONNECTING 由 EventSource 重连，CLOSED 由 Main 权威轮询重新建立连接，不因此生成新回复。

SSE 入口以 Main 的所有者、消息存在性与当前 attempt 为交付权威，在请求 Chat 前与握手返回后均校验。接纳回执丢失而 Main 尚未确认的 pending attempt 不得交付本地文本；Main 已提交 sent 终态则足以确认交付。已有 probe/quality 调用方未传 attempt 时，BFF 将 Main 当前身份固定到上游请求。删除或修订发生在握手期间时，取消上游正文并拒绝交付；已打开的流仍由既有取消 intent、attempt 事件和客户端栅栏收敛。

Stop 命令携带用户点击时观察到的 attempt，Main 在 Turn 锁内校验并回显该身份；迟到命令不得取消新 attempt，迟到回执不得停止或清空新回复。编辑或重新生成成功后的浏览器读取栅栏使在途旧快照失效，已观察 attempt 不因流缓存清理而丢失。周期性过期清理也在同一 Turn 锁内重读索引，避免扫描旧版本后删除新索引。

`PreparedTurn` 是 Chat 内唯一执行输入：编译时直接生成带稳定消息 id、source kind、Soul/Scene trace、预算与模型 profile 的对象，不再先造产品对象、再经 WeakMap/`*Wire` 转换。Invocation、event、tool 与 commit ACK schema 只存在于 `packages/chat/src/agent-runtime`；Shared 保留 Main↔Chat 的产品执行快照、接纳回执、工具效果、终态提交、记忆重建、readiness 与无内容运营证据契约。本地 AgentRun event 文件只记录 content-free lifecycle/tool/failure 事实；文本 delta 与终态正文分别属于 Redis 流和未决 `proposal.json`。

2026-10-07 决策调整：图片动作由 Companion Agent 根据当前请求和完整上下文选择，取代词表意图识别、独立分类模型和 required-action 强制调用。`PreparedTurn` 按产品权限与模型工具能力暴露图片工具；有 Main 固定的已交付图片时才暴露编辑工具。所有请求沿用原生 user/assistant 对话与 `tool_choice=auto`，保留消息 ID、来源和跨说话者先后顺序。历史、Scene、召回和保存偏好提供上下文，不单独触发新付费动作；Agent 理解拒绝、讨论、短确认和本次衣着要求。预算包含同一原生传输的完整消息及工具 schema。这证明传递保真，不证明模型语义判断永远正确。

Agent 自己编写生成或编辑方向及 `requestedNudity`，Main 不再次解释用户措辞。Main 校验冻结 Turn/attempt、工具参数、实际编辑来源、实时权益和额度，再交给现有 Generation 原子预留。每个 Turn/用户原文仅允许一个图片动作，身份不按生成与编辑工具拆分；重新生成复用原收据，工具或衣着意图改变时拒绝第二个动作。编辑用户原文才形成新的动作身份。

群聊历史的 Character 归属必须穿过 Pi 的不可变消息投影到达实际 provider 请求。Agent 从当前 Character 的已提交历史理解图片邀约与短确认，宿主不合成确认事实。跨 attempt 的 turn_action 重放遵循统一 user→conversation→Turn→attachment 锁序，并在锁内重读 Job、状态与费用；requesting 只是动作身份已保存，不能作为成功预留 ACK。中断后恢复该动作先绑定当前 attempt，再进入原有 Generation 原子预留，以同一动作身份防止重复扣费。

产品契约要求整条回复完成当前用户请求，并在完成后结束；“先回答”不能变成随后追加无关剧情的许可。角色语气与动作保持在用户指定的语言、长度、句数和内容范围内，不依靠输出后裁剪或额外重试补救。

模型请求的普通历史对话按响应 Character 的 ID 投影：自己的话使用 `assistant` 且不加姓名前缀，其他 Character 的话使用带原姓名的 `user` 输入；原生工具调用与结果保留协议要求的角色。此前所有 Character 都使用 `assistant`，长对话实测会诱导模型续写多角色剧本、编造本应检索的旧对白。这个变化仅作用于 provider 视角，不改 Main 原角色、speaker 归属或召回原文。预估预算与实际发送共用此投影。仅在本角色最后一条完整回复之后，对另一 Character 已回答的历史用户消息标注已回答；本角色的原生 assistant 回复已闭合更早的输入，无需重复标记。这样避免末尾连续输入角色把旧问题重新解释为待办，也不把长期重复历史改造成带重复标记的新模式。Soul 中规范的 `## Dialogue examples` 标题仅在模型视图中注明为语气示例，不改不可变 Soul 内容及例句。

长期记忆的 resident profile 即使通过事实支持校验，也只作为历史上下文进入 `<context>`，不得把其中引用的旧用户指令提升到 system；system 仅保留静态记忆策略。 Chat 发出的请求把背景上下文和逐字保留的当前用户原文放在两个 `user` 消息中，工具往返仍在其后。这仅证明 HTTP 请求投影；本机 oMLX 0.7.1rc1 在模板前合并连续同角色消息，不能把独立请求元素当成模型侧独立轮次。背景仍有文本定界与历史状态说明。自动预召回 empty 只记录观察，不额外指导角色声称没有记忆；用户需要的原文仍可由 Agent 自选 session_recall 或 memory_search 取回。去重后的空 notes 或 profile-only hit 不代表没有记忆，任何检索状态都不能否定当前原文、历史及已验证 profile。显式 memory_search 返回的 profile 行与驻留画像使用相同的来源支持校验，不能绕过被拒绝的画像事实。空正文按正常结束或输出预算耗尽分类；物理用量回执以纯数字保留在 AgentRun journal，失败也不丢弃。

精确编号问答沿用结构化采样上限 0.2；编号名词前的短修饰语不应把同一事实请求误路由到表达性采样，普通角色扮演保留配置值。

普通生成、摘要、结构化 Scene 和预热均关闭隐藏推理，固定模型必须在此模式下完成资格验证。自然推理曾耗尽 Quick 的 256-token 回答预算；强制提前闭合 thinking 标记又曾将未结束的分析续文交付给用户，因此撤回这两种策略，保持现有回答档位与图片参数预算。工具选择仍为 auto，不强制工具或补写答案。即使上游意外返回推理，也不将其交付或写入记忆；上游不报告 reasoning 子计数时保持未知，已报告的 completion 总数不重复加算推理。

legacy 图片动作收据只有在用户原文未变时可跨 attempt 重放；编辑在同一事务持久标记旧身份失效，包括没有 Job 的旧收据。已有 Job 的旧编辑清除证据也使该收据失效。Gen 完成、失败、取消与运营退款都先取得与 Chat 相同的 user 锁，再取得 Request 和附件锁；批量结算先按 userId 排序取得全部用户锁，避免钱包与附件的反向等待。金额与资格仍由锁内事实和现有幂等账本决定。

OpenAI-compatible provider 仅以原生 tool call 进入动作执行；普通文本或参数 JSON 不转换成工具，也不通过兼容重试强迫调用。Agent 在 Main 返回结果后继续正常执行循环，自行给出角色回复；不合成固定图片回执。准备提示明确区分 `accepted` 与 `completed`：前者仍在制作，后者才已交付；工具 schema 不再要求预写 caption，Main 的异步交付仍以实际收据和附件状态为准。工具前文本是暂态，下一步重置后才交付最终回复。Main 已拒绝的图片动作可以产生自然的失败说明；接纳结果未知则停止，不能提交成功回复或再次购买。实际 provider 归属与每次物理请求用量仍必须可核验。

provider 的工具名分片先累计为完整当前名称，再交给 Pi；参数仍按 delta 累积。SSE `[DONE]` 结束当前响应读取，不等待 HTTP EOF，也不放宽 finish reason、provider attribution 或用量核验。

非成功 HTTP 响应的正文取消只负责释放资源，不能使原 HTTP 错误等待一个永不收敛的 cleanup promise。执行截止时间校验留在执行与接纳边界；账号擦除读取所有者时不以历史执行证据完整为前提。

陪伴记忆只从 Main 已提交产品 Turn 异步投影。Main outbox 使用至少一次投递；Chat 在独立候选 workspace 中幂等 prepare，再以单调 authority version 原子 promote。prepare/promote 不持有 relationship-wide Agent 执行锁，也不取消已经运行的 Turn。普通投影延迟不阻塞新 Turn；破坏性修订期间，由 Main 把受影响的新 Agent attempt 固定为 private execution，直到重建切换完成。基于旧 Main 权威快照返回的终态候选必须被 Main CAS 拒绝。

2026-10-17 执行内核决策：`@earendil-works/pi-ai`、`pi-durable`、`chord` 固定 `1.3.0`，igrep CLI 固定 `0.1.161`。Pi 只负责单次 Agent 运行的 model/tool loop、公共事件和上下文压缩，igrep 通过 provider-neutral CLI 承接记忆与检索；删除 DSH/Cordis 服务注册、插件 bundle、peer 与 profile bootstrap。setup/check 核验精确包版本、公共 MemoryStorage API 与 CLI surface，不能替代 full readiness 或真实产品旅程资格。

每个 attempt 创建独立 Pi `Harness`/`MemoryStorage`，工具串行，关闭自动模型重试和后台压缩。`MemoryStorage` 不跨进程持久化，不承担产品恢复：Chat 重启读取 Main 固定快照与 AgentRun 输入，已写入的不可变 proposal 只能原样重放 Main ACK，包含旧 `embedded_dsh`/plugin 字段的历史 proposal 也不改写。无 proposal 的运行按现有 attempt、deadline、取消与 ToolEffect 幂等协议恢复；不新增持久 Pi inbox、session log 或第二个状态机。

Main 投影独占长期记忆 ingest/maintain，普通 attempt 首轮前只执行一次可观测的官方 wake，并按当前消息执行 fast recall。normal 开放只读 `memory_search`，normal/private 都开放本 attempt 授权快照的 `igrep_search` 和 `session_recall`，显式配置 web provider 时保留 `igrep_web_search`；private 不读写跨会话记忆。每个 CLI 子进程只接收明确绑定的 LLM/ASK/final-sort、embedding、rerank 路由和必要进程环境，未配置能力显式禁用，`IGREP_NO_CACHE=1` 禁用共享结果缓存，不借用个人默认配置或临时更换 HOME。

上下文压力与 provider overflow 由 Pi 公共 compaction 生命周期处理。宿主的 companion 摘要仅压缩既有观察，不把历史用户请求变成当前任务；指令要求至多 200 words 的最终笔记、合并重复信息，保留明确事实与归属，不从条目序号或重复次数推断事件和时间。既有 1024-token 硬上限不变，截断摘要仍判失败。任何必要 hook 失败先锁住后续模型与工具派发。Main 的 seed/omitted 原文与 Pi 公共 `Conversation.entries()`、context contributions 共同构成只读会话召回投影。每块按 attempt/source/block/byte 稳定标识并保留 UTF-8 字节、原角色和 speaker；query 走公共 igrep `search --stdin-format jsonl --mode ultra`，结果 ID 必须回查当前 attempt 的不可变原文，不能信任搜索摘要冒充原文。system、plugin 上下文、reasoning、压缩摘要和 recall 自身输出不进入原文档案。

当前 Scene、偏好、预召回和当前用户请求在每个实际模型请求边界重新投影，保持原有来源与固定授权，不能被摘要替代。每次物理模型请求独立进入 usage 和 modelRequests 证据，包括工具后的回复和被拒绝的摘要；不能用 Pi 默认的数字 usage 把未知上游回执当成零。attempt 结束后释放内存对话和临时 workspace；保留的历史 DSH archive 清理仅处理已证明本机 owner 退出的旧目录，不更改既有 canonical `deepseek-harness` intake/backup 格式。

普通投影只合并尚未尝试的 pending 事件，并在同一接纳事务通过 event 行 CAS 与领取互斥。尝试过的事件可能已经发布指针但丢失 ACK，后来的产品事实必须取得新 authority。记忆导出明文 spool 归入 Chat 用户擦除目录；每段短文件写入重查用户 tombstone，网络等待不持用户锁。启动在开放 HTTP 前清理崩溃遗留的新目录和已退役 OS 临时目录，账号擦除清理当前用户 spool，迟到 staging 不得重新创建它。

固定 igrep `0.1.161` 的可检索 dialogue 是 `[时间, 正文]` 元组，角色与来源身份位于独立 `session/1` 文件。发布前同时核验两类文件的目录、逐行顺序、时间及 session 的角色、会话身份和原文与 Main 完整来源一致。Dialogue 的 v3 控制符传输严格解码，仅允许插入形状受限的绝对日期注释，全部原文字符须保持顺序；这不认证相对日期解释的语义正确性。维护前后来源及检索视图字节均不能变化。运行认证执行空来源及带换行、Unicode、控制符图形和相对日期的非空来源重建，空工作区或单行 ASCII 成功不能证明 ingest 格式兼容。

新版 igrep 的检索视图绑定来源文件的物理 witness；复制出的 normal attempt 在 wake / recall 前执行官方零模型 `mem reproject`，仅在自己拥有的副本中恢复绑定，不维护 profile、不写 Main 历史。Private 不执行此步骤。预召回若返回检索不完整警告，必须失败，不能将缺失来源解释为记忆为空。完整运行认证同时验证复制后的自身原文召回及双向跨关系隔离。

canonical 指针的原子切换是本地发布点。切换后隔离旧版本失败仍向 Main 报错、保留重建待完成状态，但不能回滚到可能已被隔离的旧路径。精确重放已经发布的版本也必须完成剩余旧版本与候选的隔离后才 ACK。账号删除的同一 sourceEventId 串行构造持久回执；本地 purgedAt、完成事件 ID 与请求 hash 构成不可变候选，并发投递和重试都重放同一完成信封。

Main 记忆导出按完整会话分组、组内保持时间顺序，分页不能破坏 Chat 流式解码所需的会话连续性。clear/destructive rebuild 必须撤销 pending 和 processing 普通投影；后者可能已经读出旧历史，最终 promote 仍须在 Main user 行锁内确认事件有效。用户完整删除由 Chat 持久 tombstone 阻止旧 prepare/promote 复活。官方 ingest 既负责追加，也负责 session/cursor 恢复；仅证明 dialogue 未变或 doctor 成功，不足以跳过其恢复职责。

Chat 的 NDJSON staging 以固定 64KiB 缓冲合并 transcript 写入，每个会话结束前完全写出、fsync，再进入 manifest。短写须续写，零进度和 I/O 失败明确拒绝并清理候选；缓冲不能跨会话。该局部优化不省略官方 ingest，也不改写其私有派生数据和恢复协议。

Main event consumer 的记忆投影、生命周期投递、Turn 接纳、产品事件和 Blob 删除各有独立在飞扫描；一个长维护请求不能阻塞其它职责的后续轮次。Main→Chat outbox 显式区分 memory 与 lifecycle，同一 aggregate/lane 的领取在数据库内有序，远程投递不持有领取锁，原有 lease/heartbeat/CAS 保留。停机立即停止后续领取，已开始的交付保留租约完成；30 秒 drain 未收敛则记录未完成职责并非零退出，PM2 留 35 秒窗口。跨 lane 允许生命周期命令先完成，其安全性依赖上述 Main 失效栅栏和 Chat 删除 tombstone，不依赖全局队列顺序。

Chat admission health 每个短 TTL 窗口重新检查文件、Redis、Pi/igrep pin 与唯一 Chat 模型 route；完整 provider 请求、profile、工具、记忆重建和隔离证明属于显式运营认证。Turn 与 full readiness 都只读取 `CHAT_MODEL_*`，provider warmup 不另设第二把 provider key。采样值在该唯一配置入口按 PreparedTurn 范围 fail closed；OpenRouter 由 `CHAT_MODEL_BASE_URL` 识别，并强制发送 `provider.only + allow_fallbacks=false`、校验实际 provider attribution，而不是要求不存在的 `provider=openrouter`。Pi 与 Chat shared fate：模型流只受首 token 与流空闲两个阶段超时约束，整轮统一受 AgentRun deadline/AbortSignal 约束，再配合接纳暂停、bounded drain 与 PM2 整进程恢复。不得增加一个会中止仍在推进之流的固定 completion 墙钟；没有真实故障证据前也不重新引入 worker 或 child-process seam。

切换是单次切换：停止接纳、等待有界 drain、隔离旧 AgentRun/workspace 文件，然后启动新 runtime。历史不可变 proposal 保留原字段并精确重放；旧执行轨迹不转成新 Pi 会话，隔离操作不做不可恢复删除。Scene 继续由 Main Turn 权威持有；edit/regenerate 都回到被丢弃回复之前的 Scene 锚点，再用新回复计算一次 delta，因此 Scene version 不会因 attempt 增加而重复推进，也不会保留旧回复产生的场景内容。

2026-10-04 起 Chat 在 commit 中不再运行 Scene 投影：Scene 原样推进一版，terminalEvidence 不再带 `sceneProjection`。依据是 72 轮实测只有 14 轮 applied、对抗用例 12/16 失败、却占 done 前时延约 45%，并曾把已生成回复拖到 180 s deadline 整轮失败；`packages/chat/src/scene.ts` 保留，待更便宜或更准确的投影器通过资格验证后再启用。

Scene v1 的持久形状由 Shared 唯一定义，Main execution snapshot / terminal、Chat、公开响应和语音快照复用同一 schema；`scene=null` 只允许 version 0，非空 Scene 的内外版本必须一致。Main 的终态接纳不能只信任 Chat 或 TypeScript：新 sent 必须从匹配当前 attempt 的冻结 execution snapshot 恰好推进一版，failed/blocked/cancelled 完整保留该锚点；缺失、错 attempt 或损坏锚点拒绝。完全相同的已提交终态只重放 ACK，不再次推进，保留历史合法 null/0 终态的精确重放。该校验不改变 v1 数据格式，也不证明 Scene 的自然语言内容已被正确理解。

模型首 token 前仅受首字阶段约束，不能被较短的 idle 设置提前截断；首 token 后只有真实文本、推理或工具名称/参数输出续期 idle。HTTP 字节、SSE 心跳和空 delta 不是模型进度。真实输出持续推进时允许超过首字窗口，整轮仍由已有 AgentRun deadline/AbortSignal 约束，不新增固定 completion 超时。

图片动作的语义理解与无损传递是不同保证。当前 Chat 仍提供图片方向，Main 的 `moment-direct-v1` 仅记录直接输入，标记 `verification: direct_input`，不再以固定 `confidence: 1` 冒充理解已验证。新图片动作的完整方向（含衣着约束）超过 900 字符时在附件/生成预留前明确拒绝；Main 的最终 Chat assembler 保留已接受方向，优先压缩可选角色传记与摄影修饰，必需部分或追加 Look/preset 后仍超过 2000 字符则拒绝，不静默丢弃尾部约束。产品 Turn 编辑/删除同时清除生成请求中的私有 MomentSpec 文本投影。

2026-09-09 的单 route 资格实验没有证明来源绑定的结构化候选足以替代现有入口：即使 Main 提供消息索引，模型仍会混淆剧情更新、图片专属覆盖和冲突复述。因此不启用未经资格验证的必填 MomentSpec，不保留第二 route、运行开关或并行解析 implementation；持续 Scene 理解与像素保真仍是明确的质量缺口。该判断不把 schema 合法、来源真实或请求被拒绝当成语义成功。
