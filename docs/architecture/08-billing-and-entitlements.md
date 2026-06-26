# 08 · 计费、权益与 dreamcoin

更新日期：2026-06-13

落地 `BackendFeatureSpec §3.5/§4.5/§5.8` 与 ADR-4（支付抽象 + **加密货币**）。核心三件事：**订阅生命周期**、**权益（entitlement）派生**、**dreamcoin append-only ledger**。

## 1. 计划与权益（来自 ProductFeatureMap §5.5）

| plan | billing | 价格 | 关键权益（`Plan.features` JSON） |
| --- | --- | --- | --- |
| premium | monthly | $19.99/mo | 1,000 dreamcoins、200 images、20m voice、10 videos、unlimited messages、audio messages、publish characters |
| premium | yearly | $9.99/mo（年付） | 同上 + free coins 促销 |
| deluxe | monthly | $59.99/mo | premium chat models、3x chat memory、5,000 dreamcoins、1,000 images、100m voice、50 videos |
| deluxe | yearly | $29.99/mo（年付） | 同上 + free coins 促销 |

`Plan.features` 示例（SSoT 在 seed + `lib/constants.ts`）：

```jsonc
{
  "unlimited_messages": true,
  "custom_prompt": true,
  "negative_prompt": true,
  "video_gen": true,
  "premium_models": false,        // deluxe=true
  "chat_memory_multiplier": 1,    // deluxe=3
  "monthly_dreamcoins": 1000,
  "image_quota": 200,
  "video_quota": 10,
  "voice_minutes": 20
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

```ts
// modules/billing/ledger.service.ts （事务内）
async function applyDelta(userId, delta, reason, sourceId) {
  return prisma.$transaction(async (tx) => {
    const cur = await balanceOf(tx, userId);         // SUM(delta) 或读最近 balanceAfter
    const next = cur + delta;
    if (next < 0) throw Errors.insufficientCoins(-delta, cur);   // 不允许透支
    return tx.dreamcoinLedger.create({
      data: { userId, delta, balanceAfter: next, reason, sourceId },
    });
  });
}
```

**生成预留/结算**（与 06 §8 一致）：

| 步骤 | delta | reason | sourceId |
| --- | --- | --- | --- |
| 创建生成任务 | `-cost` | `generation_spend`（reserved） | jobId |
| 成功 | 0（已扣，确认） | — | — |
| 失败/拦截 | `+cost`（或按份额） | `refund` | jobId |

按 `sourceId=jobId` 去重，保证一个任务最多净扣一次、可全额退。

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
- **dreamcoin 是平台唯一消耗型货币**（决策见 ECONOMY §0）。计划卡上的「200 images / 10 videos / 20m voice」**不是独立配额**，而是「当月 dreamcoins ÷ 费率」的上限示意（5 币/图、100 币/视频、50 币/分钟，见 ECONOMY §1）。
  - 因此 `Plan.features` 不再设 `image_quota / video_quota / voice_minutes` 独立计数；只保留 `monthly_dreamcoins`，UI 数字由 `monthly_dreamcoins ÷ 费率` 动态算出。
  - 生成扣费走 dreamcoin ledger（§4）；语音通话按分钟扣 coin（ECONOMY §1.1），`voice_enabled` 仅作能力门。
  - 免费聊天额度（每日 messages）仍用 `chat_usage`（ECONOMY §3）——消息免费，只限频，不走 coin。

## 7. 退款、争议、降级

- 退款（人工/争议）：`admin_adjust` 负 delta 或冲正；订阅争议 webhook → `past_due/canceled`。
- 降级/到期：`recomputeEntitlements` 移除高阶权益；已发放 dreamcoins **不回收**（除非欺诈，走 admin_adjust 留证）。

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
- [ ] 换 PSP 不触碰 billing 数据模型。
