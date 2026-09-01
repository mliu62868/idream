# Companion Chat PRD

## 1. 产品定义

Companion Chat 是 Main 产品中的角色陪伴会话。用户看到的是稳定的会话列表和 Turn；AgentRun、模型 trace、工具中间步骤不是产品对象。

### 1.1 所有角色共享的 Product Agent Contract

`SOUL.md` 只定义「这个角色是谁、如何表达」。所有角色共同的陪伴产品行为由版本化的 Product Agent Contract 定义，并在每个 `PreparedTurn` 中固定版本：

- 用户感受到的是主动、直接、在场的成人陪伴，而不是通用助手、客服流程或问卷。
- 先完成最新且明确的用户意图，再用 Soul 添加角色语气、情绪、调侃和场景推进。
- 角色张力可以改变表达，但不能把产品能力变成资格审查、交换条件、拖延或任意拒绝。
- 不默认用问题、选项菜单或复述把行动推回给用户；信息足够时做一个合理的角色内选择。
- 附件和工具状态拥有交付事实；角色文案必须与已经接受的产品动作一致。

唯一运行时层级为：

```text
Product Agent Contract（所有角色共同的陪伴行为）
  -> Runtime Authority（本 Turn 的能力与事实约束）
  -> immutable Character Soul（角色身份与表达）
  -> Turn State（opening / transcript / memory / Scene / time）
```

不得把共同产品行为复制进每个 Soul，也不得建立第二套角色 prompt 或 provider prompt。

## 2. 产品不变量

1. 一个 `Turn` = 一条 user message + 一条 selected final assistant reply。
2. 用户刷新、换设备或 Chat runner 重启后，消息列表由 Main PostgreSQL 恢复。
3. regenerate/edit 替换同一 Turn 的 assistant 结果，不展示内部候选分叉。
4. Chat runner 故障不能丢失已经提交的用户消息；该 Turn 显示可恢复的 pending/failed 状态。
5. Scene、Character content/release pin 与选中附件归属精确 Turn attempt；同一用户意图形成的必需产品动作跨 regenerate 复用同一计费效果并重绑当前 attempt。
6. Agent 执行完成只有在 Main 持久接受最终回复后才对用户成立。
7. 每个终态都能归因到精确 Product Agent Contract 版本和 Soul fingerprint。
8. 已接受的产品动作不能与最终角色文案相互矛盾；概率模型失败时仍保留动作并返回确定性真实文案。

## 3. 数据所有权

Main PostgreSQL 保存：

- ChatSession
- Turn 及 user/assistant wire message ID
- selected final reply、状态、模型/token 摘要
- Scene snapshot/version
- ChatTurnAttachment
- Generation、Delivery、DreamCoin reservation/settlement/refund
- 用户、Character、Soul/Release、entitlement、idempotency

Chat 本地文件保存：

- AgentRun immutable input
- execution events
- terminal commit evidence
- boundaries 与账号删除回执

DSH official igrep 保存通用 companion memory。产品不建立 Relationship 等级/分数状态。

## 4. 用户流程

### 4.1 建立会话

Main 根据用户可见性与 age≥18 规则读取 Character，固定 immutable content/release，创建或返回该用户与 Character 的唯一 active ChatSession，并保存 opening message snapshot。

### 4.2 发消息

Main 校验身份、会话、输入、每日额度和 `Idempotency-Key`，然后先写入 Turn。未通过输入规则时直接把该 Turn 终结为 blocked，不调用 Agent。

通过后 Main 把精确 snapshot 签名交给 Chat。snapshot 包含用户/Character authority、当前 user content、最近已提交 Turn、Scene、memory 模式和 attempt。

### 4.3 回复与恢复

Chat 本地保存 AgentRun 后执行 DSH。流式 token 只改善体验；最终内容通过 CAS 提交 Main。刷新页面总是读取 Main selected reply。

进程中断后，Chat worker 扫描“有 input、无 terminal”的 AgentRun 并恢复。旧 attempt 的晚到结果必须被 Main 拒绝。

### 4.4 编辑、再生成、取消、删除

- edit/regenerate 增加 attempt，并重置同一 assistant message 为 pending。
- 活跃生成时拒绝再次 edit/regenerate，避免两个 attempt 同时成为候选。
- cancel 先在 Main 把精确 attempt 终结为 cancelled，再通知 Chat/DSH 中止。
- 删除 Turn 或 Session 直接删除 Main 产品事实；Main 是列表权威。

## 5. 图片与视频生成

明确图片意图直接调用图片 ToolEffect，不反问资格。Soul 只决定表达，Main 决定产品动作和计费，Gen 决定 provider 执行。

计费语义：

- ToolEffect 被 Main 接受时创建幂等 Generation Request 并预留/扣减预算。
- 交付成功由 Main 既有 Generation terminal/delivery 流程结算。
- blocked/failed/cancelled 由同一流程释放或退款。
- 可复用的既有平台素材可按 0 成本返回。
- 禁止“provider 成功后再调用一个普通 hook 扣费”，因为超时和重试会产生未计费交付或重复扣费。

当前 Chat 产品只注册图片生成/编辑工具；没有对用户承诺未实现的聊天视频工具。未来增加 video 时复用同一 ToolEffectPort。

## 6. 消息展示

Main API 将每个 Turn 展平为：

1. user message；
2. selected assistant message；
3. assistant attachments（含 Main 校验后的 media URL）。

opening message 是 Session snapshot，不伪造成数据库 Turn。内部 tool call、provisional text、runtime trace 和未选候选不返回给用户。

## 7. 记忆

- `memoryEnabled=true` 使用 normal DSH/igrep workspace。
- no-memory 使用 private profile，不写入长期通用记忆。
- Main terminal ACK 是 memory commit gate。
- boundaries 为用户可控文件；删除账号时与 AgentRun、DSH workspace 一并清除。

## 8. 计量

- 文本免费额度按 Main 当天已提交的用户 Turn 计数。
- unlimited entitlement 由 Main 判断。
- voice 从 Main selected assistant reply 读取并走 Main voice 计费。
- image/video 使用 Generation Request → Attempt → Artifact → Delivery → Settlement。

## 9. 验收

- 相同 idempotency key + 相同内容只产生一个 Turn；不同内容冲突。
- Main 已写 Turn 后才有 AgentRun。
- Main terminal ACK 前没有 SSE `done` 或 memory commit。
- runner 重启能恢复不完整 AgentRun。
- regenerate 的旧 attempt 晚到不会覆盖新 attempt。
- 图片工具只建立一个 Generation Request；成功结算，失败退款。
- 明确图片动作成功后直接提交按用户 locale 选择的确定性确认文案；该路径不调用 Caption 模型，角色拒绝、讨价还价或 provider 超时不能覆盖已接受动作。
- 第一轮 `PreparedTurn` 包含 Session 从不可变 ContentVersion 固定的 opening message。
- `PreparedTurn.trace` 与 Main terminal evidence 均包含 Product Agent Contract 版本、最终 system prompt SHA-256 与 Soul fingerprint。
- Chat package 在依赖、源码、构建和运行环境中都不需要 PostgreSQL/Prisma。
- 账号删除会清除 Main 产品事实、Blob、AgentRun、boundaries 和 DSH workspace。
