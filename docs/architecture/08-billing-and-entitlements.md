# 08 · 计费、权益与 dreamcoin

更新日期：2026-08-15

落地 `BackendFeatureSpec §3.5/§4.5/§5.8` 与 ADR-4（支付抽象 + **加密货币**）。核心三件事：**订阅生命周期**、**权益（entitlement）派生**、**dreamcoin append-only ledger**。

## 1. 计划与权益（来自 ProductFeatureMap §5.5）

| plan | billing | 价格 | 关键权益（`Plan.features` JSON） |
| --- | --- | --- | --- |
| premium | monthly | $19.99/mo | 1,500 dreamcoins、unlimited messages、imageGeneration、voiceEnabled、voiceMinutes=30、videoGeneration=false |
| premium | yearly | $99.90/yr | 18,000 dreamcoins、unlimited messages、imageGeneration、voiceEnabled、voiceMinutes=360、videoGeneration=false |
| deluxe | monthly | $59.99/mo | 6,000 dreamcoins、Premium 全部 + premiumModels、voiceMinutes=120、videoGeneration=true（仅在 `video_gen` + provider ready 时曝光） |
| deluxe | yearly | $299.90/yr | 72,000 dreamcoins、Premium 全部 + premiumModels、voiceMinutes=1440、videoGeneration=true（仅在 `video_gen` + provider ready 时曝光） |

`Plan.features` 示例（SSoT 在 seed + `lib/constants.ts`）：

```jsonc
{
  "unlimitedMessages": true,
  "imageGeneration": true,
  "videoGeneration": false,       // deluxe=true, still gated by global video_gen/provider readiness
  "voiceEnabled": true,
  "voiceMinutes": 30,             // yearly premium=360; deluxe monthly/yearly=120/1440
  "premiumModels": false          // deluxe=true
}
```

> 价格/权益最终以商务为准；这里建立**结构**，数值在 `plans` 表，改价不改代码。

## 2. 订阅生命周期（加密货币：预付周期模型）

加密支付**无卡式自动续费**（钱包不能被拉扣），故订阅按"预付周期 + 到期续费"建模（ADR-4）：

```
invoice_created → awaiting_payment → confirming(链上确认中) → active(至 periodEnd)
                                   → underpaid / expired_window → canceled
   续费：periodEnd 前再次付款 → 延长 periodEnd
   未续费：到 periodEnd → expired（移除高阶权益）
```

映射 spec §4.5：保留 `active|canceled|expired`；`past_due` 重解释为"临期未续的短宽限窗"（宽限后 `expired`），无卡式催款。

- **下单**：`POST /billing/checkout` → `PaymentProvider.createInvoice(userId, planId)` → 按 `plans.priceCents`(USD) 生成等值加密发票（处理器锁价窗口）→ 落 `checkout_sessions`（`providerSessionId`=发票 id；金额/币种/收款地址/过期时间记于 `metadata`）→ 返回支付页/地址。
- **激活**：**只由 IPN/webhook + 足够链上确认驱动**（§3），不信前端回跳；确认到账 → `currentPeriodEnd = now + period` + 发权益 + 月度 dreamcoins。
- **续费提醒**：临期由 cron 通知用户再次付款（无自动扣款）。
- **dreamcoin 充值**：一次性加密付款，确认后经 `reward.ledger` 入账。
- **正常订单全额退款**：只允许具有 `billing.subscription.refund` 的 Admin 对已结算 prepaid subscription 发起。`AdminCommand → PaymentProvider.createRefund → immutable refund evidence → webhook/reconcile projection` 是唯一链路；前端不能直接改 subscription 或 ledger。

## 3. Webhook / IPN 幂等（关键正确性）

加密处理器通过 IPN 回调上报支付状态（如 waiting→confirming→confirmed/finished/failed/expired，或 BTCPay 的 InvoiceSettled）：

```
POST /billing/webhooks/:provider
  1) PaymentProvider.verifySignature(rawBody, headers)   ── 失败 → 400，不处理
  2) 解析 providerEventId（发票 id + 状态 / tx hash）→ upsert provider_events（唯一去重）
       若已 processedAt → 直接 200（幂等短路）
  3) enqueue('billing.webhook', {providerEventId}) → 立即 200
worker billing.webhook（必须等"已确认/已结算"才发权益）:
  - confirmed/finished/settled → 订阅 active + currentPeriodEnd=now+period；重算 entitlements（§4）；入队 reward.ledger 发月度 dreamcoins / 充值 coins
  - underpaid → 标记欠付，提示补差或退款（按处理器能力）
  - expired/failed → checkout_session=expired/canceled，不发权益
  - 标记 provider_events.processedAt
```

**不变量**：
- 一切订阅状态变更**来自验签通过 + 足够链上确认的 IPN**，不信客户端回跳（spec §4.5）。
- 按 `provider_events(provider, providerEventId)`（发票 id + tx hash）唯一去重，**恰好处理一次**。
- 验签失败绝不落库处理；确认不足绝不发权益。

## 4. dreamcoin Ledger（append-only，余额派生）

**铁律**：`balance(user) = SUM(dreamcoin_ledger.delta WHERE userId)`。**没有"余额字段"被就地写**。`balanceAfter` 仅为审计快照。

生产写入口只有 `postDreamcoinEntry(tx, intent)`。调用方提交类型化业务 intent（`signup_bonus | subscription_grant | subscription_refund | subscription_refund_restore | generation_spend | refund | redeem | referral | admin_adjust`），不得自由组合 `delta/reason`，也不得直接写 `DreamcoinLedger`。该 Module 在同一事务内负责用户行锁、余额派生、符号与规范 reason、幂等 replay/conflict、`balanceAfter` 和 GenerationSettlement 关联。

```ts
await postDreamcoinEntry(tx, {
  kind: "generation_spend",
  userId,
  amount: cost,
  sourceId: requestId,
  idempotencyKey: `generation-spend:${requestId}`,
});
```

**生成预留/结算**（与 06 §8 一致）：

| 步骤 | delta | reason | sourceId |
| --- | --- | --- | --- |
| 创建生成任务 | `-cost` | `generation_spend`（reserved） | jobId |
| 成功 | 0（已扣，确认） | — | — |
| 失败/拦截 | `+cost`（或按份额） | `refund` | jobId |

按稳定 `idempotencyKey` 去重；同 key 同 intent 安全 replay，同 key 不同 intent 返回 conflict，保证一个任务最多净扣一次、可全额退。

**奖励来源**：`signup_bonus`、`subscription_grant`（续费发放）、`redeem`、`referral`、`admin_adjust`，全部经 `reward.ledger` 队列恰好一次。

## 5. 权益（Entitlement）派生与查询

`entitlements` 表是**派生缓存**（便于快速门控查询），SSoT 是"当前活跃订阅 + 一次性授予（redeem/promo）"：

- webhook 更新订阅后，service `recomputeEntitlements(userId)`：清空 `source=subscription` 的行 → 按活跃 plan 的 `features` 重新 upsert。
- redeem/promo 授予 `source=redeem|promo`（可带 `expiresAt`）。
- 查询：`entitlements.has(userId, key)`（04 §6 `requireEntitlement`）——**服务端唯一真相**，客户端 plan 不可信（01 §8）。

```ts
async function has(userId: string, key: string): Promise<boolean> {
  const e = await prisma.entitlement.findUnique({ where: { userId_key: { userId, key } } });
  if (!e) return false;
  if (e.expiresAt && e.expiresAt < new Date()) return false;
  return e.value !== false;
}
```

## 6. 额度（quota）与权益的区别

> **经济模型已定稿，SSoT 见 `product/ECONOMY_AND_PRICING.md`。** 本节服从该文档；下面只保留工程口径。

- **entitlement**：布尔/配置型能力门（能不能用 custom prompt / video / premium models）。
- **dreamcoin 是平台唯一消耗型货币**（决策见 ECONOMY §0）。当前计划卡展示 `includedDreamcoins` 与聊天/模型权益，不展示 images/videos/voice quota；若未来恢复媒体等价数字，必须按 `includedDreamcoins ÷ 费率` 动态计算，且 `video_gen=false` 时不得展示视频承诺。
  - 因此 `Plan.features` 不再设 `image_quota / video_quota` 独立计数；币量在 `Plan.includedDreamcoins` 顶层字段，媒体消耗按 PricingRule 从 ledger 扣。
  - 语音分钟额度仍使用 `Plan.features.voiceMinutes`（滚动窗口），额度用尽后按 clip 兜底扣 coin；`voiceEnabled` 作能力门。
  - 免费聊天额度（每日 messages）仍用 `chat_usage`（ECONOMY §3）——消息免费，只限频，不走 coin。

## 7. 正常订阅退款、争议、降级

正常已结算 prepaid subscription 的全额退款不走 `admin_adjust`：

1. Admin 二次确认精确 subscription、全额 checkout 金额和理由，服务端创建 durable command。
2. 事务内锁定 subscription/checkout/user，立即将 subscription 投影为 `refund_pending`、移除 subscription entitlements，并用 `subscription_refund` 冲销**本次 grant 的精确数量**。允许余额为负；已消费 Dreamcoin 不返还，也不把余额 clamp 到 0。
3. provider refund request 必须携带 checkout 的 `amountCents/currency`。BTCPay 使用 `Custom`，不用会把超额付款一起退掉的 `RateThen`；create response 与后续 Pull Payment/payout read 在 `claimable/in_progress/completed/canceled` 任一状态下，根金额、根币种、每笔 payout 币种和累计金额都必须与请求精确一致，否则 `refund_create_invalid` 并 fail closed。
4. provider `claimable/in_progress/completed` 通过验签 webhook 或显式 reconcile 更新 immutable refund evidence；`completed` 将 checkout/subscription 收敛为 `refunded`，用户 Profile 显示完成凭据。
5. `refund_pending` 期间禁止该用户创建或 dispatch 新 subscription checkout；已在途的晚到结算进入 reconciliation，不能激活第二份订阅。provider `canceled` 只有在不存在 competing active subscription 时才能恢复原 subscription period 与 entitlements，并用 `subscription_refund_restore` 回补精确 grant。新退款尝试使用新 command id，reversal/restore 幂等键包含 command id，不与被取消尝试混用。

争议/晚到结算仍使用各自 reconciliation authority；不得伪装成正常 subscription refund。到期由 `recomputeEntitlements` 移除高阶权益。

## 8. 支付方式（已定：加密货币，见 ADR-4）

- **生产用加密货币**（推荐自托管 **BTCPay Server**：非托管、开源、无第三方 AUP/KYC 风险；托管备选 NOWPayments/Cryptomus）。规避卡组织与 Stripe/PayPal 对成人内容的封禁。
- billing 模块对处理器中立：换处理器只改 `providers/payment/<impl>` 与 IPN 适配，`subscriptions/entitlements/dreamcoin_ledger` 不动。
- **dev**：用处理器 testnet/sandbox（BTCPay testnet、NOWPayments sandbox 等）打通 invoice→IPN→entitlement→ledger 全链路，无需真实资金。
- 加密特性：等确认才发权益、无自动续费（靠续费提醒）、处理欠付/超付/发票过期（§2/§3）。

## 9. 验收（对齐 spec §9）

- [ ] Premium/Deluxe 门服务端 entitlement 强制。
- [ ] dreamcoin 全为 append-only ledger 条目，余额可由 ledger 重算。
- [ ] 订阅状态仅由验签 + 幂等 webhook 改变。
- [ ] 生成预留/结算/退款净额收敛，可重入不重复扣退。
- [ ] 正常 subscription 全额退款精确匹配 checkout 金额/币种；取消恢复和 command 重试不重复冲销或回补。
- [ ] 换 PSP 不触碰 billing 数据模型。
