# iDream 上线可用性审计

更新日期：2026-07-18

> **2026-07-18 当前默认模型更正**：本页 2026-07-03 的
> `pornmaster_zimage_default` 记录是历史证据，不再描述当前开发库。
> 当前 canonical key 是 `redcraft_krea2_default`，精确绑定
> `runner=comfyui`、`pipelineModel=redcraft-krea2-comfyui` 与
> `workflowKey=redcraft-krea2-txt2img`；真实候选探针已确认
> active/enabled/100%、模型与 workflow 文件存在、`readyForPublish=true`。
> 公开生产环境仍未因此被评估或放行。

## 2026-07-18 当前源码补充

本节是当前事实补充；下方 2026-07-03–05 的构建、E2E、PM2、Chrome、provider 与 launch-gate 数字均为历史审计证据，不是当前 revision 的 live verdict。

- Main migration rehearsal/deploy/status/drift 为 `60/60` 且无 drift；Chat DB boundary 正向能力与 15 项负向拒绝检查通过，运行时使用 `chat_service` 请求角色和独立 `chat_projector` 投影角色。
- 根 lint `2/2`、typecheck `6/6`；全量测试为 Shared `36 files / 175 tests`、Admin `89 / 397`、Gen `14 / 117`、Main `219 passed files + 2 skipped files / 1,585 passed + 3 skipped tests`、Chat `27 / 212`，总计 `385 passed files + 2 skipped files / 2,486 passed tests + 3 skipped tests`。
- fresh `PW_RUN_ID=c3d4e5f6` 在隔离端口 3880–3883 完成 `164/164`（4.5m），并证明显式 Chat projector wiring 进入真实 Playwright service graph。
- 关键页面的数据边界未发现确定性的 P0/P1 假数据路径：官方编辑 seed 是经过 DB → Release → Serving → Qualification 的治理型冷启动供给，不是测试 fixture 或自然用户活动；actor-scoped 个人页面在没有事实时保持真实 empty state。
- 根 production build `5/5` 后，834px 浏览器审查发现并修复 TopControls overflow，独立 E2E `1/1` 通过，再执行 Main-only final build。Main release 为 `idream-f7579f81-cc0e-419f-a259-9f6f78c962f9`，Admin release 为 `idream-8838f3a3-c801-47cd-8df7-36c96cb88447`，build ID 均为 `build-TfctsWXpff2fKS`。
- PM2 7 logical apps / 8 processes online；`/`、`/explore`、`/admin/today` 为 200，Chat `/healthz` 为 `ok`。Main 1440px/375px 无 overflow/console error，最终 834px `scrollWidth=834` 且 filters in bounds；Admin Today/Characters/Creative/Incidents/Cases 为 `zh-CN`，375px/834px 无 overflow、console error 0。
- 最终 checkpoint 源端为 60 migrations（latest `20260718012000`）、20 users、16 characters/Releases/live Servings/active Qualifications/media、234 base tables、7 views、1 sequence，16 authority assertions / 0 broken；Main outbox `3,936`（pending `0`、failed `0`）、inbound `5,738`（received `0`）。Chat sessions/messages/attachments 为 `294/818/4`，outbox `1,552`、inbox `488`（均 pending `0`、failed `0`），file mutations `5`（pending `0`）；Redis operational pending/failed 均为 0。
- `redcraft_krea2_default` ready；真实 workflow-native `BackendImageModel → ComfyUI 0.28.0` MPS smoke 为 832×1024、880,175 bytes、132,649ms 并通过。当前 worker 使用 `GEN_IMAGE_PROVIDER=backend` 与 ComfyUI 8188。
- `launch:probe:pipeline --include-catalog` 当前是 `6/7`：web/product/chat-service/chat-model/voice/catalog 通过，legacy `pipeline@8091` image check 因网关未运行失败。它不是当前 backend/ComfyUI 失败，也不能把 pipeline suite 宣称为通过。
- Main DB + Chat FS + local Blob 的最终静默备份与隔离恢复已通过。Artifact base 为 `/Users/kk/code/idream/local-backups/idream-main-final-20260718-60/idream-main-final-20260718-60`；bundle 目录 `0700`、23 files 全部 `0600`、171M，SHA checks 全部通过。Chat FS 为 429 files / 550,987 bytes，Blob 为 13,634 files / 162,163,688 bytes；source/restore 的 counts、schema、logical DB、Chat FS、Blob 比较均为 zero difference，restore DB remaining `0`。PostgreSQL client/server 为 `18.3/16.14`。恢复后 PM2 7 logical apps / 8 processes 全部 online，Main/Admin HTTP 200、Chat health `ok`。公开生产 providers、canary、backfill、容量与 public-launch readiness 仍为 `NOT_EVALUATED`。

## 结论

历史状态（2026-07-04）：**DONE_WITH_CONCERNS，不能判定为可公开上线运营**。按 2026-06-26 范围决策，当前目标收窄为内部演示/受控 beta。

下方记录的是当时本地产品主流程、构建、E2E、Chrome smoke、web surface、产品生成配置、public catalog、默认图片模型候选、chat service、chat model、图片 pipeline 与 voice pipeline 的审计快照；2026-07-05 Gallery 质量复验补上 PNG checksum sanity 与浏览器可解码性证据。它们不能替代顶部列出的当前 revision live Gate，公开 launch gate 仍保持严格。

## 2026-06-26 范围决策

以下集成明确延后，先不作为当前里程碑工作：

- Go.cam：`AGE_VERIFICATION_PROVIDER=gocam`。
- BTCPay：`PAYMENT_PROVIDER=btcpay`。
- R2/S3：`BLOB_PROVIDER=r2` 或 `s3`。
- Sentry：`SENTRY_DSN`。

影响：

- 当前不能按公开上线验收，只能按本地/内部演示/受控 beta 验收。
- `check:launch` 不应因为这些集成延后而被降级放行；公开上线 gate 仍然必须保持严格。
- 下面的 provider、billing、storage、observability 项目保留为未来公开上线前必须恢复的清单。

**视频生成（第一期不上线）**：与上述"延后集成"不同，这是产品功能层面的延期——因视频生成耗时过长排入 V1.1（见 `docs/architecture/12-roadmap.md` 2026-06-27 范围决策）。第一期 `video_gen` 功能位保持 `false`，readiness 检查以"视频禁用"为预期通过（产品配置 probe 见 `video_gen=false`），不计为公开上线阻断项。前端关闭态不再展示 `Video Beta` 或 `Videos` 死入口；video 只在功能位、entitlement、video models 同时满足时曝光。

## 历史已验证通过（2026-07-03–05）

| 范围 | 证据 |
| --- | --- |
| 全量 E2E | 2026-07-04 当前全量：`PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3214 PW_ADMIN_BASE_URL=http://127.0.0.1:3006 BULLMQ_PREFIX=idream:e2e:3214-full bun --cwd packages/main playwright test src/e2e`，137/137 passed；历史 76/76 证据已被当前展开后的 137 个用例覆盖 |
| 全量测试 | `bun run test` passed |
| 类型、lint、构建 | `bun run check` passed |
| 运行进程 | `pm2 restart main-web admin-web` 后 main/admin/chat/gen/sdcpp-image 在线 |
| Chrome smoke | Chrome 访问 `/generate`、`/community`、`/upgrade`、`/admin`，无 console error、无 Next error shell；Generate 在 `video_gen=false` 时隐藏视频入口，并已完成一次 image job -> worker drain -> Gallery 回显闭环；2026-07-03 launch-surface smoke 重新确认 home/explore 和已加载 admin dashboard，截图 `launch-home-current.png`、`launch-admin-protected-current.png`；2026-07-04 launch-readiness smoke 重新确认 fresh home、fresh `/generate` age gate -> anonymous generator transition、admin package dev login wall 保护态，截图 `launch-readiness-home-2026-07-04.png`、`launch-readiness-generate-age-gate-2026-07-04.png`、`launch-readiness-generate-accepted-2026-07-04.png`、`launch-readiness-admin-package-protected-2026-07-04.png`；2026-07-04 video-disabled template smoke 确认 Generate 仍无 Video mode / `Video Beta` / Gallery `Videos` tab，截图 `generate-video-disabled-template-2026-07-04.png`；2026-07-04 Admin Content Ops 图片页 Chrome 复验确认 Asset Library 与 Placements 可见 `/user-content` 首屏图均 complete 且为 `loading="eager"`、`brokenVisible=[]`、无横向溢出、console warnings/errors `[]`，证据在 `docs/product-audits/2026-07-04-admin-asset-library-current-audit/`；2026-07-04 post-E2E public catalog Chrome 复验先发现 Feed/Community 里残留人工审计合集 `Chrome handoff 1783177343553`，已清理并增强 catalog probe，after-cleanup `/explore`、`/feed`、`/community` 与滚动懒加载复查均为 fixture matches `[]`、broken/incomplete visible images `0`、横向溢出 `false`、console warn/error `0`；2026-07-05 Gallery 当前质量复验确认 invalid PNG checksum 会在 sanity 层被拒绝，valid `64x64` 图片可渲染，tiny/blank cards fallback，无横向溢出、console warnings/errors `[]`，证据在 `docs/product-audits/2026-07-05-gallery-current-quality-audit/` |
| Promo redeem | 2026-07-04 Chrome cross-surface audit first reproduced admin-created code -> Profile redeem failure (`Redeem code not found`), then fixed hash unification + legacy SHA lookup + `maxRedemptions` transaction guard. The same pre-fix SHA-backed code redeemed from `/profile`, balance moved `7,145 -> 7,222`, replay returned `Code already redeemed`, admin redemptions count became `1`, and DB ledger recorded `redeem +77`; evidence in `docs/product-audits/2026-07-04-promo-redeem-cross-surface-audit/` |
| Web surface probe | 2026-07-04 `.tmp/launch-web-surface-probe-2026-07-04-goal.json`，`ok=true`，`MAIN_WEB_URL=http://launch-readiness-1783137908.localhost:3094`、`ADMIN_WEB_URL=http://launch-admin-1783137908.localhost:3001` 下首页、`/generate`、age-gated API、admin protected state、admin API 401 都通过；2026-07-03 `.tmp/launch-web-surface-probe-2026-07-03-continuation.json` 也通过 |
| Internal Pipeline probe | 2026-06-30 `bun run launch:probe:pipeline`，6/6 passed：web surface、product config、chat service、chat model pipeline、image pipeline、voice pipeline |
| 图片 pipeline | `.tmp/launch-image-probe.json`，`ok=true`，`provider=pipeline`，`pipelineUrl=http://127.0.0.1:8091`，`model=pornmaster-zimage-turbo`，最新复验产出 1 个 asset，约 97.3s |
| Chat model pipeline | focused probe `ok=true`，`provider=pipeline`，`baseUrl=http://127.0.0.1:8061/v1`，`model=Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-mlx-8Bit`，launch ack 约 10.3s；成人伴侣中文 smoke 约 2.2s |
| Chat service BFF | focused probe `ok=true`，SSE start/delta/done、exact assistant-message reload、no-memory send、blocked-input handling 全通过；新 chat model 切换后复验约 4.8s |
| Voice pipeline | `.tmp/launch-voice-probe-2026-06-30-qwen3tts.json`，`ok=true`，`provider=pipeline`，`baseUrl=http://127.0.0.1:8061/v1`，`model=Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit`，`voice=serena`，返回 WAV 音频 |
| 产品生成配置 | 2026-07-03 `.tmp/launch-product-config-probe-2026-07-03-continuation.json`，`ok=true`，active image profile/template/pricing 存在，16 个 public characters 全有 system prompt，`video_gen=false` |
| Public catalog | 2026-07-04 `docs/product-audits/2026-07-04-public-catalog-post-e2e-cleanliness-audit/catalog-probe-after-cleanup.json`，16 public characters、3 public collections、13 public creators、16 distinct images、0 issues；同轮增强 `probe:catalog` 覆盖 public media collections 与人工浏览器审计标记，并用 `catalog-probe-before-cleanup.json` 证明会阻断 `Chrome handoff 1783177343553` 这类公开污染；2026-07-05 Chrome 又在 `/helpdesk` roadmap voting 捕获 3 条旧公开 `Chrome ...` feedback fixture，`probe:catalog` 已扩展到 public roadmap feedback items，`public-catalog-probe-before.json` 以 5 个 launch-blocking issues 失败，清理后 `public-catalog-probe-after.json` 通过：16 public characters、3 public collections、13 public creators、3 public feedback items、16 distinct images、0 issues；2026-07-04 后续把 public catalog probe 接入 `check:launch`，最新 gate 证据在 `docs/product-audits/2026-07-04-launch-catalog-gate-audit/` 与 `docs/product-audits/2026-07-05-helpdesk-roadmap-status-audit/` |
| 默认图片模型候选 | 2026-07-03 `.tmp/generation-model-candidates-2026-07-03-continuation.json`，`pornmaster_zimage_default` active/enabled/rollout 100%，`readyForPublish=true`，所需本地模型组件存在 |
| launch gate | 2026-07-04 `docs/product-audits/2026-07-04-launch-catalog-gate-audit/check-launch-current-root.json`：`bun run check:launch -- --json` 为 `7 pass / 50 fail / 2 warn`，且根命令写出可解析 JSON；新增失败是当前 shell 未设置 `PUBLIC_CATALOG_PROBE_REPORT`。`docs/product-audits/2026-07-04-launch-catalog-gate-audit/check-launch-production-example-fresh.json`：`bun run check:launch:direct -- --launch-env-file packages/main/.env.production.example --json` 在新鲜 catalog 报告下为 `31 pass / 34 fail / 0 warn`，`public-catalog-live-probe` 通过；`.tmp/check-launch-production-example-fresh-mock-2026-07-04-goal.json` 仍证明新鲜 mock payment/blob/age 报告会被 production-shaped gate 拒绝；`.tmp/check-launch-production-example-2026-07-04-video-template.json` 证明 production example 下 video provider check 以“video disabled”通过。三者都仍未达到公开上线 gate |

## 当前图片服务链路

当前生产 worker 不依赖 8091 OpenAI-compatible image gateway，而是通过 workflow-native backend registry 选择 descriptor 并直连 ComfyUI：

```text
main-web -> BullMQ -> gen-image
  -> GEN_IMAGE_PROVIDER=backend
  -> BackendImageModel -> BackendRegistry
  -> redcraft-krea2-txt2img descriptor
  -> COMFYUI_API_URL=http://127.0.0.1:8188
  -> ComfyUI 0.28.0 / MPS
```

真实 backend smoke 已产出 832×1024、880,175-byte PNG，耗时 132,649ms。下方 `sdcpp-image` / `pipeline@8091` 记录只描述 2026-06-30 的 legacy adapter；当前仓库没有 `serve:sdcpp-image` 运行脚本，不得把它当作当前启动命令。

## 当前 Pipeline 状态

当前组合探针结果必须按子能力报告：

```bash
bun run launch:probe:pipeline -- --include-catalog
```

2026-07-18 当前结果为 `6/7`：web surface、product config、chat service、chat model、voice 与 catalog 通过；legacy image step 访问未运行的 8091 gateway 失败。当前生产图片 worker 是已独立 smoke 通过的 workflow-native `backend`，所以这不是 backend failure；但组合探针仍是 6/7，不能宣称 pass。

### 2026-06-30 legacy pipeline checkpoint

- `bun run launch:probe:pipeline` 通过，6/6。
- image pipeline 已通：`@idream/gen` 调 `http://127.0.0.1:8091/images/generations`，返回 `generation.completed`，产出 1 个 asset，最新耗时约 97.3s。
- chat pipeline 已通：`@idream/main probe:chat` 以 `CHAT_MODEL_PROVIDER=pipeline` 调 `http://127.0.0.1:8061/v1/chat/completions`，当前模型 `Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-mlx-8Bit`，launch ack 最新耗时约 10.3s，成人伴侣中文 smoke 约 2.2s。
- chat service BFF 已通：签名请求 200，未签名请求 401；probe 会自动选择本地 DB 的 public approved 角色，并完成 create/send/SSE start-delta-done/exact assistant-message reload/no-memory/blocked-input smoke。2026-06-30 已把 stream timeout 提高为默认 90s（可用 `CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS` 覆盖），并把 chat worker 的 terminal SSE `done` 移到 DB finalize 之后，避免 stream 先 done、reload 仍是 generating 的竞态。
- voice pipeline 当前本机已通：`VOICE_PROVIDER=pipeline` 调 `http://127.0.0.1:8061/v1/audio/speech`，`Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit` + `serena` 返回 WAV，最新耗时约 8.4s。此前本机 `Kokoro-82M-bf16` 路径当前返回 HTTP 500；若 demo 或上线承诺切到 MOSS voice，仍必须配置对应 `PIPELINE_VOICE_API_URL` 并重新运行 `bun run launch:probe:pipeline -- --include-voice`。

## 未来公开上线阻断

### Providers

未来公开上线前，必须把生产 provider 从 mock 切到真实实现：

- `CHAT_PROVIDER=pipeline`
- `VOICE_PROVIDER=pipeline`
- `PAYMENT_PROVIDER=btcpay`
- `BLOB_PROVIDER=r2` 或 `s3`
- `AGE_VERIFICATION_PROVIDER=gocam`

### Chat

当前失败项：

- `chat-bff-signing-secret`
- `chat-database-url`
- `chat-fs-root`
- `chat-model-provider`

需要配置：

- `CHAT_BFF_SIGNING_SECRET`，main-web 和 packages/chat 完全一致
- `CHAT_DATABASE_URL`，Postgres 用户必须是 `chat_service`
- `CHAT_FS_ROOT`，绝对路径且挂载 durable storage
- `CHAT_MODEL_PROVIDER=pipeline` 或 `openai`

### Billing（已延后）

当前失败项：

- `payment-api-key`
- `payment-btcpay-base-url`
- `payment-btcpay-store-id`
- `payment-webhook-secret`

未来公开上线前需要配置 BTCPay Greenfield：

- `BTCPAY_BASE_URL`
- `BTCPAY_STORE_ID`
- `BTCPAY_API_KEY`
- `BTCPAY_WEBHOOK_SECRET`

然后运行：

```bash
bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json
```

BTCPay live probe 现在必须同时证明两件事：Greenfield key 能读取目标 store，
且能创建一张小额 launch-test invoice 并返回 HTTPS checkout URL。旧版只包含
`canViewStore=true` 的 store-read 报告会被 `payment-provider-live-probe` 拒绝，
因为它不能证明 checkout 可创建。

2026-07-04 本地 `launch:probe:payment` 只产生 `provider=mock` 证据；production-shaped gate 会拒绝该报告，不能用来替代 BTCPay live probe。最新 mock 报告
`.tmp/launch-payment-probe-2026-07-04-invoice-proof.json` 已带新字段
`canCreateInvoice`/`invoiceId`/`checkoutUrl`，但 provider 仍是 mock，仍不是公开上线证据。

### Compliance（已延后）

当前失败项：

- `age-verification-service-url`
- `age-verification-api-key`
- `age-verification-webhook-secret`
- `age-verification-link-back-url`
- `age-verification-callback-url`

未来公开上线前需要配置 Go.cam gateway：

- `AGE_VERIFY_SERVICE_URL`
- `AGE_VERIFY_API_KEY`
- `AGE_VERIFY_WEBHOOK_SECRET`
- `AGE_VERIFY_LINK_BACK_URL`
- `AGE_VERIFY_CALLBACK_URL`

`AGE_VERIFY_LINK_BACK_URL` 和 `AGE_VERIFY_CALLBACK_URL` 必须是公网 HTTPS，不能是 localhost 或 placeholder。

然后运行：

```bash
bun run launch:probe:age -- --report .tmp/launch-age-probe.json
```

2026-07-04 本地 `launch:probe:age` 只产生 `provider=mock` / `status=not_required` 证据；production-shaped gate 会拒绝该报告，不能用来替代 Go.cam live session probe。

### Storage（已延后）

当前失败项：

- `blob-bucket`
- `blob-endpoint`
- `blob-access-key`
- `blob-secret-key`

未来公开上线前需要配置 R2/S3 私有对象存储：

- `BLOB_ENDPOINT`
- `BLOB_BUCKET`
- `BLOB_REGION`
- `BLOB_ACCESS_KEY_ID`
- `BLOB_SECRET_ACCESS_KEY`

然后运行：

```bash
bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json
```

2026-07-04 本地 `launch:probe:blob` 只产生 `provider=mock` / filesystem readback 证据；production-shaped gate 会拒绝该报告，不能用来替代 R2/S3 signed URL readback probe。

### Observability（已延后）

当前失败项：

- `sentry-dsn`

未来公开上线前需要配置：

- `SENTRY_DSN`

## 未来公开上线前执行顺序

1. 按 `docs/product/PRODUCTION_SECRET_CHECKLIST.md` 从 `packages/main/.env.production.example`、`packages/chat/.env.production.example`、`packages/gen/.env.production.example` 建立 secret manager 配置。
2. 部署或接入真实 pipeline、chat、BTCPay、Go.cam gateway、R2/S3、Sentry。
3. 运行所有 probe：

```bash
bun run --filter @idream/gen probe:image -- --model <active-product-config-model> --report .tmp/launch-image-probe.json
bun run launch:probe:video -- --model ltx23-gtanimation-i2v --reference <reviewed-character-image> --report .tmp/launch-video-probe.json
bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe.json
bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json
bun run launch:probe:catalog -- --report .tmp/public-catalog-probe.json
bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json
bun run launch:probe:chat -- --report .tmp/launch-chat-probe.json
bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json
bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json
bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json
bun run launch:probe:age -- --report .tmp/launch-age-probe.json
bun run launch:probe:sentry:main -- --report .tmp/launch-sentry-main-probe.json
bun run launch:probe:sentry:admin -- --report .tmp/launch-sentry-admin-probe.json
bun run launch:probe:sentry:chat -- --report .tmp/launch-sentry-chat-probe.json
bun run launch:probe:sentry:gen -- --report .tmp/launch-sentry-gen-probe.json
```

4. 运行最终 gate：

```bash
bun run check:launch -- --launch-env-file .tmp/production-launch.env
```

只有该命令 `PASS`，并且 Chrome 真实用户流程仍无 console/runtime 错误，才能把状态改为可上线运营。
