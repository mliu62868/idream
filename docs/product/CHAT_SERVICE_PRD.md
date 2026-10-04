# Companion Chat PRD

更新日期：2026-10-04

本文定义完整 Chat 产品契约，关联 [PRD](PRD.md) CH-01–16。实现与运行资格见 [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md)，执行边界见 [ADR-21](../architecture/21-companion-chat-deep-runtime.md)，待办见 [剩余工作](REMAINING_WORK_EXECUTION_PLAN.md)。目标、已实施和已验证分别判断。

## 1. 用户承诺

用户得到的是与同一角色持续互动：最新意图被回应，角色身份稳定，获授权的历史、Scene 与记忆能够延续，接受的动作和费用可查证、可恢复。模型输出或 provider 成功只是链路中的一步。

| 用户任务 | 产品结果 | 需求 |
|---|---|---|
| 从角色卡开始或继续聊天 | 明确角色身份与开场，历史跨刷新/设备恢复 | CH-01–03、10 |
| 编辑、重生成、停止或删除 | 同一 Turn 的修订关系清楚，旧结果不覆盖新回复 | CH-05、06 |
| 控制记忆和互动方式 | Auto Memory、pins、instructions、互动设置与 profile 有来源、版本和删除边界 | CH-04、11、12、16 |
| 看见、编辑或听见角色 | 图片、视频与声音按各自已发布能力交付 | CH-06、07 |
| 群聊或双向通话 | 回复归属明确，记忆、权限、额度和中断恢复可靠 | CH-13、14 |
| 用麦克风写消息 | 转写成可编辑草稿，明确 Send 才形成 Turn | CH-15 |

### 共同产品行为

| 输入 | 职责 |
|---|---|
| Product Agent Contract | 所有角色共享的行为规则、动作与交付承诺 |
| Soul | 角色身份、背景和表达；不自行改变产品资格 |
| 已授权当轮事实 | Main 固定所有者、Character/Release、attempt、能力、预算、Scene 与已接受动作 |
| 历史与上下文 | 已提交对话、获授权记忆和用户控制帮助延续互动；引用与旧邀约不是新授权 |

角色应主动、直接地回应最新明确意图，用角色语气推进互动。信息足够时作合理选择，不能把能力变成问卷、交换条件、拖延或任意拒绝；事实不足时不编造用户偏好或共同经历。应保留开场、说话者与时间来源，让记忆在相关时自然出现。

Main 的权限、预算与交付事实限定能做什么；在此范围内，共同规则和最新明确意图优先于角色任性、旧剧情或召回建议。换场景不默认为永久身份变更。正文可以自然表达，但只能按实际状态说“已接受”“正在生成”或“已完成”。共同规则不复制到每个 Soul，prompt 组织由 [PreparedTurn](../../packages/chat/src/prepared-turn.ts)、[prompt 实现](../../packages/chat/src/prompt.ts) 与 ADR-21 承载。

## 2. 产品事实与所有权

- 普通 Turn 包含一条用户消息和一条 selected final assistant reply。opening 与 proactive 有显式来源；内部工具步骤、未选候选和 trace 不进入用户历史。
- Main PostgreSQL 持有 Session、Turn/attempt、Character/Release、Scene、附件、交付、额度和账务。刷新、跨设备与运行恢复都读取 Main。
- Chat 无数据库，在同一进程内嵌 DSH/official igrep，使用自托管 OpenAI-compatible 模型。本地 AgentRun 只保留执行和未决接纳证据，不形成第二套产品状态机。
- 回复完成以 Main 持久接纳为准；流式文本和 Agent 轨迹不是已保存历史，也不是记忆来源。每个终态能追溯到适用的 Contract、Soul 与实际模型请求。
- Scene、附件与角色版本固定到精确 attempt；同一意图的必需动作跨重生成复用原请求与计费效果，编辑改变意图则使旧动作身份失效。
- 套餐与 conversation profile 可以控制额度、速度和高成本能力，不能换掉角色人格或基础连续性。产品不建立 Relationship 等级/分数。
- 既定审核保持 `MODERATION_PROVIDER=mock` 的 `underage/minor/csam` 拦截与角色年龄 ≥18；聊天保留举报、账号与隐私边界。

## 3. 用户流程与恢复

| 动作 | 结果与边界 |
|---|---|
| 建立会话 | 校验当前访问/Serving 资格，继续 active 单聊或创建带固定开场的新会话，角色身份与内容版本明确 |
| 明确 Send | 用户消息先持久保存；同一幂等请求返回同一 Turn，不同内容冲突。输入阻断不调用 Agent |
| 等待回复 | 使用接受时的角色、历史、Scene、记忆与控制版本；可以流式阅读，Main 接纳后才显示完成 |
| 断网、刷新或重启 | 恢复同一 attempt 或给出明确失败；传输重连不新建回复，已失败/取消需显式重试 |
| 编辑或重生成 | 替换同一 Turn 的 selected reply；活跃回复时不并行创建候选。回到被替换回复之前的 Scene，再由新回复推进一次 |
| Stop | 绑定用户观察到的 attempt；Main 先接受取消，再终止执行，迟到命令不能取消新回复 |
| 删除或清除 | Main 历史与相关记忆来源失效，迟到回复、附件或投影不得使已删除内容复活 |

Main 负责 durable 接纳、租约、终态与超时回收；Chat 只重放未确定 ACK 的结果。具体恢复、来源栅栏与清理协议见 ADR-21。

Group Chat 支持 2–12 个角色和选择/`@` 应答。每个 Turn 固定应答角色，保留跨说话者身份与顺序；某角色的记忆、邀约和媒体不借给另一角色。单聊或整个群聊同时最多有一个可执行回复，较新的 blocked Turn 不能绕过旧回复。

主动消息由用户在单聊显式开启，默认关闭，当前节奏契约为 6–168 小时。等待用户回应时不重复发送，停用、权限撤销或删除后停止调度。它不消费用户主动发送额度，仍保留独立用量事实。

## 4. 记忆与用户控制

- Auto Memory 的长期记忆只从 Main committed Turn 异步投影；普通投影延迟不阻塞回复。用户能看到当轮模式，并暂停、纠正后重建或清除角色记忆。
- memory off 不读写长期通用记忆，并忽略依赖记忆的 pins；显式 Custom Instructions 仍生效。破坏性修订重建完成前，受影响新 attempt 不使用旧记忆。
- Pinned Memories、Custom Instructions、response length、scene generation、active messages、互动强度与 conversation-profile Catalog 分别版本化固定到 Turn，不静默改写 Soul、在途回复或历史。
- Profile 在执行前明示能力与成本，底层 provider/model 由服务端选择；用户控制、群聊角色和记忆有明确可见性、归属与跨账号隔离。
- Scene 保持人物、地点、衣着和叙事连续性。结构合法、版本推进和来源绑定不代替实际语义正确。
- 清除与账号删除同时处理 Main 来源、资产和 Chat 派生文件，撤销在途旧投影；执行/记忆清理按 ADR-21。

## 5. 媒体动作

| 能力 | 用户动作 | 交付契约 |
|---|---|---|
| 图片 / Image Edit | 描述时刻，或修改有权使用的图片 | Main 固定身份、Scene、source/reference 与生成请求，状态和结果回到原回复 |
| Chat Animate | 在已交付图片上描述运动并接受报价 | 独立 Chat video 与视频能力/权益检查，固定 source、原 Turn/attempt、route 与价格 |
| 自然语言视频动作 | 在对话中请求视频 | 必须单独发布 Chat capability 与 Product Action，不能由 Animate 或共享 renderer 推定可用 |
| Generate Video / GN-19 | 在 Generate 选择合格视频配方和序列控制 | 多 scene、时长、比例、质量档及可选 voice/audio 单独验收，不代替 Chat 视频 |
| Voice Clip | 对已完成回复明确 Play | 接受价格上限后合成，固定 selected reply/声音与账务，已交付声音可重播 |
| Mic / Voice Call | 草稿输入或双向通话 | 分别按 CH-15/14 接纳、恢复和计量，不能用单条 Clip 代替通话 |

图片的身份、编辑、反馈与质量见 [角色图片契约](CHARACTER_IMAGE_GENERATION_SYSTEM.md)；Clip、输入与 Call 见 [语音契约](VOICE_RELEASE_CHECKLIST.md)。明确且有权执行的图片意图直接形成动作，角色语气不能否认已接受动作或虚报完成。

角色应能在后续对话中延续自己已交付的图片，保持正确来源、状态与已知描述。生成 brief 只说明想生成什么，不能据此声称看见或验证了实际像素细节。

## 6. 费用与既有权益

- 消息额度由 Main 的原 Turn 产品日、预留与已消费事实决定；编辑、重试、取消和跨日修订不按点击次数重复计量。
- 图片/视频在接受时预留预算，Main 根据真实交付唯一结算或释放/退款。复用素材、重复请求与未知结果按接受条款处理，客户端不能推断费用。
- Voice 优先使用接受的计划分钟，再按 clip 兜底 Dreamcoin。价格、已购权益与退款规则见 [经济契约](ECONOMY_AND_PRICING.md)。
- 计划到期或能力关闭只影响新接纳；用户仍可按原访问权限阅读历史、播放和下载既有媒体。

## 7. 验收

1. 真实模型回应最新意图，身份、开场、时间与已知事实连续；不拒绝已接受动作、不编造用户事实、不泄露内部过程。
2. 同一请求、重连、接管和重生成不多建 Turn/动作或多扣费；旧 attempt、旧账号和权限撤销后的结果不回流。
3. Main 接纳前不显示最终完成；刷新/跨设备/重启后历史、选中回复、Scene 与附件恢复一致。
4. 记忆开关、纠正、清除、控制版本和群聊隔离在实际模型输入/输出中正确，不只证明 schema 合法。
5. 图片、编辑、Chat 视频、Generate 序列与声音分别证明真实交付、质量、持久化、下载、失败恢复和唯一结算。
6. Stop、删除、账号清理与计划到期保留正确权限、来源和既有权益；状态、错误与重试在移动端及键盘操作中可用。
7. 记录所测 source revision、实际模型/工作流、请求/attempt/产物、首字/完成耗时和用量；技术成功、语义/像素/听感质量、设备/语言及公开环境资格分别给结论。
