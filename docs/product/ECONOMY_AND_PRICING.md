# 经济模型与定价（dreamcoin 费率卡）

更新日期：2026-06-28
状态：产品定稿（数值最终以商务为准；本表为 SSoT 结构）

> **本文是经济模型的单一事实来源（SSoT）。** 计划权益、生成扣费、免费档配额、退款规则均以此为准。
> 工程落地见 `architecture/08-billing-and-entitlements.md`；**费率与计划数值的代码 SSoT 是 `packages/main/prisma/seed.ts`**（`PricingRule` / `Plan` 种子）。本文出现的具体数字若与 seed 不一致，以 seed 为准并回写本文。

---

## 0. 核心模型：单一货币（dreamcoin）

复刻自 ourdream.ai 的真实模型，反推并验证得到以下结论：

> **dreamcoin 是平台唯一的消耗型货币。** 一切付费生成（图片、视频、语音）都按费率扣 dreamcoin。
> 计划卡上的「200 张图 / 10 个视频 / 20 分钟语音」**不是三个独立配额**，而是「把当月 dreamcoin 全部花在该类目时的上限示意」。

官方文案佐证（对标站 ourdream.ai 计划卡文案）：

> "1,000 dreamcoins is included in the subscription which **covers all your needs including videos**."

这条决策**纠正了早期文档把 image_quota / video_quota / voice_minutes 当作独立计数器的设计**（见 `08-billing §6` 旧表述）。MVP 一律折算为 dreamcoin，KISS：一种货币、一个 append-only ledger。

### 0.1 反推验证（数值自洽性）

| 计划 | 当月币量（seed） | 卡面示意 | 反推单价 |
| --- | --- | --- | --- |
| Premium | 1,500 | 300 images | **5 币/图** |
| Premium | 1,500 | 15 videos | **100 币/视频** |
| Deluxe | 6,000 | 1,200 images | 5 币/图 ✓ |
| Deluxe | 6,000 | 60 videos | 100 币/视频 ✓ |

两档计划用**同一套单价**完全吻合 → 单一货币模型成立（币量取自 `seed.ts` 的 `Plan.includedDreamcoins`：Premium 月 1,500 / Deluxe 月 6,000）。

> **语音不走币折算**：语音是按计划的**独立分钟额度**计量（`Plan.features.voiceMinutes`，Premium 30 / Deluxe 120 分钟·月，滚动 30 天窗口），额度用尽后才按 clip 兜底扣 dreamcoin（见 §1.1），因此不纳入上表的「币 ÷ 单价」反推。

---

## 1. 费率卡（Rate Card）

所有数值为「币（dreamcoin）」。这是扣费 SSoT，工程实现见 `PricingRule` 表 + `06 §8`。

### 1.1 基础单价

| 操作 | 基础费率 | 说明 |
| --- | --- | --- |
| 图片生成（默认模型，1 张） | **5 币/张** | `count` 张则 ×count，如 4 张 = 20 币 |
| 视频生成（默认时长） | **100 币/个** | 与默认时长绑定；更长时长 P1 另议 |
| 语音（按条 TTS 朗读） | **计划分钟额度优先；超出后 2 币/条** | 先消耗 `Plan.features.voiceMinutes`（滚动 30 天窗口）；额度用尽后每条 clip 兜底扣币（`PricingRule` mode=`voice`，`baseCost` 默认 2，代码 SSoT 见 `seed.ts`）。同一 `messageId` 只生成/计费一次 |
| 文字消息 | **0 币** | 订阅用户 unlimited；免费档按 `chat_usage` 周期限量（§3） |
| 音频消息（额度内 TTS 回复） | **0 币** | 计划分钟额度覆盖范围内不额外扣币 |

### 1.2 乘数（在基础单价上叠加）

最终扣费：`cost = ceil(base × count × model_mult × duration_mult)`

| 乘数 | 取值 | 适用 | 备注 |
| --- | --- | --- | --- |
| `count`（图片张数） | 1–4（P0）/ 最高 256（P1） | 图片 | 线性叠加 |
| `model_mult`（模型档位） | 默认 1.0；premium/experimental 模型 1.5–2.0 | 图片/视频 | 高阶模型仅 entitlement 允许时可选；具体倍率在 `ModelProfile.costMultiplier` |
| `duration_mult`（视频时长） | 默认 1.0 | 视频 | P1 支持更长时长时启用 |
| `orientation`（画幅比例） | **1.0（不额外计费）** | 图片 | 5 种比例同价，避免定价复杂度 |

> **乘数算法的唯一定义在此**：`base × count × model_mult × duration_mult`，逐项相乘后 `ceil`（代码实现见 `service.ts` 的 `generationCost`）。其余文档（如 `ADMIN_CONSOLE_PLAN`、`BackendFeatureSpec`）引用本节，不得另立公式。

### 1.3 扣费时点（与 ledger 一致，见 08 §4）

| 步骤 | delta | reason | 说明 |
| --- | --- | --- | --- |
| 创建生成任务 | `-cost` | `generation_spend`（reserved） | **下单即预留**，锁价；余额不足直接 402 拒绝入队 |
| 任务成功 | 0 | （已结算） | 无额外 delta |
| 任务失败/被拦截 | `+cost` | `refund` | **全额退**（按 `sourceId=jobId` 幂等，绝不重复退） |
| 部分成功（多图，部分被拦截） | `+被拦截份额` | `refund` | 按未产出的张数按比例退 |

**并发竞态**：预留发生在 `POST` 事务内（`balance ≥ cost` 校验与扣减原子），因此「下单时够、排队中被并发花掉」不会发生——余额在下单瞬间就被扣减占用。

---

## 2. 订阅计划与权益

价格与权益对齐真实站点 ourdream.ai；**数值 SSoT 为 `seed.ts` 的 `Plan` 种子**（`priceCents` / `includedDreamcoins` / `features`）。

| 计划 | 月付 | 年付（一次付清 / 等效月价） | 当月 dreamcoin | 关键权益 |
| --- | --- | --- | --- | --- |
| **Free** | $0 | — | 注册赠币（一次性，见 §3） | 浏览、有限聊天、无付费生成（除非用赠币/充值） |
| **Premium** | $19.99/mo | $99.90/yr（≈$8.33/mo） | 1,500 / 月（年付 18,000/年） | unlimited messages、image gen、voice（30 min/月）、video gen |
| **Deluxe** | $59.99/mo | $299.90/yr（≈$24.99/mo） | 6,000 / 月（年付 72,000/年） | Premium 全部 + **premium models** + voice（120 min/月） + video gen |

### 2.1 年付促销

- 年付**首次订阅**额外赠 1,000 dreamcoins（一次性，`reason=promo`）。
- 年付一次性付清（加密支付无自动续费，见 08 §2）。

### 2.2 `Plan.features` 结构（SSoT 在 `seed.ts`）

`includedDreamcoins` 是 `Plan` 的**独立顶层列**（不在 `features` 里）。`features` 为 camelCase JSON，实际字段如下（取自 `seed.ts` 的 Premium / Deluxe 月卡）：

```jsonc
// Premium 月卡 features
{
  "unlimitedMessages": true,
  "imageGeneration": true,
  "videoGeneration": false,   // deluxe = true
  "voiceEnabled": true,
  "voiceMinutes": 30          // deluxe = 120；年卡 360 / 1440
  // deluxe 额外：premiumModels: true
}
```

对应 `Plan` 顶层：`priceCents`（Premium 月 1999 / 年 9990；Deluxe 月 5999 / 年 29990）、`includedDreamcoins`（Premium 月 1500 / 年 18000；Deluxe 月 6000 / 年 72000）。

> 注意：
> - 旧 `features` 里的 `image_quota / video_quota` 计数器字段**已废弃**（被单一货币模型取代）；图片/视频额度统一折算 dreamcoin。
> - `voiceMinutes` **仍在使用、并按滚动 30 天窗口计量**（见 §1.1），不是废弃字段。
> - 计划卡 UI 上的「N images / N videos」文案由 `includedDreamcoins ÷ 费率` 动态算出展示，不硬编码。
> - 「custom prompt / negative prompt / premium chat models / chat memory multiplier」等高阶权益由 entitlement / Chat Service 层计算，**不落在 `Plan.features`** 内。

---

## 3. 免费档（Free Tier）配额 — 定义

早期文档此处为空白，现明确定义：

| 维度 | 免费档额度 | 说明 |
| --- | --- | --- |
| 注册赠币 | **一次性 250 币** | 足够试用约 50 张图，体验生成漏斗；`reason=signup_bonus`（代码 SSoT：`service.ts` signup 授予 250），不每月续 |
| 文字消息 | **每日 30 条 / 角色不限** | 经 `chat_usage` 按自然日滚动计；超额提示升级 |
| 聊天模型 | 基础模型 | 非 premium models |
| 聊天记忆 | `chat_memory_multiplier = 1`（基线） | 见 Chat PRD |
| 图片/视频/语音 | 仅用赠币或充值 | 无每月免费额度；赠币用完即需订阅或充值 |
| 发布角色 | 不可 | 仅可保存私有（My AI） |
| 自定义 prompt / negative prompt / 高阶模型 | 不可 | premium 门 |

> **设计意图**：免费档让用户走完「探索→创建→生成一次→看到结果」的 aha 时刻（250 币 ≈ 50 张图），但持续生成必须订阅。消息额度给足以体验聊天黏性，但限制日上限以保护成本与推动转化。
> 具体数值（250 币 / 30 条）为**可调运营参数**，应进入 A/B 实验（见 PRD 指标章）；当前默认值的代码 SSoT 在 `seed.ts` / `service.ts`。

---

## 4. 充值、退款、降级

### 4.1 单独充值 dreamcoin

- 一次性加密付款，确认到账后 `reason=topup` 入账（08 §2）。
- 充值币与订阅赠币**同池**（都进同一 ledger），不区分有效期（MVP）。

### 4.2 退款规则

| 场景 | 处理 | reason |
| --- | --- | --- |
| 生成失败（provider 错误/超时） | 全额退预留币 | `refund` |
| 输出被审核拦截 | 全额退预留币（用户无产出不应付费） | `refund` |
| 多图部分被拦截 | 按未产出份额退 | `refund` |
| 订阅争议/人工退款 | `admin_adjust` 冲正 + 留审计 | `admin_adjust` |
| 已发放赠币 | **不回收**（除非欺诈） | — |

### 4.3 降级 / 到期

- 订阅到期 → `recomputeEntitlements` 移除高阶权益（custom prompt / premium models / 3× memory 等）。
- **已发放的 dreamcoin 余额保留**，可继续按费率消费（降级不清零余额）。
- 高阶模型生成入口在降级后置灰（entitlement 门控），但用户仍可用基础模型 + 余额生成。

---

## 5. 余额不足体验（UP-06）

- 任何付费操作前，前端展示「本次消耗 X 币 / 当前余额 Y 币」。
- 余额不足：展示**升级**（订阅，性价比最高）与**充值**两个 CTA，文案点明「1,000 币含在订阅中，覆盖图片与视频」。
- 服务端在 `POST` 时二次校验余额（客户端余额不可信），不足返回 402 + 结构化 `insufficient_coins{ required, balance }`。

---

## 6. 与其他文档的关系（防止漂移）

| 文档 | 引用本文的内容 |
| --- | --- |
| `08-billing-and-entitlements.md §6` | 配额→币的折算口径（本文 §0/§1 取代其「建议」表述） |
| `BackendFeatureSpec.md §5.5` | 生成请求契约引用本文 §1.2 的费率与乘数公式 |
| `ADMIN_CONSOLE_PLAN.md` | `PricingRule` 字段语义；改价走配置版本化 + 审计 |
| `CHAT_SERVICE_PRD.md` | `chat_memory_multiplier` 数值与语音计费口径 |
| `PRD.md §6.7` | 计划卡展示口径（动态算出 images 等示意，不硬编码） |

---

## 7. 验收

- [ ] 任意计划的「images/videos/voice 示意数字」= `monthly_dreamcoins ÷ 对应费率`，由代码动态算出，无硬编码独立配额。
- [ ] 生成扣费严格遵循 `cost = ceil(base × count × model_mult × duration_mult)`，全平台一处定义。
- [ ] 免费档赠币、日消息额度为可配置运营参数，不写死在判定逻辑。
- [ ] 失败/拦截/部分拦截退款幂等收敛（`sourceId=jobId`），不重复退、不漏退。
- [ ] 降级不清零余额；已发赠币不回收。
