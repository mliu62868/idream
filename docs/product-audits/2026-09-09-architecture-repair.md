# 架构改进实施与验收 · 2026-09-09

## 结论与范围

本轮落实架构审计的八个候选，并继续追查 01、08 的底层失败。02–07 的确定性缺陷已修复；01 增加真实时间顺序与来源 ID 的无损传递，并修复工具 JSON 重采样、截断接纳、流式超时及 Scene 终态持久化权威缺口，语义方案仍未通过替换资格；08 已从单会话文件复制扩大到真实 PostgreSQL、多会话导出、维护与调度实测，修复导出及删除栅栏，并在保留官方恢复的前提下合并落盘写入。不能据此宣布角色场景保真、长期记忆质量或公开生产就绪。

改动基于 `e3bfe0f04ece35cab14a376c488c1f36e703ccfe`，保留 Main PostgreSQL 的产品与计费权威、无数据库 Chat 和独立 Gen。没有添加备用模型线路、功能开关或第二套长期实现。审核配置保持既定 mock，支付方案不变。本轮没有创建 commit、外部 issue 或公开发布。

## 八项结果

| 候选 | 实施结果 | 关键证据 / 限制 |
| --- | --- | --- |
| 01 场景事实 → 图片 | Main 接纳前检查完整方向预算；方向及必要身份不截断，可选传记/摄影描述让位。MomentSpec 记录 `direct_input`，编辑/删除同步清理。强制图片工具上下文改为带消息 ID 的跨说话者时间序列，不再按用户/角色分组而颠倒先后。 | 超长方向在附件、Job、扣费前拒绝；模型输入顺序回归先红后绿，预算测试使用真实 replay 来源。来源绑定语义原型仍未合格；完整原文不等于正确理解或像素保真。 |
| 02 Profile 私有状态 | 权威用户 ID 作为私有子树 key；焦点重验同步撤销权限，失败隐藏私有内容，同账号保留未保存草稿。所有私有请求绑定 owner header，并拦截旧账号异步结果、下载及导航。 | 挂载回归证明 A→B 切换、迟到列表、失败隐藏、同 A 草稿。数据库回归证明 A header+B cookie 被拒绝，包括写资料及退出登录；旧代码实际返回 200 并修改 B。 |
| 03 购买权益权威 | Main、Chat 配额/快照、Admin 用量及退款恢复统一读取已购 offer。批量读取避免 Admin N+1。独立授予和明确的无快照旧订阅保留；损坏快照拒绝，不退回现行 Plan。 | 已购权益与现价 Plan/缓存故意不同的真实数据库回归先红后绿；退款恢复不再被改价改变。 |
| 04 原请求恢复 | `useGenerationReceipts` 统一 owner、持久化、原 payload/key、同步 suspend/resume 及迟到 ACK 栅栏。Generate、Enhance、Chat Retry/Variation 使用同一生命周期；Chat 增加原请求显式核对区。 | 响应丢失后卸载/重挂仍用原键与原价；老 ACK 不能清掉新 owner 凭证。同事件 React 批处理 suspend→resume 已有专门回归。不会自动补发收费请求。 |
| 05 角色素材用途 | 生成 purpose 保留为真实来源和模板信息，最终 avatar/cover/gallery 放置不再要求生成用途相同；保留身份、来源、真实 Run、三张不同图及 Release 不可变校验。角色保存后的可选埋点失败不再把已提交保存报成 500。 | generated/bootstrap 跨位置轮换、历史 Release、篡改 sourceMeta/Run、埋点故障的回归均有覆盖；没有降低来源验证。 |
| 06 付费生成接纳 | Create、Retry、Variation、Enhance 收敛到现有 `generation-job-authority.ts`。入口只准备真实差异；幂等、余额、在飞上限、附件绑定、Job/扣费/事件/首 Attempt/outbox 在同一事务提交，提交后唤醒。 | PostgreSQL outbox 插入故障验证整笔回滚与同键再试；原有重放、重试上限、Chat 附件及增强集成断言保留。 |
| 07 Voice 价格同意 | 新增只读报价、签名 token 与明确确认；同意绑定用户、文本指纹、价格及分钟窗口。持久化 `billingAuthority`，DB 约束跨 attempt 不可更改。新报价包括零币也需确认；已交付重播不二次确认/计费。 | 覆盖未报价、过期、价格变化、分钟耗尽、取消、迟到报价和原请求恢复；真实 Pocket TTS 样本见下节。没有恢复自动预热。 |
| 08 记忆增长 | 从单会话文件实测扩展到真实 PG、多会话 NDJSON、官方 ingest、维护与检索。修复跨分页会话交错、破坏性变更未撤销 processing 普通投影。新增 64KiB 落盘缓冲，保留官方 ingest 恢复职责与原子 promote。 | 最新同输入 A/B 的 10k+2 完整投影为 13.41→13.11s，仅 2.28% 单样本变化；主成本是上游全历史扫描。跳过未变会话的 4.65s 实验仍已撤回。真实维护仅小样本，完整容量/首字 SLA 未通过。 |

主要实现分别位于 `ProfileWorkspace.tsx`、`useGenerationReceipts.ts`、`subscription-lifecycle.ts`、`generation-job-authority.ts`、`voice-clip.ts` 及现有角色素材权威模块；没有按审计标题另建 v2 实现。

## 继续实施：记忆增长与异步调度

真实 PostgreSQL 回归证明全局 `createdAt` 排序会把不同会话交错输出，违背 Chat 一次处理完整会话的 NDJSON 契约。改为 `sessionId → createdAt → id`，402 个交错 Turn / 804 条消息跨 200 行分页先红后绿。另在实际 prepare 已读取旧历史时执行 clear 或 destructive rebuild，旧代码仍调用 promote；现在两种操作都令 pending/processing 普通投影失效，沿用已有 user 行锁与最终发布状态检查，三项集成回归全部通过。

调度另有两层阻塞：outbox 在同一批次串行等待记忆，而 consumer 用同一在飞 Promise 阻止下一轮所有职责。现将 Main→Chat 显式划为 memory/lifecycle，并给产品事件、两个 Chat lane、Turn 接纳和 Blob 删除各自独立扫描；memory 50 + lifecycle 50 保留原 Chat 总批量 100。同 aggregate/lane 通过短事务领取锁与前序检查避免竞争者越序，远程调用仍在锁外，重试及 ACK 继续使用原 lease/CAS。真实 PG 回归要求旧 memory 持续阻塞期间，下一轮的新 Turn、cancel、purge、account deletion 都已投递；旧代码为 0/4，修复后通过。

关闭消费者使用同一 AbortSignal 停止后续任务，已开始交付不被假装取消或释放租约。正常关闭回归证明第一条 ACK 后第二条仍 pending/attempt 0；有界关闭回归证明 29,999ms 未结束、30,000ms 明确拒绝且保留原 processing/attempt/lease，晚 ACK 仍只能完成原 CAS。PM2 `main-event-consumer` 的等待窗口为 35 秒，避免先于应用 drain 强杀。账户删除沿用既有 Chat 持久 tombstone，正在 prepare 的旧候选无法在 user purge 后 promote。

增长实测保留全量投影实现：100 / 1,000 / 10,000 条消息，首次投影约 1.11 / 2.49 / 11.61 秒，新增两条后的投影约 1.05 / 2.65 / 13.38 秒。10k 仍导出约 14.03MB 编码 NDJSON，并调用四次官方 ingest（其中三次没有新增事件）。HTTP 边界是进程内 Request 适配，维护及完成时间戳在零模型基线中显式拦截；不是 TCP 吞吐、真实维护完成时间或生产 SLA。四个并发 attempt 的复制+空 wake 约 0.27–0.38 秒，也不是对话首字延迟。

曾通过复用未变 dialogue 把 10k 追加投影降至 4.65 秒，但审查发现官方 ingest 还修复原始 session 文件和 cursor；dialogue 完整、doctor 成功不能证明这些职责可跳过。快路径及专属测试已完整撤回。后续优化应进入官方 ingest 的重复扫描处，不在 Chat 复制越来越多上游私有恢复协议。

独立的最小真实维护样本：100 条短事实、两个会话，一次 maintain 5.507 秒，`Qwen3.5-4B-MLX-4bit` 两次调用、7,267 输入 / 31 输出 tokens，处理 100 行且 pending 归零；102 条的一次 fast recall 4.185 秒、6 hits，使用 harrier embedding（113 tokens）和 Qwen3 reranker（27,066 tokens）。这批发生在已撤回快路径的实验 revision，不能冒充最终源码性能。代理共转发四次 HTTP，第五次被硬预算阻止，整个 benchmark 非零退出；10k recall、真实首字与长期质量未测。没有扣产品币、充值或外部付费交易。

原件、各自 revision、命令与清理记录见 [记忆增长安全切片](../../.scratch/core-quality-20260907/memory-growth-safe-slice-20260909.md)。两种增长报告和真实模型报告均保留，不用后来的通过覆盖旧实验。受控 fixture、临时 workspace、计数代理及任务队列元数据已清理，专用测试库 seed 和证据保留。

## 真实 Voice 与浏览器（首轮证据）

受控开发库 `localhost:5433/idream_runtime_20260812`，专用 audit 用户 `cmttwydsd000278l7vunoxpft`，角色 `alexa-reeves`，会话 `45c2882c-f04a-4698-b2a8-990a56489d5a`。使用产品创建会话与已存在的短开场白，不额外调用 Chat 或 Gen。账号使用注册赠送的 250 测试币，并临时授予一小时语音访问；没有充值、购买订阅或第三方转账。

- 390px 浏览器展示 “up to 2 Dreamcoins”、余额与分钟优先规则。确认前 `VoiceClipRequest=0`、`VoiceUsageFact=0`；Cancel 关闭确认而不执行。
- 显式确认后：Pocket TTS / `alba`，system voice setting version 2；5,280ms WAV，253,484 字节，受保护 content GET 200。Main 请求从开始到持久化完成为 677ms，不当作浏览器端到端延迟。
- request：`voice_clip_request_bf70dc8cdacd7214ddee4430ebffc57f3e606978f1bd4f799b2964da980c2e79`，attempt 1；provider request：`voice:voice_clip_request_bf70dc8cdacd7214ddee4430ebffc57f3e606978f1bd4f799b2964da980c2e79:provider`。
- artifact：`media_voice_a5165dfe-658c-4d3b-9198-2947bddb122a`；唯一用量事实，扣费 2，余额 248，等于确认上限。刷新后 Play 返回原 artifact、HTTP 200，无价格二次确认。全量声音听感/角色表现不在这一短样本的结论内。
- 真实语音运行时版本：`idream-worktree-594126f5273b40ce558993867f86a20a28e4f1312978810e4d9e1b499aa7a3d6`。此后测试性能、E2E、文档及 Generate nullable scope 的显式类型守卫变化，不把旧语音请求改标为后续 revision。

浏览器原件保存在本机 `output/playwright/`，价格确认截图为 `.tmp/architecture-repair-20260909/voice-price-mobile.png`。最终测试、清理与源码指纹收据保存在本机 `.tmp/architecture-repair-20260909/evidence.json`，该文件不包含凭据。

真实 Profile 焦点重验后保留未保存名称，390px 下无横向溢出。审计会话通过产品 archive API 归档（200）；退出后登录 Session 为零，临时语音授予已移除，专用用户已暂停。保留唯一语音请求、用量、产物和两条账本事实，未删除历史证据或其它账号数据。

## 首轮验证口径

Main 默认集成/coverage 使用单独新建并按正常 setup 重建的 `idream_test_architecture_20260909`、Redis DB 15 与数据库派生前缀；同库串行。不是开发库，也不借用纯测试代替集成。

首轮完整 coverage 暴露了挂载测试存储 shim 不完整、旧长文本 fixture 超过新预算、扫描测试重复 AST 分析三类问题。分别补全每测试隔离的 Storage fixture、保持身份/场景断言并另测旧超长输入明确拒绝、缓存不可变源码/Prisma 写索引/字段分析。没有放宽 timeout、扫描集合、允许入口或覆盖率门槛。第二轮 3,229 条通过，仅余两项扫描超时；优化后独立 inventory 44/44，全部 689 个源码文件的 writer 集合不变。

最终 Main coverage：403 文件、3,232 项通过，保留原 2 文件/3 项跳过；statements 82.56%、branches 74.84%、functions 87.97%、lines 85.12%，四项门槛通过。根 `bun run check` 和最终 Main `check`（lint/typecheck/build）通过；Main 原有 14 条未使用导入 warning 未作任务外清理。Chat 249、Admin 1,162、Gen 301 项及 Shared 52 文件全量测试通过，PM2 契约 120 项通过。Gen 一项毫秒级计时测试在并发重负载下失败，独立定向及完整重跑均通过，未修改测试。

隔离 Chrome 最终单轮 8/8 通过（47.3s）：原键恢复/换账号/409 跨页三条、Voice 明确同意和刷新重播、Profile 资料/兑换/媒体、匿名隔离、子路由以及退出/完整删除流程。故障/配额回归使用受控 provider，不能冒充真实生成；上节 Pocket 是独立真实验证。第一轮账号删除用例因完整导航导致 Chromium 回收 response body 而失败；改为透明捕获真实 server response 后原样交付，保留 receipt、导航、状态和数据库删除流程的全部断言。继续执行发现真实 “Back to login” 缺陷：同路径 Next Link 改变 history 不触发原生 hash subscriber，回执页不退出。该账号边界改用正常文档导航，保持链接和键盘行为，不拦截路由或修改全局 History。浏览器最终源码归属见本地收据；这 8 条不是全平台 Chrome 认证。

开发库已通过正常 `db:migrate:deploy` 应用 `20260909090500_voice_clip_billing_authority`，迁移 authority 检查 83/83；标准 PM2 wrapper 的 drain、重启与 readiness 已完成。没有生产数据库操作、任务外数据清理或规避 ownership 拒绝。

## 继续实施的验证与隔离

继续实施后，Chat 全量 27 文件 / 250 项、typecheck/build 和根 `bun run check` 通过；PM2 契约增为 121/121。所有生产改动的 SHA-256 已保存，后续测试隔离修正未改变这七个生产文件。没有新增 migration，也未重跑不受本次改动影响的浏览器、Voice 或 Gen 旅程；首轮证据保留原版本归属。

继续实施的第一次 Main 全量覆盖为 404 文件 / 3,240 项通过，另有两项 metrics/query 失败。原因是新增消费者测试启动了独立指标刷新，留下 registry/snapshot，改变另一个测试“尚未发布”的初始状态。临时 sequencer 强制消费者先于 query，精确复现同两项失败；随后仅在新增调度测试隔离已有的 `startMetricSnapshotRefresh` seam，五类真实 dispatcher 和关闭断言保留，原 query 断言不改，同顺序 11/11 通过。指标刷新本身仍由已有生命周期、重试与物化测试验证；测试自身还精确清理其 prefix 的 outbox 和孤立记忆 authority。

最终 Main coverage 单轮为 **405 文件 / 3,242 项通过**，3 文件 / 4 项跳过（包含显式 opt-in 的真实增长 benchmark），298.24 秒；statements 82.56%、branches 74.88%、functions 87.97%、lines 85.13%，全部门槛通过。隔离修正后的 Main typecheck、定向 lint、diff 与文档链接检查也通过。测试库沿用 `localhost:5433/idream_test_architecture_20260909` 和 Redis DB 15 的独立数据库派生前缀，同库串行；开发库和生产库没有被该测试重建。

详细测试、生产文件指纹、各阶段 source revision 与最终运行时收据位于本机 `.tmp/architecture-continuation-20260909/evidence.json`；不把失败实验改写为成功，也不将不同 revision 的模型/性能样本合并认证。

## 第三轮：工具终态、真实流进度与有界落盘

正式 adapter 原来在第一响应遗漏 native tool call 时无条件再请求，即使响应已是完整合法的同名工具参数 JSON，也先丢弃；第二响应则会把 `finish_reason=length` 的可解析 JSON 当成动作。两个首响应计数回归和一个截断回归先红后绿：现在第一候选也经过原 `parseImageAgentToolCall` 校验，仅 `stop`、无 native tool 混入的完成参数可转换，保留最多一次兼容重试、provider 归属和总 token 用量。补充额外说明、错误工具包装、未知参数、缺参数和混合工具的拒绝回归；没有扩大 schema 或授权范围。

原流式 idle 在每个网络字节到达时重置，造成两种相反问题：首 token 前的 role metadata 可能提前触发较短 idle，首 token 后连续心跳又使已停滞模型不超时。三个确定性反例先失败；改为真实文本、推理或工具名称/参数输出才进入并续期 idle。文本、推理和工具参数持续推进、总时长超过首字窗口的三个正对照也通过；body 取消、悬挂 cancel、外部 AbortSignal 和输出字节上限仍保留。没有添加固定 completion 墙钟。

在当前唯一 Ornith route、原 1024 输出预算与 0.9 采样下，新增四次正式流式 adapter 调用，仅使用保存的受控 PreparedTurn 输入，没有执行 Main 工具或 Gen：

| 系统输入 | 显式晴天右移 | 用户事实与角色错误复述冲突 |
| --- | --- | --- |
| 当前生产 system / formatter | 3.111s，165 输出 tokens；晴天正确，但遗漏笔记本相对杯子的右侧，混入年龄、眼睛、头发 | 2.911s，163 tokens；雨夜与 warm dusk 混合，遗漏左右关系并混入固定外貌 |
| 只把 system 换为短的非角色扮演视觉指令（实验） | 2.414s，149 tokens；右侧/闭合/平放正确，但仍添加 young woman 等身份限定 | 2.300s，128 tokens；左侧正确，但仍同时雨夜与 warm dusk |

四次均正常 native tool 结束，合计 6,606 输入 / 605 输出 tokens；provider response 分别为 `chatcmpl-cf262ac1`、`chatcmpl-ebc33d8f`、`chatcmpl-ca643ca4`、`chatcmpl-7ac7f0c3`。协议成功不等于语义成功，且这组保存输入的 state 没有 Scene 字段，不能冒称完整持久 Scene 链认证。短 system 候选未进入生产，停止追加该方案模型请求；新样本没有支持“仅增加输出预算即可修复”的假设。每份原件在 `.tmp/architecture-continuation-20260909/formal-stream-*.json` 保留 raw SSE、请求正文、用量、实际生产文件 SHA 与当时 revision；后续 idle 修复不改标这些模型样本的版本。

另用生产 `sceneForReply` 离线确认：图片 only、条件假设和已否认地点仍可污染持续 Scene；人物离场无法由当前 append-only delta 表达。小的、同 route、非角色扮演 Scene interpretation 仅形成实验设计，尚未执行或接入。它需区分完整 story/image 状态、显式清除、来源不足与旧无来源 Scene；新增一次解释的延迟和失败行为不能隐藏。当前没有通过删 Scene、堆地点词库或拒绝所有图片来假装修复。

记忆方面，官方 `igrep 0.1.137` 没有公开多会话 batch/manifest ingest 入口。10k corpus 的单会话无变更 ingest 为 2.422s；cProfile 的 2.489s 中，约 2.170s / 87.2% 是全 dialogue 的 secret-shield 正则扫描。这是具体依赖内部成本，不是 workspace copy；没有绕过秘密保护、恢复检查或在项目里复制其私有状态协议。

项目内修复只把 transcript 的逐片段 `write` 改为固定 64KiB 缓冲；每会话 fsync 前完全写出，处理短写、零进度、I/O 失败和中途断流。512 条原为 1,536 次写入，原代码在有界次数断言下失败；新实现同时验证完整内容、跨 chunk Unicode、会话隔离、0600 权限及失败候选清理。相同 PG/官方 CLI 的六阶段 A/B 中，逐会话 SHA-256、NDJSON 字节与最终内容全部一致。10,002 条的导出+stage 为 801.53→389.74ms（51.4%），但完整投影仅 13.41252→13.10707s（2.28%，单样本而非容量保证）；仍有四次官方 ingest、`newEvents=[2,0,0,0]`。主瓶颈没有被这个局部优化消除。原件见 [ingest 剖析](../../.scratch/core-quality-20260907/igrep-ingest-profile-20260909.json)、[旧写法 A/B](../../.scratch/core-quality-20260907/memory-pg-growth-unbuffered-ab-20260909.json) 与 [缓冲 A/B](../../.scratch/core-quality-20260907/memory-pg-growth-buffered-ab-20260909.json)。

本轮 Chat 全量 28 文件 / 270 项、typecheck/build 和根 `bun run check` 已通过；Main 原 14 条、Admin 原 6 条 lint warning 不变。隔离 PG 的三个导出/破坏性栅栏回归及零模型完整 benchmark 通过；独立审查复跑 adapter 36 项和 8 个内存流反例通过。Main 生产源码未新增改动，未重跑上一轮全量 coverage 或不受影响的浏览器/Voice/Gen；原 3,242 项证据保留原 revision。没有新 migration、产品扣币、充值或公开发布。详细收据追加到本机 `.tmp/architecture-continuation-20260909/evidence-round3.json`，不覆盖上一轮结果。

## 第四轮：Scene 权威合同与解释器资格

持续 Scene 的生产函数再次复现三类失败：显式晴天更新后仍保留今晚、图片 only 地点写入后续剧情、离场人物留在 participants。独立检查还发现 Shared 对 Scene 使用 `unknown`、Main 直接保存 Chat 传入版本；真实 PostgreSQL 接受了 `sceneVersion=999 / scene=null`，并把该回复选为已发送。这是持久权威缺口，不依赖模型能力判断。

现将既有七字段 v1 Scene 收敛到 Shared 的同一 schema，Chat、Main 公开响应和语音快照复用，不新增格式或 migration。内外 version 必须一致，null Scene 仅可配 version 0。Main 在原 user→session 锁及 terminal CAS 内，验证当前 attempt 的冻结 execution snapshot：新 sent 恰好 +1，failed/blocked/cancelled 原样继承全部 Scene，不能只保留版本而篡改地点。精确历史 ACK 不再推进；edit/regenerate 从丢弃回复之前的锚点重算。测试覆盖跳版、回退、不推进、失败改值、活动行漂移、缺失/错误锚点、重复 ACK 及两种修订；旧合成 sent/null0 fixture 改为正式 runner 的 anchor+1，不削弱用量、权限和工具效果断言。

Scene interpretation 另做了 7 次有界隔离调用，同一 Ornith route、1024 输出预算，无 Main 写入或 Gen。先比较完整快照与局部变更接口，再隔离 native 解析、普通 JSON 和现有低温结构化采样；没有按结果修改 fixture 预期或重复抽样挑成功。合计 13,543 输入 / 2,189 输出 tokens，逐调用耗时合计 32.725 秒，不是端到端延迟或容量指标。已知最前两例未过，故没有消费后续三例与三个未见例，也不接入额外终态模型调用。

一个重要归因修正：安装版 `mlx_lm` Qwen parser 只读取顶层 `type`，`anyOf: [array/object, null]` 的合法 XML 参数会静默变为字符串，oMLX native 不抛错就不会进入能正确解析的 fallback。直接运行安装函数、同一 XML 的四组对照已证明该路径，未改安装文件。历史 raw SSE 已是服务端解析后结果，不能倒推原 XML 或把全部类型问题归咎模型。明确非 nullable 顶层类型后，真实 native schema 通过，但仍有旧左侧与新右侧并存；只把 temperature 0.9 改为现有 structured 0.2，模型把海边/晴天/右侧塞进 framing 而不替换旧事实，仍不合格。普通 JSON 对照复写 schema 后触及 1024 上限，没有最终候选，不计为语义判负。

因此本轮上线范围仅为确定性的 v1 权威合同；完整快照、局部变更和 JSON 解释器都保留为明确标记的隔离实验。没有增加备用模型、必填候选、静默字符串修补、清空 Scene 或拒绝所有图片。来源索引或继承 lineage 仍不能充当新事实已被证明的证据。逐请求原件、协议/语义分项与离线 parser 复现见 [第四轮资格审查](../../.scratch/core-quality-20260907/scene-qualification-round4-20260909.md)。

本轮最终 Main coverage 单轮 **406 文件 / 3,254 项通过**，原有 3 文件 / 4 项跳过，302.15 秒；statements 82.57%、branches 74.93%、functions 87.97%、lines 85.14%，四项门槛全部通过。使用 `localhost:5433/idream_test_architecture_20260909`、Redis DB 15 和独立数据库派生前缀，执行前确认目标隔离，同库串行。Chat 全量 **28 文件 / 271 项**、Shared 全量 **52 文件 / 374 项**、根 `bun run check` 均通过；Main 原 14 条、Admin 原 6 条 lint warning 保持不变。独立窄审查未发现本轮五个生产文件的具体回归；另有实际 PG 的 Scene 12 项和既有 Voice Scene 数据库兼容 5 项定向验证通过。

本轮没有新增 migration 或语义生产调用，也未重跑浏览器、实际 Voice/Gen 和不受影响的 PM2 拓扑契约；它们的前轮证据保留原 revision，不与当前状态合同测试混成新的端到端认证。受控重启、最终源码指纹、逐请求用量及精确测试清理记录追加在本机 `.tmp/architecture-continuation-20260909/evidence-round4.json`，不覆盖前轮收据。

## 仍未通过的质量与下一步

当前唯一 Chat 自托管模型 `Ornith-1.5-35B-A3B-Abliterated-MLX-4bit` 首轮进行了 13 次有界本地请求。复核后必须区分失败类型：3 次 thinking 输出在 1024 token 上限前尚未形成候选，不具语义判负资格；关闭 thinking 后的 3 次有 JSON，但原实验脚本只识别 native tool call。完整原型也未同步修改旧 JSON 兼容解析器，合法新协议会被旧解析器拒绝。这些协议/测量缺陷不能归咎于模型；已保存最终 native/JSON 候选中仍有 dusk/night 混合、显式右移后沿用左侧等独立语义错误，故不改标为合格。

继续只改变单个条件的 4 次模型级实验，没有执行工具、写业务数据或调用 Gen：移除 tools/tool_choice 的 2 次仍有左右矛盾或黄昏/雨夜混合；保留 thinking 并把输出预算从 1024 提到 4096 的晴天右移例，在 30.268 秒、3176 输出 token 后得到正确核心场景；另一个漂移例由实验脚本在 60.001 秒截断，最终正文与用量未知，不能判为语义失败。实际运行 oMLX app 0.6.4 的非流式实现会先发 HTTP 200 和空格 keepalive，因此 HTTP 200 也不能当作完成证据。完整记录在 `.tmp/architecture-continuation-20260909/`，每份保留当时 source revision；这不是修改后正式 formatter 的真实模型验收。

结论是“现行 1024 预算及候选协议尚未取得资格”，不是“模型绝无此能力”。后续诊断继续使用流进度和首 token/空闲界限，独立验证语义能力、延迟预算与未见例；不盲目继续加预算、堆提示或再发图片。前两轮 17 次、第三轮 4 次、第四轮 7 次场景模型请求各自保留不同协议与 revision，不合并成同构成功率；这些资格实验保持零 Gen 消费，记忆模型调用另列。

后续需取得能通过已知失败类型及未见例的自托管语义能力，再验证实际图片。igrep 上游 profile/Forget 授权、精确标签与像素局部编辑质量仍按原事项继续；本轮没有用提示堆叠或替换记忆算法宣称关闭。实验与完整记忆增长表见 [安全切片与实测](../../.scratch/core-quality-20260907/scene-and-memory-safe-slice-20260909.md)。
