# 完成创作者作品、Packs/Comics 与收益旅程

Type: task
Priority: P1
Status: needs-info
Requirements: PF-08/11～14、PF-05/06、EX-10、SE-01～07

创作者应能发布可理解的作品、让用户发现和持续访问，并核对作品带来的资格与收益。当前公开作者页、关注和普通媒体合集具备基础实现，但尚无 Pack 购买权利、Comic 连续阅读或 Creator 经济闭环。

**当前可复现边界**

- [service.ts:3864](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/service.ts:3864) Packs 固定空；[ProfileWorkspace.tsx:230](/Users/kk/code/idream/packages/main/src/components/ourdream/ProfileWorkspace.tsx:230) 明示未提供。[service.ts:2744](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/service.ts:2744) 是普通合集，`public_pack` 只是现有媒体可见性值。
- [FeedWorkspace.tsx:19](/Users/kk/code/idream/packages/main/src/components/ourdream/FeedWorkspace.tsx:19) 只有 character/collection 类型；[discovery.ts:968](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/discovery.ts:968) 提供公开 creator profile，没有等级/Studio 收益/payout 产品操作。

**需要的信息**

需明确并版本化 Creator 等级门槛和公开角色资格、Pack 当前/未来内容范围/许可/价格/退款规则，以及 Dreamcoin/现金激励、确认窗口/冲正和 payout 条件。PRD 定义能力目标，未提供这些可以直接执行的商业数值；不得用模拟值宣布真实收益。Comic 阅读、归属、非支付发布及 SE-01～07 公开内容库存/体验可先行，不依赖经济规则定价。

**预期行为与真正退出条件**

1. 作者完成作品发布 → Feed/Community/作者页发现 → 他人阅读/购买 → 作者数据回访；Comic 可连续阅读并带作者来源，Chat/Remix 接续保留权限和 lineage。
2. Pack 明确内容范围、购买、解锁、退款和长期权利；计划到期不锁回已购内容。普通合集不能冒充 Pack，链接可见/公开发现与私有作品分别受控。
3. Creator level/Studio 从合格 canonical facts 计算，收入可分待确认/可结算/已支付/失败并与 ledger 对账；退款或无效活动能冲正，测试/internal 流量不冒充真实收益。
4. 用受控作者与另一真实权限用户完成 Chrome 跨账号旅程，发布/撤下/转私有后可见性即时正确；不得从复制/收藏/进入合集推定私有作品已授权公开。
5. SE-01～07 分别签发：按实际 dedicated registry/CMS publication 盘点已发布路由、内容族、用途和缺口；指南有目录/正文分区/FAQ/CTA，比较页有真实差异/功能/价格和 CTA，Library 聚合类型/视频/比较/指南，营销页有 hero/角色/功能/相关页/footer，文章有可读正文；Images/Videos/Glossary/Authors/Resources Hub 的分类、卡片、分页和 CTA 指向真实发布内容或已提供的产品能力。每个获授权路由验证 title/description/canonical/sitemap，草稿/撤下/未获授权库存不可继续索引或公开读取。以运行库存和 Chrome 任务证明供给完整性，不用空模板、合法空态或机械补足 212 URL 签发；CMS 能发布文章也不等于作品阅读/购买能力完成。

## Comments

- 2026-09-10：不重复重建已实现的 Creator Profile、分页、关注、普通 Collection 管理/播放或 CMS 发布；聚焦其尚缺的用户任务和权利。
