# iDream 浏览器端到端产品与运营审计

- 日期：2026-08-14 至 2026-08-15（America/Los_Angeles）
- 环境：本机受控 beta，`main-web :3000`、隔离支付验收实例 `:3010`、`admin :3001` 及相关服务在线；正常退款复验期间 `:3000` 临时接入 BTCPay，完成后恢复 mock；外部支付使用 BTCPay 官方 Testnet Demo
- 视角：用户转化、内容消费、角色生产、审核、Release 与运营队列
- 结论：核心受控 beta 闭环可用；本轮修复了 31 类直接影响用户或运营判断的问题，并补齐了真实 Chat、BTCPay 测试网结算与正常订阅全额退款、付费图片、Fish Audio 语音与 LTX 视频证据。当前证据不构成公开生产上线批准。

## 端到端步骤

1. Explore：已登录用户可浏览、筛选、搜索并进入角色详情。修复了角色标题与年龄在辅助技术中拼成 `Alexa Reevesage 19` 的语义问题；1280×720 固定视口下，首行 5 张角色图均为 eager，页面无 Next.js Issues，旧 LCP 告警未复现。公开面仍存在 `Mara Vale Launch` / `Chrome Launch Audit` 等上线验证命名；它们有完整发布权威，不是 audience-invalid fixture，但编辑呈现仍不适合作为默认首位内容。
2. Character detail：Alexa Reeves 详情、Chat 和 Generate 主行动清楚可用。
3. Chat：已有会话、消息历史和 Memory boundary 正常加载；后续用受控验收账号真实发送两条消息，均经 SSE 完成、Chat DB 持久化并由 Outbox 投影到 Main。实际模型为 `Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-mlx-8Bit`，其中 Dev User 的两句短回复请求约 17.5 秒完成。
4. Generate：角色、余额、身份锁、任务和图库均可加载。修复了非角色所有者永久停留在 `Loading saved Looks…` 的错误状态。
5. Create：身份表单与校验工作。修复了标题只写 `AI Girl`、但性别选项包含 Female / Male / Trans 的产品矛盾。
6. My AI / Profile：账户、权益和媒体库可加载。修复了媒体卡直接暴露内部 `media_*` 标识和完整身份锁运行时 prompt 的问题。
7. Feed：推荐流、Chat / Remix / Like / Share / Report 操作入口存在；首位仍是上线验证内容。
8. Community：人物、角色、合集和筛选可加载；创作者榜首仍被 `Chrome Launch Audit` 上线验证身份占据。
9. Upgrade：实时套餐目录和本地 mock checkout 表达清楚；随后另起隔离的 `:3010` 验收实例接入 BTCPay Testnet Demo，未改动 `:3000` 默认 mock 配置。
10. Help Desk：工单、申诉和路线图表单可加载。确认 Dev User 是 `internal`，服务端拒绝客户历史是正确的数据分区；修复了前台把这个稳定权限边界显示成可重试故障的问题。真实客户历史链路已有集成覆盖，本轮没有重新创建客户账号做浏览器写入。
11. Admin Today：权威投影可加载，阻塞项排序可解释。修复了 `我的班次 0` 容易被误读的问题，改为 `我的今日队列`；同目标、同用途且相邻的 Creative Run 现在聚合显示，首个最高优先事项保持可见，其余仍可展开独立处理；中文班次中的系统状态、动作、排序理由、日期与数据分级已中文化，运营填写的标题和权威 ID 保留原文。旧 SLA 案例仍需由运营在来源域处置。
12. Character portfolio / overview：角色范围、状态与最近媒体生产可查看；列表中存在多项审计 fixture 残留。
13. Assets：视觉身份版本、参考集、候选采用、证据审计可用；生成成功不会自动变成审核或发布。
14. Release preview：Live / Draft 并排渲染正常；新增紧凑的发布差异摘要，明确首发、无变更或与 Live 不同的字段类别，不改变 QA、Release 或 Serving 权威。
15. Release control：未完成上线 QA 时发布被正确阻断。本轮未勾选确认、未发布、未回滚。修复了发布检查项和媒体恢复状态直接显示内部英文 key 的问题。
16. 390px 移动端复测：Explore、Alexa Reeves 详情、已有 Chat、Admin Today 与后台抽屉导航均无页面级横向溢出；主行动、消息输入、底部导航、工作模式与运营队列保持可见可操作。
17. 焦点可见性：发现 Explore 的移动和桌面搜索框清除了原生 outline，却没有替代焦点反馈；已为两处搜索容器补上统一的 2px 高对比焦点环，并在浏览器运行态复验。
18. 768px Explore：桌面侧栏已占用 220px 时，300×322 的浮动升级卡仍覆盖约三分之一内容区，同时侧栏和网格内已有两个 Upgrade 入口；已把浮层调整为只在 `lg` 以上出现，保留平板已有转化入口且不阻挡发现浏览。
19. 768px Character detail：详情 Hero 在中等断点提前切换为桌面排版，导致 Like / Report 仍可聚焦却被卡片裁切；已让紧凑排版延续到平板，四个动作全部在可见边界内。
20. 768px Admin Today：页面无横向溢出，但未定义的 `--ad-accent` 让当前选中的“摘要”、`认领`按钮及 Experiments 的主按钮变成白字透明底；已统一使用现有权威色 `--ad-ink`，当前视图和主操作重新可见。
21. 200% 等效重排：以 1280px 桌面宽度的一半（640px CSS 视口）复测 Explore；筛选器、升级入口、双列角色卡和底部导航均重排，无页面级横向溢出。
22. 200% 等效角色详情：Alexa Reeves 的标题、描述和 Chat / Generate / Like / Report 四个动作都在首屏可见边界内，无横向溢出。
23. Character Review：640px 下原表格只能横滚，最关键的 Approve / Reject 操作藏在最右侧，滚动容器也不能键盘聚焦；已把操作列固定在右侧，为滚动区补上名称和焦点入口，并补齐性别、风格等中文表头。
24. Generation Jobs：密集任务表在 640px 下保持操作列可见、每行详情可进入；修复了 `Unknown review`、`captured`、`cancelled` 等状态及汇总指标混入英文的问题。
25. Generation Job detail：Request / Attempt / Delivery / Settlement 权威详情可在窄布局继续纵向阅读；表格标题、列名和状态已中文化，事件类型和权威 ID 作为技术证据保留原值。
26. Explore 慢网与中断：2.5 秒延迟下，筛选更新原来错误显示为 `Loading more characters...`，容易被理解成分页追加；现已区分首次加载与筛选刷新，并给结果区增加忙碌语义。角色接口中断仍显示明确错误、Retry，恢复网络后可原位重试。
27. Chat 慢网与中断：路由加载、会话列表失败和恢复路径均可读；会话接口中断时，已有会话区显示断言式错误和 Retry，同时独立的推荐角色入口继续可用。恢复后原位重试成功，无代码修复需要。
28. Generate 配置中断：原页面在配置权威失联时仍显示“无锁定身份”“无任务”“无媒体”等伪业务事实；现改为隐藏未解析的角色身份，并在 Jobs / Gallery 明确说明依赖失联和重试路径。恢复配置后，角色、任务和图库重新加载。
29. Admin Today 慢网与中断：原页面刷新时无反馈，刷新失败继续静默展示旧队列；首次加载失败还直接暴露 `Failed to fetch`。现已标注“正在刷新并显示上次快照”、刷新失败、首次加载失败及 Retry，恢复网络后可原位回到权威队列。
30. 真实付费图片：Dev User 从 242 coins 实扣到 234；Job `cmsu0jpa4000oj7l7j3zd2xlx` 经 `qwen-image-edit-img2img@1`、ComfyUI request `2014f7ed-f408-49f2-8315-56122c134146` 在约 102 秒完成。Attempt、TerminalRecord、Artifact、user_library Delivery 与 Ledger 全部一致；用户点击 `Looks like them` 后，`identity=match` feedback revision 1 已持久化。
31. 真实语音：免费账号被 `voice_enabled` 权益正确阻断；Deluxe 验收账号真实生成并播放 Fish Audio。最新短回复产物使用 `fish-audio-s2-pro-8bit` / `fish-female-default`，时长 5.879 秒，约 46.1 秒完成，WAV 落库并计入套餐内用量，Dreamcoin 成本为 0。
32. 真实付费视频：Deluxe 验收账号从 6,142 coins 实扣到 6,042；Job `cmsu11sal001uj7l7kuc94vnb` 经 `ltx23-gtanimation-i2v@1`、ComfyUI request `f75e5ff9-1ee6-40eb-8b0c-a300a1f71813` 在 473.734 秒完成。产物为 768×1152、3.88 秒 H.264/AAC MP4；Attempt、TerminalRecord、Artifact、Delivery 与 Ledger 全部一致，图库可加载和播放。
33. 视频语义复核：文件抽取的 0.05 / 0.65 / 2.7 秒帧证明产物不是黑片；应用内浏览器截图未捕获视频合成层，不能据此误判。真实偏差是 I2V 只动画当前角色主图，无法把白天游艇首帧替换为提示中的雨夜港口，而旧 UI 却写成 `Scene Prompt` / `Auto (identity-aware)`。
34. 视频产品契约修复：前台现在直接展示实际首帧，改用 `Animate this image`、`Motion direction`、`Auto (animate source)`，并明确不会替换服装、光线或地点；视频 queued / running 卡片增加“通常 6–10 分钟”的分钟级预期。真实浏览器复验通过。
35. 语音转化修复：免费账号缺少语音权益时，原 CTA 错写成 `Upgrade for unlimited messages`；现根据能力阻断原因显示 `Upgrade for voice access`，返回当前 Chat 的 `returnTo` 保持不变。真实浏览器复验通过。
36. 视频 worker 运营日志：本轮新请求正常完成，但一个旧 Bull 失败源 `dedupe_Z2VuZXJhdGlvbjpjbXMwZXlkYncwMDFnbW1sN3p4aDQyaXoz` 因 `invalid_schema` 被每分钟重复扫描并记录 warning。这是历史残留的运营噪声，不是本轮视频的失败；现有工具要求先 dry-run、再由操作者用理由和精确确认文本承认该残留，本轮未擅自改写历史状态。
37. 真实测试网购买：Launch Audit 用户从 iDream Upgrade 创建 $19.99 Premium monthly 发票 `Bw6ug2E78Hiz8cGitHQC6D`；为让公共 faucet 可覆盖支付，BTCPay 沙箱固定使用 `BTC_USD=1000000` 测试汇率。Testnet3 交易 `1b36dad317ce0c3b0797d344e9f0eab101d901dec1de992a2fd16b625f4119ec` 支付 5,500 sats，发票进入 `Settled (paid over)`。
38. 回调与权益结算：签名 webhook 经受限 Cloudflare Quick Tunnel 到达本地 BFF；checkout `cmsu41bsi000byel7f6f8eno6` 完成，Premium 订阅激活至 2026-09-15，7 项权益生成，Dreamcoin 从 250 一次性增加 1,500 至 1,750。未出现重复订阅、重复 grant 或多条同幂等键 Ledger。
39. `PaidOver` 终态修复：真实 webhook 只有 `overPaid=true`、没有 `additionalStatus`；旧实现对已绑定发票跳过 provider lookup，把产品终态错误保存为 `none`，严格探针拒绝通过。现改为结算时用 provider 发票作为金额、币种、订单身份和 additional status 权威；已处理 webhook 的重放也能修复旧的错误状态，同时不重复发权益。
40. 重放与严格探针：同一 `InvoiceSettled` 手工重投两次，共 3 次独立 delivery；产品只保留 1 个业务事件、1 个 active subscription、1 个 subscription grant，严格支付探针 `authorityVersion=payment_product_settlement_v1` 返回 `ok=true`、`replayVerified=true`、`providerInvoiceAdditionalStatus=paid_over`。
41. 权益真实消费：浏览器为 Mara Vale Launch 提交 1 次 ComfyUI 图片，Job `cmsu4jaol000uyel779hfu3wz` 完成并进入 Gallery；Ledger 实扣 8 coins，余额从 1,750 收敛到 1,742，证明新订阅权益不是只停留在资料页文案。
42. 超额付款退款：BTCPay 为超额的 3,501 sats 创建 Pull Payment、客户提交领取地址、运营以 1 sat/vB 签名并广播交易 `635da19e520fce006c37123147b568e5265068684d239f61413351fde27b8951`；链上输出与目的地址、金额一致，随后在 Testnet3 区块 `5121585` 确认。它只退回沙箱超额款，不撤销 $19.99 订阅。截至这一步，iDream 还没有普通已完成订阅的退款命令、provider refund 契约、退款事件投影、订阅/权益回收和 Dreamcoin 结算，因此不能把这一步表述成完整订阅退款闭环；步骤 44–52 随后补齐并复验了该链路。
43. 运行时恢复：审计清理阶段发现 PM2 daemon 的进程表为空；generation cutover 检查证明当时没有 active request、in-flight Bull row 或待投递 terminal outbox。原有 ComfyUI 注册方式会把含空格和括号的 Python 路径交给 shell，连续重启失败。现增加 argv-safe launcher 与 `bun run comfyui:start`，恢复 ComfyUI 0.33.0 / MPS 8188 后，再通过受保护的 `bun run pm2:start` 恢复完整开发拓扑；主站、Admin、ComfyUI HTTP 均为 200，2 个 image worker、1 个 video worker 与 Redis ownership 一致，队列已恢复并保存 PM2 dump。
44. 正常订阅退款入口：Admin Billing 使用独立 `billing.subscription.refund` 权限，只允许对已结算的 prepaid subscription 发起全额退款；二次确认明确展示 `$19.99`、立即冻结访问、精确冲销本次 1,500 Dreamcoin grant，已消费的 8 Dreamcoins 不返还。
45. 真实金额缺陷拦截：第一版 BTCPay adapter 使用 `RateThen`，真实 Pull Payment 显示 5,500 sats，会把已经单独退过的 3,501 sats 超额款再次退回。浏览器在客户领取前发现并停止；运营归档该 Pull Payment，未产生 payout。代码改为 `Custom amount=19.99 currency=USD`，并在 provider 回读与投影层同时拒绝金额或币种不一致。
46. 取消恢复：归档未领取 Pull Payment 后，iDream 将退款投影为 `canceled`，订阅重新 active、权益恢复，并用 `subscription_refund_restore +1,500` 把余额恢复到 1,742；同一订阅可用新 command id 重试，旧命令和新命令的 reversal/restore 幂等键互不覆盖。
47. 精确重试：Admin 重新发起全额退款后，BTCPay Pull Payment `2EiJiut5j5e3BNDWRB6KFY2taXfh` 显示精确 `$19.99 USD`；iDream 再次冻结访问、清空订阅权益，并用新的 `subscription_refund -1,500` 把余额收敛到 242。
48. 客户领取与链上付款：客户向 Testnet3 地址提交领取；运营钱包以 1 sat/B 签名，输出 1,999 sats、手续费 141 sats，广播交易 `f2539afb5a1390dd1d99936302eab3a742569e2b089fbd794a0544153fa89cfe`。BTCPay payout 从 awaiting → in progress → completed。
49. Webhook 收敛：临时受限 webhook 自动把 `in_progress` 与 `completed` 投影回 checkout/subscription；最终 checkout=`refunded`、`needsReconciliation=false`，subscription=`refunded`、entitlement=0，退款证据保存 `$19.99 USD`、payout id、command id、provider reference、完成时间和余额 242。
50. 用户完成态：真实退款用户重新登录后显示 `242 dreamcoins · Free`、无付费访问，并明确显示 `Full refund completed · 1,500 Dreamcoins reversed · balance 242`；完成态不再暴露领取按钮。
51. 运营完成态：Admin 中文计费台同时显示 subscription=`已退款`、refund=`已完成`、provider refund id 与账本 `-1,500 / +1,500 / -1,500`，最终 balanceAfter=242。宽表的操作列固定在右侧，关键退款动作与结果不再被横向裁掉；新退款确认、按钮和状态文案已中文化。
52. 外部与本地清理：用于补足钱包的测试网 faucet 余款已全额归还，BTCPay 钱包归零；临时 API key、webhook、Quick Tunnel 与凭据文件已删除，main-web 已恢复 `PAYMENT_PROVIDER=mock`，新 PM2 进程环境中不存在临时 `BTCPAY_*` 变量，测试用户 `dataClass` 已恢复为 `fixture`。
53. 退款并发权威复核：独立 Spec review 发现 `refund_pending` 等待客户领取期间仍可能购买新套餐，而旧退款取消会盲目恢复旧订阅。现于 checkout intent、provider dispatch、settlement activation 三层阻断或隔离新订阅；取消恢复前锁定用户并拒绝 competing active subscription，避免双 active 与旧套餐覆盖当前权益。
54. 退款金额 fail-closed 复核：取消态此前跳过金额校验，BTCPay completed 聚合也可能忽略额外的跨币种 payout。现对 `claimable/in_progress/completed/canceled` 全状态校验根金额/币种，拒绝任一跨币种 payout 与 live 累计超额；两个独立 P0 经 Spec 复核均已关闭。
55. Billing 可恢复筛选：Admin Billing 服务端首屏与浏览器 URL 状态此前可能产生 hydration 分歧，直接打开带筛选器的运营书签不稳定。现首屏使用确定性默认查询，挂载后恢复 URL 筛选；共享 Zod 契约统一 Main 列表/命令响应与 Admin 解析，mounted 回归覆盖无 hydration 错误和书签恢复。
56. 运行态清理复核：首次清理只把 `BTCPAY_BASE_URL` 留成空字符串，旧 PM2 进程仍覆盖本地 mock 配置，导致 Main 动态 API 模块加载返回 500。经受保护的队列 drain/fence 停止并新建整套 PM2 拓扑后，临时变量已从进程环境消失；Main 动态角色 API 返回预期 age-gate 403，Admin 307、Chat `/readyz` 200、Fish `/health` 200，全部服务 online，2 个 image worker 与 1 个 video worker ownership 保持一致。

## 本轮已修复

| 优先级 | 问题 | 改进 | 浏览器复验 |
| --- | --- | --- | --- |
| P0 | 公共角色生成页永久显示 `Loading saved Looks…` | 非所有者明确结束 Looks 权威加载，同时不伪造“没有保存的 Looks” | 通过 |
| P1 | 创建页标题与可选性别矛盾 | `Create Your Dream AI Character` | 通过 |
| P1 | 搜索占位词带有物化、族裔化表达 | 改为意图和题材导向示例 | 通过 |
| P1 | My AI 媒体卡暴露内部 ID 和运行时 prompt | 回退为 `Generated image/video/voice clip`，隐藏内部 prompt 卡片摘要 | 通过 |
| P1 | Release 与媒体恢复状态夹杂内部 key / 英文 | 映射为运营可读标签并补齐中文 | 通过 |
| P2 | `我的班次` 与实际“今日到期/超时”语义不一致 | 改为 `我的今日队列` | 通过 |
| P2 | 非客户账号的历史权限边界显示为可重试故障 | 改为明确的客户账号说明，禁用无意义的刷新与 Retry | 通过 |
| P1 | Today 前十被同目标、同用途的重复 Creative Run 淹没 | 只聚合相邻同类批次，保留服务端顺序、完整计数、首项操作及每条深链 | 通过 |
| P2 | Release Preview 需要人工扫描两整页判断草稿差异 | 增加首发 / 无变更 / 字段类别差异摘要，复用服务端 `changedFields` 权威 | 通过 |
| P2 | Today 中文班次混入系统英文状态、动作和 ISO 日期 | 只本地化结构化运营元数据并格式化日期，记录标题与 ID 不翻译 | 通过 |
| P2 | Explore 标题与年龄的辅助技术名称粘连 | 为标题提供完整的 `名称, age 年龄` 可访问名称，视觉文案不变 | 通过 |
| P1 | Explore 搜索框获得焦点后没有可见反馈 | 移动与桌面搜索容器统一显示 2px 高对比焦点环 | 通过 |
| P1 | 768px Explore 浮动升级卡遮挡发现网格且与另外两个入口重复 | 浮层只在 `lg` 以上显示，平板保留侧栏和网格内 Upgrade 入口 | 通过 |
| P1 | 768px 角色详情的 Like / Report 可聚焦但被 Hero 裁切 | 平板继续使用紧凑排版，完整动作组到 `lg` 才切桌面布局 | 通过 |
| P1 | Admin 未定义 `--ad-accent` 导致选中态和主按钮视觉消失 | Today 与 Experiments 改用已有 `--ad-ink` 设计令牌 | 通过 |
| P1 | 200% 等效宽度下审核决策操作藏在横滚最右侧，滚动区无键盘入口 | 操作列固定在可见右侧；滚动区增加可访问名称和 `tabIndex=0` | 通过 |
| P2 | Generation Jobs 列表与详情混入内部英文状态、指标和列名 | 统一通过 Admin i18n / 枚举值通道显示运营中文，保留不可翻译的事件标识 | 通过 |
| P2 | Explore 筛选刷新被错误描述成“加载更多” | 区分首次加载与筛选刷新，结果区同步暴露 `aria-busy` | 通过 |
| P1 | Generate 配置失联被投影成“无身份 / 无任务 / 无媒体” | 隐藏未解析身份，Jobs / Gallery 改为依赖失联说明与 Retry | 通过 |
| P1 | Today 慢网刷新和刷新失败对运营不可见，首次失败暴露技术错误 | 明确旧快照、刷新中、刷新失败和首次失败状态，并提供原位重试 | 通过 |
| P1 | I2V 把固定首帧动画包装成可重新描述场景的生成器 | 展示真实首帧，把输入改为 Motion direction，自动模型改为 source animation，并提供 6–10 分钟预期 | 通过 |
| P2 | 语音权益阻断后的升级 CTA 错误指向“无限消息” | 按阻断能力显示 `Upgrade for voice access`，保留 Chat 返回路径 | 通过 |
| P0 | BTCPay `PaidOver` 在已绑定发票路径被降格为 `none`，严格终态无法对账 | 结算前回查 provider 权威发票；首投与已处理重放都收敛 exact additional status，且不重复发放权益 | 通过：真实支付、3 次 delivery、严格探针与 67 个支付相关测试 |
| P0 | 正常已结算 prepaid subscription 没有全额退款、撤权和 Dreamcoin 冲销权威 | 增加专用权限、幂等 Admin command、provider refund 契约、exact grant reversal/restore、webhook/轮询收敛与用户完成态 | 通过：真实 `$19.99` BTCPay Testnet 退款、取消恢复、重试、链上完成和数据库对账 |
| P0 | BTCPay `RateThen` 会按原始 5,500 sats 全退，与已完成的 3,501 sats 超额款退款重叠 | 改用 `Custom $19.99 USD`；provider create/read/project 三层拒绝非精确金额与币种，归档未领取错误单后才允许新 command 重试 | 通过：错误单未领取即归档；精确输出 1,999 sats 完成 |
| P0 | `refund_pending` 期间可新购，取消旧退款会复活旧订阅并覆盖当前权益 | checkout intent / dispatch / settlement 三层阻断或隔离；取消恢复拒绝 competing active subscription | 通过：独立 Spec 复核与 75 个 focused tests |
| P0 | 取消态和额外跨币种 payout 未完全执行退款金额 fail-closed | 全状态精确校验根金额/币种、每笔 payout 币种和累计金额 | 通过：取消金额不一致、跨币种和累计超额回归 |
| P1 | Admin Billing 宽表把退款动作裁在最右侧，中文确认框夹杂英文 | DataTable 可选固定最后一列；退款动作、确认、对账、完成态走 Admin i18n / enum value 通道 | 通过：完成态浏览器复验与 25 个 Admin focused tests |
| P1 | Billing 带筛选 URL 的服务端首屏与客户端初始化不一致 | 首屏固定默认查询，挂载后恢复 URL；Main/Admin 共用 shared Zod 契约 | 通过：mounted hydration 与筛选恢复回归 |
| P1 | ComfyUI PM2 进程丢失后没有可复现的注册入口，含空格/括号的 Python 路径经 shell 启动失败 | 新增直接 `spawn` 的 argv-safe launcher、根级启动命令和运维 runbook；不经 shell 解释模型与用户目录路径 | 通过：launcher 回归、ComfyUI 0.33.0 / MPS、全拓扑恢复与 ownership 探针 |
| P1 | 清理后旧 PM2 进程仍携带空的 `BTCPAY_BASE_URL`，覆盖 mock 配置并让动态 API 返回 500 | 通过既有 fence/drain 停止并全新启动 PM2 拓扑，确认临时变量不在进程环境 | 通过：动态 API 预期 403、Admin/Chat/Fish 健康检查与 worker ownership |

## 产品与运营判断

### 做得好的部分

- 用户链路从发现角色到详情、历史会话、生成和媒体库是连通的。
- 真实计费媒体链路已从 Request → Attempt → TransportExecution → TerminalRecord → Artifact → Delivery → Settlement 做到逐层对账；本轮共实际消费 108 Dreamcoins，没有重复扣费或异常重试。
- CharacterWorkspace 把生产、审查、草稿资产包、QA、Release 和 Serving 分开，关键边界没有被 UI 偷偷合并。
- Release 在 QA 不完整时 fail closed，并明确提示不可逆、用户可见。
- Today 页面公开数据来源、产品时区、新鲜度和排序策略，便于运营解释“为什么它排在这里”。
- BTCPay 建单、链上付款、签名 webhook、订阅、权益、Dreamcoin grant、回调重放和一次真实消费已在同一受控账号上闭环；严格探针在真实 provider lookup 后通过。
- 正常 prepaid subscription 的 Admin 全额退款、立即撤权、精确 grant 冲销、取消恢复、重新发起、客户领取、链上支付、webhook 收敛、用户/运营完成态和测试资金清理已在同一账号闭环。

### 仍需处理的高影响问题

1. **P1 · 上线验证内容占据公开首位**：`cleanup:public-content` dry-run 为 0，证明 Mara / Chrome Launch Audit 不是 audience-invalid fixture，而是完整发布链路产生的真实上线验证内容。是否改名、降权或转为 unlisted 是编辑运营决策，不能用通用 fixture 清理脚本误伤。
2. **P1 · 公开生产支付仍未批准**：真实闭环使用公共 Testnet Demo、固定沙箱汇率、临时 Quick Tunnel 和测试币；它证明代码与操作链路，不证明主网钱包、正式域名、生产密钥、真实汇率、通知、对账、canary/backfill 和观察窗口。
3. **P2 · 旧视频失败源持续制造告警噪声**：当前 worker 每分钟重复报告同一个 `invalid_schema` 失败源，容易掩盖新故障。应使用现有 `generation-cutover:acknowledge-failed-source-residue` 的 dry-run → 人工确认流程处置，不应直接删队列记录或降低告警级别。

## 可访问性观察

- 页面主标题、导航、表单 label、按钮名称和 Release tab 语义整体可读。
- Explore 卡片外层链接和内层 heading 现在都有自然的完整名称；浏览器 DOM snapshot 确认内层 heading 为 `Alexa Reeves, age 19`。
- 390px 下的 Explore → Character detail → Chat 与 Admin Today → 移动导航，以及 768px 下的 Explore → Character detail 与 Admin Today，已完成重排、溢出和可操作性检查。
- 640px 下完成 200% 桌面宽度等效重排检查；审核表滚动区域现在可聚焦，关键操作列始终在可视侧。
- 搜索框焦点前后已用浏览器截图和计算样式复验；当前浏览器自动化按键通道没有推进 Tab 顺序，因此没有把“全站键盘流程”误报为通过。
- 本轮已用 2.5 秒延迟和定点接口阻断验证 Explore、Chat、Generate、Admin Today 的加载、失败与恢复；这证明应用状态表达，不等同于真实移动网络性能基准。
- 本轮仍未完成真实屏幕阅读器、桌面浏览器原生菜单缩放或全站键盘顺序验证；截图和 DOM snapshot 不能替代 WCAG 或完整性能验证。
- 缩放结论来自 640px CSS 宽度的等效重排和 2× visual viewport 指标；应用内浏览器不能设置并持久化桌面浏览器菜单中的站点缩放值，因此不把它表述为 Chrome 菜单缩放的完整替代。

## 证据边界

- 用户已明确授权常规按量 API / 模型 / 生成与支付请求；本轮用受控账号真实发送 Chat，执行 2 次 8-coin 图片、1 次套餐内 Fish Audio 语音、1 次 100-coin LTX 视频，并完成 1 次 BTCPay Testnet3 购买、1 次超额款退款和 1 次正常 `$19.99` subscription 全额退款。
- 未提交工单、关注、公开合集，也未执行 Release 发布、回滚或账号删除。
- 管理后台除原有开发环境检查外，本轮进入 BTCPay 沙箱完成发票、webhook 重投、超额款退款、正常订阅退款、取消恢复和最终 payout；测试网交易无真实货币价值。
- 本轮证据证明本机受控 beta 与 BTCPay 测试网的浏览器闭环，不证明真实域名、生产密钥、主网钱包、真实汇率、生产 provider、canary / backfill 或线上观察窗口。
- BTCPay 测试汇率固定为 `BTC_USD=1000000` 只为兼容公共 faucet；因此 $19.99 套餐价格的 UI/订单一致性可验证，不能从该交易推导真实市场 BTC 金额或生产手续费。
- 临时 Quick Tunnel 只允许转发到精确 webhook 路径；它是测试传输证据，不是生产 ingress 方案。
- 支付沙箱 API key 与 webhook 已删除，Quick Tunnel 已停止，main-web 已恢复 mock provider；临时凭据文件已删除。BTCPay 沙箱 store、发票、退款和测试币归还交易保留作审计证据。
- 公开内容清理仅执行 dry-run；计划为 0 个角色、0 个合集、0 个反馈项，没有修改数据库。
- 慢网验证只在应用内浏览器临时注入延迟或阻断指定 GET 接口；结束时已恢复网络条件，没有通过代理或服务端改写制造结果。
- 视频播放器截图中的灰黑区域是浏览器截图工具未捕获视频合成层；本轮用实际 MP4 的多时间点帧抽取和 ffprobe 校验补充，不把截图限制当作产品黑片。

## 截图证据

### 用户主链路

![Explore](01-user-explore.png)

![Character detail](02-character-detail.png)

![Existing chat](03-character-chat.png)

![Generator before fix](04-character-generator-loading-look.png)

![Generator after fix](15-postfix-character-generator.png)

![Create before fix](11-user-character-create.png)

![Create validation](12-create-validation.png)

![Create after fix](14-postfix-character-create.png)

![Feed](16-user-feed.png)

![Community](17-user-community.png)

![Profile](18-user-profile.png)

![User library after fix](21-postfix-user-library.png)

![Upgrade](19-user-upgrade.png)

![Help Desk](20-user-helpdesk.png)

![Help Desk non-customer boundary after fix](22-postfix-helpdesk-history.png)

### 运营主链路

![Admin Today](05-admin-today.png)

![Admin Today grouped Creative Runs after fix](23-postfix-admin-today-grouped.png)

![Admin Today language before fix](25-before-admin-today-language.png)

![Admin Today localized operational metadata](27-postfix-admin-today-language.png)

![Character portfolio](06-admin-character-portfolio.png)

![Character overview](07-admin-character-overview.png)

![Character assets](08-admin-character-assets.png)

![Release preview](09-admin-release-preview.png)

![Release preview change summary after fix](24-postfix-admin-release-change-summary.png)

![Release control before fix](10-admin-release-control.png)

![Release control after fix](13-postfix-admin-release.png)

### Explore 语义与固定视口复测

![Explore before heading semantics fix](26-before-explore-semantics.png)

![Explore after heading semantics fix](28-postfix-explore-heading-semantics.png)

### 移动断点与焦点复测

![Mobile Explore](29-mobile-explore-before.png)

![Mobile character detail](30-mobile-character-detail-before.png)

![Mobile existing chat](31-mobile-chat-before.png)

![Mobile Admin Today](32-mobile-admin-today-before.png)

![Explore search focus before fix](33-keyboard-explore-focus.png)

![Mobile Admin navigation](34-mobile-admin-navigation.png)

![Desktop Explore search focus after fix](35-keyboard-explore-focus-after.png)

![Mobile Explore search focus after fix](36-mobile-explore-focus-after.png)

### 平板断点复测

![Tablet Explore before obstruction fix](37-tablet-explore.png)

![Tablet character detail before clipping fix](38-tablet-character-detail.png)

![Tablet Explore after obstruction fix](39-tablet-explore-after.png)

![Tablet character detail after clipping fix](40-tablet-character-detail-after.png)

![Tablet Admin Today before selected-state fix](41-tablet-admin-today.png)

![Tablet Admin Today after selected-state fix](42-tablet-admin-today-selected-after.png)

### 200% 等效重排与密集后台表格

![Explore at 200 percent equivalent width](45-zoom-equivalent-explore.png)

![Character detail at 200 percent equivalent width](46-zoom-equivalent-character-detail.png)

![Character Review before sticky actions](47-zoom-equivalent-admin-review.png)

![Generation Jobs before localization](49-zoom-equivalent-admin-jobs-table.png)

![Generation Job detail before localization](50-zoom-equivalent-admin-job-detail.png)

![Character Review after sticky actions and localized headers](51-zoom-equivalent-admin-review-after.png)

![Generation Jobs after operational localization](52-zoom-equivalent-admin-jobs-localized.png)

![Generation Job detail after operational localization](53-zoom-equivalent-admin-job-detail-localized.png)

### 慢网、接口中断与恢复

![Explore filter refresh before wording fix](55-resilience-explore-slow-loading.jpg)

![Explore retryable character API failure](56-resilience-explore-error.jpg)

![Chat slow route and session loading](57-resilience-chat-route-loading.jpg)

![Chat retryable session API failure](58-resilience-chat-error.jpg)

![Generate dependency failure before truthful-state fix](60-resilience-generate-error-before.jpg)

![Today refresh failure before visible stale-state warning](62-resilience-today-refresh-error-before.jpg)

![Today initial failure before friendly recovery copy](63-resilience-today-initial-error-before.jpg)

![Generate dependency failure after truthful-state fix](64-resilience-generate-error-after.jpg)

![Explore filter refresh after wording and busy-state fix](65-resilience-explore-slow-refresh-after.jpg)

![Today slow refresh after stale-snapshot status fix](66-resilience-today-slow-refresh-after.jpg)

![Today refresh failure after visible stale-snapshot warning](67-resilience-today-refresh-error-after.jpg)

![Today initial failure after friendly retry state](68-resilience-today-initial-error-after.jpg)

![Today recovered after retry](69-resilience-today-recovered.jpg)

### 真实写入、付费生成与修复复验

![Real image generation before submit](70-real-write-generate-start.jpg)

![Real image queued and charged](71-real-write-image-queued.jpg)

![Real image completed and delivered](72-real-write-image-complete.jpg)

![Real Chat streaming](73-real-write-chat-streaming.jpg)

![Real Chat completed](74-real-write-chat-complete.jpg)

![Free account voice entitlement gate before copy fix](75-real-write-voice-entitlement-gate.jpg)

![Paid Chat reply ready for voice](76-paid-account-chat-ready.jpg)

![Real Fish Audio playing](77-real-fish-audio-playing.jpg)

![Real video request before submit](78-real-video-before-submit.jpg)

![Real video queued and charged](79-real-video-queued.jpg)

![Real video completed and delivered](80-real-video-complete.jpg)

![Real video player activated](81-real-video-playing.jpg)

![Extracted real video frame at 0.65 seconds](85-real-video-extracted-frame-0650ms.jpg)

![Extracted real video frame at 0.05 seconds](86-real-video-extracted-frame-0050ms.jpg)

![Extracted real video frame at 2.7 seconds](87-real-video-extracted-frame-2700ms.jpg)

![Video source contract after fix](88-video-contract-fixed.jpg)

![Voice upgrade CTA after fix](89-voice-upgrade-copy-fixed.jpg)

### 真实 BTCPay 结算、权益与退款

![BTCPay provider upgrade](91-btcpay-live-upgrade.jpg)

![BTCPay invoice before payment](92-btcpay-invoice-open.jpg)

![Settled Premium subscription and 1,750 coins](93-payment-settled-profile.jpg)

![BTCPay invoice paid over](94-btcpay-invoice-paid.jpg)

![Paid entitlement consumed by a real ComfyUI image](95-payment-entitlement-consumed.jpg)

![BTCPay overpayment refund completed](96-btcpay-overpayment-refund-completed.jpg)

![Admin subscription refund before action](97-admin-subscription-refund-before.jpg)

![Admin full-refund confirmation](98-admin-refund-confirmation.jpg)

![Admin full-refund confirmation ready](99-admin-refund-confirmation-ready.jpg)

![Admin refund claimable state](100-admin-refund-claimable.jpg)

![Customer refund claimable state](101-profile-refund-claimable.jpg)

![Browser-detected RateThen over-refund defect](102-btcpay-refund-overamount-detected.jpg)

![Exact Custom 19.99 USD refund claim](103-btcpay-exact-refund-claim.jpg)

![BTCPay exact subscription refund completed](104-btcpay-refund-completed.jpg)

![Customer exact refund completed](105-profile-refund-completed.jpg)

![Admin exact refund completed with sticky authority column](106-admin-refund-completed.jpg)

![Testnet faucet surplus returned and wallet zeroed](108-btcpay-faucet-balance-returned.jpg)

## 验证命令

- 根级 `bun run test`：Shared 258、Admin 603、Chat 348、Gen 202、Main 2,506，合计 3,917 个测试通过；Main 另有 3 个显式 process-chaos 测试跳过，命令退出码 0。
- 根级 `bun run check`：5 个包的 lint / typecheck 与 Admin、Main 的 Next.js 16.2.1 production build 全部通过。
- `bun run test:pm2-config`：85 个 PM2、源码身份、worker ownership、恢复与 ComfyUI launcher 测试全部通过。
- `bun run probe:gen-image-ownership`：2 个 image worker、1 个 video worker，PM2 / OS / Redis identity 全部一致；`packages/gen` preflight 检查 7 个 descriptor、12 个模型引用，0 个问题。
- 运行态复核：Main 动态角色 API 返回预期 age-gate 403、Admin 根路由 307、Chat `/readyz` 200、Fish `/health` 200；PM2 11 个实例全部 online，全部进程环境的 `BTCPAY_*` 键集合为空，`packages/main/.env` 为 `PAYMENT_PROVIDER=mock`。
- `git diff --check`：通过。
- 真实支付严格探针：`ok=true`、`providerLookupVerified=true`、`replayVerified=true`，3 次 delivery、1 个 active subscription、7 项 entitlement、1 条 subscription grant。
- 订阅退款 focused 回归：Billing lifecycle、BTCPay adapter 与 subscription refund integration 共 75 个测试通过，覆盖 `refund_pending` checkout 阻断、晚到结算隔离、competing active 防御、精确 `Custom` 金额、取消态不一致、跨币种/累计超额拒绝、归档恢复与第二次 command 重试；Standards 与 Spec 双轴复核均无新增 finding。
