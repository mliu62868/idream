# 10 · 运维：环境 · 部署 · 迁移 · CI · 可观测性

更新日期：2026-06-28

## 1. 环境矩阵

> Postgres-only（ADR-2）：dev = prod = Postgres，无 SQLite、无 provider 切换。

| 环境 | DB | provider 实现 | 用途 |
| --- | --- | --- | --- |
| **local dev** | Docker Postgres（`docker-compose.yml`）+ Redis | mock（AI/支付/存储/验证） | 本地开发；`db:push` + seed |
| **preview / staging** | Postgres（独立库/分支）+ Redis | sandbox（BTCPay testnet / mock） | 集成验证 |
| **production** | Postgres + Redis | 真实（加密处理器 / 自托管模型流水线 / R2 / Upstash） | 线上（pm2 自托管，见 §4.3） |

> dev 与 prod 同为 Postgres，无行为漂移；搜索性能索引（`pg_trgm`）放在迁移 SQL（03 §5）。CI 跑真实 Postgres + Redis（§5）。

## 2. 环境变量目录

`.env`（dev）/ Vercel 环境变量（preview/prod）。**全部经 `lib/env.ts` Zod 校验，缺失即 fail-fast**。本地从 `.env.example` 开始，生产从 `packages/main/.env.production.example` 与 `packages/gen/.env.production.example` 开始，填充值只放在 secret manager。

| 变量 | 环境 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | all | Postgres URL（prod 用 **pooled**；dev 指向 Docker PG） |
| `DIRECT_URL` | prod | Postgres **direct** URL（迁移用，绕过 pooler） |
| `REDIS_URL` | all | BullMQ + 跨服务事件总线（dev=Docker redis） |
| `BULLMQ_PREFIX` | all | 队列前缀；main↔chat 必须一致（见 06 §9） |
| `CHAT_DATABASE_URL` / `CHAT_FS_ROOT` | all | chat 服务库连接 + 文件层根（记忆/会话日志，见 03 §3.4） |
| `BETTER_AUTH_SECRET` | all | ≥32 字节随机 |
| `BETTER_AUTH_URL` | all | 站点 URL |
| `INTERNAL_TOKEN` | all | 保护 `/api/internal/*` |
| `UPSTASH_REDIS_REST_URL`/`_TOKEN` | prod | 限流（dev 可空走 DB 令牌桶） |
| `PAYMENT_PROVIDER` + 处理器密钥 | prod | 加密处理器；支持 `btcpay`，需要 base URL、store id、Greenfield API key、webhook secret |
| `PIPELINE_API_URL` / `PIPELINE_API_TOKEN` | prod | 内部自托管开源模型流水线（chat/image/video/voice 共用，OpenAI 兼容；dev 可空走 mock）；main 已支持 chat/voice pipeline adapter |
| `GEN_IMAGE_PROVIDER` | all | `mock` / `pipeline`；主站和 `packages/gen` 只切 provider adapter，不直接切 MLX 或 sd.cpp |
| `MODERATION_PROVIDER=safety-gateway` + `MODERATION_SERVICE_URL`/`MODERATION_API_KEY` | prod | 审核/CSAM 检测（**独立密钥/服务**，07 §3）；main 与 gen 复用同一 adapter |
| `BLOB_PROVIDER` + `BLOB_*` | prod | 私有对象存储；支持 `r2` / `s3`，需要 endpoint、bucket、region、access key、secret key |
| `AGE_VERIFICATION_PROVIDER=gocam` + `AGE_VERIFY_SERVICE_URL`/`AGE_VERIFY_API_KEY`/`AGE_VERIFY_WEBHOOK_SECRET` | prod | Go.cam 身份年龄验证；主站调内部 gateway，gateway 持有 Go.cam SDK/partner keys |
| `SENTRY_DSN` | prod | 错误追踪 |

模型档位、prompt template、preset、feature flag、价格和 entitlement gate 不应写死在 env。它们属于后台配置数据，详见 [ADMIN_CONSOLE_PLAN.md](../product/ADMIN_CONSOLE_PLAN.md)。env 只保存服务地址、密钥和 adapter 总开关。

生成生产服务 secret：

```bash
bun run --silent launch:secrets
```

该命令只输出随机 dotenv 行，不会写文件；把输出复制到 secret manager 后，再填入数据库、Redis、BTCPay、Go.cam gateway、对象存储、Sentry 和 Pipeline gateway 的真实地址/凭据。

生产环境有两层门禁：

当前逐项审计见 [LAUNCH_READINESS_AUDIT.md](../product/LAUNCH_READINESS_AUDIT.md)；
只有 direct launch gate 与 Chrome 真实流程都通过时，才可以判定为可公开上线运营。

```bash
SDCPP_IMAGE_PORT=8091 \
SDCPP_IMAGE_MODEL_ID=pornmaster-zimage-turbo \
SDCPP_CLI=/Users/kk/code/sdcpp/sd-cli \
SDCPP_DIFFUSION_MODEL=/Users/kk/Downloads/pornmasterZImage_turboV35Bf16.safetensors \
SDCPP_LLM=/Users/kk/.localai/models/z-image-components/Qwen3-4B-Instruct-2507-Q4_K_M.gguf \
SDCPP_VAE=/Users/kk/.localai/models/z-image-components/split_files/vae/ae.safetensors \
SDCPP_STEPS=1 \
SDCPP_MAX_COUNT=1 \
SDCPP_TIMEOUT_MS=300000 \
bun run --filter @idream/gen serve:sdcpp-image
```

另开一个 shell 先跑内部 Pipeline beta 探针：

```bash
bun run launch:probe:pipeline
```

该命令会加载 `packages/main/.env`、`packages/chat/.env` 和
`packages/gen/.env`，验证 main/admin web surface、产品生成配置、chat service
BFF 签名、`CHAT_MODEL_PROVIDER=pipeline` 的 chat model，以及
`GEN_IMAGE_PROVIDER=pipeline` 的图片生成。voice 默认跳过，除非已配置
Pipeline `/audio/speech` gateway，或显式要求：

```bash
bun run launch:probe:pipeline -- --include-voice
```

### MOSS-TTS voice runner

Voice 使用独立的 OpenAI-compatible endpoint，不复用 `sdcpp-image`：

```bash
PIPELINE_VOICE_API_URL=http://127.0.0.1:8000/v1 \
PIPELINE_VOICE_MODEL_DEFAULT=OpenMOSS/MOSS-TTS-Local-Transformer-v1.5 \
bun run launch:probe:voice:local
```

Apple Silicon 上已经验证过一个更小的 oMLX 路径：

```bash
set -a; source packages/chat/.env; set +a
PIPELINE_VOICE_API_URL=http://127.0.0.1:8061/v1 \
PIPELINE_VOICE_API_TOKEN="$CHAT_MODEL_API_KEY" \
PIPELINE_VOICE_MODEL_DEFAULT=Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit \
VOICE_MODEL_PROBE_VOICE_ID=serena \
bun run launch:probe:voice:local
```

该模型的可用 speaker 包括 `serena`、`vivian`、`uncle_fu`、`ryan`、`aiden`、
`ono_anna`、`sohee`、`eric`、`dylan`。探针会在模型名包含 `Qwen3-TTS` 时默认用
`serena`。

Runner 选择：

- **不要用 sd.cpp 跑 MOSS-TTS**。sd.cpp 只保留为图片 `sdcpp-image` gateway。
- **生产/共享 GPU 优先 SGLang-Omni**。MOSS-TTS 官方说明 Local-Transformer-v1.5
  有 SGLang-Omni Day-0 支持，并暴露 OpenAI-compatible `/v1/audio/speech`、
  streaming 和 voice cloning。
- **Apple Silicon 本地实验可用 MLX / mlx-audio**。这适合开发机验证音色和延迟，
  但当前产品接入仍只认 `PIPELINE_VOICE_API_URL`。
- `PIPELINE_VOICE_API_URL` 优先级高于 `PIPELINE_API_URL`，避免 voice probe 误打到
  `http://127.0.0.1:8091` 的图片 gateway。

之后再按需要跑真实图片探针和上线门禁：

```bash
bun run launch:probe:pipeline
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

等价的显式命令如下，适合临时改 gateway、模型或输出路径时使用：

```bash
mkdir -p .tmp
GEN_IMAGE_PROVIDER=pipeline \
PIPELINE_API_URL=http://127.0.0.1:8091 \
PIPELINE_API_TOKEN=local-pipeline-token-0123456789 \
PIPELINE_IMAGE_MODEL_DEFAULT=pornmaster-zimage-turbo \
PIPELINE_IMAGE_SIZE_DEFAULT=512x512 \
BLOB_ROOT=/Users/kk/code/idream/.tmp/probe-blob \
  bun run --filter @idream/gen probe:image -- \
  --prompt "launch readiness portrait" \
  --count 1 \
  --report .tmp/launch-image-probe.json

bun run --filter @idream/main probe:web-surface -- \
  --report .tmp/launch-web-surface-probe.json

bun run --filter @idream/main probe:blob -- \
  --report .tmp/launch-blob-probe.json

bun run --filter @idream/main probe:product-config -- \
  --report .tmp/launch-product-config-probe.json

bun run --filter @idream/main probe:chat-service -- \
  --report .tmp/launch-chat-service-probe.json

bun run --filter @idream/main probe:chat -- \
  --report .tmp/launch-chat-probe.json

bun run --filter @idream/main probe:voice -- \
  --report .tmp/launch-voice-probe.json

bun run --filter @idream/main probe:payment -- \
  --report .tmp/launch-payment-probe.json

bun run --filter @idream/main probe:age -- \
  --report .tmp/launch-age-probe.json

bun run --filter @idream/main probe:safety -- \
  --report .tmp/launch-safety-probe.json

bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env
```

`.tmp/production-launch.env` 应来自 secret manager 导出，或由
`packages/main/.env.production.example` 复制后填入真实生产值；不要提交到 git。
这份文件必须包含 `APP_ENV=production`、所有 provider/密钥/外部服务配置，以及
`PIPELINE_IMAGE_PROBE_REPORT=.tmp/launch-image-probe.json` 和
`WEB_SURFACE_PROBE_REPORT=.tmp/launch-web-surface-probe.json`、
`PRODUCT_CONFIG_PROBE_REPORT=.tmp/launch-product-config-probe.json`、
`CHAT_SERVICE_PROBE_REPORT=.tmp/launch-chat-service-probe.json`、
`CHAT_MODEL_PROBE_REPORT=.tmp/launch-chat-probe.json`、
`VOICE_MODEL_PROBE_REPORT=.tmp/launch-voice-probe.json`、
`PAYMENT_PROVIDER_PROBE_REPORT=.tmp/launch-payment-probe.json`、
`AGE_VERIFICATION_PROBE_REPORT=.tmp/launch-age-probe.json`、
`BLOB_STORAGE_PROBE_REPORT=.tmp/launch-blob-probe.json`、以及
`SAFETY_GATEWAY_PROBE_REPORT=.tmp/launch-safety-probe.json`。
`--launch-env-file` 中的值会覆盖当前 shell 的 dev env，适合在部署前做可重复的生产门禁。
需要机器可读结果时加 `--json`。

`APP_ENV=production` 时主站拒绝使用 mock
chat/voice/moderation/payment/blob/age-verification provider，且必须配置
`CHAT_SERVICE_URL` 与 `CHAT_BFF_SIGNING_SECRET`。`check:launch` 会进一步
检查 Postgres、Redis、Sentry、对象存储、支付 webhook、审核、年龄验证和图片
Pipeline 配置，并要求 `PIPELINE_IMAGE_PROBE_REPORT` 指向最近一次真实图片
pipeline probe 报告。报告必须证明 provider 为 `pipeline`、模型和
`PIPELINE_API_URL` 匹配、finalizer payload 为 `generation.completed`，且至少
产出 1 个 asset；否则 `check:launch` 失败。这样配置完整但模型服务超时的环境
不能误报为可上线。门禁还要求 `WEB_SURFACE_PROBE_REPORT` 指向最近一次 web surface
probe 报告，证明 main-web 首页和 `/generate` 返回健康 HTML、未过 age gate 的公开 API
按 403 fail-closed、admin-web 未登录时返回 protected state，且 admin JSON API 未登录时按
401 fail-closed；否则服务进程在线但用户入口或管理入口不可用时不能误报为可上线。门禁还要求
`PRODUCT_CONFIG_PROBE_REPORT` 指向最近一次 product
config probe 报告，证明 DB 中至少有 active image model profile、image character/freeplay
prompt template 和 image pricing rule；如果 `video_gen` feature flag 打开，还必须同时有
active video profile、video prompt template 和 video pricing rule，并且 `GEN_VIDEO_PROVIDER`
不能是 mock。`video_gen=false` 时，视频 provider 可保持 mock 且门禁通过。门禁还要求
`CHAT_SERVICE_PROBE_REPORT` 指向最近一次 chat
service probe 报告，证明 `/healthz` 可达、BFF 签名的只读 chat 请求返回 200、
未签名请求返回 401；否则 chat split 不能误报为可上线。`VOICE_MODEL_PROBE_REPORT`
也必须指向最近一次 voice
probe 报告，证明当前 `VOICE_PROVIDER` 能通过同一个 pipeline gateway 生成可用
voice asset；否则语音能力不能误报为可上线。门禁也要求 `BLOB_STORAGE_PROBE_REPORT` 指向最近一次对象存储
probe 报告，证明当前 `BLOB_PROVIDER` 能对真实 bucket 完成 PUT、signed GET
读回校验和 DELETE；否则对象存储 env 填了但 credentials、bucket policy 或 endpoint
不可用时会失败。门禁还要求 `SAFETY_GATEWAY_PROBE_REPORT` 指向最近一次 safety gateway
probe 报告，证明 `MODERATION_SERVICE_URL` 能鉴权、返回可解析 decision，并且良性文本不会被误拦。
`CHAT_MODEL_PROBE_REPORT` 则证明 `CHAT_MODEL_BASE_URL`/`PIPELINE_API_URL` 指向的
OpenAI-compatible chat gateway 能鉴权、返回 assistant 文本并正常结束流式响应。
`PAYMENT_PROVIDER_PROBE_REPORT` 对 BTCPay 使用无副作用的 Greenfield
`GET /api/v1/stores/{storeId}`，证明 `BTCPAY_API_KEY` 具备读取目标 store 的权限；
probe 不创建 invoice，不改变支付状态。
`AGE_VERIFICATION_PROBE_REPORT` 会通过内部 age gateway 创建一个 probe
verification session，证明 Go.cam gateway 能鉴权、返回 pending session id 和公开 HTTPS
验证链接；该 probe 不提交证件或完成年龄认证，但会在 provider/gateway 侧留下一个待处理测试 session。
门禁也会明确指出“env 已配置但当前代码还没实现真实 adapter”的情况。
对象存储已支持 R2/S3 兼容 API：主站用同一配置生成私有媒体下载签名，
gen worker 用同一配置写入生成产物。
支付已支持 BTCPay Greenfield API：checkout 创建 invoice，webhook 使用
`BTCPay-Sig`/`x-signature` 对原始请求体做 HMAC 校验，只有 settled invoice
会激活订阅。
审核已支持 `safety-gateway` adapter：main-web 和 gen worker 都会把文本/媒体
审核请求投到 `MODERATION_SERVICE_URL`（根路径默认 `/moderation/check`），用
`MODERATION_API_KEY` Bearer token 鉴权，并统一解析 `passed/flagged/blocked`、
`policyCode` 和 `confidence`。
chat/voice provider 已支持 `pipeline`：chat 调 OpenAI-compatible
`/chat/completions`（SSE 或 JSON 均可），voice 调 `/audio/speech`，音频可由
Pipeline 返回对象存储 key，或由 main 写入私有 blob。
年龄验证已支持 `gocam` adapter：main-web 调内部 age gateway 创建验证
session，gateway 负责 Go.cam SDK/partnerId/cipherKey/HMAC key；回调到
`/api/v1/age-verification/webhooks/gocam` 时必须带
`x-age-verify-signature`、`x-gocam-signature` 或 `x-signature` HMAC 签名。

图片 worker 在 production 下拒绝 `GEN_IMAGE_PROVIDER=mock`；使用 `pipeline`
时必须配置 `PIPELINE_API_URL`。本地 ComfyUI/Z-Image、MLX 或 sd.cpp 都应挂在
内部 Pipeline API 后面，产品服务只调用 pipeline adapter。`probe:image` 必须返回
`ok: true` 且 finalizer payload 为 `generation.completed`，并把 `--report`
写出的 JSON 提供给 `check:launch` 后，才能继续跑主站 E2E。
`pornmasterZImage_turboV35Bf16.safetensors` 不是可直接传给 LocalAI 的完整
model id；它是 Z-Image diffusion model，需要匹配的 Qwen3 4B text encoder
和 Flux/Z-Image VAE。`serve:sdcpp-image` 用这些组件包装成
OpenAI-compatible `/images/generations` / `/v1/images/generations` 接口，
产品层仍只配置 `PIPELINE_API_URL` 与稳定 alias（例如
`pornmaster-zimage-turbo`）。
本地容量较弱时可用 `PIPELINE_IMAGE_SIZE_DEFAULT=512x512` 做接口/队列/Blob
smoke；线上质量尺寸由后台 `GenerationModelProfile.defaultWidth/defaultHeight`
或 Pipeline Service profile 控制，不能靠产品层静默降级。

`prisma.config.ts`（Prisma 7，**每个包一份**，路径相对各包根目录）：

```ts
// packages/main/prisma.config.ts （packages/chat 同构，指向各自 schema）
import "dotenv/config";
import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",                          // 相对 packages/main
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/idream" },
});
```

## 3. 数据库与连接池

- **prod**：Neon（或 Supabase）—— Vercel Postgres 已下线，走 **Vercel Marketplace**。
- **连接**：app（serverless）用 **pooled** 连接（`DATABASE_URL`，PgBouncer/Neon pooler，防连接耗尽）；`migrate` 用 **direct** 连接（`DIRECT_URL`）。
- PrismaClient 单例（09 §4.1）防 HMR/函数复用泄漏。
- 规模上来可选 **Prisma Accelerate** 或 driver adapter 进一步池化/缓存。

## 4. 部署

### 4.1 部署形态

**实际部署 = pm2 自托管常驻进程拓扑（见 §4.3，`ecosystem.config.js`）**。队列由 BullMQ 常驻 worker 持续消费（ADR-5），**不需要 Cron drain**。仅周期性维护任务（清理过期 session/软删媒体、额度结算）需要定时器，可用 pm2 cron restart、容器内调度或外部 cron 触发对应 `/api/internal/*` 端点（校验 `INTERNAL_TOKEN`）。

- `next.config.ts` 已 `output:"standalone"`（pm2 与 Docker 均用）。
- `/api/internal/*` 由 `INTERNAL_TOKEN` 保护，`proxy.ts` matcher 排除 `/api/internal`。
- 长任务/流式 route 配 `maxDuration`（route segment config）。

### 4.2 Docker（备选自托管）
- 既有 `Dockerfile` + `docker-compose.yml`：app + Postgres。Cron 用容器内调度（如 `node-cron` 触发 drain，或外部 cron 调 `/api/internal`）。

### 4.3 PM2（自托管进程拓扑）

`ecosystem.config.js` 是自托管时的产品服务入口。主站和后台拆成两个独立 Next.js 服务：

| PM2 app | package | 默认端口 | 说明 |
| --- | --- | --- | --- |
| `main-web` | `packages/main` | `3000` | 公开产品页、角色、订阅、用户 API 和 BFF |
| `admin-web` | `packages/admin` | `3001` | 内部管理后台和 `/api/v1/admin/*` 控制面 API |
| `chat` | `packages/chat` | `CHAT_PORT` | chat API/SSE + worker，单实例本地文件写入 |
| `gen-image` / `gen-video` | `packages/gen` | n/a | 异步生成 worker |
| `gen-finalizer` / `main-event-consumer` | `packages/main` | n/a | 主站侧权威写回和事件消费 |

运行命令：

```bash
bun run build
bun run pm2:start
bun run pm2:status
```

Next.js 服务使用 `output: "standalone"`，构建后会把 `.next/static` 和 `public` 复制进 standalone 目录。PM2 通过 `scripts/start-next-standalone.cjs` 先加载对应 package 的 `.env`，再运行 standalone `server.js`，不使用 `next start`。

如果是在同一个工作目录内执行 `bun run build`，构建完成后必须对 web 进程执行 `pm2 restart main-web admin-web`。不要在 in-place Next.js build 后对 web 进程执行 `pm2 reload`：旧 cluster worker 可能继续引用已被新构建删除的 server chunk，表现为随机 `ChunkLoadError`、路由超时或 client reference manifest 缺失。只有每个进程都指向不可变 release 目录时，`pm2 reload main-web admin-web` 才适合作为零停机切换。

`admin-web` 使用 `packages/admin/.env`，但必须与 `packages/main/.env` 共享 `DATABASE_URL`、`BETTER_AUTH_SECRET`、`INTERNAL_TOKEN`、`CRON_SECRET` 等服务端密钥。PM2 默认给 `main-web` 设置 `PORT=3000`、给 `admin-web` 设置 `PORT=3001`；需要改端口时在启动 PM2 前设置 `MAIN_WEB_PORT` / `ADMIN_WEB_PORT`。

## 5. CI/CD（`.github/workflows`）

流水线（对齐 global verify 体系 L1-L4）使用 bun workspace、Postgres 和 Redis：

```
1. setup bun 1.3.14 + bun install --frozen-lockfile
2. install Playwright Chromium
3. bun run check                         # 全包 lint + typecheck + build
4. bun run --filter @idream/main test    # 主站 L2/L3，Postgres + Redis
5. bun run --filter @idream/chat test    # chat 边界和服务测试，Postgres + Redis
6. bun run --filter @idream/gen test     # 生成 worker/provider 测试
7. bun run --filter @idream/shared test  # 跨服务 contract 测试
8. prepare idream_e2e DB + seed
9. start main-web dev server
10. bun run --filter @idream/main test:e2e # L4 Playwright
```

- **迁移在部署前于 CI/部署流水线跑** `prisma migrate deploy`（prod direct URL），失败则阻断发布。
- `bun run check` 是本地最小门；上线前还必须跑 `bun run --filter @idream/main test:e2e` 和 `bun run check:launch -- --launch-env-file .tmp/production-launch.env`。
- 数据库迁移 SQL **只能由具备权限者/CI 执行**（global rule：模式变更 SQL 由用户/CI 跑，Claude 只产出）。

## 6. 迁移 Runbook（Postgres-only）

应用内表走 Prisma（每包独立 schema/migrations）；**跨服务库边界（schema/role/grant/视图/chat 表）走 `db/sql/*.sql`，由用户在 prod 手工执行**。

| 操作 | 命令 | 谁执行 |
| --- | --- | --- |
| dev 改 schema（应用内表） | `bun run --filter @idream/main db:push`（Postgres dev 库，无迁移文件） | 开发者 |
| 生成迁移 | `bun run --filter @idream/main db:migrate:dev`（产生迁移文件，提交 git） | 开发者 |
| 加性能索引 | 在迁移目录手写 raw SQL（`pg_trgm` 等，03 §5） | 开发者 |
| 部署应用内表迁移 | `bun run --filter @idream/main db:migrate:deploy`（prod direct URL） | CI |
| **DB 边界变更** | `db/sql/*.sql`（`bash db/sql/apply-validate.sh`）：`01_schemas_roles` / `02_core_views` / `03_character_management` / `03_chat_tables` / `04_grants` / `05_main_recent_chats` | **用户在 prod 执行** |
| 回滚 | 写"down"迁移或新正向修复迁移（Prisma 不自动回滚） | CI + 评审 |

**破坏性变更**（删列/改类型）：分两步（先兼容加列/双写 → 迁移数据 → 再删旧），避免停机。

> `db/sql/` 是跨服务库边界的 SSoT：chat 服务以 `chat_service` 角色连接、只读 main 的 core/billing/compliance 视图、读写 `chat.*` 表（见 03 §3.4）。这些 DDL 不归 Prisma `db push` 管。

## 7. 备份与容灾

- Neon/Supabase 自带 PITR/快照；设保留期。
- 对象存储（R2）跨区/版本化。
- ledger/审核/CSAM 证据等审计数据**长期保留**（07 §6/§3）。
- 定期演练恢复。

## 8. 可观测性

### 8.1 日志
- `lib/logger.ts`（pino）结构化 JSON，带 `requestId`/`userId`(脱敏)/`route`；**禁 console.log**（global rule + hook）。
- 不记明文密码/token/敏感聊天内容（07 §6）。

### 8.2 错误追踪
- Sentry（prod），关联 requestId；`handle()` 兜底未捕获异常。

### 8.3 产品埋点（PRD §9）
- `events.track(name, props, ctx)` → `after()` 异步 → `analytics_events` 表 +/或外发分析平台。
- 覆盖事件：age_gate_viewed/accepted、signup/login_clicked、character_card_viewed/clicked、explore_filter/search、category_selected、chat_started、message_sent、character_create_started/created、generation_started/completed/failed、media_liked/managed、feed_*、upgrade_viewed、checkout_started、subscription_started、referral/redeem、content_reported、moderation_appeal_started。

### 8.4 运营指标 / 漏斗（PRD §9、§10）
- 转化漏斗：age gate 通过率、首页→注册、卡片点击率、搜索/筛选使用、首聊启动、创建完成率、生成成功率、免费→付费、举报处理时长。
- 系统健康：队列积压/死信、生成成功率与时延、provider 错误率、限流命中、DB 连接数。
- 仪表盘可先用 SQL/Studio 看 `analytics_events`、BullMQ 队列状态（waiting/active/failed），再接 BI。

### 8.5 告警
- BullMQ failed/积压增长、生成成功率骤降、webhook 处理失败、CSAM 命中（高优先级人工通道）、错误率/延迟阈值。

### 8.6 管理后台运行指标

后台控制面本身也要监控：

- 配置发布：model profile、prompt template、feature flag、pricing rule 的发布/回滚次数。
- 高风险操作：封号、下架、ledger adjustment、dead-letter requeue、profile disable。
- 审计完整性：后台写操作必须有 `AdminAuditLog`；发现缺审计的写路径直接告警。
- 权限失败：非授权访问 `/api/v1/admin/*` 的次数和来源。
- 生成运营：按 profile/runner/provider error code 切分成功率、平均等待、退款率、blocked 率。
