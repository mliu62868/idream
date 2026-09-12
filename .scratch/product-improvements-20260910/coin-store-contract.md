# Dreamcoin Store 实施边界

本轮实现独立 CoinOffer 与 CheckoutSession 购买意图，价格/币量/资格/条款按商品版本固化。Admin 通过正式 v2 权限、幂等命令和同事务 audit 创建草稿/发布/退役；发布新版本会退役同 offerKey 的旧版本，但不改写已受理发票。

用户在商店看价格与条款，显式确认后创建发票。pending 请求在 POST 前以当前用户为键保存，不按时间淘汰；恢复使用原 body/key。GET 不发起支付；刷新支付状态是显式 POST。下单前重新确认当前账号，服务端再约束 viewer scope。失去响应时保留旧意图；只有已确认的购买回执或明确未受理错误才允许新 key。

确认到账由现有 provider 签名/订单核验与 Checkout 锁权威驱动，沿用唯一 DreamcoinLedger writer、`coin-topup:<checkoutId>` 一次性 key。充值不创建 Subscription/Entitlement。未付款、金额不符、过期/不明状态不能当作到账。原订阅分支继续使用其既有排他规则。

测试专用的商品与 provider stub 不代表真实商用参数；开发库没有 seeded/published CoinOffer。本轮新增 8 项数据库集成覆盖 Admin 权限/版本、重复订单、并发 webhook、旧版本结算、未知 provider 恢复、金额/未付拒绝、跨账号、付费资格。现有订阅 50 项回归同时通过；6 项挂载测试覆盖 UI 明确确认、回执持久化/复用、账号切换、状态刷新不丢失另一未知意图和明确拒绝。

尚未完成：正式商品价格、明确退款/撤销及已消费币的处理规则、实际 provider 的充值与退款验收、商业上线。当前已有的 subscription refund 不能充当 Coin refund。没有把本项关闭，也没有真实购买或发送资金。
