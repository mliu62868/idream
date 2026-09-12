# 完整产品与公开运营阻塞事项

这些事项来自 [本次源码审计](/Users/kk/code/idream/.scratch/product-audit-20260910/product-scope.md)，基线 `9ce5e5da3362dc397eb73b7f72a621141740fd4b`。这是本地待办，不代表本次已完成实现或运行验收。领取前核对当前代码及主任务结果；已经修复的部分追加验证结果，不重复实施。

| 事项 | 优先级 / 状态 | 覆盖原审计差距 |
| --- | --- | --- |
| [01 Chat → Generate 准确接续](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/01-chat-generation-continuity.md) | P0 / ready-for-agent | 1：Scene、版本、brief、源图未随跳转接续 |
| [02 完成多角色与主动互动控制](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/02-complete-conversation-controls.md) | P1 / ready-for-agent | 3：Group Chat；6：主动消息与 conversation profiles；已有 Scene/偏好真实遵从 |
| [03 完成聊天视频与双向通话](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/03-chat-video-and-voice-calls.md) | P1 / needs-info | 4：Voice Call；5：Chat Video。Chat Video 可先独立实施，通话的发布费率/额度契约尚缺 |
| [04 补全生成参数并校准升级承诺](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/04-generation-controls-and-entitlement-copy.md) | P1 / ready-for-agent | 7：seed/模型/批量/视频参数；CR-11 Create/Voice 与 Preset 运行目录/语义等价；8 的 P2 升级文案已修复 |
| [05 独立 Coin Store](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/05-coin-store.md) | P1 / needs-info | 2：独立充值。缺正式 offer 商品/价币值与 refund 规则 |
| [06 创作者作品、Packs/Comics 与收益](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/06-creator-works-and-economy.md) | P1 / needs-info | 9：Creator levels/Studio/收益；10：Packs/Comics；SE-01～07 公开内容族/库存/有效供给。缺作品购买权利、等级和收益规则，公开内容可先行 |
| [07 Affiliate 归因与结算](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/07-affiliate-attribution-and-settlement.md) | P1 / needs-info | 11：商业联盟。缺正式资格/归因/佣金/结算条件 |
| [08 公开生产认证](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/08-public-production-certification.md) | P0 / needs-info | 生产域名/环境/provider/真实支付/对象存储/恢复与观察窗认证 |
| [10 账号验证与访问恢复](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/10-account-verification-and-recovery-contract.md) | P0 / needs-info | AC-02：明确验证码/恢复码关系和无恢复码恢复路径，不能因已有恢复码废除需求 |

`needs-info` 指完整签发缺少明确输入，不表示其中所有研发工作都必须等待。缺口未收口时可以单独报告已经通过的核心受控体验，不能宣告完整对标或公开运营完成。既定 `MODERATION_PROVIDER=mock` 保持；任何事项均不要求重新启用 safety-gateway。

## Comments

- 2026-09-10：初始根据当前源码和 PRD 合并为 8 项；最终逐行核对补入 10 的账号恢复契约漏项，补强 04 的 CR-11 和 06 的 SE-01～07 退出条件。当前 9 项开放、09 已完成；未把已实现的恢复码、记忆控制、单条 Voice Clip、普通合集、默认单段 Video 或本轮已修复文案重新列为未启动。

## 本轮已完成事项

| 事项 | 状态 | 实际验收 |
| --- | --- | --- |
| [09 时间注释与记忆源校验](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/09-memory-temporal-source-admission.md) | resolved / 已验收 | 原投影自动恢复，4 条 Main 原文逐条一致；真实 Chrome 新会话准确回答 Cedar 与蓝色厨房窗台，wake/memory-search 均命中。56 项相关测试及 Chat typecheck 通过。 |

本附录记录受控本地完成项，不改变上表仍开放的完整产品与公开生产阻塞。[记忆恢复证据](/Users/kk/code/idream/.tmp/product-audit-20260910/memory-live-recovery.json)保留具体版本、运行实例和请求归属。
