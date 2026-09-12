# 提供独立 dreamcoin 充值闭环

Type: task
Priority: P1
Status: needs-info
Requirements: UP-06/09、PF-04、GN-12/16

已有计划的用户用完 dreamcoin 后，应能独立充值并回到原任务。再次买计划、兑换码、测试加币不能代替正式 Coin Store。

**当前可复现边界**

[service.ts:667](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/service.ts:667) 只有计划 checkout 与 dreamcoin 余额读取；[billing-checkout.ts:140](/Users/kk/code/idream/packages/main/src/server/modules/ourdream/billing-checkout.ts:140)、`:201` 固定 Plan selector/offer/planId。当前无独立 coin offer、充值 checkout 或购买历史产品链。

**需要的信息**

正式充值商品的币量、价格/币种、资格、赠币/促销和撤销/退款规则尚未出现在现有 Plan seed 或经济契约中。需发布这些商业规则；生产支付配置依赖 [08](/Users/kk/code/idream/.scratch/product-audit-20260910/issues/08-public-production-certification.md)。工程权威与受控测试可先行，不应凭空发布实际售价。

**预期行为**

独立、版本化 coin offer 在执行前报价；一次性加密 checkout，经真实 provider 确认才幂等入账，并保留购买历史与支持查询。充值成功回原 Chat/Generate，不自动重发付费任务。

**真正退出条件**

1. Chrome 完成余额不足 → offer/quote → 真实 checkout → confirmation → ledger topup → 返回原任务；余额、购买历史、provider invoice 一致。
2. 延迟/重复/乱序通知、未知 provider 结果、取消/过期、退款/冲正均有准确可恢复状态，重复确认不重复赠币。
3. 商品改价后旧已接受报价/offer 保持版本；跨账号访问和回调不能把币充给错误账号；一次性计划权益与 coin topup 分开。
4. 不充值、不真实确认时不得用内部加币或 demo checkout 关闭本事项。

## Comments

- 2026-09-10：已有 Plan checkout、账本、兑换码、referral 与近期已购权益修复继续复用，不重复记为缺失。
