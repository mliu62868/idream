# 产品与架构改进

用户于 2026-09-10 要求根据完整产品审计实施修复与改进。此前审计补丁保留；本文追踪新增实施，不把功能缺口改写为已完成。

## 实施范围

| 原事项 | 实施与验收状态 |
| --- | --- |
| 01 Chat → Generate | 已实现并通过 5 项集成；真实无源图接续生成成功、8 coins 一次结算。正统一 Chat/Comic 来源协议，随后复验原图接续 |
| 02 群聊、主动互动、会话档位 | GroupConversation + 独立角色 session/统一 Turn 顺序及 UI 已实现，集成验证中；主动互动与完整档位尚未完成 |
| 03 Chat Video、Voice Call | Chat Video 实施中，复用报价、生成与媒体交付权威；双向 Call 与正式计量/费率未完成 |
| 04 生成控制与目录 | seed、合格角色模型选择、未知提交精确恢复已实现；prompt 改变立即使旧报价失效，300ms 合并连续输入；更深批量/多场景/视频参数仍未完成 |
| 05 Coin Store | 版本化商品、Admin v2 审计发布、商店/发票历史/未知提交恢复、provider 确认一次到账已实现并集成验证；没有发布真实商品，退款/商业规则及真实收款仍未完成 |
| 06 Comic/Creator/Packs/内容供给 | Comic 章/页、作者编排、Admin v2 审核、公开阅读与独立媒体权限已实现，10 项集成通过；正在实现有许可的实际 Remix；经济、Pack 与公开内容供给审计未完成 |
| 07 Affiliate | 资格、归因、佣金/结算规则待输入；不能用 referral 冒充 |
| 08 生产认证 | 缺目标环境；本地验证与生产认证分开 |
| 10 账号验证/恢复 | 邮箱验证码、重发限流、密码找回/撤销旧会话已实现；13 项新集成 + 15 项旧账号/删除集成通过。真实邮件服务未配置/未发送，不把 mocked transport 当送达证据 |

## 验证约束

- Main 默认集成测试重建专用测试库，串行执行；浏览器测试与全量 build 不并行，避免删除 Next 测试目录。
- 新能力先覆盖真实失败模式与权限/并发/重放，再用受控账号验证。真实生成沿用已授权最低充分规格；不执行购买、第三方转账或公网发布。
- 最终报告绑定源 revision、记录测试、真实 provider 交付和未验证边界。

## 本轮新增证据（整合期间，尚非最终冻结版本）

- 真实 Chat 接续：job `cmtuxk5ey005kppl7me3ig3kr`、attempt `cmtuxk5go005qppl7vgmzfk10`，ComfyUI `qwen-image-edit-img2img`，832×1024、seed `20260910`，131.874 秒，balance 127→119；媒体已持久化并在 Chrome 检视。
- Coin: `coin-purchases-integration.log` 8/8；`coin-billing-integration.log` 原 billing 50/50。首次 Coin 测试有一处夹具错误，误用不存在的 `invoice_created`，按既有 `created` 状态修正后重跑 8/8。
- Coin UI: 6 项挂载回归 + 3 项 auth redirect 回归通过；Admin 合约注册 3/3。实际响应必须通过严格 DTO 才可清除未知付款回执。
- 当前开发库迁移为 87 项：新增 Comic、GroupConversation、Comic Remix 权限和 CoinOffer，均在确认 localhost 专用开发库后通过正式迁移命令应用。没有更改生产数据库。
- 源码整合完成前暂停真实 Chat 请求，待 PM2 wrapper 重启 Main 清除旧 Prisma 客户端缓存；不添加兼容旧缓存的运行时分支。
- 整合中另发现 Main 的 Next 开发子进程以 `RangeError: Map maximum size exceeded` 崩溃、但 PM2 父启动器仍 online。已用真实子进程 + 宿主 IPC 保活复现 Main/Admin 两条假在线路径（2 个用例先红），修复为子进程终止后显式退出；Node/Bun 两种 runtime 和原启动器回归共 15/15 通过。此修复保证退出码与故障恢复，不等于已定位并修复 Next 内部 RangeError。

## 2026-09-11 续做：修复与回归

源码基线仍为 `9ce5e5da3` 加共享工作区；日志在 `.tmp/product-improvements-20260911/`。

- CoinStore viewer 竞态：付款写入期间的 focus 仍经 `/api/v1/me` 核对账号——同账号不丢弃在途结果，换号立即重载；写请求返回后再确认 viewer，不一致则不投影余额、发票或清除回执；加载时余额、回执和历史要等服务端 scoped 历史读取成功后一并提交。原有 2 个红用例转绿。
- Payment provider 切换：`ensureCheckoutInvoice` 只经 checkout 上冻结的 provider 查询或建单；配置切换后返回 503，5xx 信封不带 details，客户端保留同 key。Coin 与订阅 checkout 的 requestHash 都按冻结 provider 比较，重放不再误判 `new_key`。新增订阅路径回归；coin 用例和 mounted 用例改为服务器真实可发出的 5xx 信封。
- ComicStudio：beforeunload 读取 ref，新建草稿保存后同步跳转不再被旧监听拦截。原红用例转绿。
- 账号凭据：保留按 userId 唯一读取 credential；删除基于错误前提加入的 Better Auth 哈希双格式分支；新增"同一用户多条 credential 时登录、邮箱重置、恢复码全部失败关闭且不改凭据"集成用例。
- 验证：mounted/纯测试 20/20；`idream_test@5433`、Redis `127.0.0.1:6379/15` 上 coin + 邮箱恢复 23/23（`auth-coin-billing-integration.log`），billing 51/51（`billing-integration.log`）；main typecheck 通过；全仓 `bun run check` exit 0（`repo-check.log`，14 条既有 lint warning）。

### Better Auth 结论（待决策）

- `/api/auth/[...all]` 挂载的 Better Auth 在 `usePlural: true` 加单数 Prisma 模型下，任何落库调用都抛 `Model users does not exist`，自 monorepo 骨架提交起即如此。前端、Admin、e2e、proxy 均不调用。
- 开发库 45 条 credential 全为 Main scrypt 且 `accountId=email`；Better Auth 格式、`accountId=userId`、同用户多凭据均为 0。PRD 与审计范围没有社交登录。
- 所以"两入口登录、兼容两种既有哈希"的前提不成立。本轮不激活该入口：激活会绕过 Main 的恢复码、User 根锁、匿名合并和限流，形成第二凭据权威。也未删除：删除与 ADR-3 冲突，需要决策。可选方向是删除挂载和 `userFromBetterAuth` 读分支并更新 ADR-3，或明确保留为未来 OAuth 载体后再修配置。

### 运行环境

- 本轮开始时 OrbStack（开发库与测试库均在 5433）、全部 PM2 进程、oMLX、ComfyUI 都未运行；已按 README wrapper 启动，13 个进程 ready。
- Chat `/readyz?full=1` 在 oMLX 刚启动后首测失败（`child command failed: exit_nonzero`），模型热身后重试通过（Ornith-1.5-35B、igrep 0.1.137、DSH 0.1.1-rc.2）；手动复现 igrep 生命周期全部 exit 0。未改代码。

## 2026-09-11 受控 localhost 真实验证

环境：README wrapper 启动的 PM2 13 个进程；Chat 模型为 oMLX `Ornith-1.5-35B-A3B-Abliterated-MLX-4bit`；ComfyUI 图片 8189、视频 8188；浏览器为真实 Google Chrome（Playwright，channel chrome，headless）。登录态是开发库中带 `idream-verification-20260911` 标记签发的会话，脚本不接触密码；Admin 与用户使用不同浏览器上下文。脚本、截图和 JSON 证据在 `.tmp/product-improvements-20260911/`，日志里的会话 token 已脱敏。

| 链路 | 结果 |
| --- | --- |
| 单角色 Chat 生图 | Turn `5117d8af…`（Ornith，18.5 s）触发 job `cmtx063k2000b6ul7yya71agj`，attempt `cmtx063lk000h6ul7n7revogp` succeeded；comfyui `qwen-image-edit-img2img`，129.3 s，扣 8（136→128）。媒体 `media_nz3ohosffe9mtx08vaa` 为 832×1024 PNG，Chrome 解码，重载后可见。首轮脚本因会话复用把旧图当成新图，已按附件 id 重测。 |
| 两成员群聊 | 群 `9d24c297-00d5-4e8f-a3b5-ecf09c409a3b`：Lola turn `65d5bf06…` 6.4 s，Sarah turn `c5f9b8b1…` 3.6 s，ordinal 为 1、2，模型均为 Ornith，不扣币，重载可见。质量问题：Sarah 几乎逐字复述 Lola 的回答。 |
| Comic 作者与审核 | 验证作者（`.invalid` 域，customer）生成 `media_zzolljaww9tmtx0oo7a`（comfyui `redcraft-krea2-redmix3-txt2img`，99.7 s，扣 5）。comic `95761895-dba3-4103-90a8-32ea8c312b30` 保存为 draft v1（unlisted、允许 remix），提交为 pending_review v2，保存后同步跳转没有 beforeunload 对话框。seed admin 在 Admin web 审阅页面后批准为 published v3，`comic.approve` 审计含理由。 |
| Chat video | 报价通过后创建 job `cmtx0p9oa00156ul7ym8eees3`（comfyui `redgraft-ltx25-i2v`，扣 100）。生成期间整机合盖休眠（14:04–14:51Z，只有几次约 2 秒的 DarkWake）：worker 丢锁后试图回退，被 Main 以 409 拒绝，没有重复提交或二次扣费；唤醒后 attempt `cmtx0p9qc001b6ul7myprppvw` 记为 `unknown`（ambiguous_non_replayable）。ComfyUI 在 14:53:49Z 实际出片，但现有代码不会向 provider 取回迟到结果。15:21:28Z 未知结果清扫器自动 `confirm_failed`：请求 failed，账本恰好一笔 `refund +100`（净 0），附件 failed；Chat 卡片显示 "Video unavailable" 并只提供 "Check video retry price"。 |
| 读者 remix | 审计账号打开已发布的 unlisted comic，从页面进入 remix，创建 job `cmtx11gfk0001dol7re2ec1ed`（comic_remix，扣 8）。DarkWake 时 Bull 任务 stalled 失败，Main attempt 仍为 queued，从未提交 ComfyUI。修复（见下）加载后，陈旧对账于 15:19:07 记录 `failed_source_replaced` 并重派一次，15:22:31 完成，媒体 `media_kvovcm4bwomtx3uo6y` 为 832×1024 PNG；重派没有额外扣费。 |

验证中发现并修复：

- Chat video 能力声明只检查 `video_generation`，报价却对用户必填的 Motion 文本要求 `premium_controls`，导致界面先显示可用、报价时才返回 402。能力判定已与准入一致；新增集成回归，原"其他账号"用例改为完整资格，继续验证归属拒绝。
- ChatVideoComposer 把说明文字放在 Source image 的 label 内，拼进了下拉框的可访问名称；改为 `aria-describedby`。
- Chat 图片附件的 "More like this" 与 "Use for identity" 使用固定高度，窄卡片中换行被裁切；改为最小高度，允许换行。
- Main 全量纯测试的 4 个确定性失败：generation-context 事务内 `Promise.all` 改为串行；Admin comics 列表经 manifest 唯一查询门；manifest 路由计数更新为 249；CreatorProfile 用例的 mock 排除 comics 请求。
- 生成请求被 worker stall 后永久卡在 queued：Bull 把 stall 超限的任务置为 failed（`attemptsMade` 仍小于上限、无 Gen 终态记录），Main 陈旧对账判定为"无 transport 应重派"，却因源行不是 completed 而每分钟空转，用户既拿不到结果也不退款。`redispatch` 只在没有 transport（Gen 从未进入 provider 阶段）时产生，因此现在把陈旧的 failed 源行与 completed 同样替换；替换前写入确定性 id 的 `failed_source_replaced` 事件，每个 attempt 最多替换一次，替换后若再次失败则判为耗尽，转 `unknown` 由清扫器退款，避免毒任务循环。传输集成测试新增真实 Redis 用例（真实入队 → `UnrecoverableError` 失败 → 重派一次并留事件 → 再失败转 `unknown/generation_source_exhausted` 且不再入队），6/6 通过；真实运行时 B 已据此恢复交付。

撤回：曾把 Comic 新建页首批字段丢失判断为注水覆盖，并临时加入注水前禁用。时间线探针显示，输入发生在年龄门 checking 阶段，内容区 inert 且被全屏覆盖层遮挡，真实用户无法输入；元素没有重挂载，也没有被注水改写。该修改已删除。

运行事件：

- main-web 在 14:01:36Z 因 `RangeError: Map maximum size exceeded` 崩溃，随后被 PM2 拉起，说明启动器修复生效。堆栈位于 Next 16.2.1 开发运行时中 React 19.2.4 服务端开发构建注册的 async_hooks `pendingOperations` Map，并非应用代码的 Map；尚未查到可证实的上游修复。
- 编辑 Main 源码期间，PM2 watch 共重启 gen-finalizer 与 main-event-consumer 9 次。
- `caffeinate -i` 只能阻止空闲休眠，不能阻止合盖休眠；长时间真实生成需要接电源并保持开盖。

### 群聊复述问题（未修复）

- 首轮（群 `9d24c297…`）中，Sarah 几乎逐字复用了 Lola 的回答。
- 在群聊约束里补一句"不要复述或改写其他角色的回复"后，于新群 `cae01c81-22f9-4f9c-9ac0-623dbbf58ddf` 按原顺序复测（`browser/flow3c-group-order.json`）：Lola 反而复用了 Sarah 上一轮的原话，两段回复词级 Jaccard 0.29，最长连续相同 7 个词。补句无效，已撤回。
- 正常对话路径把全部历史作为同一条 user 消息中的引用记录 JSON 发送，他人回复带 `source: "character"` 和 `speaker`，并不以 assistant 角色出现。复述更可能是模型直接复用上下文里对同一问题的答案。
- 下一步需要产品确认群聊上下文保留多少他人原话，再用多样本 A/B 比较重合度与连续性，例如把他人回复标为独立来源并附引用规则、只保留摘要或更换模型；单次样本不足以下结论。
- 同一复测中出现一次 `igrep_memory_failed`：新成员会话首轮，retryable，DSH 未提交终态；紧随其后的另一成员成功。此前手动复现 igrep 生命周期正常，判断为间歇性记忆依赖故障，未修改代码。

### Chat video 真实交付

经产品重试路径（重试报价 200、确认 202）创建 job `cmtx47adg000ldol7ahenoau3`，attempt `cmtx47afr000rdol73s7kbesf` succeeded，comfyui `redgraft-ltx25-i2v`，948.1 秒，扣 100。媒体 `media_xk2xbx0fkfomtx4rlyl` 在 Chrome 重载后可播放（5.04 秒，768×1152）。修复下载后，真实 Chrome 点击 "Download video" 触发文件下载：`idream-video-media_xk2xbx0fkfomtx4rlyl.mp4`，2,261,486 字节，含 MP4 `ftyp`（`browser/flow2e-video-download.json`）。

### 代码审查后的修复

跨包 Standards 与 Spec 两路审查的结论逐条回源码核实后，修复以下属实问题：

- 过期后晚付（expired/invalid + paid_late 等）的 Coin 发票进入 `provider_unknown` 且 `needsReconciliation=true`。provider 之后确认 settled 时，webhook 只改 status，结算因标记未清而 409、事务回滚、反复重投。现在只有在 provider 查询核验同一发票为 settled 时才清除标记；coin 集成测试新增"只入账一次、重投不重复"。
- 邮箱验证码限流在某条策略拒绝时仍给其他计数加一，冷却期内被 429 拒绝的请求也占用每小时 5 次额度。改为全部检查通过后再统一计数，并写明持久化、fail-closed 的原因；新增回归。
- 归档群聊发消息返回 404 "Choose a Character…"，现返回 410；群聊 HTTP 用例补上发消息断言。
- Turn 编辑、删除时，附件的 `promptHint`（视频附件保存用户手写的 Motion）没有随来源脱敏，现一并清空；新增不入队的集成用例。
- Chat 视频卡片的 "Download video" 是直指下载 JSON 接口的 `<a>`，现先取权威 URL 再跳转；mounted 用例覆盖点击，真实 Chrome 已验证。
- Admin 媒体依赖修复链接 `?comic=` 无人读取，ComicReviewPanel 现按该参数直接打开对应 comic；新增 mounted 用例。
- CoinStore `payload()` 与 ChatVideoComposer 的能力响应改为 schema 解析（`parsePublicApiError`、zod）。

门禁：Main 纯测试 118 文件 1353/1353；coin、邮箱、群聊、视频集成 42 项全部通过（视频文件改写后 6/6）；传输集成 6/6；Main `tsc` 与改动文件 lint 通过；Admin 深链用例 3/3、lint 与 typecheck 通过；`git diff --check` 通过。

### 收尾记录

- 审计账号的 `video_generation`、`premium_controls` 于 15:59:09Z 过期；`chat_video` 恢复为关闭（version 2）。
- 测试额度：前一会话的 +25 QA allocation 已在验证中消耗 5，剩余 20 经 Admin v2 canonical 调整冲正（`admin_adjust −20`，带审计与幂等键），余额 0；没有直接修改账本。
- 已撤销全部 `idream-verification-20260911` 标记会话（剩余 0）以及验证作者的全部会话；scratchpad token 已删除；证据日志中的会话 token 已脱敏。
- 验证 comic 已由 Admin 以理由撤下，读者访问返回 404。验证作者账号（customer 类，`.invalid` 域）未擦除：Admin 擦除是宽限期后不可逆的删除，超出授权，需要用户决定。
- 已停止用于防空闲休眠的 `caffeinate`。PM2 拓扑、OrbStack、oMLX、ComfyUI 保持运行。

### Next 开发运行时崩溃修复

`RangeError: Map maximum size exceeded` 的根因不在本仓库：Next 打包的 React 19 RSC 开发运行时（`next/dist/compiled/next-server/app-page*.runtime.dev.js`）无条件注册 `async_hooks` 钩子，把每个异步资源记进 `pendingOperations` Map，而唯一的清理是 `destroy` —— Node 对 promise 只在 GC 回收时才发。开发服务持续渲染时创建速度超过回收，Map 触到 V8 元素上限后 `Map.set` 在钩子内部抛错，用户代码无法捕获，进程直接退出。栈顶的 `createIterator (dist/build/swc/index.js)` 只是压垮它的最后一个分配点，不是元凶：上游复现用一个 await 百万 promise 的 server component，在完全没有 HMR 的情况下同样崩溃。

**升级 Next 修不了**（已实证，非推断）：16.3.5 的 `dist/build/swc/index.js:505` 仍是 `async function* createIterator()`，`hot-reloader-turbopack.js:159` 仍是 `for await`，编译运行时里仍是同一句无条件 `.enable()`。上游 umbrella issue #85666 仍开着，两个候选修复 PR #91704 与 #96182 都未合并，#97153 / #97152 / #96140 / #87772 均作为重复被并入。

修法是给这个 Map 加上界，而不是停用异步调试：新增 `scripts/bound-react-async-debug.cjs`，由 Main 与 Admin 两个 dev 启动脚本经 `NODE_OPTIONS=--require` 预加载（走 NODE_OPTIONS 而非 argv，以便覆盖 Next 派生的进程）。它只包装 `init` 源码含 `pendingOperations` 的那一个钩子：`admitted` 满额后跳过 `init`，`destroy` 时同步移除。安全性来自 React 自身的约定 —— 钩子可以在 promise 已在飞行中时才启用，所以「查不到条目」是设计内状态，`before` 与 `promiseResolve` 都以 `void 0 !== node` 开头，`destroy` 只做 delete。钩子形状不匹配时预加载自动退化为无操作。

验证：新增 `scripts/bound-react-async-debug.test.cjs` 并并入 `test:pm2-config`，全套 127/127；把默认上限临时降到 500 后经 PM2 wrapper 重启，此时 Map 在首次渲染即饱和、几乎每个 `init` 都走跳过路径，连打 40 次真实首页渲染 40/40 返回 200，main-web 重启数 0、无新异常；随后恢复 100000 并重启，`GET /` 200、`ps eww` 确认预加载在位。lint 0 error、typecheck 6/6。

边界（未证）：没有做数小时长跑复现 —— 原始崩溃需数小时才出现，本轮只证明了上界机制生效、饱和路径在真实运行时安全、服务正常。按构造该失败模式已不可达（Map 大小恒 ≤ 上界），但「本机再不崩」需后续长跑观察。上游修复合入后应删除此预加载。

### 未修复与待决策

- 需要决策：Better Auth 挂载点的去留；验证作者账号是否擦除；群聊上下文保留多少他人原话（复述问题）。
- 未修复的运行问题：新成员会话首轮出现间歇性 `igrep_memory_failed`。（Next 开发运行时 `RangeError: Map maximum size exceeded` 已修，见上节。）
- 审查中核实但未改的判断项：
  - 邮件 provider 未进入 providers 注册表、没有 mock 实现；
  - Coin 商品 Admin 命令放在 `modules/billing` 而非 `admin-v2`；
  - GroupChatManager 缺少 mounted 用例；
  - `ensureCheckoutInvoice` 用可空 `coinOfferId` 区分商品类型，适合改为判别联合；
  - `local-pipeline` 手写 P2002 判断（复用现有 helper 有循环依赖风险）；
  - Comic 派发授权与视频跨账号的创建、取消、重试缺少专门集成用例；
  - CoinStore 回执沿用订阅 checkout 的 sessionStorage 约定，关闭标签页后丢失，但服务端历史仍保留原发票。
- 当前逐项产品状态见 [REPORT.md §9](../product-audit-20260910/REPORT.md)。主动消息、完整 Conversation Profile、Voice Call、Coin 退款与商业规则、Affiliate、生产认证仍未完成。
