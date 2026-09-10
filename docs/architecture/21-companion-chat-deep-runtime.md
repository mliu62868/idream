# ADR-21：单进程 Companion Chat 与 Main 驱动的记忆投影

> 状态：Accepted
>
> 取代：ADR-19 的独立 `chat-agent` process/interface、同步 commit-ACK 后 workspace promotion；ADR-20 的完整本地 AgentRun 状态机。DSH/igrep 唯一执行内核、Main 产品 Turn 权威与本地精确终态候选仍有效。

Companion Chat 只有两个需要独立生命周期的 module：Main 持有产品 Turn、修订、接纳、终态与工具效果；Chat 在一个 Bun 进程内执行 Agent 运行。DSH/igrep 是 Chat 内部 implementation，不再通过 HTTP/NDJSON/token/readiness seam 组成第二个应用，也不保留第二 adapter、双 runtime 或兼容回退路径。

Agent 运行只在 Main ACK 未确定时保存完整且不可变的终态候选；Main accepted、duplicate accepted 或明确永久拒绝后即可清理。运行轨迹不是状态机：成功轨迹提交后清理，失败或未决轨迹最多保留七天。Main 的 lease、attempt、权威快照和终态 CAS 是唯一 durable job state。用户取消先提交 Main 终态，再由同一事务写 durable Main→Chat cancel intent；同步 HTTP 只是低延迟快路，outbox 重试负责最终写入 Chat attempt tombstone。Main 接受 failed/cancelled 终态后，SSE `error` 就结束该 attempt；重新生成是新的产品命令，不是流连接自行重试。

`PreparedTurn` 是 Chat 内唯一执行输入：编译时直接生成带稳定消息 id、source kind、Soul/Scene trace、预算与模型 profile 的对象，不再先造产品对象、再经 WeakMap/`*Wire` 转换。Invocation、event、tool 与 commit ACK schema 只存在于 `packages/chat/src/agent-runtime`；Shared 只保留 Main↔Chat 的记忆重建、readiness 与无内容运营证据契约。本地 AgentRun event 文件只记录 content-free lifecycle/tool/failure 事实；文本 delta 与终态正文分别属于 Redis 流和未决 `proposal.json`。

强制图片工具也保留消息 ID、来源及跨说话者的原始先后顺序；历史只是引用数据，不重新授权旧动作，runtime/recall 不伪装成用户。预算测试使用与实际执行相同的 replay 来源分类，包含最新用户事实的完整序列化成本。这只保证输入不被重排或截断，不把传输保真当成语义验证。

OpenAI-compatible provider 在首个响应中以普通文本返回所需工具的完整参数 JSON 时，复用原 schema 校验后直接接纳，不先丢弃并重采样。仅 `stop` 完成、无混入 native tool delta 的候选允许转换；`length`、残缺终态、额外字段或说明文字不能因 JSON 可解析而成为动作。原生工具、最多一次兼容重试、实际 provider 归属和总用量记账保持同一实现。

陪伴记忆只从 Main 已提交产品 Turn 异步投影。Main outbox 使用至少一次投递；Chat 在独立候选 workspace 中幂等 prepare，再以单调 authority version 原子 promote。prepare/promote 不持有 relationship-wide Agent 执行锁，也不取消已经运行的 Turn。普通投影延迟不阻塞新 Turn；破坏性修订期间，由 Main 把受影响的新 Agent attempt 固定为 private execution，直到重建切换完成。基于旧 Main 权威快照返回的终态候选必须被 Main CAS 拒绝。

Main 记忆导出按完整会话分组、组内保持时间顺序，分页不能破坏 Chat 流式解码所需的会话连续性。clear/destructive rebuild 必须撤销 pending 和 processing 普通投影；后者可能已经读出旧历史，最终 promote 仍须在 Main user 行锁内确认事件有效。用户完整删除由 Chat 持久 tombstone 阻止旧 prepare/promote 复活。官方 ingest 既负责追加，也负责 session/cursor 恢复；仅证明 dialogue 未变或 doctor 成功，不足以跳过其恢复职责。

Chat 的 NDJSON staging 以固定 64KiB 缓冲合并 transcript 写入，每个会话结束前完全写出、fsync，再进入 manifest。短写须续写，零进度和 I/O 失败明确拒绝并清理候选；缓冲不能跨会话。该局部优化不省略官方 ingest，也不改写其私有派生数据和恢复协议。

Main event consumer 的记忆投影、生命周期投递、Turn 接纳、产品事件和 Blob 删除各有独立在飞扫描；一个长维护请求不能阻塞其它职责的后续轮次。Main→Chat outbox 显式区分 memory 与 lifecycle，同一 aggregate/lane 的领取在数据库内有序，远程投递不持有领取锁，原有 lease/heartbeat/CAS 保留。停机立即停止后续领取，已开始的交付保留租约完成；30 秒 drain 未收敛则记录未完成职责并非零退出，PM2 留 35 秒窗口。跨 lane 允许生命周期命令先完成，其安全性依赖上述 Main 失效栅栏和 Chat 删除 tombstone，不依赖全局队列顺序。

Chat admission health 每个短 TTL 窗口重新检查文件、Redis、DSH/igrep pin 与唯一 Chat 模型 route；完整 provider 请求、profile、工具、记忆重建和隔离证明属于显式运营认证。Turn 与 full readiness 都只读取 `CHAT_MODEL_*`，不再有 `DSH_READY_*` 或第二把 provider key。采样值在该唯一配置入口按 PreparedTurn 范围 fail closed；OpenRouter 由 `CHAT_MODEL_BASE_URL` 识别，并强制发送 `provider.only + allow_fallbacks=false`、校验实际 provider attribution，而不是要求不存在的 `provider=openrouter`。合并后的 DSH 与 Chat shared fate：模型流只受首 token 与流空闲两个阶段超时约束，整轮统一受 AgentRun deadline/AbortSignal 约束，再配合接纳暂停、bounded drain 与 PM2 整进程恢复。不得增加一个会中止仍在推进之流的固定 completion 墙钟；没有真实故障证据前也不重新引入 worker 或 child-process seam。

切换是单次切换：停止接纳、等待有界 drain、隔离旧 AgentRun/workspace 文件，然后启动新 runtime。旧格式不进入新 implementation，也不做不可恢复删除。Scene 继续由 Main Turn 权威持有；edit/regenerate 都回到被丢弃回复之前的 Scene 锚点，再用新回复计算一次 delta，因此 Scene version 不会因 attempt 增加而重复推进，也不会保留旧回复产生的场景内容。

Scene v1 的持久形状由 Shared 唯一定义，Main execution snapshot / terminal、Chat、公开响应和语音快照复用同一 schema；`scene=null` 只允许 version 0，非空 Scene 的内外版本必须一致。Main 的终态接纳不能只信任 Chat 或 TypeScript：新 sent 必须从匹配当前 attempt 的冻结 execution snapshot 恰好推进一版，failed/blocked/cancelled 完整保留该锚点；缺失、错 attempt 或损坏锚点拒绝。完全相同的已提交终态只重放 ACK，不再次推进，保留历史合法 null/0 终态的精确重放。该校验不改变 v1 数据格式，也不证明 Scene 的自然语言内容已被正确理解。

模型首 token 前仅受首字阶段约束，不能被较短的 idle 设置提前截断；首 token 后只有真实文本、推理或工具名称/参数输出续期 idle。HTTP 字节、SSE 心跳和空 delta 不是模型进度。真实输出持续推进时允许超过首字窗口，整轮仍由已有 AgentRun deadline/AbortSignal 约束，不新增固定 completion 超时。

图片动作的语义理解与无损传递是不同保证。当前 Chat 仍提供图片方向，Main 的 `moment-direct-v1` 仅记录直接输入，标记 `verification: direct_input`，不再以固定 `confidence: 1` 冒充理解已验证。新图片动作的完整方向（含衣着约束）超过 900 字符时在附件/生成预留前明确拒绝；Main 的最终 Chat assembler 保留已接受方向，优先压缩可选角色传记与摄影修饰，必需部分或追加 Look/preset 后仍超过 2000 字符则拒绝，不静默丢弃尾部约束。产品 Turn 编辑/删除同时清除生成请求中的私有 MomentSpec 文本投影。

2026-09-09 的单 route 资格实验没有证明来源绑定的结构化候选足以替代现有入口：即使 Main 提供消息索引，模型仍会混淆剧情更新、图片专属覆盖和冲突复述。因此不启用未经资格验证的必填 MomentSpec，不保留第二 route、运行开关或并行解析 implementation；持续 Scene 理解与像素保真仍是明确的质量缺口。该判断不把 schema 合法、来源真实或请求被拒绝当成语义成功。
