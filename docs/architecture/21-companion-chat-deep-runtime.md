# ADR-21：单进程 Companion Chat 与 Main 驱动的记忆投影

> 状态：Accepted
>
> 取代：ADR-19 的独立 `chat-agent` process/interface、同步 commit-ACK 后 workspace promotion；ADR-20 的完整本地 AgentRun 状态机。2026-10-17 起执行内核由 Pi/igrep 取代 DSH/igrep；Main 产品 Turn 权威与本地精确终态候选仍有效。
>
> 结构：第一部分「现行契约」按主题陈述现行规则，每条只写一次；第二部分「决策日志」按日期记录决策、证据与被取代的旧规则。两者不一致时以现行契约为准；修改规则时同时追加决策日志。2026-11-26 由按日期追加的补丁日志重构为本结构。

Companion Chat 只有两个需要独立生命周期的 module：Main 持有产品 Turn、修订、接纳、终态与工具效果；Chat 在一个 Bun 进程内执行 Agent 运行。Pi/igrep 是 Chat 内部 implementation，不通过 HTTP/NDJSON/token/readiness seam 组成第二个应用，也不保留第二 adapter、双 runtime 或兼容回退路径。没有真实故障证据前不重新引入 worker 或 child-process seam。

## 一、现行契约

### 1. Turn 权威与 attempt

- Main 的 lease、attempt、权威快照和终态 CAS 是唯一 durable job state；Chat 的运行轨迹不是状态机。基于旧 Main 权威快照返回的终态候选必须被 Main CAS 拒绝。
- 新消息、编辑与重新生成都由 Main 在用户与会话锁内确认执行资格。单聊会话或整个群聊同时最多有一个可执行回复；较新的 blocked Turn 不得绕过仍在执行的旧回复。
- 新的修订 attempt 重新核验公共 Serving 权威，固定 Release 不能保留已撤销的执行资格；已接纳 attempt 的终态仍由原快照与 CAS 完成。
- assistant message id 在不同 attempt 间复用，不能独自标识执行。Chat 清理旧 attempt 只删除仍指向它的本地索引；周期性过期清理在同一 Turn 锁内重读索引，避免扫描旧版本后删除新索引。
- 编辑携带打开编辑器时观察到的 attempt，包括正文不变的回复重试。Main 在 Turn 锁内校验 attempt，并在同一事务把接受的键绑定到请求摘要和修订后的 attempt。传输结果未知时，浏览器复用原请求和同一 `Idempotency-Key`。缺少 attempt 的编辑一律返回 409（无存量回执，原重放路径已删除）；带当前 attempt 的请求可省略键；已被取代的修订及异负载重用键返回 409。
- 新浏览器发送携带 `sendProtocolVersion: "chat-send-2"`，与原发送意图一起固定并进入幂等摘要。缺少或过期协议仅可读取精确已有回执；即使旧消息已删且没有墓碑，也不得再次创建 Turn 或恢复执行。旧客户端保留草稿并提示刷新，不自动给旧意图补协议重投。内部 proactive 与绑定 voiceCall 的输入继续使用原权限。
- Chat 首次接纳时固定并持久化 deadline，重复接纳与恢复重放同一时间；接纳回执绑定 Turn/attempt 并将该截止时间交给 Main。Main 在实际截止时间加终态提交宽限之后回收，不从另一个进程的配置或普通行更新时间猜测新运行的期限。没有该字段的历史 generating 行沿用旧回收政策。
- 待接纳（pending）attempt 受接纳 TTL 约束，默认 180 秒。到期仍未被 Chat 接纳时，Main 将其提交为 failed `admission_expired`，void 该 Turn 的额度 fact，并写入 durable cancel intent，迟到的接纳不能再执行它。
- Main 主动消息的无时区时间字段按 UTC 比较和推进，不继承数据库会话时区。
- 回复版本：最新 Turn 的纯文字回复被 regenerate 取代时，保留为可选版本（`chat_turn_alternatives`，含当前回复至多 10 个，按生成顺序编号）。选回某个版本是 Main 对该 Turn 的修订：attempt 递增、不调用 Chat、不扣额度、不重放工具效果；记忆按第 6.3 节的可投影规则退休被换下的回复，未重建时为新当前回复调度普通投影。编辑用户消息或开始更新的 Turn 时版本作废；带媒体附件的回复不成为版本，也不能被换下，因为其附件、计费与交付绑定在具体 attempt 上。未被选中的版本不进入长期记忆。选回版本写入 `chat.exchange.corrected.v2` 的 `selected` 修正，指标计入被采用的回复。

### 2. 交付与 SSE

- SSE 入口以 Main 的所有者、消息存在性与当前 attempt 为交付权威，在请求 Chat 前与握手返回后均校验。接纳回执丢失而 Main 尚未确认的 pending attempt 不得交付本地文本；Main 已提交 sent 终态则足以确认交付。已有 probe/quality 调用方未传 attempt 时，BFF 将 Main 当前身份固定到上游请求。删除或修订发生在握手期间时，取消上游正文并拒绝交付；已打开的流由既有取消 intent、attempt 事件和客户端栅栏收敛。
- 浏览器的文本缓存、停止标记与 EventSource 绑定 attempt，观察到新 attempt 后撤销旧来源。传输断开只重连同一 attempt：CONNECTING 由 EventSource 重连，CLOSED 由 Main 权威轮询重新建立连接，不因此生成新回复。编辑或重新生成成功后的浏览器读取栅栏使在途旧快照失效，已观察 attempt 不因流缓存清理而丢失。
- Main 接受 failed/cancelled 终态后，SSE `error` 结束该 attempt；重新生成是新的产品命令，不是流连接自行重试。
- 文本 delta 属于 Redis 流（`STREAM_MAXLEN=4000`），终态正文属于未决 `proposal.json`。SSE 以 25 ms / 48 字符的 `DeltaCoalescer` 微批合并 delta。
- 正文发布时机：开放媒体动作工具的轮次中，携带显式付费授权、多语种媒体/改图/重发意图或紧接图片邀约的短确认轮次缓冲前导正文，防止媒体承诺泄漏；其余轮次实时推送 `text_delta`，若意外触发媒体工具调用，则以 `text_reset` 清空已推送正文并转入媒体处理。实际选择媒体动作后，工具前后生成的承诺文字不进入公开流；未实际选择动作时释放普通正文；未开放媒体动作工具的对话保持原生流式。
- Chat 收到已持久化的附件回执后，在同一 SSE 发送 `attachments_changed`。浏览器按当前 attempt 重新读取 Main 会话，继续接收独立正文。卡片状态来自 Main，成品仅在附件为 `completed` 且媒体可读时显示。刷新与后续确认始终读取 Main 当前附件与 attempt，客户端旧身份不能覆盖新状态。
- 会话读取分页，默认返回最近 50 个 Turn，更早的历史按页读取。

### 3. 取消与停止

- 用户取消先提交 Main 终态，再由同一事务写 durable Main→Chat cancel intent；同步 HTTP 只是低延迟快路，outbox 重试负责最终写入 Chat attempt tombstone。
- Stop 命令携带用户点击时观察到的 attempt，Main 在 Turn 锁内校验并回显该身份；迟到命令不得取消新 attempt，迟到回执不得停止或清空新回复。
- Stop 禁止继续执行、发布文本和提交终态，但允许已开始的模型请求向原 AgentRun 追加无正文的用量回执；未知用量仍为 null。该专用入口只写现存且身份匹配的运行轨迹，不改 Main 的 cancelled 终态、额度或新 attempt。发布事件失败时，已派发的模型请求同样可以提交无正文用量回执。
- 取消与擦除分别推进执行禁区和回执禁区；历史未区分两者的 tombstone 按擦除保守处理。Turn 删除、旧 attempt 清理及账号擦除不可被迟到 Stop 解禁，关系维护期间也拒绝回执。
- 首次 Stop 固定本地诊断七天到期时间，重投或迟到回执不得续期；追加与过期清理使用相同锁，禁止重新创建已删目录。
- 非成功 HTTP 响应的正文取消只负责释放资源，不能使原 HTTP 错误等待一个永不收敛的 cleanup promise。执行截止时间校验留在执行与接纳边界；账号擦除读取所有者时不以历史执行证据完整为前提。

### 4. 额度

- 每个可执行 Turn 在启动前持有唯一额度 fact。首次可执行的编辑创建预留；失败后重试先恢复预留并核验剩余额度；已经计量的修订不再花一份额度。
- proactive 不消耗用户主动发送额度，fact 沿用 Turn 的 UTC 产品日。跨日修订核验实际恢复的原 Turn 产品日额度桶。
- 额度 fact 的 `consumedAt` 独立记录已消费事实：成功回复或已接纳的取消一旦消费，后续 attempt 失败或未接纳取消都不能清除它；回复统计不承担取消的消费记账。
- 释放额度的两种失败：已发出模型请求但无 proposal 的中断运行释放尚未消费的额度（见第 8 节）；pending 接纳过期 void 额度 fact（见第 1 节）。
- 媒体费用与消息额度各自以 Main 账本为准，见第 5 节。

### 5. 媒体动作

#### 5.1 工具选择与动作身份

- 主对话统一使用 `request_character_media`、`resend_session_media` 和 `edit_last_image`。`PreparedTurn` 根据 Main 的权益、官方库存种类、已交付媒体及模型能力暴露工具。两类角色（官方、非官方）共用工具契约。
- OpenAI-compatible provider 仅以原生 tool call 进入动作执行；普通文本或参数 JSON 不转换成工具，也不通过兼容重试强迫调用。Agent 在原生 `tool_choice=auto` 中理解本次请求，补全方向和明确条件；Main 冻结的 `imageActionMode` 与产品权限约束执行。
- Main 校验冻结 Turn、attempt、权限和同一用户消息修订的动作身份。重试回复复用持久回执，修改原文创建新的动作身份。历史附件和未决终态提案按原记录恢复。
- 群聊中，Agent 从当前 Character 的已提交历史理解图片邀约与短确认，宿主不合成确认事实。
- 跨 attempt 的 turn_action 重放遵循统一 user→conversation→Turn→attachment 锁序，并在锁内重读 Job、状态与费用；requesting 只是动作身份已保存，不能作为成功预留 ACK。中断后恢复该动作先绑定当前 attempt，再进入原有 Generation 原子预留，以同一动作身份防止重复扣费。
- legacy 图片动作收据只有在用户原文未变时可跨 attempt 重放；编辑在同一事务持久标记旧身份失效，包括没有 Job 的旧收据；已有 Job 的旧编辑清除证据也使该收据失效。
- 回复重试在 Main 锁内校验并重绑已有媒体附件。执行快照的 `recoveredMediaAction` 是已有动作的持久事实，不是预选意图；其状态必须有相应 Job、交付资产或未付费编辑草稿支撑，已取消草稿不能被复活。此时 Chat 直接进入媒体请求提取及独立正文阶段，不再开放媒体工具、不伪造执行记录；实际提取与正文仍计入同一预算。

#### 5.2 授权、库存与计价

- 普通消息先出价格确认卡。用户发送时授权的单次付费图片可直接履约，视频始终需要独立确认。单次付费 Chat 授权仅覆盖一张照片：Main 在写入附件和生成预留前拒绝多张请求，已接纳的历史收据和按原数量显式报价的重试继续有效。
- 统一请求还支持只查可用性和明确只收取已有内容；后者查不到时返回无匹配，不能回落实时生成。明确要求新生成时跳过库存。普通发图或视频优先检索可用库存，详细条件仍用于匹配。非官方角色的图片使用实时生成，同样遵循图片授权和价格确认。
- 官方库存检索有 1.5 秒只读预算。向量与词面融合结果经过显式服装、必需事实、排除项、时长和音轨条件校验。运营描述与事实来自成品审核，生成方向仅记录请求意图。检索与履约仅接受与当前描述匹配的索引；库存描述索引升级后，已发布条目需要在 Admin 重新保存以生成新索引。
- 库存图片每张 5 币，视频每个 30 币，具体价格以当前 PricingRule 和已确认报价为准。图片自动模式可以回落同价实时生成；自动图片选中库存后，仅库存失效触发实时生成回落。视频没有合适库存时返回零扣费的无匹配。
- 直接授权与报价确认走同一履约入口；价格与授权冲突由原接纳事务拒绝。Main 在扣费事务内复核素材修订和视觉身份，原子记账并安排延迟揭示。库存或 Generation 的接纳事务给出首次接纳或重放事实，Main 依据锁内附件组装回执，包括已经发生的交付或失败。
- 运营批量图片和视频包以 draft、unknown 入库，审核员确认服装事实后可发布到聊天库存或专属合集。

#### 5.3 履约、揭示、重发与锁序

- 在揭示时间到达前，附件没有可读取的媒体资产 ID。到期时 Main 从获准的不可变副本创建用户私有资产。延迟期内撤下素材或删除消息按原支付额退款。已交付副本保留在用户会话中。
- 显式重发使用自己会话已交付的资产 ID，Main 在锁内校验当前可读性并创建免费附件。近期媒体事实保留已审核描述、存在和缺失事实、服装、时长、音轨与编辑来源。
- 已交付的确认式编辑可携带 `editProvenance`，绑定实际成功 attempt 的冻结 dispatch、源资产和已执行操作；它与视觉 `description` 分离。重发读取资产自己的来源链，不能把最近一次用户请求改写为该图片的事实。`requestedTarget` 仍是编辑意图；源资产引用不扩大当前会话的可发送权限。
- Gen 完成、失败、取消与运营退款都先取得与 Chat 相同的 user 锁，再取得 Request 和附件锁；批量结算先按 userId 排序取得全部用户锁，避免钱包与附件的反向等待。金额与资格由锁内事实和现有幂等账本决定。

#### 5.4 图片编辑与方向

- 局部图片编辑的 `editScope` 由 Agent 按当前意图填写，Main 不引入关键词分类。新动作缺少 scope 时拒绝；历史整图动作不追溯改写。新局部动作只产生 `awaiting_confirmation` 附件与规范化原图快照，不创建 Job 或扣费；目标词不自动变成分割遮罩。用户确认具体区域、改色或生成操作及报价后，Main 才按冻结的 `confirmed-mask-rgba-1` 接纳任务。浏览器预览、Gen 的确定性改色、局部采样和保护区证据按 ADR-17 执行。
- 用户消息准入时固定本会话已交付且可读的最新源图，包括无角色归属的场景图；重试回复沿用同一源图。旧快照可沿用自身记录的已交付图片，缺少这份来源证据时只可恢复已提交的编辑动作。
- Chat 提供图片方向；Main 的 `moment-direct-v1` 仅记录直接输入，标记 `verification: direct_input`，不以固定 `confidence: 1` 冒充理解已验证。新图片动作的完整方向（含衣着约束）超过 900 字符时在附件/生成预留前明确拒绝。Main 的最终 Chat assembler 保留已接受方向，优先压缩可选角色传记与摄影修饰；必需部分或追加 Look/preset 后仍超过 2000 字符则拒绝，不静默丢弃尾部约束。产品 Turn 编辑/删除同时清除生成请求中的私有 MomentSpec 文本投影。
- 不启用必填 MomentSpec，不保留第二 route、运行开关或并行解析 implementation。

#### 5.5 结果语义

- 媒体动作的接纳、交付与失败由 Main 的附件状态表达，不合成角色口吻的媒体回执。`accepted` 只证明请求已被接纳，`completed` 证明已有交付，均不证明修改语义、选区完整或保真质量；交付状态不能替代区域准确性或视觉验收。库存检索的 `matches` / `no_match` 均不表示交付，检索失败也不能冒充 no_match。
- 发送或生成接纳结果未知则停止，不能提交成功回复或再次购买。
- 不设线上 critic 门禁。纯媒体空正文可确定地消除额外承诺；混合请求保留自由文本能力及其经验性风险，必须记录实际模型输出的资格范围，不能宣称任何故事或历史上下文下都绝无媒体断言。
- 图片动作的语义理解与无损传递是不同保证；schema 合法、来源真实或请求被拒绝都不等于语义成功。持续 Scene 理解与像素保真是明确的质量缺口。

#### 5.6 媒体状态与角色正文分离

- 开放媒体动作工具时，以当前用户原文和真实动作回执确定仍需回答的独立要求。没有独立要求时，真实附件卡片就是回复，正文为空。有独立要求时，复用正式 native 消息投影、Soul、历史和实际非媒体工具证据继续生成正文；当前媒体命令、动作回执和媒体工具不进入正文阶段。Main 确认附件后，媒体工具结果通过 Pi 原生 `control.terminate` 结束该工具轮；混合工具轮仍遵循 Pi 的全部结果终止条件。不先生成随后丢弃的媒体台词。
- 独立要求的确定按以下顺序：
  1. 媒体工具参数可携带 Chat 侧路由提示 `independentTextRequest` 与独立文本请求的逐字摘录。二者只在 Chat 本地使用，转发 Main `tool-effects` 前剥离，不影响 Main 账本与收据 schema。
  2. 摘录逐字核验通过时，直接作为独立请求进入正文阶段，跳过 `media_extraction` 调用。
  3. 模型声明 `independentTextRequest=false`、通过确定性单意图守卫（单句短文本、无问号、无多任务连接词）且 Main 确认真实附件时，跳过 `media_extraction`，以空正文加卡片提交。
  4. 其余情况（含摘录缺失或核验失败）回落到 `media_extraction` 逐字抽取。
- 逐字抽取以 Markdown 引用复制独立请求，原文的空行也带引用符号，片段之间用未引用的空行分隔；没有独立请求时返回 `NONE`；库存未交付时首行提供固定反馈文案的语言代码；查找结果满足条件式问答或创作的前提时，抽取已触发的原文任务。Chat 拒绝额外正文和截断，并按原顺序定位片段；相邻片段之间的空白从原文恢复，被排除的文本以段落边界隔开。逐字定位验证片段来源，语义完整性由模型抽取和样例验收覆盖。
- 独立正文沿用原用户消息 ID，以已核验的原文片段和当前阶段可用工具选择语言、格式与系统指令；多段正文按各段自己的语言、长度和格式生成。独立正文阶段可使用当前阶段的只读工具，并继承实际执行的只读检索证据；它在已核对媒体结果后流式输出。当前消息保留 `current_user` 身份，使背景上下文仍进入 `<context>`；不能删除身份后追加普通 user 消息绕过正式封装。
- 跨阶段继承的真实非媒体工具调用和结果以当前 attempt 的执行来源保留，校验原文、role、callId 与 owner，压缩后仍可召回，不冒充 Main 历史或普通 plugin 背景。两个媒体阶段共享工具调用身份；工具调用 ID 在同一原生响应、后续响应和压缩后均不可复用，移交到独立正文的工具证据也占用原身份，冲突在派发前拒绝。
- 提取与正文请求沿用同一 provider/profile、物理请求 journal、用量、deadline 和取消边界，共用剩余总步数与总预算；不重放媒体动作。
- 已执行库存查询而无媒体动作或附件时，正常结束的工具循环按 Main 的最后一次查询回执和用户原文反馈：请求符合才发送时，未能交付说明未找到符合要求的内容；仅询问库存时，可以报告发现相近候选；查询失败时说明当前不可确认。原模型草稿中的交付承诺不进入公开流；当前原文中仍需回答的独立要求继续使用媒体独立正文流程。只读库存查询不触发图片回执语言和流程词校验。当前消息旁说明库存能力和本轮实际授权；付费入口的指引只适用于明确要求新制或整图重做且本轮没有付费授权。
- Main 仅在 `mediaResponse` 指向同一 Turn、当前 attempt 的真实非 requesting 媒体附件时接纳空正文；历史已选中的不可变 proposal 仍可原样重放。HTTP 错误或未确认动作不能伪造附件证明。混合请求的独立正文失败仍是回复失败，不能退化为卡片存在即成功。
- 产品工具等待启动事件成功写入后才请求 Main。

### 6. 记忆投影

#### 6.1 投影来源与投递

- 陪伴记忆只从 Main 已提交产品 Turn 异步投影。Main 投影独占长期记忆 ingest/maintain。首次接纳终态与记忆投影意图在同一事务写入；精确重放只返回原提交回执，原 outbox 继续负责投影投递和重试。
- Main outbox 至少一次投递。普通投影只合并尚未尝试的 pending 事件，并在同一接纳事务通过 event 行 CAS 与领取互斥；尝试过的事件可能已经发布指针但丢失 ACK，后来的产品事实必须取得新 authority。
- Main→Chat outbox 显式区分 memory 与 lifecycle lane，同一 aggregate/lane 的领取在数据库内有序，远程投递不持有领取锁，原有 lease/heartbeat/CAS 保留。Main event consumer 的记忆投影、生命周期投递、Turn 接纳、产品事件和 Blob 删除各有独立在飞扫描，一个长维护请求不能阻塞其它职责的后续轮次。跨 lane 允许生命周期命令先完成，其安全性依赖 Main 失效栅栏和 Chat 删除 tombstone，不依赖全局队列顺序。
- Main 记忆导出按完整会话分组、组内保持时间顺序，分页不能破坏 Chat 流式解码所需的会话连续性。
- 附件已回答的空正文 Turn 保留原用户文字，并由 Main 核验后标记 `answeredByAttachment`；不伪造 assistant 台词，也不删除用户消息。该标记只允许用于 user 记录，其他记录继续遵循既有顺序与完整性校验。

#### 6.2 prepare / promote 与栅栏

- Chat 在独立候选 workspace 中幂等 prepare，再以单调 authority version 原子 promote。prepare/promote 不持有 relationship-wide Agent 执行锁，也不取消已经运行的 Turn；普通投影延迟不阻塞新 Turn。
- promote 的栅栏是关系级 `companion_memory_authorities` 行的 `FOR UPDATE` 加 authority version 校验；破坏性变更（含 clear memory）同样写该行，账号硬删除删除该行，因此仍然互斥。version 已被更新时，普通投影放弃 promote；重建仅在被撤销（clear、删号）时放弃，因为之后以 canonical 为种子的投影带不上重建的删除。memory lane 按 aggregate 分组有界并发（至多 4），同一 aggregate 内严格串行。已知限制：promote 仍跨 promote HTTP 持有该关系行；promote 期间同一关系若有终态提交需要新的投影 authority，会在持有 users 行锁时等待该行。影响面已从"每次 promote 阻塞该用户全部操作"收窄到"同关系并发终态"，彻底消除需要 Chat 侧带版本栅栏的两阶段 promote。持有 users 行锁时不发起任何远程调用（包括 prepare/promote/purge HTTP）。
- clear/destructive rebuild 必须撤销 pending 和 processing 普通投影；后者可能已经读出旧历史，最终 promote 须在上述关系级栅栏内确认事件仍有效。
- canonical 指针的原子切换是本地发布点。切换后隔离旧版本失败仍向 Main 报错、保留重建待完成状态，但不能回滚到可能已被隔离的旧路径。精确重放已经发布的版本也必须完成剩余旧版本与候选的隔离后才 ACK。
- 用户完整删除由 Chat 持久 tombstone 阻止旧 prepare/promote 复活。账号删除的同一 sourceEventId 串行构造持久回执；本地 purgedAt、完成事件 ID 与请求 hash 构成不可变候选，并发投递和重试都重放同一完成信封。

#### 6.3 修订与破坏性重建

- regenerate、edit、删除单条消息或会话、选回回复版本，只在被取代的 attempt 可能已被投影时（assistant 已 sent 且该 Turn `memoryEnabled`）触发破坏性关系记忆重建。重建挂起期间不拒绝修订：新的 purge 栅栏并入尚未被领取的重建事件（守护更新与领取互斥），已被领取的重建可能已导出，不再扩大，新事件排在其后（同一 aggregate 串行投递）。挂起期间该关系的新 Agent attempt 固定为 private execution，直到所有重建切换完成。
- 被取代的 attempt 不可能已被投影时（未 sent，或未开启记忆），只清除旧 attempt 的 AgentRun 产物，不重建关系记忆，新 attempt 的记忆保持开启。

#### 6.4 igrep 来源格式与 staging

- igrep 的可检索 dialogue 是 `[时间, 正文]` 元组，角色与来源身份位于独立 `session/1` 文件。发布前同时核验两类文件的目录、逐行顺序、时间及 session 的角色、会话身份和原文与 Main 完整来源一致。Dialogue 的 v3 控制符传输严格解码，仅允许插入形状受限的绝对日期注释，全部原文字符须保持顺序；这不认证相对日期解释的语义正确性。维护前后来源及检索视图字节均不能变化。
- 官方 ingest 既负责追加，也负责 session/cursor 恢复；仅证明 dialogue 未变或 doctor 成功，不足以跳过其恢复职责。
- Chat 的 NDJSON staging 以固定 64KiB 缓冲合并 transcript 写入，每个会话结束前完全写出、fsync，再进入 manifest。短写须续写，零进度和 I/O 失败明确拒绝并清理候选；缓冲不能跨会话。该局部优化不省略官方 ingest，也不改写其私有派生数据和恢复协议。
- 记忆导出明文 spool 归入 Chat 用户擦除目录；每段短文件写入在 Chat 用户级 fence 锁内重查用户 tombstone，等待网络时不持有该锁。启动在开放 HTTP 前清理崩溃遗留的新目录和已退役 OS 临时目录；账号擦除清理当前用户 spool，迟到 staging 不得重新创建它。

#### 6.5 attempt 记忆副本与 wake

- normal attempt 从不可变 canonical 版本复制自己的记忆副本，复制使用 copy-on-write 克隆。新版 igrep 的检索视图绑定来源文件的物理 witness；副本在 wake / recall 前执行官方零模型 `mem reproject`，仅在自己拥有的副本中恢复绑定，不维护 profile、不写 Main 历史。Private 不执行此步骤，也不读写跨会话记忆。
- 普通 attempt 首轮前只执行一次可观测的官方 wake（可由缓存命中提供，观测带 `cache: "hit"`），并按当前消息执行 fast recall。`mem wake` 结果按不可变 canonical version 的 realpath 进程内缓存（LRU 256），relationship/user purge、账号擦除、rebuild promote 与 shutdown 使缓存失效，epoch 计数防止失效前发起的查询写回。
- reproject 不能按版本共享：igrep 0.1.169 的检索视图绑定文件 inode/ctime，克隆出的已 reproject 副本仍会失效；共享目录又无法容纳每个 attempt 自己的 `knowledge/`（igrep 拒绝符号链接来源），因此每个 attempt 仍各自 reproject。workspace prepare、复制与 reproject 的耗时作为 content-free `runtime_observation` 进入 AgentRun journal，不发给 Main。
- 预召回若返回检索不完整警告，必须失败，不能将缺失来源解释为记忆为空。自动预召回 empty 只记录观察，不额外指导角色声称没有记忆；去重后的空 notes 或 profile-only hit 不代表没有记忆，任何检索状态都不能否定当前原文、历史及已验证 profile。用户需要的原文仍可由 Agent 自选 `session_recall` 或 `memory_search` 取回。

### 7. 执行内核与预算

#### 7.1 内核、输入与协议位置

- Pi 只负责单次 Agent 运行的 model/tool loop、公共事件和上下文压缩；igrep 通过 provider-neutral CLI 承接记忆与检索。DSH/Cordis 服务注册、插件 bundle、peer 与 profile bootstrap 已删除；`deepseek-harness` 只保留为既有记忆 intake/session 与备份格式标识。
- `PreparedTurn` 是 Chat 内唯一执行输入：编译时直接生成带稳定消息 id、source kind、Soul/Scene trace、预算与模型 profile 的对象，不先造产品对象、再经 WeakMap/`*Wire` 转换。它固定 Soul、当前事实及预算内保留的对话；两阶段用同一投影生成模型输入。
- Invocation、event、tool 与 commit ACK schema 只存在于 `packages/chat/src/agent-runtime`；Shared 保留 Main↔Chat 的产品执行快照、接纳回执、工具效果、终态提交、记忆重建、readiness 与无内容运营证据契约。
- 每个 attempt 的原生执行阶段使用独立、临时的 Pi `Harness`/`MemoryStorage`，不跨进程持久化、不承担产品恢复；媒体独立正文阶段复用同一执行入口和剩余总步数，额外的请求提取也占用该预算。工具串行；Pi 自动模型重试和后台压缩关闭。不新增持久 Pi inbox、session log 或第二个状态机。
- 任何必要 hook 失败先锁住后续模型与工具派发。宿主适配带标签的 `onReport`，保留原始异常分类。模型请求意图、产品工具启动和终态候选遇到写入栅栏时，生产端口把拒绝传回执行层。
- attempt 结束后释放内存对话和临时 workspace（包括媒体正文的搜索快照）；保留的历史 DSH archive 清理仅处理已证明本机 owner 退出的旧目录，不更改既有 canonical `deepseek-harness` intake/backup 格式。

#### 7.2 回复契约与模型视图

- 整条回复完成当前用户请求，并在完成后结束；“先回答”不能变成随后追加无关剧情的许可。角色语气与动作保持在用户指定的语言、长度、句数和内容范围内，不依靠输出后裁剪或通用格式重试补救。媒体附件与独立正文可以共同完成回复，但附件存在不能掩盖独立问题或故事的遗漏。
- 普通历史对话按响应 Character 的 ID 投影：自己的话使用 `assistant` 且不加姓名前缀，其他 Character 的话使用带原姓名的 `user` 输入；原生工具调用与结果保留协议要求的角色。该投影仅作用于 provider 视角，不改 Main 原角色、speaker 归属或召回原文；预估预算与实际发送共用此投影。群聊历史的 Character 归属必须穿过 Pi 的不可变消息投影到达实际 provider 请求。
- 仅在本角色最后一条完整回复之后，对另一 Character 已回答的历史用户消息标注已回答；本角色的原生 assistant 回复已闭合更早的输入，无需重复标记。Soul 中规范的 `## Dialogue examples` 标题仅在模型视图中注明为语气示例，不改不可变 Soul 内容及例句。
- 请求把背景上下文和逐字保留的当前用户原文放在两个 `user` 消息中，工具往返在其后；背景有文本定界与历史状态说明。长期记忆的 resident profile 即使通过事实支持校验，也只作为历史上下文进入 `<context>`，不得把其中引用的旧用户指令提升到 system；system 仅保留静态记忆策略。显式 `memory_search` 返回的 profile 行与驻留画像使用相同的来源支持校验，不能绕过被拒绝的画像事实。
- 当前 Scene、偏好、预召回和当前用户请求在每个实际模型请求边界重新投影，保持原有来源与固定授权，不能被摘要替代。
- 原生只读检索工具成功后（空结果也属于成功检索），后续生成请求末尾附带一条静态回复上下文，提醒模型按原请求回答、保留事实归属并在完成后结束。normal/private 均适用；该上下文不改写当前用户原文，不进入 Pi conversation、压缩材料或召回档案，也不新增修复模型调用；成功标记仅在当前 attempt 内有效，自动预召回和失败查询不触发。Pi 提前预留其输入成本，因此临界上下文可能更早压缩。
- 没有真实媒体附件证明的空正文按正常结束或输出预算耗尽分类。

#### 7.3 推理与采样

- Ornith 8-bit 的普通 Companion 生成开启隐藏推理；摘要、一般结构化提取、预热和 igrep 辅助模型关闭推理。推理不交付、不写入记忆。禁止强制提前闭合 thinking。
- Inkling 在开放媒体工具的模型轮次使用 `minimal` 推理提示，工具选择由原生 `auto` 完成；逐字抽取和独立正文从请求起点关闭推理。
- 推理和正文共同受 PreparedTurn 的模型总输出预算及请求显式上限约束。回答档位通过产品偏好约束长度；当前 provider 不支持同时硬保证独立的可见 token 上限，不能声称已实现此能力，也不以输出后裁剪补救。工具选择为 auto，不强制工具或补写答案。
- 逐字抽取使用 1,024-token 专用额度；独立正文使用模型总输出额度及该请求的显式上限，以容纳多段各有长度要求的答案。
- 采样值在唯一配置入口按 PreparedTurn 范围 fail closed。精确编号问答沿用结构化采样上限 0.2；编号名词前的短修饰语不把同一事实请求误路由到表达性采样；普通角色扮演保留配置值。

#### 7.4 检索与召回工具

- normal 开放只读 `memory_search`；normal/private 都开放本 attempt 授权快照的 `igrep_search`、`session_recall` 与只读 `igrep_read_source`；显式配置 web provider 时保留 `igrep_web_search`。可用工具提示与真实注册保持一致；显式要求的只读查询不能被自动预召回取代；检索成功也不产生保存或未来记忆承诺。
- `igrep_search` 只索引保留的对话，不重复索引 system 契约或已省略原文；已省略原文经 `session_recall` 的来源绑定返回。可进入媒体独立正文的 attempt，其首阶段检索文件只包含保留的历史，当前原文和实时上下文通过首阶段的固定输入交付，旧文件续页仍可回读精确历史。媒体正文使用自己的 `media-body.jsonl` 搜索快照，首阶段 `conversation.jsonl` 保持不变，已返回的版本续页在同一 attempt 的两个 loop 间仍可读取。
- Chat 验证检索命中属于当前阶段的语料，向模型交付预览及可供原文回读的相对路径和行范围。仅省略原始对白时提示使用会话召回。
- 本地与会话内检索使用公开 `search --strict`，不完整或模型阶段降级均按失败记录；不解析英文提示判定完整性。
- `igrep_read_source` 仅接受本 attempt 授权 knowledge 目录内的相对路径，拒绝越界与符号链接；每页至多 6000 字节，续页要求原 fingerprint，保留原始 UTF-8 与源范围语义；参与 Pi 的大结果来源 cursor 预算，不能读取跨关系记忆或替代 `session_recall` 的原文身份绑定。
- 会话召回投影由 Main 的 seed/omitted 原文与 Pi 公共 `Conversation.entries()`、context contributions 共同构成。每块按 attempt/source/block/byte 稳定标识并保留 UTF-8 字节、原角色和 speaker；query 走公共 igrep `search --stdin-format jsonl --mode ultra`，结果 ID 必须回查当前 attempt 的不可变原文，不能信任搜索摘要冒充原文。system、plugin 上下文、reasoning、压缩摘要和 recall 自身输出不进入原文档案。
- 每个 CLI 子进程只接收明确绑定的 LLM/ASK/final-sort、embedding、rerank 路由和必要进程环境；未配置能力（含 image embedding 路由）显式禁用；文本快照使用 `IGREP_INDEX_LEVEL=none`，不设置 `IGREP_IMAGE_AUGMENTATION_MODE`；`IGREP_NO_CACHE=1` 禁用共享结果缓存；不借用个人默认配置或临时更换 HOME。
- 空记忆工作区及纯寒暄短语跳过 `memory-search` 子进程。
- 检索只用于缺失的事实：system 指引说明角色描述与可见对话已知，直接据此回答，不为其中已有的事实发起检索。

#### 7.5 上下文、压缩与预算

- 上下文压力与 provider overflow 由 Pi 公共 compaction 生命周期处理。宿主的 companion 摘要仅压缩既有观察，不把历史用户请求变成当前任务；指令要求至多 200 words 的最终笔记、合并重复信息、保留明确事实与归属，不从条目序号或重复次数推断事件和时间。1024-token 硬上限不变，截断摘要判失败。
- 历史窗口超限时按固定 8 条（4 轮）块对齐阶梯淘汰（`selectCacheAlignedTranscriptWindow`），避免逐轮滑动使 KV 前缀缓存连续失效。
- 最终请求按 adapter 相同的消息和工具序列化估算输入预算；估算器按脚本加权（ASCII 4 chars/token、CJK 1.5 tokens/char），不等于 provider tokenizer 精确计数。请求预算和召回投影使用同一个 Pi 截止点。
- Pi 压缩后仍超限时，先移除可派生摘要，再把大只读工具结果替换为当前 attempt 内精确来源 cursor；召回结果只按完整原文 chunk 分页，保留未返回的 ID 与来源续页 cursor。最新回读至少保留一个完整 chunk，不能退化成不断回读自身的空页；不可容纳的固定输入仍拒绝。分页只改变发送副本，不修改 Main/Pi 原文。

#### 7.6 Provider、超时、重试与并发

- Turn 与 full readiness 都只读取 `CHAT_MODEL_*`，provider warmup 不另设第二把 provider key。OpenRouter 由 `CHAT_MODEL_BASE_URL` 识别，强制发送 `provider.only + allow_fallbacks=false` 并校验实际 provider attribution，而不是要求不存在的 `provider=openrouter`。
- 模型流只受首 token 与流空闲两个阶段超时约束，整轮统一受 AgentRun deadline/AbortSignal 约束。首 token 前仅受首字阶段约束，不能被较短的 idle 设置提前截断；首 token 计时从请求意图落盘后、物理派发前开始，本地写入由 AgentRun 总 deadline 约束。首 token 后只有真实文本、推理或工具名称/参数输出续期 idle；HTTP 字节、SSE 心跳和空 delta 不是模型进度；真实输出持续推进时允许超过首字窗口。不增加会中止仍在推进之流的固定 completion 墙钟。
- 瞬时失败重试：adapter 对单次物理模型请求最多在进程内自动重试一次，前提是失败属于传输错误、首 token 超时或 HTTP 429/5xx，且该请求未产生任何输出进度（同上进度定义）。重试是一次新的物理请求，同样先落盘请求意图、事后记录用量；仍受 AgentRun deadline 与取消约束。其它失败不重试；Pi 的自动重试保持关闭；进程重启后的未知结果仍按第 8 节处理，不重放。
- provider 的工具名分片先累计为完整当前名称再交给 Pi，参数按 delta 累积。SSE `[DONE]` 结束当前响应读取，不等待 HTTP EOF，也不放宽 finish reason、provider attribution 或用量核验。
- 进程内 `ConcurrencyWaitQueue` 以 FIFO 即时唤醒等待容量（默认 `PI_CAPACITY_WAIT_MS=15000`），超时才返回 `CompanionCapacityError`。`InferencePriorityGate` 在前台实时 Turn 推理期间让后台 `mem maintain` 与 `profile-evidence` 礼让。Pi 与 Chat shared fate，依靠接纳暂停、bounded drain 与 PM2 整进程恢复。

### 8. 恢复

- Agent 运行只在 Main ACK 未确定时保存完整且不可变的终态候选；Main accepted、duplicate accepted 或明确永久拒绝后即可清理。成功轨迹提交后清理，失败或未决轨迹最多保留七天。
- Chat 重启读取 Main 固定快照与 AgentRun 输入；已写入的不可变 proposal 只能原样重放 Main ACK，包含旧 `embedded_dsh`/plugin 字段的历史 proposal 也不改写。
- 每次物理模型请求前先等待无正文请求意图写盘。只有可证明尚未发出请求的运行才能自动继续；已发出请求但没有 proposal 的运行提交 `agent_run_interrupted` 失败，保留 Main 用户消息、释放尚未消费的额度，由用户显式重新生成新 attempt。存活回执保留实测用量，未确认请求保持 null；历史未记录请求意图的 `pi.started` 运行也按未知结果处理。模型接口没有原请求结果重取契约，故不承诺恢复尚未持久化的原回复。取消、删除、deadline 与 ToolEffect 幂等边界不变。
- 停机立即停止后续领取，已开始的交付保留租约完成；30 秒 drain 未收敛则记录未完成职责并非零退出，PM2 留 35 秒窗口。

### 9. Scene

- Scene 由 Main Turn 权威持有。Scene v1 的持久形状由 Shared 唯一定义，Main execution snapshot / terminal、Chat、公开响应和语音快照复用同一 schema；`scene=null` 只允许 version 0，非空 Scene 的内外版本必须一致。
- 当前不运行任何 Scene 内容投影：终态提交只把 Scene 原样推进一版（`packages/chat/src/agent-runner.ts`），terminalEvidence 不带 `sceneProjection`。`packages/chat/src/scene.ts` 的投影逻辑没有生产调用方；`packages/chat/src/scene-light.ts`（单次 JSON Schema 增量投影，含前台礼让与失败软降级）仅有测试引用，未接入 commit 或 post-commit 路径。任何投影器须先通过质量资格验证，才能以 post-commit 异步方式接入；同步 commit 保持零阻塞。2026-11-26 用 `packages/chat/eval/companion` 的 scene 用例验证 `scene-light`（Inkling-2-Mini）：用例通过 7/12，字段准确率 75%，p50 约 2 s；地点/时间变化只识别 1/6，根因是模型回填当前值而非按约定返回 null，未达接入资格。
- Main 的终态接纳不只信任 Chat 或 TypeScript：新 sent 必须从匹配当前 attempt 的冻结 execution snapshot 恰好推进一版，failed/blocked/cancelled 完整保留该锚点；缺失、错 attempt 或损坏锚点拒绝。完全相同的已提交终态只重放 ACK，不再次推进，保留历史合法 null/0 终态的精确重放。该校验不改变 v1 数据格式，也不证明 Scene 自然语言内容已被正确理解。
- edit/regenerate 都回到被丢弃回复之前的 Scene 锚点，再由新回复推进一次（启用投影后为一次 delta），因此 Scene version 不因 attempt 增加而重复推进，也不保留旧回复产生的场景内容。

### 10. 可观测性与资格

- 本地 AgentRun event 文件只记录 content-free lifecycle/tool/failure 事实。每次物理模型请求（包括工具后的回复、被拒绝的摘要、媒体提取与正文、瞬时重试）独立进入 usage 和 modelRequests 证据；物理用量回执以纯数字保留在 AgentRun journal，失败也不丢弃；不能用 Pi 默认的数字 usage 把未知上游回执当成零。上游不报告 reasoning 子计数时保持未知，已报告的 completion 总数不重复加算推理。实际 provider 归属与每次物理请求用量必须可核验。 被 adapter 进程内重试取代、且未产生输出的物理请求保留自己的回执（未知仍为 null），并标记 `retried: true`；回复用量只汇总产出该回复的请求链。
- 媒体阶段失败日志记录所处阶段、已知的模型停止原因、已收到的 token 回执和回合剩余时间。
- Chat admission health 每个短 TTL 窗口重新检查文件、Redis、Pi/igrep pin 与唯一 Chat 模型 route；准入健康和完整认证共用已安装包的版本核验。完整 provider 请求、profile、工具、记忆重建和隔离证明属于显式运营认证。
- setup/check 核验精确包版本、公共 MemoryStorage API、CLI surface，以及无模型的真实 CLI 搜索、JSONL ID、UTF-8 分页及版本变化拒绝；它不能替代 full readiness。full readiness 另验真实 provider 与记忆生命周期；其本地检索用保留对话中的事实核验，不要求 system-only 事实出现在检索语料中。
- 运行认证执行空来源及带换行、Unicode、控制符图形和相对日期的非空来源重建，空工作区或单行 ASCII 成功不能证明 ingest 格式兼容；完整认证同时验证复制后的自身原文召回及双向跨关系隔离。
- 契约与原生工具循环回归、setup/check、readiness 都不替代同一 source revision 的真实运营、交付、恢复与计费旅程验证。

### 11. 版本、依赖与切换

- 现行版本：执行 composition 80（`packages/chat/src/agent-runtime/composition.ts`）；行为契约 / 产品提示版本 `companion-product-28`（`packages/shared/src/chat/companion-agent-prompt.ts`）；`@earendil-works/pi-ai`、`pi-durable`、`chord` 精确固定 `1.5.2`；igrep CLI 固定 `0.1.169`（`scripts/setup-pi-companion.mjs`）。readiness 核验契约版本。
- Main 与 Chat 在排空原写入者后以同一 source revision 切换。切换是单次切换：经 PM2 wrapper 停止接纳、等待有界 drain 并停止旧 Main/Chat 写者，隔离旧 AgentRun/workspace 文件，执行 migration，再从同一源码启动服务和浏览器版本；不混跑旧写者。隔离不做不可恢复删除；历史不可变 proposal 保留原字段并精确重放，旧执行轨迹不转成新 Pi 会话；已接纳 Job 和历史精确收据保留恢复能力。

## 二、决策日志

按日期升序。每条记录决策、证据和被取代的旧规则；现行规则见第一部分。

### 未注明日期的既有决策

- 群聊历史投影：此前所有 Character 都使用 `assistant`，长对话实测会诱导模型续写多角色剧本、编造本应检索的旧对白，因此改为第 7.2 节的按响应 Character 投影；"已回答"标注只放在本角色最后一条完整回复之后，避免末尾连续输入角色把旧问题重新解释为待办，也不把长期重复历史改造成带重复标记的新模式。
- 请求消息结构：背景与当前原文拆成两个 `user` 消息只证明 HTTP 请求投影；本机 oMLX 0.7.1rc1 在模板前合并连续同角色消息，不能把独立请求元素当成模型侧独立轮次。
- 线上 critic：“语义审查、一次改写、再次审查”的实验同时出现漏检和误拒，未成为可用的交付真值，不保留线上 critic 门禁。
- 检索完整性：新版 `search-api` 的证据包没有等价的机器可读 complete/degraded 状态，超时可能返回 exit 0 与文本 guidance，因此保留严格 CLI `search --strict`。

### 2026-09-09 MomentSpec 单 route 资格实验

单 route 资格实验没有证明来源绑定的结构化候选足以替代现有入口：即使 Main 提供消息索引，模型仍会混淆剧情更新、图片专属覆盖和冲突复述。决定不启用未经资格验证的必填 MomentSpec，不保留第二 route、运行开关或并行解析 implementation。

### 2026-10-04 Commit 中移除 Scene 投影

Chat 在 commit 中不再运行 Scene 投影：Scene 原样推进一版，terminalEvidence 不再带 `sceneProjection`。依据：72 轮实测只有 14 轮 applied，对抗用例 12/16 失败，却占 done 前时延约 45%，并曾把已生成回复拖到 180 s deadline 整轮失败。`packages/chat/src/scene.ts` 保留，待更便宜或更准确的投影器通过资格验证后再启用。

### 2026-10-17 执行内核改为 Pi/igrep

`@earendil-works/pi-ai`、`pi-durable`、`chord` 固定 `1.3.0`，igrep CLI 固定 `0.1.161`。Pi 负责单次运行的 model/tool loop、公共事件和上下文压缩，igrep 以 provider-neutral CLI 承接记忆与检索；删除 DSH/Cordis 服务注册、插件 bundle、peer 与 profile bootstrap。调研见 [Pi 运行时调研](../research/PI_RUNTIME_RESEARCH_2026-10-17.md)。

### 2026-10-23 隐藏推理与中断恢复收紧

- 按用户选择，Ornith 8-bit 普通 Companion 生成开启隐藏推理，取代此前全部关闭的策略；推理与正文共享总输出预算，不再把 Quick 的 256-token 回答设置误作二者的共享总预算。证据：强制提前闭合 thinking 曾将未结束的分析续文交付给用户，该做法继续禁止。
- 真实 SIGKILL 实验发现，无 proposal 时重跑同一 attempt 会再次调用模型，并丢失第一次请求的用量证据。因此收紧恢复规则为第 8 节的"请求意图先落盘、已发出请求无 proposal 即 `agent_run_interrupted`"。

### 2026-10-30 媒体状态与角色正文分离

开放媒体动作工具的 step 暂存正文；实际选择媒体动作后承诺文字不进入公开流；以用户原文和真实动作回执逐字提取独立要求，无独立要求时空正文加卡片即回复。此时的"有媒体工具的模型响应结束后才发布正文"规则于 2026-11-24 被意图感知流式取代。

### 2026-11-01 依赖升级

Pi 三包升级为 `1.4.0`，igrep 固定 `0.1.164`。文本快照改用 `IGREP_INDEX_LEVEL=none`，移除新版拒绝的 `IGREP_IMAGE_AUGMENTATION_MODE`，显式关闭未配置的 image embedding 路由；setup/check 增加无模型的真实 CLI 搜索、JSONL ID、UTF-8 分页及版本变化拒绝核验。

### 2026-11-14 Pi 1.5.2 与 composition 71

Pi 三包升级为 `1.5.2`（igrep 仍 `0.1.164`）。composition 71 合并同时更新的既有媒体重发解释规则，引入 `control.terminate` 结束媒体工具轮、工具调用 ID 不可复用、带标签 `onReport`、首 token 计时从意图落盘后开始与主动消息 UTC 推进（后者修复开启后提前领取或推迟下一周期），详见第 5.6、7.1、7.6、1 节。

### 2026-11-17 igrep 0.1.169 与 composition 73 / 74

igrep 升至 `0.1.169`，composition 73 收紧检索命中的阶段归属、预算与召回共用 Pi 截止点、媒体两阶段共享工具调用身份和用量回执；同日复盘 composition 74 限定首阶段检索文件只含保留历史，并把写入栅栏拒绝传回执行层。详见第 3、5.6、7.4、7.5 节。

### 2026-11-18 composition 75 与产品提示 26

库存优先与库存查询反馈规则见第 5.2、5.6 节。产品提示随后演进至现行 `companion-product-28`。

### 2026-11-24 第一性原理优化，composition 79

- 意图感知流式解耦：媒体工具暴露不再一刀切抑制普通文本流式，仅对媒体意图轮次缓冲，其余实时推送并以 `text_reset` 兜底。
- 纯媒体零二次 LLM 快路：新增 Chat 侧路由提示 `independentTextRequest`，满足单意图守卫且 Main 确认附件时跳过 `media_extraction`。
- KV 前缀缓存与多语种预算：8 条（4 轮）块对齐阶梯淘汰；脚本感知估算器修复中文长对话低估 4~6 倍触发 400 overflow 的问题。
- 并发与热路径：`ConcurrencyWaitQueue`、`InferencePriorityGate`、空记忆与寒暄跳过 `memory-search`、`DeltaCoalescer` 微批与 `STREAM_MAXLEN` 提升至 4000。
- 新增 `packages/chat/src/scene-light.ts` 作为异步 post-commit Scene 投影的候选实现。原文表述读起来像已接入；经 2026-11-26 核对，它只有测试引用，未接入生产，现行状态以第 9 节为准。

### 2026-11-26 恢复、记忆栅栏与热路径决策

证据来自同日 Chat/Agent 静态分析（本地 `.scratch/chat-agent-analysis-20261126/REPORT.md`，基于 HEAD `b559da959`；未做延迟实测）。以下规则自本日起为现行契约，已在分支 `chat-agent-improvements-20261126` 实施（composition 80）：

- 瞬时失败进程内重试一次（第 7.6 节）。证据：首 token 超时、传输错误、5xx 当时直接提交 failed，Chat 计算的 `retryable` 在 Main 无消费方，本地 oMLX 偶发卡顿时用户只能手动重新生成。仅对"无输出进度"的物理请求放开"关闭自动模型重试"，每次物理请求仍单独 journal，不违反"未知结果不重放"；Pi 自动重试保持关闭。
- 条件式破坏性重建（第 6.3 节）。证据：此前 regenerate/edit/删除无条件调度关系重建、新快照固定 `memoryEnabled=false`，重建完成前后续修订被 409 拒绝，用户感知为"重试后角色失忆""连点重新生成报错"；failed/cancelled/blocked 的 attempt 不可能已被投影。
- pending 接纳 TTL 180 秒 → failed `admission_expired`（第 1 节）。证据：dispatcher 没有最大次数或 TTL，`reclaimStalled` 只处理 `generating`；Chat 宕机时会话被锁、占用并发名额，恢复后才回答几小时前的消息，损坏快照无限重试。
- promote 栅栏收窄到关系级（第 6.2 节），修正旧文"网络等待不持用户锁"与"最终 promote 须在 Main user 行锁内确认"的冲突。证据：`b559da959` 的 `packages/main/src/server/modules/chat/companion-memory-authority.ts` 在 `SELECT … FROM users FOR UPDATE` 事务内 `fetch` Chat promote（HTTP 超时 15 s、事务超时 20 s），期间该用户的发送、终态提交、Stop、改偏好全部阻塞。旧文"网络等待不持用户锁"原指 Chat spool 写入，现明确为 Chat 用户级 fence 锁（第 6.4 节）。
- 媒体工具调用可携带逐字摘录，核验通过即跳过 `media_extraction`（第 5.6 节）。证据：媒体轮次最多串行三次 LLM 调用（工具选择 → 提取 → 正文），composition 79 快路只覆盖单句纯媒体请求。
- 会话读取分页，默认 50 个 Turn（第 2 节）。证据：`getChatSession` 曾 include 全部 Turn 的全部列（含 executionSnapshot）并逐附件富化，叠加生成期间 1.5 s 轮询。
- attempt 记忆副本使用 copy-on-write 克隆，`mem wake` 按 canonical version 缓存（第 6.5 节）。证据：`packages/chat/src/agent-runtime/workspace.ts` 每个 normal Turn 递归复制整份关系记忆，复制耗时随记忆规模线性增长；wake 只取决于不可变 canonical version。
- 文档修正：Scene 投影器未接入（第 9 节）。
- 回复版本（第 1 节），按用户选择实现完整版：可切换并选定为当前回复，限纯文字回复。
- 检索优先级（第 7.4 节）。证据：companion 质量评测（42 例，Inkling-2-Mini，单样本）中 7 例在事实已可见时仍调用检索，额外 1–3 轮请求，其中一例检索为空后否认 Soul 事实；加入指引后物理请求 57 → 52、多轮请求用例 11 → 8，通过数不变（39/42）。关闭文本线索的对照组多失败一个保存偏好的长度用例，线索暂保留，删除须以多样本评测为据。
- 删除 legacy 读取分支：无 deadline 的 generating watchdog、无 attempt 的编辑回执重放、attachmentAttempt 的 effect 回退读取。开发库计数为 0，另由 migration `20261126030000_backfill_legacy_chat_attempt_shapes` 把任何环境中残存的旧形状迁到新形状（generating 行的 deadline 回填为 updatedAt + 5 分钟，与旧回收时刻一致），删除不依赖单库计数；legacy 附件 id（81 行）、缺 effect.name 的图片（9 行）、旧 send 协议（598 个 Turn）仍有存量，保留。
- 同日复盘（独立代码审查）修正：重建挂起不再拒绝修订（原 409 使选回版本与连续重新生成在重建窗口内不可用）；重试取代的请求不再使回复用量为 null；快照仅确定性错误计入有界重试，瞬时数据库错误走普通退避；选回版本写 `selected` 指标修正；分页在最新页与已加载内容无重叠时改从最新页游标继续，避免历史空洞。characterStats 展示计数改为提交后尽力递增，失败会少计（有日志），`statsCountedAt` 仍是权威事实。
- 新增 `packages/chat/eval/companion` 质量评测（`bun run --filter @idream/chat eval:companion`）：用例走生产 `prepareCompanionTurn` → `CompanionEngine` 路径，确定性检查加 judge 标签、代码判定，结果绑定 source revision。
