# 本轮产品验证入口与隔离清单

记录时间：2026-09-10 UTC。本文件是操作清单和只读环境证据；历史报告不作为当前完成证明。

## 当前运行基线

- Git HEAD：`9ce5e5da3362dc397eb73b7f72a621141740fd4b`，初始工作树干净。
- `node scripts/source-revision.cjs`：`idream-worktree-5484711258bb827314d857531144bfd205bb7a7e529ed6c1f221554496a3f33a`。
- PM2 Main、Admin、Chat、Gen image/video、finalizer、event consumer、admin command worker 均 online，运行 development 源文件/官方 development wrapper；以上服务携带相同 `IDREAM_SOURCE_REVISION`。ComfyUI image/video/H3、Fish、Pocket 也 online。未对服务进行启停。
- Main `http://127.0.0.1:3000`，Admin `http://127.0.0.1:3001`，Chat `http://127.0.0.1:3100`。
- 2026-09-10T01:01Z：Chat `/healthz` 返回 ok；`/readyz` 返回 accepting/warmed/fileStore/redis/agentRuntime/fresh 全 true。只读健康请求不证明模型响应成功。未请求可能触发模型的 `/readyz?full=1`。
- 配置文件所示（非直接读取进程内部 env）：Main Chat adapter `pipeline`；Chat `openai`，模型 `Ornith-1.5-35B-A3B-Abliterated-MLX-4bit`，端口 8061；Gen 图/视频 `backend`，ComfyUI image 8189/video 8188；语音 Pocket 8063，身份语音 Fish 8062。
- Main 配置 `PAYMENT_PROVIDER=mock`、`BLOB_PROVIDER=mock`、`AGE_VERIFICATION_PROVIDER=mock`。这是本地真实生成与公开生产就绪的边界；不将已定 `MODERATION_PROVIDER=mock` 当成缺口。

## 已核对的隔离

- 本地开发库连接成功：`localhost:5433/idream_runtime_20260812`。
- 专用 Main 测试库连接成功：`localhost:5433/idream_test`。默认 Main test/coverage 会重建 public schema 并 seed；有数据库 advisory lease 防止同库并跑。
- Redis `127.0.0.1:6379` DB 0、14、15 均 PONG。开发服务使用 DB 0；Main 集成用例默认 DB 15，并由测试数据库身份生成 `idream:test:<sha256>` prefix；E2E 用 DB 14 + 每轮专属 prefix。DB 14/15 已有其他 key，不能全库 flush。
- 当前官方 `packages/main/playwright.config.ts` 强制管理独立 Main/Admin/Chat、fixture 与 worker，`reuseExistingServer=false`；不复用 ambient 3000/3001 或 Chat FS。
- E2E 从 `PW_DATABASE_URL` 派生每轮数据库 `idream_test_playwright_<port>_<runId>`，独立 `idream:e2e:<port>:<runId>` Redis prefix、Chat FS、blob 临时叶目录、Next dist/config。最终 lifecycle verifier 在服务停下后核验 cleanup receipt，失败使整轮失败。
- 3300–3303 检查时没有监听。计划使用 `PW_BASE_URL=http://127.0.0.1:3300`，`PW_REDIS_URL=redis://127.0.0.1:6379/14`，固定本轮 `PW_RUN_ID=a0910001`。
- Google Chrome 已安装；Bun 1.4.0 可用。官方配置不指定 browser channel；本轮临时配置仅继承官方配置并指定 `channel: chrome`、绝对输出/工作目录，不修改测试或产品源码。

## 本轮补充回归

实际执行命令（从 `packages/main`）：

```bash
PW_BASE_URL=http://127.0.0.1:3300 PW_REDIS_URL=redis://127.0.0.1:6379/14 PW_RUN_ID=a0910001 \
  bun run test:e2e --config ../../.tmp/product-audit-20260910/chrome.playwright.config.ts
```

日志：`.tmp/product-audit-20260910/chrome-e2e.log`；产物：`.tmp/product-audit-20260910/chrome-artifacts`。
此回归使用 mock/fixture provider，覆盖真实 Chrome 与隔离 Main/Chat/Gen 业务编排，不代表真实 GPU/LLM/语音质量或公开生产支付能力。主 agent 另在 3000 使用 Chrome 实测真实服务。

## 最小真实闭环与补证方法

1. 在 Chrome 使用新建、可识别的本轮账号走年龄确认、注册登录、Explore/详情、完整创建、My AI、Chat、生成、图库、Profile、付费入口及运营处理。主 agent 本轮账号 `product-audit-20260910@example.test`；本子任务不读其 token，不清理或修改。
2. Chat 至少一轮真实发送、流式结束、刷新持久化；验证 regenerate、跨会话 recall/无记忆边界、错误/中断恢复、额度事实。独立正式探针可用：`bun run --cwd packages/main probe:chat-service -- --service-url http://127.0.0.1:3100 --main-web-url http://127.0.0.1:3000 --user-id seed-chat-probe-user --character-id <本轮确认的角色> --report <绝对报告路径>`。先确认专用 actor 及角色可用，保留异常中的精确 session IDs。该探针会真实调用模型，自动清理其识别的 probe 会话；不能用于普通用户或 Quality 会话。
3. 图片/视频优先由 Chrome 各生成最低充分规格一次，记录 Job/Attempt/Artifact/MediaAsset、provider/workflow/model、耗时、余额前后、Gallery 刷新和下载/播放。随后只读：`bun run --cwd packages/main probe:generation-persistence -- --job-id <本轮Job> --report <绝对报告路径>`。它验证 terminal checksum/receipt/outbox、transport 成功、artifact 与交付一致、MediaAsset 持久化和唯一 spend settlement。
4. `.tmp/product-audit-20260902/capture-generation-job-evidence.cjs` 是可复用只读方法，接受 `--job-id --owner-id --source --out --blob-root`；能逐 Job 核验余额账本、terminal/source、blob checksum。要求 `IDREAM_SOURCE_REVISION` 与当前 source 一致。运行前重新看参数和目标，不重用历史 Job IDs。
5. 语音由 Chrome 对本轮真实 assistant message 点击播放，再次播放验证幂等、刷新可取媒体；记录 VoiceClipRequest、VoiceUsageFact（durationMs/costDreamcoins）、MediaAsset 与余额。`probe:voice` 只验证 adapter/provider 音频 bytes，使用内存 ProbeBlobStore；不能单独证明用户交付/持久化/计费。历史 `.scratch/voice-audit-20260906/verify-live.ts`/`round2-live.ts` 展示精确请求与核账方法，但硬编码旧账号/角色并含写入，不应原样重跑。
6. 常规重试测试不要引发失控 provider 重复生成；第一次异常后先审查 Job/Attempt/队列与 ledger，再决定恢复。浏览器/终端前后记录 `source:revision`；代码变更后此前证据只能说明其旧 source。

## 清理与上线边界

- 官方 E2E 应由已配置 teardown 清理自己的派生 DB、精确 Redis prefix、FS/blob/Next 目录；结束后额外只读核验无本轮数据库、key、3300–3303 listener、owned 目录。不手动 `FLUSHDB` 或杀猜测 PID。
- 真实闭环只清本轮明确拥有的数据，先保留账本、request/attempt/artifact/审计证据；已有历史测试角色/账号不得直接复用、重指派 owner 或批量删除。优先使用产品会话/媒体/账号删除流程验证清理。
- 本地 payment/age/blob 的 mock 不能证明真实加密货币支付 webhook、退款/对账、公开对象存储、年龄 provider；还需生产域名、配置、告警、恢复/容量与同 revision launch gate 证据。
- CI 要求：`bun run check`，Admin test，Main coverage，Chat/Gen/Shared test，`test:pm2-config`，迁移 deploy + authority + rehearsal，隔离 E2E。它们不替代本次实际产品链路证据；当前子任务仅执行 E2E 补充回归。

## 首轮回归与修复后的定向验证

首轮 `a0910001` 完整运行结果：173 项，146 passed、18 failed、1 flaky、8 did not run；21.9 分钟。官方 teardown 后独立复核临时数据库、精确 Redis prefix、运行目录及 3300–3303 端口均已清空；记录在 `chrome-e2e-cleanup.json`。

首轮失败与唯一次重试暴露了真实问题及已退役流程的测试漂移，不能概括为 18 个产品缺陷，也不能据 146 项通过声称已完成真实供应商验证。

已修复的产品问题：

- My AI 分享成功文案仍称需要人工审核，改为自动检查后的「等待发布准备」。测试同时检查 `Character=approved/public`、`Submission=approved` 且无人工 reviewer、`Serving=inactive/null`，确保未暗中发布。
- Profile 通知深链只在挂载后 50ms 尝试 focus；偏好响应较慢时 checkbox 仍 disabled，失去焦点。改为等待通知值可用后 focus，保留 routePath 变更响应并清理计时器。E2E 显式延迟偏好响应 150ms 验证原竞态。
- 运营 Hero 图片直接采用成功后卡住：前端 mutation 快照省略 `reviewDecisionId`，服务端投影使用 `null`，严格比较让 receipt 永不清除，Chat 图片生成一直 disabled。按无人工审核的新契约将两侧缺省归一为 null；完整真实调用链挂载回归先红后绿，相关 57 项通过。其真实浏览器验证列入后续运行。
- Create 的公开/不公开分享提交已自动 `approved`，旧成功分支仍按 `pending_review` 判断，错误展示通用保存文案和直接打开入口。改为根据服务端返回的 `visibility` 说明等待发布准备；私人角色仍可直接打开。新增 private/unlisted/public 三分支挂载回归，先复现 2 项失败后全部 22 项通过。

第二轮 `a0910002` 只选原失败、未执行及 flaky 共 27 项。5 项有效通过：Admin 所有控制面路由、资源归档确认、客户/账单写入、历史共享角色检索、CMS。运营首项正确暴露上述采用卡锁；另两个 Admin 测试需将审计 target 改为真实 project.id、反馈 locator 改为语义 role=status。之后根任务并行 `bun run check` 的 build 清理了 Main `.next` 父目录（包含 E2E 独立叶目录），导致测试服务 ENOENT/500；这一阶段的 Chat/auth 失败不计产品缺陷，主动 SIGINT 终止。官方 teardown + `check-e2e-cleanup.ts a0910002` 独立核验通过。

第三轮 `a0910003` 禁用并行 build 后运行剩余 22 项：13 passed、2 failed、7 did not run，3.4 分钟；官方 teardown 与独立清理复核通过。运营完整空白角色→身份→完整图包→Preview→Release 首项通过，确认直接采用卡锁修复；另一项运营回滚用例在已经发布、Serving live 及监测验证后被旧入口文案阻止，改为当前 `Character availability and rollback`，保留回滚命令与 Serving 事实断言。唯一用户侧失败是上列 Create 成功分支；Profile 延迟响应焦点回归、消息正文/操作布局与编辑删除、账号恢复、申诉等均通过。

第四轮 `a0910004` 使用 `chrome-remaining.playwright.config.ts`，日志 `chrome-remaining.log`，产物 `chrome-remaining-artifacts`。选择剩余 9 项及其同进程运营第一项 fixture 前置，共 10 项；第 2 项和移动端测试依赖第一项产出的 wizardCharacterId/Release，不能过滤掉这个前置。结果 3 passed、1 failed、6 did not run，1.6 分钟；角色完整发布、Release 验证/监测/回滚、公开 Create 恢复与等待发布提示均通过。运营第 3 项走到 Case 后，旧全页文本 locator 被 Evidence 与 Decision and verification 两处同文案触发 strict violation；将桌面和 responsive helper 都精准限定在可访问的 Evidence 区域。官方与独立清理核验均通过。

第五轮 `a0910005` 使用 `chrome-admin-remaining.playwright.config.ts`，只执行运营文件 9 项（剩余 7 项及两个前置），日志 `chrome-admin-remaining.log`、产物 `chrome-admin-remaining-artifacts`。前 3 项通过，第 4 项 Today 被旧密度按钮/同时展示全部队列/直接来源链接交互阻断，5 项未运行；1.9 分钟。按现行 Today 单队列→Preview→Open source record 交互更新，保留投影与真实深链验证；同轮核对并精确限定 responsive 上传区域与新页面标题。官方与独立清理复核通过。

第六轮 `a0910006` 复用上述运营配置，CLI `--output ../../.tmp/product-audit-20260910/chrome-admin-a0910006-artifacts`，日志 `chrome-admin-a0910006.log`。**9/9 passed，2.2 分钟，exit 0**。覆盖完整角色发布、Release 验证/监测/回滚、Creative/Incident/Case、Today 投影与来源深链、Job 深链状态、409 重试/焦点恢复、核心页面 WCAG 2.2 AA，以及 375/834px 四类完整键盘工作流。官方 teardown 后 `check-e2e-cleanup.ts a0910006` 再次确认临时数据库 0、Redis prefix key 0、全部 owned 目录不存在、3300–3303 无监听。

### 完成口径与证据边界

- 原 173 项：首轮 146 项通过，其余失败、flaky 和未运行项经修复后的定向回归全部取得通过证据。最后运营 9 项一次连续通过。没有为获得绿灯而跳过失败路径、降低 DB/账本/Serving/键盘/axe 断言；旧人工审核流程依据已生效产品契约改为自动检查及发布准备。
- 这是完整首轮加风险定向回归的合并覆盖，**不是在最终单一冻结 revision 上重新执行 173 项**。第六轮启动指纹为 `idream-worktree-6820fec0e49c4f06ae8196b229d58777db9005eed485b918dd6a24f47d0e2c20`，存于 `chrome-admin-a0910006-source.txt`。主任务随后修正 AgeGate 两处颜色，其 Chrome 对比度结果由主任务独立验证；该样式变化不属于运营用例覆盖，最终构建由主任务在全部 E2E teardown 后执行。
- 各轮清理证据：首轮 `chrome-e2e-cleanup.json`，其后 `chrome-e2e-cleanup-a0910002.json` 至 `chrome-e2e-cleanup-a0910006.json`。第 2 轮构建干扰的无效阶段完整保留，不计作产品失败或通过证据。
- 本子任务补充的 `CreateWorkspace.mounted.test.ts` 22/22 通过；新增分享成功分支测试先红后绿。运营采用 receipt 修复相关 57/57 通过；Profile 焦点回归用显式延迟偏好响应的 Chrome E2E 锁定原竞态。合并中途 Main `tsc --noEmit` 与定向 lint 通过，最终全仓检查结果以主任务记录为准。
- 全部 E2E 使用真正 Google Chrome、官方隔离拓扑及 fixture/mock provider I/O。真实 LLM/图像/视频/语音、公开支付与生产就绪结论须结合主任务独立证据，不能由本报告代替。

以下为逐类修正依据：

- `admin-v2-workspaces.e2e.ts:2099`：角色创建 201 成功，实际跳到精确 `/admin/characters/<id>?tab=assets`，旧 regex 只接受无 query。依据 2026-09-09 运营手册「创建成功后直接进入图片工作区」及 `creation.ts` 返回的 assets deepLink，改为解析正式响应 schema 后断言精确角色 ID + assets URL。
- `admin-web.e2e.ts` 的 `Library`、`Billing Operations`、`CMS & SEO` 已分别更名为 `Operational Assets`、`Orders & Billing`、`Site Content & SEO`。依据当前 nav 和对应页面标题更新精确断言；Library 影响全路由 smoke 与归档确认两个用例，Billing 影响全路由与核账确认两个用例。
- 两条旧 `admin review queue ...` 用例要求人工审核队列、批准和 saved moderation view；实际 legacy URL 进入 Characters 工作区。运营手册明确日常人工审核退役，现已改为历史角色发现/筛选，以及真实自动检查/准备发布；保留无人工 reviewer、未发布、审计和 Serving 事实核验。
- 初始失败 trace、截图、error context 保留于本轮 `chrome-artifacts`；修改后定点重跑另写独立日志。产品主线源码和其他测试在本轮并行任务中变化，本轮不是冻结源码的正式上线认证。

补充已复现的旧预期：

- Compliance 擦除后 UI 现显示带精确 userId 的成功说明，年龄 override 现显示 verificationId 和 verified 状态。已更新该用例的成功 banner 精确内容，保留 typed confirmation、HTTP 200 与 DB deleted/verified 断言。
- `chat-composer-layout.e2e.ts` 的 session fixture 缺 `ownerScope`；新 public schema 要求 `/^user:.+/`，因此在布局验证之前即进入 Chat unavailable。生产端同形响应是否正确应由真实 Chat 核对；此 fixture 失败不能直接证明聊天功能不可用。
- `flows.e2e.ts` 的 invalid-login 子步骤要求直接 `Contact Help Desk` 链接；实际是 `Forgot password? Recover access` + 恢复代码引导。登录 API 正确返回 Invalid email or password，需按当前恢复流程重验。
- `public-routes.e2e.ts` 的 `/`、`/explore` 标题仍要求竞品 OurDream.ai，实际是 iDream 标题。
- `ui-workflows.e2e.ts` 完整 Create 已创建角色并出现在 My AI，末端旧断言等待 `pending review`；现已验证自动检查/等待发布状态，保留完整资料、持久化和 Serving 未上线断言。
