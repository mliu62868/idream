# iDream 产品方案完整性评审

更新日期：2026-06-24

## 1. 结论

当前方案的方向是合理的：iDream 应先把 **18+ 合规门槛、角色发现/选择、图片生成、图库、dreamcoin、审核和后台控制面** 做成稳定闭环，再扩展视频、公开 feed、community preset 和复杂创作工作流。

最重要的产品判断：

1. **图片优先是正确选择**。图片生成比视频更容易闭环，也更适合作为 dreamcoin 消耗和 Premium 控制项。
2. **Pipeline API 抽象是正确选择**。产品层不应该关心 MLX 还是 `stable-diffusion.cpp`；用户只关心生成质量、速度、价格、可控性和安全。
3. **管理后台必须是 P0**。没有后台配置、审计、审核、任务排障和退款追踪，图片生成不能面向真实用户上线。
4. **P0 需要拆成多个发布门槛**。现在文档里的 P0 同时覆盖“内部可跑”“用户可用”“公开上线”，范围会失控。必须分为 Internal Alpha、Closed Beta、Public Launch。
5. **公开上线前的合规硬门不能延期**。CSAM/未成年检测、年龄验证策略、举报/申诉、媒体私有访问和审计不是优化项。

总体评分：

| 维度 | 评分 | 判断 |
| --- | --- | --- |
| 产品方向 | 9/10 | 目标清晰，图片优先和后台控制面是正确抓手 |
| MVP 范围 | 7/10 | 能闭环，但 P0 定义偏大，需要拆发布门槛 |
| 用户体验闭环 | 8/10 | 生成前/中/后覆盖较完整，仍需补首次成功和失败恢复细节 |
| 运营后台 | 8/10 | 覆盖面合理，P0 应进一步收敛到最关键操作 |
| 安全合规 | 7/10 | 设计意识足够，但公开上线硬门需要更明确 |
| 商业化 | 7/10 | dreamcoin/entitlement 方向对，仍需明确免费激活额度和价格实验 |
| 可执行性 | 8/10 | 架构边界清楚，最大风险是跨模块排期过宽 |

## 2. 产品定位是否成立

成立。当前 PRD 把 iDream 定位为 18+ AI 角色扮演和 AI 伴侣平台，核心任务是：

- 发现角色。
- 创建角色。
- 聊天。
- 围绕角色生成图片/视频。
- 通过 Premium/Deluxe 和 dreamcoin 变现。

这条链路合理，因为“角色”是所有核心行为的共同对象。图片生成不应做成孤立工具，而应服务于角色关系、角色创建、聊天延展和图库留存。

产品主线建议压缩成一句话：

> 用户先找到或创建一个 18+ AI 角色，再通过聊天和图片生成持续创造私密内容，平台用高级控制、模型质量、额度和图库管理变现。

## 3. 发布门槛重定义

当前 `P0` 覆盖范围过宽。建议改为三层门槛：

### 3.1 Internal Alpha

目标：团队能跑通业务闭环，不面向真实用户。

必须具备：

- Auth、age gate、seed 角色。
- 图片生成任务：mock 或 sandbox provider。
- dreamcoin reserve/refund。
- 私有 media 写入和 signed URL。
- 基础 `/generate` 工作台。
- Admin 能看 job、media、ledger、moderation event。
- 关键测试通过。

允许缺口：

- 真实支付可 mock。
- 真实 CSAM provider 可 mock，但接口和事件必须在。
- 年龄验证 provider 可 mock。
- prompt/profile 配置可先用 seed 或 JSON。

### 3.2 Closed Beta

目标：小范围真实用户可用，人工运营强介入。

必须具备：

- 真实 Pipeline API。
- 真实私有对象存储。
- 基础 output moderation。
- 明确免费激活额度和 Premium gate。
- Admin 可暂停 profile、回滚 prompt template、处理失败任务。
- 用户能看到失败原因、退款和重试。
- 支持工单/帮助入口。

允许缺口：

- 视频仍关闭。
- community preset 关闭。
- public feed 关闭。
- 高级批量管理可延期。

### 3.3 Public Launch

目标：面向真实公网流量。

必须具备：

- 法务确认的 CSAM/未成年检测和上报 runbook。
- 按司法辖区触发的身份年龄验证策略。
- 真实支付或明确可运营的支付方案。
- 完整举报/申诉闭环。
- 管理后台审计、权限、配置回滚。
- 生成成本、成功率、退款率、blocked 率监控。
- 数据保留、删号、隐私和日志策略。

未满足这些条件时，不应公开上线成人生成能力。

## 4. 用户旅程完整性

### 4.1 首次生成旅程

目标旅程：

```text
Visit -> Age gate -> Explore/Generate -> Sign up -> Select character or Freeplay
-> See cost -> Generate -> Track job -> View result -> Like/download/delete
-> Hit premium/control gate -> Upgrade or buy coins
```

方案覆盖得比较完整，但需要补两处产品细节：

1. **免费激活额度**：文档说免费用户可基础生成，同时 Premium 提供图片额度。需要明确免费用户是通过 signup bonus、每日免费次数，还是只能预览不可下载。
2. **首次成功时间目标**：建议设定 `time_to_first_image <= 90s`，超过 30s 时 UI 要解释排队，不让用户以为失败。

### 4.2 失败旅程

已有 queued/running/moderating/completed/failed/blocked/refunded。方向正确。

建议把用户文案和后台状态分开：

- 用户看到：“Queued”、“Creating”、“Final checks”、“Ready”、“Could not create”、“Refunded”。
- 后台看到：`queued`、`running`、`moderating_output`、`blocked`、`provider_timeout` 等精确状态。

原因：`moderating_output` 对普通用户太工程化，也会让用户误解平台在审查自己。前台用 “Final checks” 更稳。

### 4.3 图库旅程

P0 的 Images、Liked、download、delete 足够。

建议 P0 加一个 “Use as reference / Generate similar” 入口，但可以只是创建新 job 的轻量复用，不做复杂 image edit。它能提高生成后的二次使用和 coin 消耗。

## 5. 图片生成方案评审

### 5.1 MLX vs stable-diffusion.cpp

产品结论正确：

- 不把 MLX 或 `stable-diffusion.cpp` 暴露给产品层。
- 用户只选择 “Default / Premium / Fast / Quality” 这样的模型档位。
- runner 留在 Pipeline Service 内部。

P0 生产优先 `stable-diffusion.cpp` 合理，因为它比 MLX 更适合跨平台部署和统一运维。MLX 适合 Apple Silicon 低成本实验，但不适合作为默认线上容量。

### 5.2 Pipeline Service 边界

当前边界合理：

- Main Site 管用户、权益、计费、状态、安全结论。
- `packages/gen` 做队列消费、调用 pipeline、写 blob、finalize。
- Pipeline Service 做 prompt 编译、runner 选择和推理。
- Runner 只做模型执行。

需要补一个产品级指标：**profile 级别质量看板**。

至少追踪：

- profile success rate。
- median/95p generation time。
- cost per successful image。
- retry/refund rate。
- user like/download rate。
- blocked rate。
- manual review hit rate。

这些指标决定模型 profile 是否能进入 Premium 或默认档。

## 6. 管理后台评审

后台方案覆盖面合理，但 P0 应收敛。

P0 管理后台最小可用应只有六个模块：

| 模块 | 为什么必须 P0 |
| --- | --- |
| Dashboard | 判断生成服务是否健康 |
| Generation Jobs | 排查失败、退款、用户投诉 |
| Generation Config | 发布/禁用/回滚 model profile 和 prompt template |
| Moderation Queue | 处理举报、blocked 内容和申诉 |
| Users/Billing | 查询用户、plan、entitlement、ledger |
| Audit Log | 资金、安全、内容操作留证 |

可以延期：

- SEO/CMS 管理。
- Feed/Community 管理。
- Analyst 角色和高级导出。
- Admin saved views。
- 双人审批工作流。

这些是 Public Launch 或 V1.1 能力，不必阻塞 Internal Alpha。

## 7. 商业化完整性

方向正确：Premium/Deluxe + dreamcoin。

需要补三类产品决策：

1. **免费用户激活**：建议给 signup bonus 或每日少量基础生成，否则用户无法体验图片质量，升级转化会弱。
2. **Premium vs Deluxe 差异**：Premium 应解锁 custom prompt/negative prompt；Deluxe 应解锁 premium model、更高并发或更多 monthly coins。不要只靠“更多额度”区分。
3. **退款规则可解释**：失败、blocked、partial success 都要明确是否 refund。用户侧需要看到 “2 images created, 2 refunded” 这类结果。

建议新增商业指标：

- first generation conversion。
- free -> first paid conversion。
- coins spent per active user。
- refund rate by profile。
- premium control usage rate。
- upgrade modal conversion by gate type。

## 8. 安全与合规完整性

方案把安全放在 P0 是正确的。

最大风险是文档里“真实 CSAM 检测、年龄验证和支付暂缓”容易被误读为可以公开上线。建议所有相关文档统一表述为：

> 可在 Internal Alpha / Closed Beta 中 mock 或人工兜底，但 Public Launch 前必须接真实能力并通过法务/运营验收。

产品上还需要补：

- 用户 blocked 后的申诉或帮助入口。
- 举报后的状态查询或收件确认。
- 真实人物/肖像投诉入口。
- 管理后台 support consent 流程，避免内部人员随意查看敏感内容。

## 9. 范围风险

当前最大产品风险不是技术路线，而是 **MVP 同时包含太多闭环**：

- Explore。
- Create。
- Chat。
- Generation。
- Billing。
- My AI。
- Admin。
- Safety。

如果团队资源有限，建议以“图片生成商业闭环”为第一条真实可用路径：

```text
Auth + Age gate
-> Explore seed characters
-> Generate image
-> Gallery
-> Dreamcoin reserve/refund
-> Premium gate
-> Admin job/moderation/config
```

Chat 和 Creator 可以并行推进，但不应阻塞图片生成闭环的 Alpha。反过来，公开上线时 Chat/Create 的安全审核仍必须完整。

## 10. 需要补齐的产品决策

| 决策 | 建议默认 | 原因 |
| --- | --- | --- |
| 免费用户能否生成 | 能，使用 signup bonus 或每日小额度 | 激活用户必须先看到质量 |
| Video 是否露出 | 露出 locked/beta，但不可提交 | 保留欲望，不引入成本 |
| Public feed | P1，P0 全部 private | 降低二次审核和治理负担 |
| Community preset | P1，P0 只 built-in + user private | 降低 UGC 审核压力 |
| Image edit | P1/P2 | 输入图、mask、来源和安全复杂度高 |
| 生成状态文案 | 前台友好，后台精确 | 降低用户焦虑 |
| Admin P0 | job/config/moderation/user/billing/audit | 控制真实运营风险 |
| Public Launch gate | 法务 + CSAM + age verification + payment + audit | 成人产品硬门 |

## 11. 建议调整路线图

建议把当前 M6/M7/M9 拆得更贴近图片生成闭环：

1. **M6a：图片生成 Alpha**
   - mock/pipeline provider 均可。
   - job async、ledger、media、signed URL、basic UI。
   - admin job detail。

2. **M6b：生成配置中心**
   - model profile。
   - prompt template。
   - built-in preset。
   - publish/rollback/audit。

3. **M6c：真实 Pipeline Beta**
   - Pipeline API。
   - private blob。
   - output moderation。
   - provider metrics。

4. **M7：商业化**
   - Premium/Deluxe gates。
   - checkout/mock -> real provider。
   - dreamcoin grants。

5. **M9：公开上线后台**
   - moderation queue。
   - support/user/billing。
   - audit hardening。
   - dead-letter/requeue。

## 12. 完整性检查表

### 用户侧

- [x] 角色/Freeplay 入口。
- [x] cost preview。
- [x] Premium gates。
- [x] async job status。
- [x] gallery。
- [x] failed/blocked/refund。
- [ ] 首次免费激活额度。
- [ ] partial success UI。
- [ ] generate similar/remix 轻入口。
- [ ] support/help path for failed generation。

### 后台侧

- [x] job detail。
- [x] model profile。
- [x] prompt template。
- [x] preset governance。
- [x] audit log。
- [x] billing/ledger lookup。
- [ ] role permission matrix beyond admin/moderator。
- [ ] support consent。
- [ ] dry-run quality review workflow。
- [ ] profile health dashboard。

### 商业侧

- [x] dreamcoin reserve/refund。
- [x] Premium/Deluxe gates。
- [x] plan/entitlement service-side enforcement。
- [ ] free activation policy。
- [ ] price per image/profile rule.
- [ ] refund policy for partial success.
- [ ] upgrade conversion metrics by gate.

### 安全侧

- [x] input/output moderation concept。
- [x] private media + signed URL。
- [x] report/moderation queue。
- [x] hard policies identified。
- [ ] Public Launch CSAM provider and runbook。
- [ ] Public Launch age verification policy。
- [ ] appeal/support UX for blocked outputs。
- [ ] legal/privacy review checklist。

## 13. 最终判断

方案已经具备成为真实产品的骨架，特别是以下三点做得对：

- 生成引擎被隔离在 Pipeline Service 后面。
- 图片生成不是一次性 API，而是任务、计费、审核、图库和后台共同组成的产品闭环。
- 管理后台被提升为产品控制面，而不是事后补的审核页面。

需要修正的是发布语义和少数产品细节：

- 把 P0 拆成 Internal Alpha、Closed Beta、Public Launch。
- 明确免费生成激活和 Premium/Deluxe 差异。
- 补 partial success、用户支持路径和 quality review metrics。
- 对公开上线硬门给出不可绕过的验收清单。

按这些调整后，方案是合理且基本完整的。下一步应进入执行拆票：先做“图片生成 Alpha 闭环”，再做“生成配置中心”和“真实 Pipeline Beta”。
