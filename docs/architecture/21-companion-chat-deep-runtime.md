# ADR-21：单进程 Companion Chat 与 Main 驱动的记忆投影

> 状态：Accepted
>
> 取代：ADR-19 的独立 `chat-agent` process/interface、同步 commit-ACK 后 workspace promotion；ADR-20 的完整本地 AgentRun 状态机。DSH/igrep 唯一执行内核、Main 产品 Turn 权威与本地精确终态候选仍有效。

Companion Chat 只有两个需要独立生命周期的 module：Main 持有产品 Turn、修订、接纳、终态与工具效果；Chat 在一个 Bun 进程内执行 Agent 运行。DSH/igrep 是 Chat 内部 implementation，不再通过 HTTP/NDJSON/token/readiness seam 组成第二个应用，也不保留第二 adapter、双 runtime 或兼容回退路径。

Agent 运行只在 Main ACK 未确定时保存完整且不可变的终态候选；Main accepted、duplicate accepted 或明确永久拒绝后即可清理。运行轨迹不是状态机：成功轨迹提交后清理，失败或未决轨迹最多保留七天。Main 的 lease、attempt、权威快照和终态 CAS 是唯一 durable job state。用户取消先提交 Main 终态，再由同一事务写 durable Main→Chat cancel intent；同步 HTTP 只是低延迟快路，outbox 重试负责最终写入 Chat attempt tombstone。Main 接受 failed/cancelled 终态后，SSE `error` 就结束该 attempt；重新生成是新的产品命令，不是流连接自行重试。

`PreparedTurn` 是 Chat 内唯一执行输入：编译时直接生成带稳定消息 id、source kind、Soul/Scene trace、预算与模型 profile 的对象，不再先造产品对象、再经 WeakMap/`*Wire` 转换。Invocation、event、tool 与 commit ACK schema 只存在于 `packages/chat/src/agent-runtime`；Shared 只保留 Main↔Chat 的记忆重建、readiness 与无内容运营证据契约。本地 AgentRun event 文件只记录 content-free lifecycle/tool/failure 事实；文本 delta 与终态正文分别属于 Redis 流和未决 `proposal.json`。

陪伴记忆只从 Main 已提交产品 Turn 异步投影。Main outbox 使用至少一次投递；Chat 在独立候选 workspace 中幂等 prepare，再以单调 authority version 原子 promote。prepare/promote 不持有 relationship-wide Agent 执行锁，也不取消已经运行的 Turn。普通投影延迟不阻塞新 Turn；破坏性修订期间，由 Main 把受影响的新 Agent attempt 固定为 private execution，直到重建切换完成。基于旧 Main 权威快照返回的终态候选必须被 Main CAS 拒绝。

Chat admission health 每个短 TTL 窗口重新检查文件、Redis、DSH/igrep pin 与唯一 Chat 模型 route；完整 provider 请求、profile、工具、记忆重建和隔离证明属于显式运营认证。Turn 与 full readiness 都只读取 `CHAT_MODEL_*`，不再有 `DSH_READY_*` 或第二把 provider key。采样值在该唯一配置入口按 PreparedTurn 范围 fail closed；OpenRouter 由 `CHAT_MODEL_BASE_URL` 识别，并强制发送 `provider.only + allow_fallbacks=false`、校验实际 provider attribution，而不是要求不存在的 `provider=openrouter`。合并后的 DSH 与 Chat shared fate：模型流只受首 token 与流空闲两个阶段超时约束，整轮统一受 AgentRun deadline/AbortSignal 约束，再配合接纳暂停、bounded drain 与 PM2 整进程恢复。不得增加一个会中止仍在推进之流的固定 completion 墙钟；没有真实故障证据前也不重新引入 worker 或 child-process seam。

切换是单次切换：停止接纳、等待有界 drain、隔离旧 AgentRun/workspace 文件，然后启动新 runtime。旧格式不进入新 implementation，也不做不可恢复删除。Scene 继续由 Main Turn 权威持有；edit/regenerate 都回到被丢弃回复之前的 Scene 锚点，再用新回复计算一次 delta，因此 Scene version 不会因 attempt 增加而重复推进，也不会保留旧回复产生的场景内容。
