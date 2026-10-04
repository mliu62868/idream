# 经济模型与定价（dreamcoin 费率卡）

更新日期：2026-10-04
状态：现行经济产品契约；目标与实现差异须显式记录，不由代码现状取消承诺

> **本文是经济模型的单一事实来源（SSoT）。** 计划权益、生成扣费、免费档配额、退款规则均以此为准。
> 工程落地见 [计费与权益](../architecture/08-billing-and-entitlements.md)。`packages/main/prisma/seed.ts` 提供新环境的默认 `PricingRule` / `Plan`，不是现有库或已购买权益的实时权威；seed 使用非覆盖式初始化，运行配置可以已有受审计版本。新购买读取已发布 Plan/Coin Offer，新生成读取唯一有效 PricingRule 与 profile；接受后以不可变 offer/quote/billing authority 履约。默认值、产品承诺与运行事实不一致时记录差异，不能静默覆盖已购买合同，也不能把 seed 当作新的产品决策。

经济模型服务 Explore、Create、Chat、Generate、My AI、Feed/Community/Creator Economy、Upgrade 与 Affiliate 组成的完整平台循环，而不是用锁回历史制造续购：

- 基础 Chat 人格、上下文和记忆质量不按计划分级；计划主要购买消息额度、高成本媒体、速度和高级创作控制。
- 用户创建、购买或已交付的聊天与媒体在计划到期后仍可查看和下载。
- 每次付费动作先展示成本再执行；失败、拦截或未交付按权威状态机幂等退款。
- 计划是一次性预付的周期访问，当前 provider 不自动续订，到期后由用户自行重新购买。

### 用户得到什么，何时才算完成

| 动作 | 用户承诺 | 权威与成功条件 | 未知或失败时 |
| --- | --- | --- | --- |
| 购买周期访问 | 得到已接受 offer 的时长、能力和赠币 | 可信 provider 结算，访问周期/权益与唯一 grant 可读回 | 未确认不发权益；少付、晚到或冲突先对账，回跳不冒充到账 |
| 充值 | 得到已接受 Coin Offer 的币量，不改变访问周期 | 确认后恰好一次入 ledger，有购买回执 | 原 checkout 恢复/对账，不重复下单或发币 |
| 图片/视频生成 | 事先知道费用，拿到有效且已交付结果 | 接受的 quote、Request/Delivery 与扣退净额一致 | 恢复原请求；无交付份额按原费用规则退，unknown 先核对 |
| 点击语音播放 | 明确分钟额度与可能扣币上限，重播原 clip 不再计费 | 原回复/attempt、已接受费用条款、实际语音用量与交付对应 | 恢复同一请求，不改原同意；未交付不能冒充已收费成功 |
| 到期或退款 | 明白哪些新能力结束，哪些既有结果保留 | 到期、真实退款、人工补币分别有状态与账本证据 | 普通到期不回收余额/历史；退款按 §4.2 精确处理原购买 |

运营改价仅影响新报价与新 offer；任何客服、Admin 或配置动作都不能直接覆写余额、历史 ledger、已接受价格或原购买权益。

---

## 0. 核心模型：单一货币（dreamcoin）

iDream 使用单一消费货币，由接受的报价、交付与账本约束：

> **dreamcoin 是平台唯一的消耗型货币。** 图片/视频生成按费率扣 dreamcoin；语音优先消耗计划分钟额度，额度用尽后按 clip 兜底扣 dreamcoin。
> 在 iDream，「N 张图 / N 个视频」若被展示，只能表示把计划 dreamcoin 全用于该类基础生成的等价示意，不能另造独立图片/视频配额；语音分钟是独立额度，见 §1.1。当前计划卡不展示媒体等价数字；若未来恢复，必须动态计算，且 `video_gen=false` 时不得展示视频承诺。竞品表述只作为带日期研究材料，不决定 iDream 的计费权威。

## 1. 费率卡（Rate Card）

所有数值为「币（dreamcoin）」。本节维护费率产品契约；实际新报价的工程权威是当前唯一有效 `PricingRule` 与所选 profile，接受后的费用不被后续改价覆盖。

### 1.1 基础单价

| 操作 | 基础费率 | 说明 |
| --- | --- | --- |
| 图片生成（默认模型，1 张） | **5 币/张** | `count` 张则 ×count，如 4 张 = 20 币 |
| 原生视频生成（默认路线） | **100 币/个** | 基础单价；合法时长/质量由已发布 recipe/profile 与报价限定。序列按各场景报价合计，见 §1.2 |
| 语音（按条 TTS 朗读） | **计划分钟额度优先；超出后 2 币/条** | 使用已购买 offer 的语音额度；额度用尽后按已接受费率兜底扣币。请求绑定原回复与 attempt，重播已交付原 clip 不重复合成/扣费；同一 message 的新回复不能被旧 clip 身份免单 |
| 文字消息 | **0 币** | 有效付费访问用户 unlimited；免费档按 `chat_usage` 周期限量（§3） |
| 音频消息（额度内 TTS 回复） | **0 币** | 计划分钟额度覆盖范围内不额外扣币 |

### 1.2 乘数（在基础单价上叠加）

图片/原生视频单次费率产品模型：`cost = ceil(base × count × rule_mult × model_mult)`。

当前统一实现见 [generation pricing](../../packages/main/src/server/lib/generation-pricing.ts)：`ceil(PricingRule.baseCost × outputCount × PricingRule.multiplier × profileMultiplier)`。`rule_mult` 是 Admin 发布的规则倍率，不能遗漏。普通视频已有按发布路线选择时长/画幅/质量的能力；未发布选项必须拒绝，不能把较宽请求 schema 当成支持范围。当前普通视频及序列的原生场景均未另加动态 `duration_mult` 或按秒费，时长可选不等于额外收费；以后变更收费须先发布版本化规则/profile 并进入用户接受的报价。

| 乘数 | 取值 | 适用 | 备注 |
| --- | --- | --- | --- |
| `count`（图片张数） | 1–4（P0）/ 最高 256（P1） | 图片 | 线性叠加 |
| `rule_mult`（费率规则） | 默认 1.0；读取已发布 `PricingRule.multiplier` | 图片/视频/语音 | 与基础费率一起固定到接受的报价；后台改价必须参与真实计价 |
| `model_mult`（模型档位） | 默认 1.0；premium/experimental 模型 1.5–2.0 | 图片/视频 | 高阶模型仅 entitlement 允许时可选；具体倍率在 `ModelProfile.costMultiplier` |
| 视频时长/质量 | 不另加动态倍率 | 普通视频及序列原生场景 | 执行选项固定到接受的 recipe/profile/quote；能力与费用分别校验 |
| `orientation`（画幅比例） | **1.0（不额外计费）** | 图片 | 5 种比例同价，避免定价复杂度 |

> **乘数与取整的产品定义只在此维护**。其它功能规格与运营文档引用本节；所有执行入口复用统一实现，不自行另算。数量、倍率、时长等边界必须有当前 capability/profile 支持，P1 上限不是现行 backend 已兑现的声明。

**视频序列报价。** 当前 [sequence quote](../../packages/main/src/server/modules/ourdream/video-sequence.ts) 对每个原生场景调用上述统一报价，总价为各场景已取整费用之和，不把合成后的总时长再乘一遍。接受时冻结场景 quote、请求 fingerprint、音频配置与需要的 voice pin，并在同一事务接受/预留；[Shared sequence contract](../../packages/shared/src/contracts/video-sequence.ts) 和当前 production profile 限定场景时长与数量。当前英文旁白报价的额外 dreamcoin 费用为 0，不套用 Chat TTS 的单条兜底费；后续收费变更同样须事先报价。合成失败只重试已完成场景的合成，不再次收取场景生成费用；场景失败/取消按原请求实际交付与未启动份额结算，unknown 先对账。

### 1.3 扣费时点（与 ledger 一致，见 08 §4）

| 步骤 | delta | reason | 说明 |
| --- | --- | --- | --- |
| 创建生成任务 | `-cost` | `generation_spend` | **接受即负向扣币，业务称预留**，锁价；余额不足直接 402 拒绝入队 |
| 有效结果已交付 | 0 | （按 Delivery 结算） | 无额外 delta；provider 成功不等于用户已交付 |
| 明确失败/被拦截/取消且无交付 | `+未退费用` | `refund` | 按 Request/ledger 稳定身份幂等退；总退款不超过原扣币 |
| 部分成功（多图部分未交付） | `+未交付份额` | `refund` | 保留已交付产物，按冻结报价与结算规则退未交付份额 |

**并发竞态**：预留发生在 `POST` 事务内（`balance ≥ cost` 校验与扣减原子），因此「下单时够、排队中被并发花掉」不会发生——余额在下单瞬间就被扣减占用。

这里没有独立 escrow 钱包或额外 capture 扣币。unknown/回执丢失先核对不可变终态，不能一边退币一边重新调用非幂等 provider。晚到产物的归档、抑制交付与受限恢复沿原 Request/settlement 权威处理，不能从“出现了文件”反推已付款或再次扣退。

---

## 2. 预付访问计划与权益

iDream 的计划价格与权益如下；竞品公开快照见 [对标矩阵](PRODUCT_PARITY_MATRIX.md)，不进入运行计费配置。新购买使用已发布计划，既有购买读取原 offer。

| 计划 | 月付 | 年付（一次付清 / 等效月价） | 当月 dreamcoin | 关键权益 |
| --- | --- | --- | --- | --- |
| **Free** | $0 | — | 注册赠币（一次性，见 §3） | 浏览、有限聊天、无付费生成（除非用赠币/充值） |
| **Premium** | $19.99/mo | $99.90/yr（≈$8.33/mo） | 1,500 / 月（年付 18,000/年） | unlimited messages、image gen、voice（30 min/月）、`videoGeneration=false` |
| **Deluxe** | $59.99/mo | $299.90/yr（≈$24.99/mo） | 6,000 / 月（年付 72,000/年） | Premium 全部 + premium generation models + voice（120 min/月） + video entitlement；仅在 `video_gen` 与 provider gate 同时 ready 时曝光 |

月/年和等效月价说明购买周期及比较口径，不代表钱包自动续费。每次确认购买按已接受 offer 的 `includedDreamcoins` 发放一次，年付总币量不是十二笔未经定义的自动月发任务。语音的 30/120 分钟·月产品承诺保留；年卡 seed 存为 360/1440，而当前 `voiceMinutesRemainingMs` 直接按有效 `voice_minutes` 查询滚动 30 天使用量，月度承诺与年卡计量存在静态口径差异。此差异须独立核验和决策，不能把字段乘十二解释为已兑现按月额度或新的无限滚动承诺。

### 2.1 年付促销

- **首次年付购买**额外赠 1,000 dreamcoins（一次性产品目标，`reason=promo`）。曝光前须有版本化活动资格、唯一领取与真实账本证据；仅有本文条款不能声称默认支付已发放。未验证实现不得删除该目标或伪造赠币承诺已兑现。
- 年付一次性付清（加密支付无自动续费，见 08 §2）。

### 2.2 权益与卡面

`Plan.includedDreamcoins` 是独立币量，`features` 中的 `unlimitedMessages/imageGeneration/videoGeneration/voiceEnabled/voiceMinutes/premiumModels` 描述能力。年卡语音默认值与月度承诺的差异按 §2 单独核验。

计划卡展示币量、消息和生成能力；高阶控制仍须服务端 entitlement。基础 Chat provider/model、人格、上下文与记忆不按计划分级；Deluxe 的 `premiumModels` 是生成模型权益。图片/视频不另设 quota；未来若展示等价数量须按费率动态计算且遵守能力门控，语音分钟不能混入币折算。

## 3. 免费档（Free Tier）配额 — 定义

| 维度 | 免费档额度 | 说明 |
| --- | --- | --- |
| 注册赠币 | **一次性 250 币** | 按基础费率可试用约 50 张图，仍受实际报价与能力限制；`reason=signup_bonus`，不每月续 |
| 文字消息 | **每日 30 条 / 角色不限** | 按 Main Turn 的 UTC 产品日计量；编辑、重生成与已消费取消不重复制造额度事实，超额提示升级 |
| 聊天模型 | 当前配置的 DSH model | 所有方案使用同一 provider/model |
| 聊天记忆 | official igrep + Chat 边界/关系投影 | 不按方案承诺倍率 |
| 图片/视频/语音 | 基础付费请求使用赠币或充值；能力仍受门控 | 无每月免费媒体额度；余额不能替代 video、高阶模型等能力资格。免费语音按接受的单条报价扣币，使用当前允许的系统默认声音，不自动预合成 |
| 发布角色 | 不可 | 仅可保存私有（My AI） |
| 自定义 prompt / negative prompt / 高阶模型 | 不可 | premium 门 |

> **设计意图**：免费档先让用户走完「Explore → Create/Chat/Generate → 获得一个真实可用结果」的 aha 时刻（250 币按当前基础费率约可试用 50 张图），但持续高成本生成需要购买访问计划或充值。消息日上限保护成本，但不把 Chat 留存定义为唯一的产品价值证明。
> 具体数值（250 币 / 30 条）为**可调运营参数**，应进入 A/B 实验（见 PRD 指标章）；当前实现与运营配置需分别核验，代码数值不能静默取代本契约。

---

## 4. 充值、退款、降级

### 4.1 单独充值 dreamcoin

- 一次性加密付款，确认到账后 `reason=topup` 入账（08 §2）。
- 充值币与访问计划赠币**同池**（都进同一 ledger），不区分有效期（MVP）。

### 4.2 退款与补偿规则

| 场景 | 处理 | reason |
| --- | --- | --- |
| 明确失败/取消且无有效交付 | 全额退原未退费用；unknown 先对账 | `refund` |
| 输出被审核拦截 | 全额退预留币（用户无产出不应付费） | `refund` |
| 多图部分未交付/被拦截 | 按未交付份额退，保留已交付结果 | `refund` |
| 正常已结算预付访问全额退款 | provider 退款命令；立即冻结该访问权益并精确冲销原购买 grant，按退款回执对账 | `subscription_refund`；合法取消恢复用 `subscription_refund_restore` |
| 少付/多付/晚到支付或争议 | 沿原 checkout 与 provider evidence 对账，不伪装成正常访问退款 | 依专门 reconciliation 契约 |
| 客服人工币补偿/调整 | 追加 ledger + 权限/确认/审计；不改变真实 provider 收退款事实 | `admin_adjust` |
| 注册/活动赠币与普通到期 | **不因普通到期回收**；欺诈处置另有依据 | 原奖励 reason；调整必须留证 |

正常访问退款的冲销量是**本次购买已授予的精确币量**，即使部分已消费也允许形成负余额，不把余额归零、不退还已消费的生成币。provider 退款取消只在不存在冲突访问周期时恢复原周期、原 offer 权益及精确 grant；重试沿 command 身份幂等。真实退款、权益冻结、币冲销和客服补偿各有独立事实，完整工程流程见 [账务架构 §7](../architecture/08-billing-and-entitlements.md#7-正常预付访问退款争议到期)。

### 4.3 降级 / 到期

- 访问权益到期 → `recomputeEntitlements` 移除高阶权益（custom prompt / premium generation models / video entitlement 等）。
- **已发放的 dreamcoin 余额保留**，可继续按费率消费（降级不清零余额）。
- 高阶模型生成入口在降级后置灰（entitlement 门控），但用户仍可用基础模型 + 余额生成。
- **既有聊天历史保持可见，已交付媒体保持可见并可下载**；不得因到期重新模糊、隐藏或删除。计划变化只影响新的高阶请求。

---

## 5. 余额不足体验（UP-06）

- 任何付费操作前，前端展示「本次消耗 X 币 / 当前余额 Y 币」。
- 余额不足：展示**升级**（周期访问，性价比更高）与**充值**两个 CTA，并从当前 Plan 数据动态说明包含的 dreamcoin 和可覆盖能力，不硬编码币量。
- 服务端在 `POST` 时二次校验余额（客户端余额不可信），不足返回 `402 payment_required` 与结构化费用/余额；具体字段由该入口 Zod/响应契约维护，客户端据此展示所需额度。

---

## 6. 权威与实施

价格与权益承诺由本文维护，报价、账本与退款实现见 [计费架构](../architecture/08-billing-and-entitlements.md)，服务/API 见 [后台规格](BackendFeatureSpec.md)，真实状态与差异见 [当前覆盖](CURRENT_FUNCTIONAL_COVERAGE.md)。

## 7. 验收

- [ ] 当前 `/upgrade` 计划卡不展示已禁用的视频承诺；若恢复图片/视频等价示意，必须由 `includedDreamcoins ÷ 对应费率` 动态算出，语音独立显示分钟，无硬编码独立配额，并受 feature flag 控制。
- [ ] 所有付费生成入口使用 §1.2 唯一计价实现，规则倍率、profile 倍率与接受的报价实际一致；普通视频只提供已发布时长/质量选项，序列按冻结场景报价合计，合成重试不重复收费，未发布收费规则不先收费。
- [ ] 免费档赠币、日消息额度为可配置运营参数，不写死在判定逻辑。
- [ ] 失败/拦截/部分拦截退款幂等收敛（`sourceId=jobId`），不重复退、不漏退。
- [ ] 普通到期不清零余额；正常访问退款精确冲销原 grant，取消恢复与重试不重复冲销/回补；客服补币不冒充真实退款。
- [ ] 到期/降级不隐藏既有聊天或已交付媒体；媒体仍可下载，只关闭未来高阶能力。

以上是验收标准；年卡语音窗口、首次年付促销及免费参数配置化未有同 revision 运行证据时保留待核验状态。
