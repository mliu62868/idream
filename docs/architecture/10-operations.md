# 10 · 运维：环境 · 部署 · 迁移 · CI · 可观测性

更新日期：2026-07-18

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
| `CHAT_DATABASE_URL` | all | Chat 请求连接；必须使用 `chat_service` role，只能创建 durable file intent，不能伪造投影完成 |
| `CHAT_PROJECTOR_DATABASE_URL` | all | Chat 文件投影连接；必须使用独立 `chat_projector` role，完成文件副作用后收敛 mutation receipt |
| `CHAT_FS_ROOT` | all | Chat 文件权威根（session trace、记忆、关系、边界；必须是 durable volume，见 03 §3.4） |
| `BETTER_AUTH_SECRET` | all | ≥32 字节随机 |
| `BETTER_AUTH_URL` | all | 站点 URL |
| `INTERNAL_TOKEN` | all | 保护 `/api/internal/*` |
| `UPSTASH_REDIS_REST_URL`/`_TOKEN` | prod | 限流（dev 可空走 DB 令牌桶） |
| `PAYMENT_PROVIDER` + 处理器密钥 | prod | 加密处理器；支持 `btcpay`，需要 base URL、store id、Greenfield API key、webhook secret |
| `PIPELINE_API_URL` / `PIPELINE_API_TOKEN` | prod | OpenAI-compatible adapter 地址/凭据；当前 chat/voice 使用，8091 image gateway 仅为 legacy 可选路径 |
| `GEN_IMAGE_PROVIDER` | all | `mock` / `pipeline` / `backend`；当前生产 worker 使用 `backend`，经 workflow descriptor 直连 ComfyUI |
| `COMFYUI_API_URL` | backend | workflow-native ComfyUI API；当前本地 runtime 为 `http://127.0.0.1:8188` |
| `GEN_WORKFLOW_DIR` | backend | workflow descriptor JSON 根；未显式设置时使用仓库 `packages/gen/workflows` |
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

当前图片 worker 的真实 smoke 直接走与生产相同的 workflow-native provider seam：

```bash
COMFYUI_API_URL=http://127.0.0.1:8188 \
bun run --filter @idream/gen smoke:backend -- \
  --model redcraft-krea2-comfyui \
  --out /private/tmp/idream-backend-smoke.png
```

2026-07-18 证据为 `BackendImageModel → BackendRegistry → ComfyUI 0.28.0/MPS`，
832×1024、880,175 bytes、132,649ms。仓库当前不存在 `serve:sdcpp-image` 脚本；
旧 sd.cpp gateway/8091 命令只能作为历史架构记录，不能用于当前启动或健康判断。

另开一个 shell 先跑内部 Pipeline beta 探针：

```bash
bun run launch:probe:pipeline
```

该命令会加载 `packages/main/.env`、`packages/chat/.env` 和
`packages/gen/.env`，组合验证 web/product/chat 等能力。它的 legacy image step
仍检查 `GEN_IMAGE_PROVIDER=pipeline` / 8091 gateway，与当前生产 worker 的
`GEN_IMAGE_PROVIDER=backend` 是两个独立 gate。voice 默认跳过，除非已配置
Pipeline `/audio/speech` gateway，或显式要求：

```bash
bun run launch:probe:pipeline -- --include-voice
```

2026-07-18 的 `launch:probe:pipeline --include-catalog` 为 `6/7`：web、product
config、chat service、chat model、voice、catalog 通过；legacy 8091 image check
因 gateway 未运行失败。当前 `backend` smoke 独立通过，所以不能把该失败解释为
ComfyUI/backend failure；同样不能把组合 pipeline suite 宣称为 pass。

### Local ComfyUI runner（FP8 / 升级 runbook）

PyTorch MPS 没有原生 Float8 dtype。runner（`/Users/kk/ComfyUI-Installs/idream (1)/ComfyUI`，
pm2 进程 `comfyui-idream`，端口 8188）依赖 `custom_nodes/` 里的
[ComfyUI-AppleSilicon-FP8](https://github.com/pawel-mazurkiewicz/ComfyUI-AppleSilicon-FP8)
在每次启动时给 MPS 打运行时 patch。禁止把旧的 `fp4-fp8-for-torch-mps` pip 包装回
venv——两者 patch 同一批 MPS 算子，叠加后行为不可预测（2026-08-02 已切换并卸载旧包）。

ComfyUI 升级**不需要重新打补丁**：custom_nodes 不会被升级触碰，patch 在启动时自动
重放。升级后只需重启并验证：

```bash
pm2 restart comfyui-idream
cd packages/gen && bun run preflight && bun run smoke:backend
```

- `preflight` 硬检查节点目录（经 `.env` 的 `COMFYUI_VENV_PYTHON` 推导）与模型可见性，
  异常 exit 1；
- `smoke:backend` 用生产 fp8 模型（默认 `redcraft-krea2-redmix3-fp8`）真实出图。

异常处置：

- **smoke 失败 / 黑图**（ComfyUI 内部 API 变动导致 patch 失效）：更新节点后重启——
  `git -C "<comfyui>/custom_nodes/ComfyUI-AppleSilicon-FP8" pull && pm2 restart comfyui-idream`。
  逐项 patch 生效状态看启动日志：
  `pm2 logs comfyui-idream --nostream | grep AppleSilicon-FP8`；其中 `na_gemm`
  内核编译失败属预期（M5/Metal 4.1 专属，本机自动降级 LUT 路径）。上游未跟进新版
  ComfyUI 时的临时退路：受影响 descriptor 先切 GGUF/bf16 权重。
- **Desktop 大版本升级重建 venv**：节点目录仍在，但其 pip 依赖（`mtlflashattn`/
  `ninja`）可能被清，用 venv python 重装 `pip install -r <节点目录>/requirements.txt`。
  依赖缺失只降级 flash-attention 加速，fp8 核心 patch 不受影响。

细节与出处：`packages/gen/README.md` §"FP8 on Apple Silicon (MPS)"、
`docs/research/QWEN_FP8_ON_APPLE_MPS_LANDED_2026-07-29.md`（头部含 2026-08-02
方案切换说明）。

### Local voice runner

Voice 当前使用 Fish Audio S2 Pro 8-bit。仓库内 `8062` 进程使用 oMLX 随附的
`mlx-audio` 直接常驻装载模型，暴露 OpenAI-compatible `/v1/audio/speech` 和
持久声音注册接口。它不复用 legacy 8091 image gateway：

```bash
bun run voice:fish:prepare-system -- \
  --audio /path/to/curated-adult-female-reference.wav \
  --manifest /path/to/curated-adult-female-reference.json
pm2 delete pocket-tts 2>/dev/null || true
pm2 start ecosystem.config.js --only fish-audio --update-env
pm2 save
curl -fsS http://127.0.0.1:8062/health
bun run launch:probe:voice:local
```

先在 oMLX Admin → Downloads 下载公开的 `mlx-community/fish-audio-s2-pro-8bit`。
`/health` 必须报告 `runtime: mlx_audio`、`acceleration: mlx`、
`model_loaded: true`、`voice_cloning: true`、`system_voice_ready: true`；
系统女性参考 WAV 或 manifest 缺失时会直接返回 HTTP 503。默认配置：

```dotenv
VOICE_PROVIDER=fish-audio
FISH_AUDIO_API_URL=http://127.0.0.1:8062/v1
FISH_AUDIO_MODEL=fish-audio-s2-pro-8bit
FISH_AUDIO_MODEL_PATH=/path/to/.omlx/models/mlx-community/fish-audio-s2-pro-8bit
FISH_AUDIO_LANGUAGE=auto
FISH_AUDIO_DEFAULT_VOICE_ID=fish-female-default
FISH_AUDIO_SYSTEM_REFERENCE_AUDIO=/path/to/curated-adult-female-reference.wav
FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST=/path/to/curated-adult-female-reference.json
```

声音克隆入口在 Admin 的 Character Workspace → Voice，分成候选制作和明确启用
两段 authority。候选制作会：

- 读取最多前 30 秒的单人参考录音和准确转录文本；
- 将规范化参考 WAV 与 manifest 持久化到 `.data/fish-audio/voices/`；每次生成时
  将参考 WAV 解码为 MLX array，并与 `ref_text` 一起传给 Fish，进程重启后仍可复用；
- 保存性感、亲密、俏皮、自信或自然 preset，以及强度、语速和采样参数；
- 保存原始参考音频和试听 WAV 为 `MediaAsset`；
- 创建状态为 `candidate` 的版本化 `CharacterVoiceProfile`，但不修改
  `Character.voiceId`。

操作者试听后，只有具备 `character.release.publish` 的账号才能明确启用候选。
启用事务会归档旧 active profile、激活同一份已试听候选、写 Audit/Outbox，并原子更新
`Character.voiceId`；新生成的聊天语音立即使用新声音，已有缓存 clip 保持不变。
聊天页会在每条助手回复完成后后台预生成并按 `messageId` 缓存语音，不阻塞文字回复；
自动预生成只消耗套餐内 `voice_minutes`，不会自动扣梦币。用户显式点击播放时复用
已有或进行中的生成；套餐分钟不足时才进入原有的显式溢出计费路径。

`FISH_AUDIO_API_TOKEN` 保护 Main → Fish runtime。旧 Pocket voice registry 与
pipeline voice adapter 仍保留为回滚路径，但不再是当前默认；已有 Pocket profile
不会被静默改写为 Fish profile，需从 Admin 原始参考音频创建并审核新的 Fish 候选。

之后再按需要跑真实图片探针和上线门禁：

```bash
bun run launch:probe:pipeline
bun run --filter @idream/gen probe:image -- --model <active-product-config-model> --report .tmp/launch-image-probe.json
bun run launch:probe:video -- --model ltx23-gtanimation-i2v --reference <reviewed-character-image> --report .tmp/launch-video-probe.json
bun run launch:probe:generation-model-candidates -- --report .tmp/launch-generation-model-candidates.json
bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe.json
bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json
bun run launch:probe:catalog -- --report .tmp/public-catalog-probe.json
bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json
bun run launch:probe:chat -- --report .tmp/launch-chat-probe.json
bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json
bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json
bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json
bun run launch:probe:age -- --report .tmp/launch-age-probe.json
bun run launch:probe:safety -- --report .tmp/launch-safety-probe.json
bun run launch:probe:sentry:main -- --report .tmp/launch-sentry-main-probe.json
bun run launch:probe:sentry:admin -- --report .tmp/launch-sentry-admin-probe.json
bun run launch:probe:sentry:chat -- --report .tmp/launch-sentry-chat-probe.json
bun run launch:probe:sentry:gen -- --report .tmp/launch-sentry-gen-probe.json
bun run check:launch:direct -- \
  --launch-env-file .tmp/production-main.env \
  --admin-env-file .tmp/production-admin.env \
  --chat-env-file .tmp/production-chat.env \
  --gen-env-file .tmp/production-gen.env \
  --report .tmp/check-launch.json
```

`LAUNCH_SCOPE` is a closed release contract: `full` is the default and requires
every product area; `core` excludes only Billing and Age Verification when those
areas are explicitly outside the release. It does not suppress migrations,
ProductConfig, HTTPS/secrets, Redis, Chat, Gen, Blob, Sentry, or any other gate.
Unknown values fail closed. Put the chosen value in the Main authority that will
feed PM2; Chat and Gen must use their own exact deployed env authorities.

`launch:probe:chat-service` must prove more than BFF reachability: it runs a signed
conversation smoke (session create, message send, SSE stream, reload, no-memory
send, and blocked-input handling). If `CHAT_SERVICE_PROBE_CHARACTER_ID` is unset,
the probe auto-selects a public approved adult character from the main DB; use
`--character-id=...` when a fixed production probe character is required.

Sentry readiness requires four distinct, fresh reports from the package-bound
`probe:sentry` entrypoints. The CLI intentionally rejects a relabeled `--service`;
each package loads its own SDK/runtime and binds the captured event plus resolved
Sentry tags to `main` / `admin` / `chat` / `gen`. A missing, mislabeled, or stale
runtime report keeps the launch gate closed.

`probe:image` 必须使用 production Gen adapter/blob env，且 model/workflow/version 必须与
`probe:product-config` 返回的全部公开图片 execution bindings 一致；报告包含 immutable
TerminalRecord ref/checksum。Video 启用时还必须用审核过的角色源图运行 `probe:video`，
完成固定 LTX workflow、MP4 decode 检查和 TerminalRecord 持久化。以下 8091 显式命令只用于需要审计旧 OpenAI-compatible image adapter 的场景；
它要求另行提供外部 gateway，仓库没有可启动它的 `serve:sdcpp-image` 脚本。当前
workflow-native backend 的工程 smoke 使用本节顶部 `smoke:backend` 命令，但公开上线
门禁只接受上述 workflow-bound `probe:image` / `probe:video` 报告。

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

bun run check:launch:direct -- \
  --launch-env-file .tmp/production-main.env \
  --admin-env-file .tmp/production-admin.env \
  --chat-env-file .tmp/production-chat.env \
  --gen-env-file .tmp/production-gen.env \
  --report .tmp/check-launch.json
```

`.tmp/production-main.env`、`.tmp/production-admin.env`、`.tmp/production-chat.env`、`.tmp/production-gen.env` 应来自 secret manager
对实际部署服务的精确导出；可分别参考对应 package 的 production example，且都不得提交到 git。Main 文件
必须包含 `APP_ENV=production`、Main provider/密钥/外部服务配置，以及
`PIPELINE_IMAGE_PROBE_REPORT=.tmp/launch-image-probe.json` 和
`WEB_SURFACE_PROBE_REPORT=.tmp/launch-web-surface-probe.json`、
`PRODUCT_CONFIG_PROBE_REPORT=.tmp/launch-product-config-probe.json`、
`PUBLIC_CATALOG_PROBE_REPORT=.tmp/public-catalog-probe.json`、
`CHAT_SERVICE_PROBE_REPORT=.tmp/launch-chat-service-probe.json`、
`CHAT_MODEL_PROBE_REPORT=.tmp/launch-chat-probe.json`、
`VOICE_MODEL_PROBE_REPORT=.tmp/launch-voice-probe.json`、
`PAYMENT_PROVIDER_PROBE_REPORT=.tmp/launch-payment-probe.json`、
`AGE_VERIFICATION_PROBE_REPORT=.tmp/launch-age-probe.json`、
`BLOB_STORAGE_PROBE_REPORT=.tmp/launch-blob-probe.json`、以及
`SAFETY_GATEWAY_PROBE_REPORT=.tmp/launch-safety-probe.json`。
传入显式 service env 文件时，对应文件是产品配置的完整 authority，ambient product credential/probe 不参与
补值，只继承 PATH/TMP 等运行命令所需白名单；缺项会失败关闭。不传显式文件时，Gate 与真实 runtime 一致地
采用 shell-over-default-file 优先级，不能让 package `.env` 覆盖部署 shell。三服务值不会互相回退。
需要机器可读结果时加 `--json`。

`APP_ENV=production` 时主站拒绝使用 mock
chat/voice/moderation/payment/blob/age-verification provider，且必须配置
`CHAT_SERVICE_URL` 与 `CHAT_BFF_SIGNING_SECRET`。`check:launch` 会进一步
检查 Postgres、Redis、Sentry、对象存储、支付 webhook、审核、年龄验证和图片生成配置。
`PIPELINE_IMAGE_PROBE_REPORT` 是历史兼容变量名，但报告必须匹配 Gen 自身 env 中的有效 provider、
active Product Config model/workflow/version、Blob authority、immutable TerminalRecord 与 Main persistence
链。当前 `backend -> ComfyUI :8188` 可在这些事实精确一致时通过；legacy `pipeline :8091` 只在 Gen
实际选择该 provider 时才是所需权威，不能再作为 backend 路线的隐式前置条件。门禁还要求
`WEB_SURFACE_PROBE_REPORT` 指向最近一次 web surface
probe 报告，证明 main-web 首页和 `/generate` 返回健康 HTML、未过 age gate 的公开 API
按 403 fail-closed、admin-web 未登录时返回 protected state，且 admin JSON API 未登录时按
401 fail-closed；否则服务进程在线但用户入口或管理入口不可用时不能误报为可上线。门禁还要求
`PRODUCT_CONFIG_PROBE_REPORT` 指向最近一次 product
config probe 报告，证明 DB 中至少有 active image model profile、image character/freeplay
prompt template 和 image pricing rule；如果 `video_gen` feature flag 打开，还必须同时有
active video profile、video prompt template 和 video pricing rule，并且 `GEN_VIDEO_PROVIDER`
不能是 mock。`video_gen=false` 时，视频 provider 可保持 mock 且门禁通过。门禁还要求
`PUBLIC_CATALOG_PROBE_REPORT` 指向最近一次 public catalog probe 报告，证明公开角色、创作者、
合集和图片素材存在且没有 fixture/audit marker、异常指标或重复图片集中度问题；否则公开目录脏数据
不能误报为可上线。门禁还要求
`CHAT_SERVICE_PROBE_REPORT` 指向最近一次 chat
service probe 报告，证明 `/healthz` 可达、BFF 签名的只读 chat 请求返回 200、
未签名请求返回 401；否则 chat split 不能误报为可上线。`VOICE_MODEL_PROBE_REPORT`
也必须指向最近一次 voice probe 报告，证明当前 `VOICE_PROVIDER` 能生成可用
voice asset；使用 Pocket TTS 时还必须确认 clone 权重可用，否则语音克隆不能误报为
可上线；使用 Fish Audio 时还必须确认真实 MLX runtime、克隆能力与
`system_voice_ready=true`，否则不能把仅靠文本标签的声音误报为系统女性身份。
门禁也要求 `BLOB_STORAGE_PROBE_REPORT` 指向最近一次对象存储
probe 报告，证明当前 `BLOB_PROVIDER` 能对真实 bucket 完成 PUT、signed GET
读回校验和 DELETE；否则对象存储 env 填了但 credentials、bucket policy 或 endpoint
不可用时会失败。门禁还要求 `SAFETY_GATEWAY_PROBE_REPORT` 指向最近一次 safety gateway
probe 报告，证明 `MODERATION_SERVICE_URL` 能鉴权、返回可解析 decision，并且良性文本不会被误拦。
`CHAT_MODEL_PROBE_REPORT` 则证明 `CHAT_MODEL_BASE_URL`/`PIPELINE_API_URL` 指向的
OpenAI-compatible chat gateway 能鉴权、返回 assistant 文本并正常结束流式响应。
`PAYMENT_PROVIDER_PROBE_REPORT` 对 BTCPay 先使用 Greenfield
`GET /api/v1/stores/{storeId}` 证明 `BTCPAY_API_KEY` 具备读取目标 store 的权限，
再使用 `POST /api/v1/stores/{storeId}/invoices` 创建一张带
`metadata.launchProbe=true` 的小额测试 invoice，证明同一个 key 具备
`btcpay.store.cancreateinvoice` 权限并返回可跳转的 HTTPS `checkoutLink`。该
probe 会在 BTCPay 侧留下测试 invoice，但不会自动确认订阅或改变本地支付状态。
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
chat provider 支持 `pipeline`，调用 OpenAI-compatible `/chat/completions`
（SSE 或 JSON 均可）。voice 当前使用 `fish-audio`，调用本地常驻 MLX Audio
`/v1/audio/speech` 并由 main 写入私有 blob；旧 `pocket-tts` 与 `pipeline`
voice adapter 仅保留为显式回滚路径。
年龄验证已支持 `gocam` adapter：main-web 调内部 age gateway 创建验证
session，gateway 负责 Go.cam SDK/partnerId/cipherKey/HMAC key；回调到
`/api/v1/age-verification/webhooks/gocam` 时必须带
`x-age-verify-signature`、`x-gocam-signature` 或 `x-signature` HMAC 签名。

图片 worker 在 production 下拒绝 `GEN_IMAGE_PROVIDER=mock`。当前生产配置使用
`GEN_IMAGE_PROVIDER=backend`：`BackendImageModel` 依据 workflow descriptor 通过
`BackendRegistry` 选择 ComfyUI/sd.cpp/Draw Things backend；当前
`redcraft-krea2-comfyui` 直连 `COMFYUI_API_URL=http://127.0.0.1:8188`。
只有显式选择 legacy `pipeline` adapter 时才要求 `PIPELINE_API_URL`。
`smoke:backend` 必须返回真实可解码图片；worker/finalizer 闭环另需证明
`generation.completed` 与 blob 写入。
`pornmasterZImage_turboV35Bf16.safetensors` 不是可直接传给 LocalAI 的完整
model id；它是 Z-Image diffusion model，需要匹配的 Qwen3 4B text encoder
和 Flux/Z-Image VAE。历史 `serve:sdcpp-image` 曾把这些组件包装成
OpenAI-compatible `/images/generations` 接口，但该脚本现已不存在；这段仅解释
legacy profile 数据，不能作为当前运行命令。当前 Redcraft 走 workflow-native
ComfyUI descriptor。
后台 `GenerationModelProfile.runnerConfig` 是 sdcpp 运行态配置入口：
管理员可登记 `.safetensors` source、`.gguf` converted target、LLM/VAE 组件、
`conversion.enabled` 和 LoRA 栈。main 创建 job 时不会把这些本地路径写入用户可见
`generation_jobs.controls`；历史 sdcpp adapter 会在内部队列 payload 中消费
`controls.sdcpp`。当前 Redcraft descriptor 由 backend registry 消费语义化 slots，
不依赖已经移除的 `serve:sdcpp-image` gateway。
同一个 `runnerConfig` 也声明角色一致性能力，队列入口会用它过滤 reference payload：

```json
{
  "capabilities": {
    "textToImage": true,
    "stableSeed": true,
    "referenceImages": false,
    "initImage": true,
    "lora": false
  }
}
```

`referenceImages=false` 时，CVP anchor/reference 不会传给模型；`initImage=false`
时，Gallery `More like this` source image 不会传给模型。sd.cpp profile 默认支持
`initImage`，但不默认支持 identity `referenceImages`；需要 identity reference 的 runner
必须显式声明并通过 smoke。所有 runner 都保留 text+seed 路径。`lora` 当前只是未来
adapter 消费开关。
历史 sdcpp 角色一致性 reference 图从 `ImageGeneratePayload.referenceImages` 进入
legacy pipeline gateway：在 `SDCPP_REFERENCE_MODE=auto` 下把 Gallery `More like this` 的 source image
映射为 `--init-img` + `--strength`；只有明确支持 reference 的 profile 才会收到
identity anchor/reference，并映射为 `sd-cli --ref-image`。可用
`SDCPP_REFERENCE_MODE=disabled|ref_image|init_img` 收紧或关闭该行为；
`SDCPP_REFERENCE_STRENGTH` 控制 init image 的 noising strength。当前
`pornmaster-zimage-turbo` 的真实 smoke 证明 `source_image -> --init-img` 可用，
但 `identity_anchor -> --ref-image` 会触发 sd-cli 早退，因此该内置 profile 保持
`referenceImages=false`、`initImage=true`。

角色一致性 smoke 有两条路径，和产品策略一致：

```bash
# Text-to-image: only stable identity text + seed, no reference image.
bun run launch:probe:character-consistency -- \
  --provider mock \
  --identity-prompt "Serena Vale, adult woman, oval face, hazel eyes, long auburn waves, small beauty mark under left eye" \
  --samples 20 \
  --mode balanced \
  --seed serena-cvp-v1 \
  --output .tmp/consistency-serena-text

# Image-to-image / reference: same identity text plus one or more anchor/reference images.
bun run launch:probe:character-consistency -- \
  --provider mock \
  --identity-prompt "Serena Vale, adult woman, oval face, hazel eyes, long auburn waves, small beauty mark under left eye" \
  --reference /absolute/path/to/serena-anchor.webp \
  --samples 20 \
  --mode strict \
  --seed serena-cvp-v1 \
  --output .tmp/consistency-serena-reference
```

每次运行会输出图片样本、`manifest.json` 和 `review.html`。`--provider mock` 只验证
流程产物和 reference transport；当前真实质量复核使用 `--provider backend` 与
`--model redcraft-krea2-comfyui`。`--provider pipeline --pipeline-url
http://127.0.0.1:8091` 仅保留为 legacy adapter 审计。通过标准仍是人工确认至少 80%
样本“像同一角色”；mock provider 不能作为质量证据。
Admin 的 `Generation Config` 页面不再作为模型资产管理入口。产品面只展示内置
profile、draft readiness、test job、publish/rollback 和 prompt recipe；模型文件路径、
runner 组件、ComfyUI workflow 与 LoRA/adapter 仍由工程侧 seed/config 管理。
`/api/v1/admin/generation/model-imports` 默认关闭，仅在
`ADMIN_MODEL_DIAGNOSTICS_ENABLED=true` 时作为隐藏的工程诊断/迁移能力保留，不应出现在
普通运营路径或发布流程里。
手动 `model-profiles` 创建和底层配置编辑同样默认关闭；普通 admin 只运营工程侧注入的
built-in profiles，可执行读取、dry-run、test image、publish/rollback 和 disable。
本地容量较弱时可用 `PIPELINE_IMAGE_SIZE_DEFAULT=512x512` 做接口/队列/Blob
smoke；线上质量尺寸由后台 `GenerationModelProfile.defaultWidth/defaultHeight`
或 Pipeline Service profile 控制，不能靠产品层静默降级。
sd.cpp 的采样参数由 `steps`、`sampler`、`scheduler`、`cfgScale` 共同控制；
`scheduler=model_default` 表示不向底层 CLI 传 `--scheduler`，使用模型/runner 默认值。
Krea2/Flux 类模型不要只按文件名套模板。运维必须先看模型元数据和官方 runner 文档：
Krea 官方 Turbo 推荐 8 steps、CFG disabled、`mu=1.15`，而 stable-diffusion.cpp
Krea2 示例要求 Krea diffusion transformer、Qwen3-VL 4B text encoder、Wan 2.1 VAE、
`--diffusion-fa` 和 `--offload-to-cpu`。这些是 runner 模板内部参数，不应暴露给内容运营。
Krea2 文件进入内置候选前，工程侧必须先固定 runner 模板与组件：
`Qwen3VL-4B-Instruct-Q4_K_M.gguf` + `wan_2.1_vae.safetensors` 是 sd.cpp Krea2
方向的默认候选；`qwen_image_vae` 已在本地探针中被证明会产出纯白图，不应作为
Krea2 sd.cpp 默认组件。

2026-06-30 本地 sd.cpp 模板历史验证结果：

- `pornmaster-zimage-turbo` 是当时已跑通的 active/default sd.cpp 图片链路；主站普通生图
  和 admin test-job 已验证 512x640 PNG，`cfgScale=1` 保持为该链路默认值。
- Redcraft Krea2 候选：当时是 ComfyUI/Krea2 fp8 checkpoint candidate，不是 sd.cpp
  text template。历史 sd.cpp 探针按 Krea 官方近似参数、按 ComfyUI 元数据参数、直接跑
  safetensors、跑本地 gguf，均生成纯白 PNG；官方 sd.cpp Krea2 组件
  `Qwen3VL GGUF + Wan2.1 VAE` 需要
  `backend=vae=cpu` 才能避开 Apple Silicon Metal VAE decode 的 `IM2COL_3D` abort，
  但退出码为 0 的样本仍被 sanity guard 判为纯白；qwen_image VAE 与 `guidance=0`
  变体也同样纯白。2026-06-30 追加的 25 样本矩阵覆盖
  model-default/simple/logit_normal `mu=1.15` scheduler、guidance 0/1/3.5、
  VAE format auto/flux/sd3/flux2、GGUF diffusion、`--model` 加载、关闭
  diffusion-fa、关闭 offload、CPU backend；所有成功退出的样本仍是纯白。fp8 text
  encoder safetensors 在 sd.cpp 触发 metadata shape validation failed。ComfyUI GGUF
  text encoder 会在普通 `CLIPLoader` 触发 torch
  unpickling error，fp8 text encoder 进入 MPS KSampler 后仍触发 unsupported
  `Float8_e4m3fn`。Civitai 文件本身标为 fp8 SafeTensor，文件名为
  `Krea2RedMix-10Steps-fp8-scaled-ComfyUI.safetensors`；因此当前更应视为
  ComfyUI FP8 checkpoint，而不是可直接发布的 sd.cpp 内置模板。2026-06-30 已用
  `packages/gen/workflows/redcraft-krea2-comfyui-text.json` 的拆分节点 workflow
  在本机 ComfyUI `--cpu` 路径跑通 256x384、2 steps smoke，输出 PNG 通过
  sanity guard；随后通过当时存在、现已移除的 `serve:comfyui-image`
  OpenAI-compatible gateway 和
  `launch:probe:redcraft-image:local` 走完 gen `probe:image`/blob 写入链路。
  `launch:probe:redcraft-consistency:local` 当时默认锁定角色 seed，已生成 20 张样本并
  人工评审为 17/20 同一角色，`consistencyRate=0.85`。seed 中仍保留 draft profile，
  `enabled=false`、`rolloutPercent=0`；这是 2026-06-30 历史 candidate 状态，不描述
  2026-07-18 的 `redcraft_krea2_default`。
- DarkBeast reference 候选：本地 `darkBeastKrea2_dbkleinv2BFS.safetensors`
  是 Civitai `modelVersionId=2740209`，AutoV2 `B20B6F2744`，baseModel 为
  `Flux.2 Klein 9B`；同一 Dark Beast 集合另有 Krea 2 version `3078453`，但该文件
  不在本地模型目录。因此当前 BFS 文件不是 Krea2 sd.cpp 图生图模板。已解析 BFS
  Head Swap workflow：body/base image 映射为 `source_image/initImage`，face/identity
  image 映射为 `identity_reference/referenceImages`，并经 Flux2 conditioning 与
  `head_swap_flux-klein_9b_000003750.safetensors` LoRA 运行。当前本机缺
  `/Users/kk/.localai/models/flux2-vae.safetensors`、Flux.2 Klein base、
  Qwen text encoder、BFS LoRA 与可导入 workflow。seed 中登记为 `comfyui`
  draft candidate，不作为 sd.cpp active profile。

结论：可以保留“内置模板”产品策略，但只能发布已通过真实图像 smoke 的模板；sd.cpp
内置模板和未来 ComfyUI/external 模板都通过 `GenerationModelProfile.runner` 与
`runnerConfig.capabilities` 暴露能力。
历史 sdcpp adapter 会在 `sd-cli` 退出码为 0 后解析 PNG 像素，拒绝纯白、纯黑或
近乎纯色的退化输出；当前 workflow-native backend 与 gen worker 同样在接受/写入
blob 前执行图片 sanity。这类任务应视作模型/profile 失败，而不是成功出图。

内置模型状态用独立 probe 固化，避免依赖人工会话记忆：

```bash
# 日常门禁：确认当前 Redcraft Krea2 default 可用，同时审计隔离的旧候选。
# redcraft_krea2_text 是历史兼容 candidate key，必须保持 draft/disabled/0%。
bun run launch:probe:generation-model-candidates -- \
  --candidate redcraft_krea2_default,redcraft_krea2_text \
  --report .tmp/launch-generation-model-candidates.json

# 验收当前默认模板：必须是 canonical Redcraft Krea2 ComfyUI workflow，
# active/enabled/100%，模型与 descriptor 文件存在且 readyForPublish=true。
bun run launch:probe:generation-model-candidates -- \
  --candidate redcraft_krea2_default \
  --require-ready \
  --report .tmp/launch-redcraft-krea2-default-ready.json

# 审计旧 Redcraft candidate 的隔离状态。它不是当前默认模板，且预期不 ready；
# 不要对这个命令加 --require-ready。
bun run launch:probe:generation-model-candidates -- \
  --candidate redcraft_krea2_text \
  --report .tmp/launch-redcraft-krea2-legacy-candidate.json

# 当前 runtime：使用已运行的 ComfyUI 8188，走与 gen-image 相同的 backend seam。
COMFYUI_API_URL=http://127.0.0.1:8188 \
bun run --filter @idream/gen smoke:backend -- \
  --model redcraft-krea2-comfyui \
  --out /private/tmp/idream-backend-smoke.png

# 需要把 descriptors 同步到 ComfyUI UI 时：
COMFYUI_API_URL=http://127.0.0.1:8188 \
bun run --filter @idream/gen sync:comfyui-workflows

# 生成 Redcraft 的 20 张角色一致性 review 包：
bun run launch:probe:redcraft-consistency:local -- \
  --provider backend \
  --model redcraft-krea2-comfyui \
  --output .tmp/redcraft-consistency-review \
  --samples 20

```

当前 `redcraft_krea2_default` candidate probe 必须为 ready；真实
workflow-native backend smoke 已通过，结果为 ComfyUI 0.28.0/MPS、832×1024、
880,175 bytes、132,649ms。它直接验证生产 `BackendImageModel` seam，不依赖 8091
legacy gateway。`launch:probe:redcraft-consistency:local` 可走同一个 Redcraft
backend 生成 `manifest.json`、20 张样本和 `review.html`；历史样本包在
`.tmp/redcraft-consistency-review`，并已补 `manual-review.json` 与 `contact-sheet.jpg`。
2026-06-30 人工 review 写回 `sampleCount=20`、`consistencyPassCount=17`、`consistencyRate=0.85`、
`seedMode=locked`。
probe 还会只读 safetensors header 并输出 `assetInspection`。Pornmaster 当前应显示
`suggestedRuntime=sd_cpp_external_components`；Redcraft 当前应显示
`hasComfyUiWorkflow=true`、`hasCheckpointLoaderSimple=true`、`hasFp8ScaleTensors=true`、
`suggestedRuntime=comfyui_fp8_krea2_checkpoint`。这条证据是 Redcraft 不能被当成
已跑通 sd.cpp 内置模板的门禁依据之一。

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

- Main/Admin production build 生成各自的 `.next-runtime` immutable release，PM2 只从当前 release pointer 启动。
- `/api/internal/*` 由 `INTERNAL_TOKEN` 保护，`proxy.ts` matcher 排除 `/api/internal`。
- 长任务/流式 route 配 `maxDuration`（route segment config）。

### 4.2 本地 Docker 基础设施

`docker-compose.yml` 只负责 PostgreSQL 与 Redis。产品运行必须走 §4.3 的完整 PM2 拓扑；仓库不提供会遗漏 Admin、Chat、Gen、finalizer、consumer 与 Voice 的 Main-only 容器入口。

### 4.3 PM2（自托管进程拓扑）

`ecosystem.config.js` 是自托管时的产品服务入口。默认运行开发拓扑；设置
`IDREAM_PM2_MODE=production` 才运行生产拓扑。主站和后台拆成两个独立
Next.js 服务：

| PM2 app | package | 默认端口 | 说明 |
| --- | --- | --- | --- |
| `main-web` | `packages/main` | `3000` | 公开产品页、角色、订阅、用户 API 和 BFF |
| `admin-web` | `packages/admin` | `3001` | 内部管理后台和 `/api/v1/admin/*` 控制面 API |
| `chat` | `packages/chat` | `CHAT_PORT` | chat API/SSE + worker，单实例本地文件写入 |
| `gen-image` | `packages/gen` | n/a | 异步图片生成 worker（当前 2 实例） |
| `gen-video` | `packages/gen` | n/a | 异步视频生成 worker；当前 `backend -> ComfyUI :8188 -> LTX 2.3 GTAnimation I2V` |
| `gen-finalizer` / `main-event-consumer` | `packages/main` | n/a | 主站侧权威写回和事件消费 |
| `admin-command-worker` | `packages/main` | n/a | Admin durable command 执行 |

当前 `ecosystem.config.js` 是 9 个 logical apps / 10 个 processes：
`fish-audio`、`main-web`、`admin-web`、`chat`、`gen-image`（2 processes）、
`gen-video`、`gen-finalizer`、`main-event-consumer`、`admin-command-worker`。ComfyUI 是独立
运行时，不计入这组 ecosystem 进程。

运行命令：

```bash
bun run pm2:start
bun run pm2:status
```

默认开发模式下，`main-web` / `admin-web` 直接运行 `next dev`，页面源码由
Fast Refresh 更新；`chat`、`gen-image`、`gen-finalizer`、
`main-event-consumer`、`admin-command-worker` 由 PM2 监听对应源码目录并
自动重启。`gen-video` 即使在开发模式也固定关闭 watch：当前 768×1152 LTX
任务约需 10–15 分钟，源码监听重启会截断已扣费的长任务。日常改代码无需
build；`.env`、Prisma Client、Next 配置等启动级
变化执行 `bun run pm2:restart`。

主站 stale reconciler 对普通 generation job 使用默认 10 分钟窗口，对视频
单独使用 `VIDEO_JOB_STALE_TIMEOUT_MS`（生产模板为 35 分钟）。这个窗口必须
大于 gen 侧 `GEN_VIDEO_TIMEOUT_MS`（30 分钟），保证 provider 先有机会返回
terminal record，再由主站判定遗留任务；不能把图片任务的短窗口直接复用
到视频。

生产模式需要先构建不可变发布，再显式启动：

```bash
bun run build
bun run pm2:start:production
```

三个 production wrapper（start/restart/reload）使用同一 fail-closed 协议：先要求调用环境明确
`APP_ENV=production`，并用之后传给 PM2 的同一份环境执行所选 `LAUNCH_SCOPE` 的完整
`check:launch:direct`；`full` 是默认，`core` 只允许显式排除 Billing 与 Age Verification；任一门禁失败时
不得暂停队列或修改 PM2。通过后，才在 Main、Gen、
finalizer 仍在线时全局 pause image/video/terminal-ingest/finalize 四条 BullMQ queue；等待 active row
归零。Gen 可把新 terminal record 投进暂停的 durable relay，Main 可把已摄入 record 的
`pending / dispatched` terminal Outbox 投进暂停的 finalize queue。之后先停止请求入口与
direct producer（`main-web`、`admin-web`、`chat`、`main-event-consumer`、
`admin-command-worker`），再停止 `gen-image`、`gen-video`，最后停止 `gen-finalizer`。
`pm2 jlist` 确认全部非 voice app 静止后，才只读检查 Postgres generation authority、terminal
Outbox 与 Redis in-flight row。静止点还会运行 Gen image+video ownership gate：同时核对 PM2 精确
cwd/entrypoint/slot、OS wrapper→实际 `src/image.ts` / `src/video.ts` child/PGID、以及 BullMQ worker 的
`runId.slot.pid` 名称；daemon orphan、外部进程、匿名/旧 run worker、数量或 PID 映射不一致都会保持
queue paused，且检测器永不发送 signal。PM2 启动后、resume 前以本次 wrapper 生成的 runId 再要求三源
一一对应。`GEN_VIDEO_PROVIDER=mock` 只在已验证的 `video_gen=false` 产品配置下成立；此时 production
ecosystem 不登记 `gen-video`，门禁严格要求 video 的 PM2/OS/Redis 三源均为 0。现场只读检查可运行
`bun run probe:gen-image-ownership`（名称保留兼容，实际同时检查 image+video）；发现 orphan 后必须在 queue 已暂停、
active=0 且连续两次 PID/PGID/start-time fingerprint 相同时由人工清理，禁止 `pkill -f` 或批量终止 PM2
daemon children。不要手工拼 PID 或直接执行 `kill`。

orphan 恢复前必须先运行只读 `bun run --cwd packages/main check:generation-cutover`。若报告中存在需人工确认的
历史 `ai.video.generate` failed residue，必须在运行 `generation:quiesce-for-orphan-recovery` **之前**完成下面的
typed acknowledgement；否则 quiesce 会先全局暂停四条 queue，再因该 residue 持续阻断 drain，最终超时且不进入
PM2 stop。Bull row 不允许物理删除。只有 Job/latest Attempt/terminal event、三次 transport、archived artifact、
suppressed delivery、spend/refund/settlement links 与 Blob 终态仍全部满足严格条件时，dry-run 才会给出 confirmation：

```bash
cd packages/main
bun run generation-cutover:acknowledge-failed-source-residue -- \
  --actor-id <bootstrap.actor.id> --queue ai.video.generate --bull-job-id <bull-job-id> \
  > /secure/operator/failed-source-plan.json

bun run generation-cutover:acknowledge-failed-source-residue -- \
  --apply --actor-id <same-bootstrap.actor.id> \
  --plan-file /secure/operator/failed-source-plan.json \
  --reason '<review reason>' --request-id <request-id> --idempotency-key <key> \
  --confirmation '<exact confirmation from dry-run>'

# 必须确认 ok=true、该 row 位于 ignoredHistory，且 failedRecoveryRows/issues 均为空。
bun run check:generation-cutover
cd ../..
```

`--actor-id` 必须来自本次实际执行人员已登录 Admin 后的 `GET /api/v2/admin/bootstrap`：使用返回的
`bootstrap.actor.id`，并确认 `bootstrap.permissions` 包含 `ops.deadletter.write`。dry-run 与 apply 必须由同一人执行；
换班时新操作者必须重新 dry-run。CLI 还会重新校验该 User 当前存在、`status=active` 且具备有效权限。禁止借用他人
actor、从数据库随意挑选账号、使用测试身份或为了恢复临时伪造授权。development wall 的 `admin` 快捷账号当前映射
`seed-admin-user`，这只校准本地开发审计；production 必须使用真实生产登录操作者，不能沿用 seed 身份。

apply 只在 Main 写入一份幂等 command receipt 与 Admin audit，不修改 Redis/Bull。cutover 与 drain 每次都
重新核对 retained row hash、DB/ledger/archive 和 Blob 缺失；任一事实漂移会立刻恢复阻断。完成上述前置条件后，
仓库的 orphan 恢复协议才从 quiesce 开始：

```bash
# 1. 仅在 cutover 已无 blocking residue 后，全局 pause/drain，再按 admission → Gen workers → finalizer
#    顺序只停止已登记进程。
#    该命令故意不跑 launch gate、不启动任何进程，也绝不 resume queue。
bun run generation:quiesce-for-orphan-recovery

# 2. 默认只读；连续采集两次 PM2/OS/Redis/cutover 状态，记录每个 PGID 的全部成员。
bun run generation:plan-orphan-recovery \
  > /secure/operator/gen-orphan-recovery-plan.json

# 3. 人工核对 safeToApply=true、targets 和 typed confirmation 后才执行。
bun run generation:apply-orphan-recovery -- \
  --plan-file /secure/operator/gen-orphan-recovery-plan.json \
  --confirmation '<exact confirmation from plan>'
```

plan 只有在四条 Generation queue 全部 paused、active Request / in-flight Bull row /
pending terminal Outbox 均为 0、已登记 image/video worker 均已停止、两次完整快照一致、且所有目标都仍是
PM2 daemon orphan 时才给出 confirmation。apply 会重新采集同样的现场并要求 target fingerprint 完全相同，
然后只向计划内的精确 PGID 发送一次 `SIGTERM`；不使用 `SIGKILL`，不停止 PM2 daemon，不改 Redis/DB，
也不恢复 queue。若进程未优雅退出或任何事实漂移，命令失败且 queue 保持 paused。完成后重新运行受控
PM2 wrapper；只有 cutover、运行态 readiness 与 ready ownership 全部通过时 wrapper 才会 resume。

PM2 action 返回 0 仍不等于发布成功：wrapper 会继续有限时轮询
目标 logical app（video 开启时 9 个、关闭时 8 个）的精确期望实例数，全部 `online` 后验证 Main/Admin HTTP、Chat `/readyz`、
Fish `/health`，并运行 Gen `preflight` 检查 ComfyUI model refs 和视频验真所需的
`ffprobe` / `ffmpeg`；全部通过才 resume 四条 queue。
若活动 Request 的最新 queued/running Attempt 已绑定 `terminalRecordRef`，门禁还要求 terminal Outbox
内容精确且对应 finalize Bull row 仍为非终态；row 缺失、failed 或 completed 都按 stranded
finalization 阻断。对于合法 `unknown` Attempt，门禁验证 delivered exact Outbox、Attempt unknown
terminal event 与 `provider_outcome_unknown` Request event，并允许 finalize Bull 已 completed 或移除；
这类 Request 保持 active 是运营对账状态，不是 stranded finalization。

drain 的跨 Redis/PostgreSQL 读使用严格 fence：先检查一次 in-flight（A），仅当 A 无 active row
时派发 pending terminal Outbox，再检查一次 in-flight（B），最后统计 pending Outbox；A/B 任一出现
active 都阻断，避免 torn snapshot。精确 failed terminal relay、finalize，以及具备精确 Blob terminal
record 的 Gen source row，在 queue paused 时可作为 cold-start durable carrier 放行；新进程启动后的 initial
scanner 负责重驱动。invalid row、身份漂移或无 Blob 的 failed source 继续阻断。

pause/drain、分层 stop、静止确认、authority gate、PM2 action、运行态 readiness 或 resume 任一步失败都保持四条
queue paused；resume 部分失败会 best-effort 重新 pause 全部 queue。需要运营完成 drain/对账后
重新执行 wrapper，禁止直接 resume 绕过门禁。初次部署没有现有 PM2 app 时，三个阶段的
`jlist` 都确认空集合后正常通过。`gen-image`、`gen-video`、`gen-finalizer` 另设 5 分钟、35 分钟、
5 分钟 PM2 `kill_timeout`，作为 pause/drain 之外的最后防线。

开发/生产模式之间切换会改变 web 的 script、cwd 和 exec mode，也会改变
worker watch 设置。从开发态切到生产态直接使用受控 wrapper；它会完成完整
launch、pause/drain、ownership 与 authority 门禁，删除所有已登记的 owned runtime 并确认整个 namespace
为空，再从 ecosystem 全新创建。这样既替换开发定义，也不会让 PM2 `--update-env` 合并保留旧的可选
provider 环境变量；新运行态通过精确定义、HTTP/preflight、ownership 后才 resume：

```bash
bun run pm2:start:production
pm2 save
```

生产态切回开发态会被 wrapper 明确拒绝。不要用 `pm2 delete`、直接
`pm2 restart` 或 `pm2 reload` 绕过该拒绝；这不是普通模式切换，而是需要先
下线公开入口、完成 generation pause/drain 与静止 ownership 核验的受控维护。
在仓库提供对称的 gated teardown 命令前，保持生产拓扑，不执行手工切换。

同一模式内使用 `bun run pm2:restart`：wrapper 会从 PM2 持久 mode marker（旧拓扑则从明确的 web
entrypoint）识别 development/production；混合或无法识别的拓扑直接失败。生产也可显式使用
`bun run pm2:restart:production`。不要直接调用 `pm2 restart ecosystem.config.js` 绕过 generation
queue pause/drain 门禁；无参数 `bun run pm2:start` 也会拒绝覆盖正在运行的 production 拓扑。
`bun run pm2:stop` 同样经过 pause/drain、分层 stop 和 quiescent ownership；只有证明 Gen 三源为 0 后
才停止 `fish-audio`，并故意让四条 Generation queue 保持 paused。后续必须用受控 start/restart 完成
readiness 后恢复，不能直接手工 resume。

当 `ecosystem.config.js` 增删进程后，确认 `pm2 list` 与目标拓扑一致，然后执行 `pm2 save`。否则 `pm2 resurrect` 或机器重启可能恢复旧 dump（例如已延后的 `gen-video` 或重复的 `main-web`）。

生产模式的 Next.js 服务使用 `output: "standalone"`，构建后会把 `.next/static`
和 `public` 复制进 standalone 目录。PM2 通过
`scripts/start-next-standalone.cjs` 先加载对应 package 的 `.env`，再运行
standalone `server.js`，不使用 `next start`。默认开发模式不读取
`.next-runtime`，直接从源码启动 Next dev。

如果是在同一个工作目录内执行 `bun run build`，构建完成后必须执行
`bun run pm2:restart:production`，让完整 generation gate 切换到新的 immutable release。不要对
`main-web` / `admin-web` 直接执行 in-place `pm2 restart` 或 `pm2 reload`：它既绕过生成门禁，也可能让
旧 cluster worker 继续引用已被新构建删除的 server chunk，表现为随机 `ChunkLoadError`、路由超时或
client reference manifest 缺失。

`admin-web` 使用 `packages/admin/.env`，但必须与 `packages/main/.env` 共享 `DATABASE_URL`、`BETTER_AUTH_SECRET`、`INTERNAL_TOKEN`、`CRON_SECRET` 等服务端密钥。PM2 默认给 `main-web` 设置 `PORT=3000`、给 `admin-web` 设置 `PORT=3001`；需要改端口时在启动 PM2 前设置 `MAIN_WEB_PORT` / `ADMIN_WEB_PORT`。

## 5. CI/CD（`.github/workflows`）

流水线（对齐 global verify 体系 L1-L4）使用 bun workspace、Postgres 和 Redis：

```
1. setup Node 24 + bun 1.3.14 + bun install --frozen-lockfile
2. install Playwright Chromium
3. bun run check                              # 全包 lint + typecheck + build
4. packages/main coverage + Admin/Chat/Gen/Shared tests
5. bun run test:pm2-config                    # production wrapper fail-closed contracts
6. prisma migrate deploy                      # CI 临时源库先落完整 history
7. bun run --filter @idream/main admin:readiness:migrations
8. bun run --filter @idream/main test:e2e     # Playwright 独占派生 DB/Redis namespace，
                                               # 自管 Main/Admin/Chat/Gen/finalizer 进程
```

- **迁移在部署前于 CI/部署流水线跑** `prisma migrate deploy`（prod direct URL），随后以 fresh/upgrade 临时库演练完整 migration chain；任一步失败都阻断发布。
- `bun run check` 是本地最小门；上线前还必须跑 `bun run --filter @idream/main test:e2e` 和 `bun run check:launch -- --launch-env-file .tmp/production-main.env --admin-env-file .tmp/production-admin.env --chat-env-file .tmp/production-chat.env --gen-env-file .tmp/production-gen.env --report .tmp/check-launch.json`，四份文件必须对应实际部署的四个 service authority。
- 数据库迁移 SQL **只能由具备权限者/CI 执行**（global rule：模式变更 SQL 由用户/CI 跑，Claude 只产出）。

## 6. 迁移 Runbook（Postgres-only）

应用内表走 Prisma（每包独立 schema/migrations）；**跨服务库边界（schema/role/grant/视图/chat 表）走 `db/sql/*.sql`，由用户在 prod 手工执行**。

| 操作 | 命令 | 谁执行 |
| --- | --- | --- |
| dev 改 schema（应用内表） | `bun run --filter @idream/main db:push`（Postgres dev 库，无迁移文件） | 开发者 |
| 生成迁移 | `bun run --filter @idream/main db:migrate:dev`（产生迁移文件，提交 git） | 开发者 |
| 加性能索引 | 在迁移目录手写 raw SQL（`pg_trgm` 等，03 §5） | 开发者 |
| 部署应用内表迁移 | `bun run --filter @idream/main db:migrate:deploy`（prod direct URL） | CI |
| **DB 边界变更** | DBA/IAM 先创建 `core_owner` / `chat_owner` / `chat_service` / `chat_projector` 并注入真实凭据；从部署中的 `CHAT_DATABASE_URL` 取脱敏后的 exact `PGHOST` / `PGPORT` / `DB`，显式设置 `SUPER` 后执行 `bash db/sql/apply-validate.sh`。脚本用 runtime `node-pg` parser 在任何 DDL 前要求 URL 用户为 `chat_service` 且三元组逐项一致；拒绝 URL query 的 target/credential override、多前导 `/` database path、可被 `psql -d` 解释成 conninfo/URI 的 `DB`、comma-separated multi-host `PGHOST` 和 ambient libpq target override；其唯一权威顺序为 `01_schemas_roles` → `02_core_views` → `03_chat_tables` → `04_grants` | **用户在 prod 执行** |
| 回滚 | 写"down"迁移或新正向修复迁移（Prisma 不自动回滚） | CI + 评审 |

**破坏性变更**（删列/改类型）：分两步（先兼容加列/双写 → 迁移数据 → 再删旧），避免停机。

> `db/sql/` 是跨服务库边界的 SSoT：Chat 请求路径以 `chat_service` 连接，只读 Main 的 core/billing/compliance 视图并写请求事务/文件 intent；文件投影器以独立 `chat_projector` 连接，只有实际完成 `CHAT_FS_ROOT` 副作用后才能推进 mutation receipt。两种角色均由 grant/trigger 强制，不能用一个全权运行时连接替代。这些 DDL 不归 Prisma `db push` 管。

Chat runtime readiness 通过 request/projector 两个真实连接验证 request 的
`session_user=current_user=chat_service`、projector 的
`session_user=current_user=chat_projector`，并按 catalog privilege 核对两者精确 least-privilege grants；
两条连接还必须指向相同 server address、port 与 database。DB/Redis/schema/capability 证据的 freshness
上限为 5 秒，过期后 `/readyz` 与新 turn/generate admission 会 singleflight 重验。真实 provider 失败只
锁存这些会排队新模型生成的入口；读取与受认证的 internal/durable ingress 继续可用。恢复循环以
5 秒起步、最大 60 秒退避，singleflight 执行完整 warmup，成功后自动恢复新 turn admission。每次 warmup
同时绑定递增的 attempt 与开始时的 invalidation epoch；只有当前 attempt 且 epoch 未变化的成功结果能恢复
admission。warmup 期间出现的新 provider failure 会推进 epoch，因此旧 warmup 完成不能覆盖更新的失败。
最终 signed Chat 证据写入
`.tmp/launch-chat-service-probe-2026-08-14-final-user-journeys.json`：unsigned 请求为 401，signed
session/message/SSE/reload/regenerate Scene anchor/no-memory/blocked-input/cleanup 全链通过。
Gate 证据为 `.tmp/check-launch-2026-08-14-final-user-journeys.json`（`LAUNCH_SCOPE=core`，44 pass /
23 fail / 0 warn / 67 total），支付与年龄验证不参与该结论。resolver 分别从 Main、Admin、Chat、Gen env
解析服务权威；APP_ENV、跨服务 token/BFF、BullMQ prefix 与 release 不得跨服务漂移，Chat 模型/Redis/BFF
及 Gen provider/ComfyUI/model 也不得回退到 Main 或 ambient process 制造假绿。23 个失败项均属于 production
envelope：development `APP_ENV`；public HTTPS Main/Better Auth URL；Better Auth
secret、internal token、cron secret 及 token separation；production web-surface；production Redis 与 BullMQ
prefix；non-mock Blob 及 bucket/endpoint/access/secret；Main pipeline token；Chat/Admin BFF secret；Chat model
key；Sentry DSN、browser env/DSN 与 Main/Admin/Chat/Gen 四 runtime canary。当前 Admin text
与本地真实 Chat/Image/Video/Voice probes 已绑定统一 source revision；四包 Sentry probes 也以同一 revision 记录了当前无外部凭据时的明确失败，因此 source-revision authority 通过，而 Sentry live canary 仍失败。
新 Gate JSON 自带 `generatedAt`、expected release、probe evidence digest 与脱敏 environment digest；公开上线仍是 NO-GO。

最终自动化证据为 Shared 46 files / 254 tests、Gen 21 / 202、Main 315 passed files + 2 skipped /
2,479 passed tests + 3 skipped、Chat 37 / 348、Admin 118 / 586；合计 537 passed files + 2 skipped /
3,869 passed tests + 3 skipped。Turbo test tasks 6/6（`@idream/chat#test` 设为 `cache:false` 并真实执行）、
typecheck 6/6、lint 2/2、production build tasks 5/5、PM2/operator/source-revision tests 84/84。最终后端补丁后，真实 Chrome 重跑
当前 public character detail（1280 与 390×844）、可见 Tab 焦点及 Chat CTA 的 401→
`/signup?next=%2Fcharacters%2Fcmsozhlsn0023i2l7m71veczu` 认证边界；随后 Browser Back 的注入
`pageshow` 证据为 `persisted=true`，恢复后 `checking=false`、heading=`Mara Vale Launch`、
`documentWidth=innerWidth=390`，无横向溢出。AgeGate focused 2 files / 18 tests、Main typecheck 与 scoped
lint 通过。完整 authenticated 客户/Admin Chrome 旅程早于该补丁，不能表述为当前 revision 又完整重跑。

`01_schemas_roles.sql` 只验证四个角色已由 DBA/IAM 创建，不创建 `_change_me` LOGIN，并要求
`core_owner` / `chat_owner` 为 `NOLOGIN`、`chat_service` / `chat_projector` 为 `LOGIN`。曾运行旧版
placeholder bootstrap 的集群，升级前必须由 DBA/IAM 先轮换两个 runtime role 的真实且不同 secret，
再把两个 owner role 收紧为 `NOLOGIN`；凭据通过 secret manager 或 DBA 的交互式密码流程注入，不能写入
仓库或 shell history。`03_chat_tables.sql` 已包含 entry attribution、每 turn memory 不可变 trigger/index、
Scene/Soul/runtime trace 与 file mutation 权威；dated SQL 仅保留为历史升级证据，不进入日常 manifest。
`04_grants.sql` 在一个事务内先撤销历史 broad/default grant，再按运行时代码的实际 SQL surface 重建
exact allowlist。`chat_service` 仍持有普通 Chat domain 表 CRUD、Scene SELECT/INSERT、file mutation SELECT
与四列 intent INSERT；`chat_projector` 只有所需表的 SELECT，UPDATE 进一步限于 session
`log_extracted_seq` + Prisma 自动写入的 `updated_at`、message `memory_extracted_attempt` + `updated_at`
和 file-mutation receipt 五列，outbox INSERT 也只开放 Prisma `recordOutbox` 实际写入的十列（含其展开的
`attempts` / `next_run_at` / `created_at` 默认值）。projector 无 sequence 权限；request 仅有 file-mutation sequence USAGE。
两者均无 schema CREATE、table TRUNCATE/REFERENCES/TRIGGER，且只能 EXECUTE 明列的
redactor/purge 函数。readiness 与 apply-validate 都遍历当前 Chat tables/columns/sequences/functions/default ACL，
未知对象或任一额外权限都会 fail closed。脚本不会全局改写 `public` schema/table 的 PUBLIC ACL，以免改变
Main 或其他数据库角色；如果既有 PUBLIC ACL 让 Chat 继承 CREATE 或 public table/column 权限，入口会在 DDL 前
把它报告为外部 DBA posture blocker。新环境必须先跑完整 Prisma
migration history，再暂停 Chat writer/projector，执行上述四步并通过结构、权限正向/负向验证；不得把
`03_character_management`、`05_main_recent_chats` 或任何 Main/public dated SQL 混入 Chat boundary apply。

旧集群的最小人工修复使用交互式 `psql`，密码只通过 `\password` 输入：

```sql
ALTER ROLE core_owner NOLOGIN;
ALTER ROLE chat_owner NOLOGIN;
REVOKE core_owner, chat_owner FROM chat_service, chat_projector;
\password chat_service
\password chat_projector
```

完成后再用部署时的 `CHAT_DATABASE_URL` 和显式 `PGHOST` / `PGPORT` / `DB` / `SUPER` 执行
`apply-validate.sh`；该入口没有数据库默认值，目标不一致会在 DDL 前退出。URL query 不能携带
`database` / `dbname` / `host` / `hostaddr` / `passfile` / `password` / `port` / `service` / `user` / `username`
覆盖；`DB` 必须是 plain database name，不能包含 `=` 或使用 `postgres://` / `postgresql://` URI，避免
被 `psql -d` 重新解释为 conninfo；URL database path 不能以多个 `/` 开头，且 `PGHOST` 不能是逗号分隔的 multi-host failover 列表。环境中不得残留
`PGHOSTADDR` / `PGSERVICE` / `PGSERVICEFILE` / `PGDATABASE` / `PGUSER` / `PGOPTIONS`。
入口拒绝在 shell xtrace 下运行：Bash 会在脚本首条命令前展开 `PS4`，脚本本身无法追回已被
`PS4` 输出的环境 secret，所以调用者不得启用 `bash -x`，也不得把 secret 放入 `PS4`。所有 `psql`
调用固定带 `-X`，不加载本机 `.psqlrc`。Chat test provision 同样会在任何 destructive `psql` 前拒绝
上述 ambient 变量；角色 credential 只经 `psql` stdin 传入，不进入 argv/异常文本。不要把密码写成
`ALTER ROLE ... PASSWORD '...'` 放进 runbook、CI log
或 shell history。本机或生产角色姿态不合格时，测试/部署失败是正确的 fail-closed 结果，不应让测试
harness 自动改写现有集群角色。

Chat test provision 在任何 `DROP DATABASE` 前必须用两个独立真实 credential 分别认证为
`chat_service` 与 `chat_projector`；测试库重建持有按 cluster/database 标识的 PostgreSQL advisory lease，
角色 bootstrap 另持有 cluster advisory transaction lock 并在得锁后重查姿态。与 runtime 复用同一
PostgreSQL cluster 时只能复用已经 canonical 的四个角色；任一 Chat runtime URL 已配置时都禁止 bootstrap。
只有目标是非 runtime disposable cluster，且 operator 显式提供与 host/port authority 精确一致的
`CHAT_TEST_DISPOSABLE_CLUSTER_CONFIRM`，才允许在锁内只 `CREATE` 缺失角色；既有角色永不 `ALTER ROLE`
或轮换密码，姿态漂移直接失败。Chat Vitest config 显式加载包内 `.env`，保证从 monorepo root 经 Turbo
进入 package task 时得到同一 target authority；Turbo 的 `@idream/chat#test` 固定 `cache:false`，不能用
历史缓存冒充这次数据库边界测试已执行。

## 7. 备份与容灾

- 一份可恢复的 iDream checkpoint 是同一静默边界下的**一致性集合**：Main PostgreSQL、`CHAT_FS_ROOT` 与媒体 Blob。只备份数据库不能称为完整 current-state backup，因为 Chat 的 session trace / memory / relationship 权威在文件层，local/mock Blob 的媒体字节也不在 PostgreSQL。
- 备份前先停止所有写入进程，并在一个固定 checkpoint 时间上确认没有正在提交的跨权威变更：Main transport outbox 不得为 `dispatched` 或未知状态，Main/Chat inbox 不得为 `processing`，生成队列与 `chat_file_mutations` 不得有正在执行的 mutation；同时确认 Main/Admin/Chat 端口无 listener。稳定的 future-scheduled、pending 或 failed durable intent 属于待恢复的产品事实，必须进入 source/restore counts 并逐字段一致，不能为做备份而提前投递、删除或伪装成已处理。
- PostgreSQL 使用与目标服务兼容的 `pg_dump` / `pg_restore`；`CHAT_FS_ROOT` 和本地 `BLOB_ROOT` 分别生成归档与逐文件 manifest/checksum。使用 R2/S3 时，live bucket 与独立 recovery endpoint/bucket 都必须启用版本化，并把精确 object-version、metadata、checksum、retention inventory 与 DB/Chat FS checkpoint 绑定；没有第二 authority 时失败关闭，不能把同一 bucket 内的临时复制当容灾证明。
- 每个 checkpoint 必须写明数据库名/schema migration count、Chat FS root、Blob provider/root、静默时间、artifact id 与 SHA-256；不得覆盖已有备份。
- 恢复演练必须进入隔离的 disposable DB/Chat FS/Blob root，校验全部 checksum、目录 manifest、migration status、业务计数和无悬空引用后再删除临时目标。只证明 `pg_restore` 成功不等于 Chat 文件和媒体可恢复。
- 仓库权威入口是 `bun run recovery:rehearse`。默认只输出脱敏 plan 并以非零退出码报告缺失条件；不会 dump、建库、复制对象或停服务。实际执行必须在受控维护窗先完成既有 runtime quiesce 流程，再以 `APP_ENV=production IDREAM_QUIESCED=1 RECOVERY_DATABASE_URL=<exact-source-superuser-url>` 加 `--apply --bundle-name <idream-recovery-...> --confirmation "CREATE RECOVERY REHEARSAL <同名>"` 运行；Main / Chat / Gen 使用不同 env 文件时分别传 `--launch-env-file`、`--chat-env-file`、`--gen-env-file`。Main 的 `DATABASE_URL` 只声明 source identity，专用 recovery URL 必须 exact same host/port/database 且实际认证为 superuser，secret 不进入 plan/metadata。apply 复用 Generation queue pause/drain、cutover 和 worker-ownership 检查；Main/Gen service env 的 effective Redis target 与 BullMQ prefix 必须 exact，并显式传给三个子检查及写入 receipt，临时 recovery `APP_ENV=production` 不能改变 service 默认 prefix。只接受明确 terminal PM2 state，并把 fresh quiescence receipt/fingerprint 写入 bundle；随后拒绝残留 listener、active DB client、非 exact migration、任何 in-flight/未知 mutation 状态、split DB/Blob authority、symlink 与覆盖已有 bundle。稳定 durable backlog 会被保留并纳入 exact restore 比较。
- apply 会在原子发布前完成：PostgreSQL 16 custom dump → fresh 隔离库 restore → counts/schema/逐表 digest/sequence/database authority exact compare；Chat FS tar → 临时目录逐文件 mode/SHA compare；local Blob 同样归档恢复，R2/S3 则要求 live 与 recovery bucket versioning、recovery bucket Object Lock，以及正整数 `RECOVERY_BLOB_RETENTION_DAYS`；AWS CLI 从 exact live VersionId 读取，向独立 recovery endpoint/bucket 写入 checksum/metadata，并以 source retention 与 policy retention 中较晚者作为明确 GOVERNANCE/COMPLIANCE retain-until，再按返回 VersionId 重读比较。成功写入的 recovery versions 是持久恢复 authority，不能在演练结束时删掉；bundle 记录它们的 exact endpoint/bucket/key/VersionId/checksum/retention，重复 bundle prefix 失败关闭。失败只清 fresh restore DB、local staging 与 publish lock，绝不删除源对象、已写入的受 retention 保护 recovery version 或覆盖最终 bundle。
- 将发布后的扁平 bundle 路径写入 `RECOVERY_REHEARSAL_BUNDLE`，operator 审阅后用 `shasum -a 256 <bundle>/<bundle>.sha256` 计算 checksum-manifest digest，并将 lowercase 结果写入 `RECOVERY_REHEARSAL_APPROVED_SHA256`；按需要设置 `RECOVERY_REHEARSAL_MAX_AGE_MINUTES`（默认 `1440`）。`check:launch` 要求 approved digest exact match，并使用真实 `pg_restore --list`、`tar -tzf`、临时提取后的 manifest reconstruction 验证 archive，校验 fresh quiescence receipt，禁止 symlink/未入 manifest 的文件，要求 source/isolated-restore 的 DB counts/schema/logical、稳定 backlog、Chat FS 与 Blob inventory 逐字节一致。Gate 通过同一 Main/Chat/Gen env resolver 计算 `CHAT_FS_ROOT` fingerprint，并与 authenticated signed Chat probe 返回的 canonical fingerprint 对账；旧 migration-60 bundle、缺 receipt 的旧 bundle、占位文件或仍有 `dispatched` / `processing` / unknown mutation 的 checkpoint 都会失败关闭，不能靠重签旧 bundle 通过。
- 当前本地 Recovery 已按上述合同在真实维护窗完成。权威 bundle 固定为 `.tmp/recovery-bundles/idream-recovery-local-20260814-final-user-journeys`；完成时间、master manifest digest 与 source authority 只由 checksummed bundle 和结构化 Gate JSON 机器校验，tracked runbook 不复制一次性 digest。PostgreSQL 16 的 71/71 migration source 与 isolated restore、schema/logical/counts、Chat FS、local mock Blob、DB/queue authority 均 exact；quiescence receipt 证明只阻断 in-flight，稳定 durable backlog 原样保留并逐项相等。恢复证据关闭本地三权威 Recovery Gate，但 local mock Blob 不能替代 production non-mock 对象存储，角色密码和外部 secrets 仍须由 secret manager 注入，也不能扩大为无前置条件的 public-production 恢复认证。
- ledger、审核与其他审计证据按既定保留策略长期保存；定期执行上述三层恢复演练。

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
