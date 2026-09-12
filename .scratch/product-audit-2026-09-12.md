# iDream 产品完整度与 Chrome 端到端审计（2026-09-12）

## 结论

当前状态：**本地受控 Beta 可用，公开运营 Go/No-Go = No-Go**。

已在 Chrome 真实走通 Explore → 角色详情 → Chat → 模型回复；Generate 可读取余额、角色、价格、历史任务和图库。创建器可进入 Identity、Appearance、Soul、Preview，并能触发预览候选生成，但本轮候选任务在 10 秒后仍为 processing，未完成“选图 → 发布 → 立即聊天”的闭环。

## 本轮 Chrome 证据

| 步骤 | 结果 | 证据 |
|---|---|---|
| 首页 / Explore | 通过 | 角色卡、搜索、排序、性别/风格/年龄筛选、分类 chips、导航、FAQ、CTA 均可见 |
| 角色详情 | 通过 | Lola Moonstruck 详情、年龄/简介/标签、Chat、Generate、Like、Report 可见 |
| Chat | 通过 | 创建私有会话；发送测试消息；模型返回可见；Edit/Delete/Regenerate/Report、Memory 开关可见 |
| Create | 部分通过 | 5 步 Identity → Appearance → Soul → Preview → Publish；字段包含年龄、外观、Soul、Voice、Occupation、Relationship、Hobbies、Fetishes、首句、Tags |
| Create 预览候选 | 未完成 | 触发后状态为“Candidate 1 of 4 · processing · 0 completed”，未能验证选图、发布和创建后聊天 |
| Generate | 部分通过 | 余额 18,753、角色选择、Prompt、Orientation、Count、Advanced、Recent jobs、Gallery、Images/Videos/Liked、Edit/Enhance/Variation/Download/Report 可见；角色身份提示显示“没有锁定身份 profile”，视觉一致性仍有风险 |
| My AI / Profile | 部分通过 | 余额、权益、Recent/Characters/Created/Presets/Media/Group chats/Packs、兑换码、推荐、账户设置、Billing & Access 可见 |
| Feed | 页面通过 | 公开角色流，Chat/Remix/Like/Share/Report 可见；未完成完整副作用与权限核对 |
| Community | 页面通过 | 角色/创作者/筛选可见；未完成 Creator levels/Studio、Pack/Comic、真实 Follow/Report/分页副作用核对 |
| Upgrade | 阻塞上线 | 页面明确写“DEMO CHECKOUT / Local mock billing”；未验证 provider checkout、确认回调、激活、到期、复购、充值账本 |
| Help Desk / Safety / Resources / Comparison | 页面通过 | 内容与表单入口可达；未完成所有匿名/登录/提交/申诉/运营权限组合 |
| 公开生产门禁 | 未通过 | `bun run check:launch -- --json`: 26 pass / 39 fail / 0 warn |

## 必须完成的上线阻塞

1. **真实商业化闭环**：Upgrade 和 Dreamcoin Store 仍是本地 mock；需要 provider checkout → confirmation → activation/topup ledger → purchase history → expiry → repurchase，且保持一次性预付、不自动续订、失败退款、幂等。
2. **生产运行环境**：当前是 development/localhost；缺生产 HTTPS 域名、生产 auth secrets、内部 token/cron 分离、Redis/BullMQ 生产绑定、对象存储和 Sentry。
3. **发布与恢复权威**：launch check 报 recovery rehearsal bundle 不完整、checkpoint migration 仅 71/90、存在 active session null/legacy pins、Main/Admin/Chat/Gen revision 不一致。
4. **真实生成证据**：image/video/voice live probe 与 Main persistence probe 过期或不匹配当前 revision/profile；H3 仍未满足质量门禁。
5. **创建闭环**：预览候选生成必须完成，并验证候选选择、失败重试不丢草稿、私有保存、公开 Release/Serving、立即 Chat、跨刷新恢复。
6. **身份一致性**：Generate 当前明确提示角色没有 locked identity profile；发布角色需要完成 Visual Identity anchor / Release pin，否则“同一角色跨 Chat/图片”承诺不成立。

## 产品能力缺口

- Chat：主动消息、等价于历史五档基线的可感知 conversation profiles、最多 12 角色 Group Chat、双向 Voice Call。
- Generate：高级 seed/model 选择、多 scene、可选时长/比例/质量/AI voice Video、精确 Chat Product Action 上下文交接；视频质量复验。
- My AI / Community：Pack、Comic、Creator levels/Studio、非支付 Affiliate 归因运营、完整 Images/Videos/Glossary/Authors 内容族与权限。
- 记忆/质量：10k 级长期 recall、跨平台/跨日质量、igrep 错误撤回边界、精确事实/动作归属、局部改图保真、声音全量听感。
- 运营：WPCU 仍是 official 以外指标仅诊断；缺生产回放、成熟窗口和认证样本。
- 安全/年龄：基础 18+ gate 已有；司法辖区触发的第三方 age verification provider、状态机和发布 gate 仍未完成。

## 自动化验证

- `bun run --filter @idream/main test:pure`: **1382 passed / 1 failed**；失败为 `finite-state-authority-inventory` 测试超时（5 秒），不是可忽略的全绿。
- `bun run check:launch -- --json`: **26 pass / 39 fail / 0 warn**，明确拒绝公开上线。

## 建议发布判定

在完成以上 5 个上线阻塞、重新生成同 revision 的 image/video/voice/persistence/recovery/Sentry/blob/catalog probes，并用受控 Chrome 账号完成创建、聊天、图片、视频、语音、重试恢复、交付、持久化、额度扣减、到期/复购全链路之前，不应宣称“所有功能完成”或开放公开运营。

## 2026-09-12 实施增量

- Create 预览跨刷新恢复现在继续绑定原始 queued/running job，不会重复创建四个候选；视觉字段变化会清除旧确认图，避免旧身份锚点与新外观混用。
- 主动消息已加入 6–168 小时用户可控 cadence、原子领取、失败退避和 `ChatTurn.origin=proactive`；未授权时不自动发送。
- Voice Call 已加入 capability/API，但没有真实 STT/TTS 双向 transport 时 fail-closed，不把 Voice Clip 或浏览器 Speech API 冒充通话。
- Affiliate 申请/点击去重/dashboard 与版本化 Creator Level facts 已加入 migration 和领域模块；Pack 购买仍未实现，避免伪造支付/账本。
- 开发库已应用 proactive、affiliate、creator-level migrations；清理了一个无可恢复 Release 的审计空 pin 会话。Soul audit 当前为 0 null pins、31 个历史 pin，launch gate 现已正确阻断 legacy pins，而不是误报通过。
- 复验：migration authority 92/92；Create 22 项、creator/voice 3 项、Soul audit 3 项通过；Main typecheck 通过。恢复 rehearsal dry-run 可生成 schema 2 计划，但 apply 仍需 production fence、同 revision source、真实 Blob/恢复目标和静默窗口。
