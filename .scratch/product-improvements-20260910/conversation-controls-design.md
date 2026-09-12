# 对话控制：只读设计与未满足项

日期：2026-09-10。基线：`9ce5e5da3362dc397eb73b7f72a621141740fd4b` 加当前审计工作区。

本文件记录后续实施边界，不签发主动互动或完整 Conversation Profile 已完成。当前先收口群聊、媒体和漫画交付及真实验证；不并发修改 Main / Chat 权威，不新增空 Catalog 框架，也不发布五个未经验证的任务标签。

## 已实现与未满足项

| 能力 | 当前证据 | 尚未满足 |
| --- | --- | --- |
| 群聊 | 2–12 名固定成员、指定回复者、Main Turn 顺序与幂等、成员记忆边界已有实现；相关数据库和 mounted 测试通过。详见 [群聊契约](../product-audit-20260910/group-chat-contract.md)。 | 两成员真实模型交付、12 人 Chrome 操作及新媒体消息归属由主任务统一验收；测试通过不能代替 provider、持久化和额度证据。 |
| 基础表达偏好 | 既有 response length、interaction intensity、scene generation，按会话版本冻结到 Turn。 | 不能把这三个控件改名后当作完整 Conversation Profile。真实遵从验证仍以本轮主任务报告为准。 |
| 主动消息 | 只有需求，没有独立用户同意、到期调度或主动 Turn 来源契约。 | 开启、关闭、频率、静默、幂等、撤销同意、计费与真实交付均未完成。 |
| Conversation Profile | 只有既有表达偏好和服务器 Chat model 配置，没有独立任务 Catalog。 | 五档任务差异、资格/费用、版本 pin、报价及真实样本未完成。 |
| Coin | 报价快照、旧 invoice 重放、provider 确认及一次入账、owner 绑定已有实现。 | 正常已完成 coin 购买的退款/冲正权威未完成；真实支付依赖另行授权的商业规则和 provider 环境。 |

需求依据：[PRD CH-08/12/15](../../docs/product/PRD.md)、[对话控制事项](../product-audit-20260910/issues/02-complete-conversation-controls.md)。

## 主动消息的最小可落地边界

建议首版限定站内文本、默认关闭。用户显式开启某个会话后，Main 在约定频率与静默条件下接受一个主动 Turn。是否同时覆盖群聊须明确；若覆盖，用户必须选择一个合格成员作为主动发言者，不能把一次开启展开为全部成员的模型请求。

Main 负责调度与产品事实。Chat 只执行已接受的不可变快照，继续禁止 scheduler；不把调度器添加到 DSH 的工具面。可复用 `packages/main/src/processes/event-consumer.ts` 的独立 reconciliation lane 和既有 `chat_admission`，无需创建另一套后台执行框架。

### 1. 明确发起者，不能伪造用户发言

当前 `ChatTurn` 固定含一条用户消息和一条助手回复；`beginChatTurn` 要求非空用户内容，Shared snapshot、Chat context 及历史/igrep 投影也假设这一结构。主动消息不能通过填入“请主动跟我说话”并隐藏气泡实现，否则会把调度意图当成用户陈述和授权。

需要明确的判别契约：

- `trigger.kind = user_message | proactive`。
- 主动事件固定 `consentId`、`consentVersion`、`scheduleEventId` 和 `scheduledFor`。
- 主动 Turn 的用户消息字段为空，不产生可见或可被记忆提取器当作用户发言的消息；助手消息明确标记“主动消息”。
- 公共历史、Shared execution snapshot、Chat context、重试、删除、Scene 与 igrep 输入按该判别处理。历史 v1 快照保留原解析和 pin，不从今天的 consent 或新设置回填旧快照；新主动快照采用明确的新版本或等价可判别契约。
- 调度触发只能提供系统来源的目的和时间，不能构成用户对图片、视频或语音付费动作的请求。首版主动 Turn 只允许文本；未获用户指令不得把“主动关心”升级为付费媒体。
- 主动助手消息的可见事实可进入关系历史，但不能被提升成用户断言。关闭后被拒绝的迟到结果不显示，也不进入记忆。

### 2. 持久同意与唯一事件

最少需要两个明确的数据概念，不借用当前通用 `notificationSettings` JSON 里的营销邮件开关：

- 会话级主动消息设置：`enabled`、单调 `version`、IANA `timezone`、静默起止本地时间、频率、`nextDueAt`；如有群聊，额外固定主动成员。
- 到期事件：唯一键 `(consentId, consentVersion, scheduledFor)`，关联唯一 Turn，并保留取消或跳过原因。它是 scheduler 的幂等权威，不是另一份消息账本。

扫描器只发现到期项。接受操作在 User → Group（若有）→ Session 的同一锁序下重新检查：当前同意与版本、用户/角色/会话有效性、权限和记忆删除边界、静默窗口、最后一次真实用户发言、活动 Turn、当前额度。确认后在一个事务内记录事件、创建 canonical Turn 和对应 UsageFact，再通过既有 admission 分发。

并发扫描、进程重启或网络超时只能重新处理同一事件/Turn，不能新增一次回复或重复扣减。会话被用户占用、额度不足、同意已撤销等情况记录为跳过或明确延后，不能不断重试并最终集中补发。

### 3. 关闭与迟到执行的竞态

停用操作先在同一用户锁内递增同意版本，再取消未交付的主动 Turn，写入既有 durable cancellation fence / outbox。关闭响应确认后，不允许旧版本产生新的可见主动回复。

仅在扫描时检查一次不够：admission 前及 terminal commit 时都需核对当前同意版本与取消状态。这样才能处理已 claim、正在 HTTP admission、模型已运行但尚未提交等窗口。Chat 收到取消后应停止执行；即使即时取消失败，Main 的 terminal fence 仍拒绝迟到结果及记忆摄入。已交付的历史不因关闭自动删除。

会话归档/删除、角色记忆清除、账号停用/删除也需要撤销相关同意与未交付事件，不能在下次扫描重新创建。

### 4. 静默时间与额度

- 静默规则按 IANA 时区的本地时间计算，再保存下个 UTC 执行时间；覆盖跨午夜、夏令时缺失与重复时段、时区变更。
- 用户修改时区或频率递增版本，旧事件失效。机器重启或静默窗口结束不补发所有漏过的时点，只安排下一个有效时点。
- 当前消息额度以 UTC 产品日的 `ChatTurnUsageFact` 计数，付费 unlimited entitlement 另有判断；一次已接受 Turn 的使用事实在删历史后仍保留。
- 最小一致方案是主动 Turn 也经过同一 `assertChatQuota`，一次接受仅占一次普通消息额度，另有用户可见的主动频率上限。额度不足跳过，不静默改为扣 Dreamcoin、买计划或产生付费媒体。
- 是否采用上述计数规则、关闭时对已接受但未交付 Turn 是否归还 allowance，必须进入明确的产品契约。不能通过删除 UsageFact 临时解决，因为这会破坏现有隐私删除与额度不退款的不变量。

## Conversation Profile 的最小权威设计

Profile 必须表达用户正在执行的任务及可验证结果，独立于长度、语气强度和 Scene direction。底层继续使用服务器选择的同一 Chat model，保持角色 Soul 和基础关系记忆；不能用模型名称或不同基础记忆质量包装成同一角色的五档品质。

在任务定义被确认后，可建立最少的不可变发布对象 `ConversationProfileRevision`：

- 稳定 `profileKey`、`version`、draft/published/retired 状态和用户可读说明。
- `taskKind`、严格的任务输入/输出契约、可验证的验收样本。
- prompt/compiler hash、执行预算及允许的 Product Actions。基础权限始终由 Main 的实际资格约束，不因 Profile 提权。
- 资格、明确报价、扣费时点、失败/取消/重试规则及整体 fingerprint。
- 会话保存所选 revision 与 selection version；三个既有表达控件仍是独立 overrides。

发送前由 Main 报价。在接受 Turn 的同一用户锁下验证 Profile、selection version、quote、资格和余额，并冻结 Profile revision、任务输入、编译版本和价格。若新 Profile 按次收费，要先扩展 canonical ledger 的专用 Chat 计费意图和唯一 settlement linkage，不能借用生成任务收费或把每次模型调用算成一个新购买。

旧 Turn 的重试/重生成沿用已接受 pin，不能读取最新 Catalog 或因改价再次收费。实际 provider/model 记入执行证据；服务器模型配置变更如何处理旧执行，须沿用明确的运行时版本契约，不让前端提交模型名。

Chat 只根据固定任务契约编译本次运行。若任务承诺某个结构化产物或步骤，则必须有实际输出和验证，不能仅改变 max tokens、temperature 或现有三个控件就宣称是独立档位。

### 五档基线的证据限制

[2026-09-01 本地对标记录](../../docs/research/OURDREAM_PRODUCT_PARITY_SNAPSHOT_2026-09-01.md) 记录的五个名称为 Balanced、Muse、Genius、Muse Genius、Mastermind，以及部分档位按回复计币。这是官方公开营销正文的历史观察，没有完成逐档实际任务语义、切换与计费测试。

因此当前不能凭名称填出五份任务契约，也不能签发 `matched`。后续需要产品决定每档用户任务和验收样本，并逐项记录 `matched`、`equivalent` 或明确的 `intentional_divergence`。没有定义与真实样本时，不创建只有名称的可选 Catalog，也不把技术能力草案发布成五档完成状态。

## 必需产品输入与验收

需要明确的产品输入：

1. 主动消息的渠道、适用范围及群聊 speaker 规则，频率上限、静默默认值、是否占普通消息额度，以及关闭/失败时的额度规则。
2. 五档实际用户任务、差异、示例与对标映射；每档资格、报价和扣费/失败/取消/重试规则。

可独立先做的技术决策包括默认关闭、显式同意版本、IANA 时区、Main 幂等权威、未知结果保留、取消 fence 和无积压补发；这些不能代替产品费用或五档任务定义。

最低验证应覆盖：

- 主动消息：两个扫描器争抢、重启重放、claim/admission/commit 三阶段关闭竞态、跨午夜和 DST、额度耗尽、已有用户 Turn、记忆清除与账号删除；再用一次真实模型主动回复证明历史来源、持久化、用量和关闭后不再交付。
- Profile：篡改与过期 quote、资格变更、改价或下线后的旧 Turn 重试、并发扣费与终态重放；以相同 Soul、关系事实和用户情境做各档真实样本，证明承诺差异，且不改写人物、用户动作或基础记忆。
- 每份真实证据记录同一 source revision、profile/consent version、Turn/request/attempt、provider/model、耗时、交付和额度；mock 与 mounted 结果不能替代。

## Coin 只读审查结论

本轮未发现可证明的新增金额、原 invoice 重放、并发入账、资格或 owner/未知回执缺陷。此结论来自当前源代码和现有回归用例审查，没有另行运行数据库或 provider 测试。

必须保留的未满足项是正常已完成 coin 购买的退款/冲正：

- `packages/main/src/server/modules/billing/coin-offers.ts` 只负责 provider 确认后的 `topup`。
- `packages/main/src/server/modules/billing/ledger.ts` 新增的业务意图只有 `topup`，没有 coin refund/reversal/restore。
- `billing-checkout.ts` 的 `refund.updated` 路径进入 Subscription 专用 evidence/projector，不能处理无 Subscription 的 coin checkout。
- Admin 的通用 `checkout-reconciliation.ts` 只确认“已放弃且迟到结算”的未发放购买退款，不能替代已入账 Dreamcoin 的退款、已消费余额处理或退款取消恢复。

商业规则与这一权威流程未补齐前，[Coin 事项](../product-audit-20260910/issues/05-coin-store.md) 的退款退出条件继续未满足；不得用 Admin 手工加减币或订阅退款测试关闭。
