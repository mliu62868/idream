# iDream 当前功能覆盖审计

更新日期：2026-06-28

## 结论

这份文档是当前代码态的功能覆盖表，覆盖的是“用户能否完整使用”和“有没有测试证据”。它补充并修正 `ProductFeatureMap.md` 里 2026-06-13 的旧状态描述。

当前状态：**本地产品闭环通过，当前目标收窄为内部演示/受控 beta；公开上线仍被真实生产依赖阻断**。

## 2026-06-28 PM 全面验证 + 修复（本轮）

对受控 beta 口径做了一次全功能 Chrome 端到端验证 + 多 agent 代码审计 + 修复。基线：`bun run check`（lint+typecheck+build）绿、`bun run test` **251/251** 绿、catalog 探针干净（16 角色/0 fail）、pipeline 内部探针 5/5（voice 未配可选跳过）。

Chrome 实测通过的流程：年龄门禁（拦截 fresh 访客）、注册(发 250 币)、Explore(真实图/筛选)、角色详情→Chat、**Chat hub `/chat`**、**Chat 回复质量**、Create 5 步向导、Generate(真实 sd.cpp 出图/画廊/premium 门控)、Upgrade、Profile、Community、创作者主页 `/creators/:id`、Feed、404 页；Admin：登录(RBAC 门控)、Dashboard、Moderation 队列。

本轮修复（均未提交，留在工作区待 review）：

- **Chat 体验质变**：`packages/chat/src/providers.ts` 对流式请求加 `chat_template_kwargs.enable_thinking=false`，并把 `CHAT_MODEL_NAME` 从 `Qwen3.5-0.8B-8bit`（出戏的通用助手口吻）切到 `Qwen3.5-4B-MLX-4bit`（~0.9s、干净无思维链泄露、稳定在角色内）。更高质量可选 `Qwen3.6-27B-oQ4-mtp`（~2.2s）。
- **前端 9 项**：`/chat` 改为真实会话中心（ChatHubWorkspace）；Create 向导登出态 401→`/signup`；Explore 去除与 AgeGateBoundary 冲突的冗余年龄门（修复登录新设备空白）；移除 Profile 语言切换器（无 i18n 的假成功死控件）；新增 app-shell `not-found.tsx`；Auth/Upgrade/Profile 网络错误 catch；Upgrade 当前套餐徽章；Explore 搜索 300ms 防抖；Gallery like/unlike + 心形态。
- **后端经济/生成/审核**：checkout 幂等防重复发币+防重复订阅；生成 worker 异常兜底退款；stale-job 回收接入 finalizer(60s)；moderation 对 `feed_item` 等非 character/media 目标正确下架(不再静默无操作)；admin discard 退款幂等；webhook 原子去重(防 TOCTOU 双结算)；moderationDecision 事务化。
- **chat/gen 服务**：regenerate 补每日配额门控；gen-video 在 deferred 态优雅退出(不再 prod 崩溃循环)；SSE 复用单例 Redis publisher；prod 缺签名密钥 fail-closed；SSE 读 Last-Event-ID 头；区分未成年审核码。
- **配置**：`gen/.env` 队列前缀 `idream:gen`→`idream:development`(修漂移)；ecosystem 给 finalizer 设 `GEN_FINALIZER_QUEUES`(不抢生成队列 + 接管 character.preview)、停跑已延后的 gen-video。
- **Referral 奖励接线（新增）**：`signup` 读 `?ref` 归因并给被邀请人 +150、邀请人 +150 dreamcoins（ledger idempotencyKey 每被邀请人一次）；前端 AuthWorkspace 从 URL 捕获 `?ref`。Chrome+DB 验证：被邀请人 250+150=400、邀请人 +150、Referral 行 completed/granted。新增 2 个回归测试。
- **Voice 接线（新增）**：`VOICE_PROVIDER=pipeline` 指向本地 oMLX `/v1/audio/speech`(:8061, Qwen3-TTS, speaker `serena`)；`PipelineVoiceModel` 默认 voice 改为可配（修「default」在 speaker-keyed TTS 上 500）。修复 voice **付费权益缺口**：运行 DB 计划缺 `voiceEnabled` feature（seed 已含，DB 陈旧）→ 已补计划 + 启用 `voice_gen` flag + 授权活跃用户。Chrome 验证：UI Play voice → 201 → 真实 WAV 音频播放（付费层；免费层 402 为正确门控）。

剩余/已知（非 beta 阻断，见 REMAINING_WORK / 下方“延后”）：运行 DB 相对 seed 陈旧（缺 `voice_gen` flag、计划缺 `voiceEnabled`——本轮已手工补，建议重跑 seed 彻底同步）；公开上线仍需真实 provider + secrets（Safety Gateway/Go.cam/BTCPay/R2/Sentry）+ prod 应用 `db/sql` 公共 schema 文件 + `APP_ENV=production`(关闭 dev-header 鉴权旁路、避免 admin/main 同源 cookie 串)。

## 2026-06-26 范围决策

以下生产依赖明确延后，先不作为当前里程碑工作：

- Safety Gateway。
- Go.cam。
- BTCPay。
- R2/S3。
- Sentry。

这意味着当前验收口径不是公开上线。公开上线状态仍保持未就绪，未来恢复公开上线目标时必须重新启用这些 provider，并通过对应 live probe 和最终 launch gate。

## 对标站当前公开信号

2026-06-25 重新查看 `https://ourdream.ai/`，公开入口仍以这些用户任务为主：

- 年龄确认。
- Explore 角色流、筛选和热门角色卡。
- Create、Chat、Generate、My AI、Feed、Community、Help Desk、Safety、Upgrade。
- Learn / Popular / Help footer 入口。
- AI companion、roleplay、chat、image/video generation、voice、memory、subscription 相关文案。

我们当前产品入口与这些一级任务基本对齐；差距不在入口数量，而在生产外部服务尚未接真实 provider。

## 当前已可用流程

| 用户/运营流程 | 当前状态 | 证据 |
| --- | --- | --- |
| 年龄门禁 | 可用；未确认前不渲染主内容，不触发受保护 API；本地接受状态可恢复 API cookie | `packages/main/src/e2e/flows.e2e.ts`：age gate flows |
| 注册和 session | 可用；注册后创建 authenticated session，并发放 250 dreamcoins | `flows.e2e.ts`：signup flow |
| Explore | 可用；搜索、分页、排序、gender filter、tag filter、移动端导航状态被验证 | `packages/main/src/e2e/ui-workflows.e2e.ts`：`explore UI syncs filters to URL and paginates results` |
| 角色详情 | 可用；角色卡进入 `/characters/:id`，Chat action 渲染 | `flows.e2e.ts`：explore grid -> character detail |
| Create -> My AI | 可用；提交角色，保存到 My AI created tab | `ui-workflows.e2e.ts`：`create UI submits a character and shows it in My AI created tab` |
| Chat | 可用；从角色详情开会话，发送消息，assistant 回复，刷新后历史仍在；chat model pipeline probe 已通过 | `ui-workflows.e2e.ts`：chat UI flow；`flows.e2e.ts`：chat API flow；`.tmp/launch-chat-probe.json` |
| Chat report | 可用；用户消息可举报并写入 `ContentReport` | `ui-workflows.e2e.ts`：chat message report |
| Generate image | 可用；生成排队、worker drain、完成、媒体进入 gallery，`/user-content` 返回真实图片 bytes；image pipeline probe 已通过 | `ui-workflows.e2e.ts`：image generation UI；`flows.e2e.ts`：generation API；`.tmp/launch-image-probe.json` |
| Generate video | 条件可用；`video_gen` flag + entitlement 打开后可排队并展示 video asset；默认 launch gate 要求 video 保持关闭或接真实 provider | `ui-workflows.e2e.ts`：video generation UI；`launch-readiness.ts`：video provider gate |
| 生成配置失败状态 | 可用；配置加载失败时显示错误，不展示假 0 balance，Generate 禁用 | `ui-workflows.e2e.ts`：generator config failure |
| Gallery report | 可用；生成媒体可举报并写入 `ContentReport` | `ui-workflows.e2e.ts`：generated media report |
| Upgrade | 本地闭环可用；Premium monthly 激活、dreamcoins 发放、profile 回显、prompt/negative prompt controls 解锁 | `ui-workflows.e2e.ts`：upgrade UI flow |
| Billing API | 本地/mock provider 闭环可用；BTCPay 已延后，真实上线前仍要求 provider 和 live probe | `flows.e2e.ts`：billing flow；`LAUNCH_READINESS_AUDIT.md` |
| Moderation/report queue | 可用；角色 report 后 admin moderation queue 可查 | `flows.e2e.ts`：moderation flow |
| Community | 可用；有公开 dreamer 数据时显示 dreamer card，并可举报 user profile；无数据时显示空状态 | `ui-workflows.e2e.ts`：community dreamers/report；Chrome smoke：community empty-state |
| Profile | 可用；余额、display name、preferences、redeem code、referral(邀请码生成，奖励发放未接线)、billing link、media tab、media report/download/delete。语言切换器已移除（无 i18n，曾为假成功死控件） | `ui-workflows.e2e.ts`：profile flow |
| Account management | 可用；sign out all sessions，delete confirmation gate，delete 后返回 login | `ui-workflows.e2e.ts`：account management flow |
| Public routes | 可用；核心公开页无 404、无 broken images、无 launch-prohibited clone copy、无 console/page errors | `packages/main/src/e2e/public-routes.e2e.ts` |
| Admin web | 可用；dashboard、generation jobs/config、moderation、users、billing、audit log；users filter；无 console/page errors | `packages/main/src/e2e/admin-web.e2e.ts` |
| Admin API | 可用；dashboard、model profiles、audit log 响应 | `flows.e2e.ts`：admin control-plane API |
| Web surface protection | 可用；home、generate、age-gated API 403、admin protected state、admin API 401 | `.tmp/launch-web-surface-probe.json` |

## 当前已验证但非公开上线口径

| 范围 | 为什么不能直接当线上完成 |
| --- | --- |
| 图片生成 | 本地已经通过 pipeline + `sdcpp-image` + `pornmaster-zimage-turbo` probe；内部 beta 用 `bun run launch:probe:pipeline` 固化验证 |
| Chat | 本地已经通过 `CHAT_MODEL_PROVIDER=pipeline` + OpenAI-compatible oMLX endpoint probe；chat service BFF probe 也通过 |
| Voice | `PipelineVoiceModel` adapter 已存在；目标模型仍选 MOSS-TTS v1.5。已在 Apple Silicon 本地跑通一个更小的 oMLX smoke path：`Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit`、`http://127.0.0.1:8061/v1`、speaker `serena`。显式 voice pipeline probe 对图片 gateway `http://127.0.0.1:8091` 返回 HTTP 404，说明 sd.cpp 不是 voice runner。若 demo 承诺 voice，必须配置 `PIPELINE_VOICE_API_URL` 并通过 `bun run launch:probe:pipeline -- --include-voice` |
| Payment | 本地 mock checkout 可验证权益闭环；BTCPay 已延后，公开上线前必须恢复 BTCPay Greenfield credentials、webhook secret、provider live probe |
| Age verification | 本地 age gate 可用；Go.cam 已延后，公开上线前必须恢复 Go.cam gateway、public HTTPS return/callback URL、webhook signature secret、provider live probe |
| Blob storage | 本地 blob 可验证 `/user-content`；R2/S3 已延后，公开上线前必须恢复 bucket/endpoint/access keys，并跑 write/sign/read/delete probe |
| Safety gateway | 本地/reporting/moderation queue 可用；Safety Gateway 已延后，公开上线前必须恢复真实 safety gateway URL/key 并跑 benign moderation live probe |
| Sentry | Sentry 已延后；公开上线前必须恢复 `SENTRY_DSN` |

## 与旧 ProductFeatureMap 的差异

`ProductFeatureMap.md` 仍有一些 2026-06-13 的旧缺口描述，例如 Create、Generate、Upgrade、Profile、Community、Admin 等流程标成“未实现”。以当前代码态为准，这些流程已经有功能实现和 E2E 覆盖。

当前暂不追求公开上线。未来重新进入公开上线阶段时，缺口不是这些本地产品流程，而是：

1. 真实生产 provider 从 mock 切换。
2. 生产 secrets 和公网回调 URL 配置。
3. 对每个真实 provider 跑 live probe。
4. `bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env` 全绿。

## 不应误判为缺失的点

- `sd.cpp` 不应直接出现在 main-web 或 gen worker 产品配置里；它只能作为 Pipeline gateway 后面的 runner。
- `Video Beta` 默认禁用是正确状态；`video_gen=false` 时上线 gate 不要求真实 video provider。
- Community 在没有公开 dreamer 数据时显示空状态是正常状态；有数据时 E2E 覆盖 dreamer card 和 profile report。
- 本地 mock checkout 只证明权益/ledger/UI 闭环，不代表真实支付可上线。

## 下一步上线动作

按 `LAUNCH_READINESS_AUDIT.md` 补齐生产 env 后，必须重新执行：

```bash
bun run launch:probe:image:local
bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe.json
bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json
bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json
bun run launch:probe:chat -- --report .tmp/launch-chat-probe.json
bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json
bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json
bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json
bun run launch:probe:age -- --report .tmp/launch-age-probe.json
bun run launch:probe:safety -- --report .tmp/launch-safety-probe.json
bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env
```

通过后再跑完整 E2E 和 Chrome smoke，才能改成可公开上线运营状态。
