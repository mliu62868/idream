# 完成 Affiliate 申请、归因与结算

Type: task
Priority: P1
Status: needs-info
Requirements: AF-01～03、SE-08、US-AF-01～03

商业伙伴应能理解合作条件、申请、取得推广链接与素材、核对有效转化及佣金，并追踪结算。当前只有普通邀请注册赠币，不支持这个经营任务。

**当前可复现边界**

[service.ts:4050](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/service.ts:4050)～`:4076` 只返回 referral code 和 `/signup?ref=...`；[static-route-authority.ts:8](/Users/kk/code/idream/packages/main/src/lib/static-route-authority.ts:8) 没有 dedicated Affiliate 能力。一个 CMS 页面或邀请码不能证明商业归因、佣金和 payout 已实现。

**需要的信息**

需正式发布 RevShare/CPA 适用产品和地区、申请资格、归因窗口与覆盖规则、有效转化定义、退款/作弊冲正、佣金率、最低结算额/币种/周期、收款验证和支持边界。PRD 只有能力要求，不能自行把第三方营销文案或普通 referral 奖励当作这些商业规则。

**预期行为与真正退出条件**

1. Chrome 走通真实条款 → 申请回执/结果 → 归因链接和素材 → 点击与转化 → 收益/结算状态 → 差异支持；未开放阶段不显示假申请成功或假 dashboard。
2. 归因/佣金规则版本固定，显示待确认/有效/撤销转化及对应收入；重复回调、退款、换号、越权访问不产生错归因或双佣金。
3. dashboard 数值来自真实可审计事实，与账本及 provider settlement 一致；无真实转化不得填模拟收入，预计收入不得标为已支付。
4. 普通 referral 的注册赠币行为保留且文案独立；公开 CTA 只指向实际已发布的申请和管理能力。

## Comments

- 2026-09-10：生产 provider/实际结算执行依赖 [08](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/08-public-production-certification.md)，不授权第三方转账或擅自发布商业条款。
