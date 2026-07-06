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
SDCPP_CLI=/Users/kk/bin/sd-cli \
SDCPP_DIFFUSION_MODEL=/Users/kk/Downloads/models/pornmasterZImage_turboV35Bf16.safetensors \
SDCPP_LLM=/Users/kk/.localai/models/z-image-components/Qwen3-4B-Instruct-2507-Q4_K_M.gguf \
SDCPP_VAE=/Users/kk/.localai/models/z-image-components/split_files/vae/ae.safetensors \
SDCPP_STEPS=1 \
SDCPP_MAX_COUNT=1 \
SDCPP_REFERENCE_MODE=auto \
SDCPP_REFERENCE_STRENGTH=0.62 \
SDCPP_MAX_REFERENCE_IMAGES=4 \
SDCPP_TIMEOUT_MS=300000 \
bun run --filter @idream/gen serve:sdcpp-image
```

新版 sd.cpp macOS binary 依赖 `libstable-diffusion.dylib`。本地把
`sd-cli`、`sd-server` 和 `libstable-diffusion.dylib` 放在同一个目录
（当前默认 `/Users/kk/bin`），否则 `sd-cli` 会在启动时因 dyld 找不到动态库退出。

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

### Local voice runner

Voice 使用独立的 OpenAI-compatible endpoint，不复用 `sdcpp-image`：

```bash
PIPELINE_VOICE_API_URL=http://127.0.0.1:8000/v1 \
PIPELINE_VOICE_MODEL_DEFAULT=OpenMOSS/MOSS-TTS-Local-Transformer-v1.5 \
bun run launch:probe:voice:local
```

本地默认 smoke path 使用 oMLX 上的 `Kokoro-82M-bf16`。该模型需要 oMLX
识别为 `audio_tts`，并且权重文件名需要有 OpenAI-compatible gateway 预期的
`model.safetensors`：

```bash
set -a; source packages/main/.env; set +a
bun run launch:prepare:voice:kokoro
bun run launch:probe:voice:local
```

`launch:prepare:voice:kokoro` 会在 `~/.omlx/models` 下定位
`Kokoro-82M-bf16`，补齐 `config.json` 的 `model_type: "kokoro"`，并在缺失时创建
`model.safetensors -> kokoro*.safetensors`。如果命令报告做了修改，先重启一次
oMLX server 再跑 probe；`launch:probe:voice:local` 会在模型名包含 `kokoro` 时自动
执行同一个预检，避免继续打到未刷新模型缓存的服务。

Kokoro 的本地配置保持 `PIPELINE_VOICE_CHUNK_CHARS=0`，不要再按固定 400 字符切段。
用 `PIPELINE_VOICE_MAX_INPUT_CHARS` 控制送入 TTS 的总长度；超限时优先保留完整句子并
丢弃尾部句子，只有第一句本身超过上限时才退到逗号/分号/词边界，避免一句话被拆进不同
chunk 造成发音不连贯。

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
bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env
```

`launch:probe:chat-service` must prove more than BFF reachability: it runs a signed
conversation smoke (session create, message send, SSE stream, reload, no-memory
send, and blocked-input handling). If `CHAT_SERVICE_PROBE_CHARACTER_ID` is unset,
the probe auto-selects a public approved adult character from the main DB; use
`--character-id=...` when a fixed production probe character is required.

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
`PUBLIC_CATALOG_PROBE_REPORT=.tmp/public-catalog-probe.json`、
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
`PUBLIC_CATALOG_PROBE_REPORT` 指向最近一次 public catalog probe 报告，证明公开角色、创作者、
合集和图片素材存在且没有 fixture/audit marker、异常指标或重复图片集中度问题；否则公开目录脏数据
不能误报为可上线。门禁还要求
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
后台 `GenerationModelProfile.runnerConfig` 是 sdcpp 运行态配置入口：
管理员可登记 `.safetensors` source、`.gguf` converted target、LLM/VAE 组件、
`conversion.enabled` 和 LoRA 栈。main 创建 job 时不会把这些本地路径写入用户可见
`generation_jobs.controls`；只在内部队列 payload 中注入 `controls.sdcpp`，由
`serve:sdcpp-image` 读取。gateway 在 `SDCPP_ALLOW_REQUEST_CONFIG=true`（默认）时按
请求 profile 覆盖 env 单模型配置；没有该块时继续使用 env fallback。
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
角色一致性 reference 图从 `ImageGeneratePayload.referenceImages` 进入 pipeline：
gateway 在 `SDCPP_REFERENCE_MODE=auto` 下把 Gallery `More like this` 的 source image
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
流程产物和 reference transport；真实质量复核要改用 `--provider pipeline`，并按需传
`--pipeline-url http://127.0.0.1:8091`、`--model ...`。通过标准仍是人工确认至少 80%
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

2026-06-30 本地 sd.cpp 模板验证结果：

- `pornmaster-zimage-turbo` 是当前已跑通的 active/default sd.cpp 图片链路；主站普通生图
  和 admin test-job 已验证 512x640 PNG，`cfgScale=1` 保持为该链路默认值。
- Redcraft Krea2 候选：当前是 ComfyUI/Krea2 fp8 checkpoint candidate，不是 sd.cpp
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
  sanity guard；随后通过 `serve:comfyui-image` OpenAI-compatible gateway 和
  `launch:probe:redcraft-image:local` 走完 gen `probe:image`/blob 写入链路。
  `launch:probe:redcraft-consistency:local` 现在默认锁定角色 seed，已生成 20 张样本并
  人工评审为 17/20 同一角色，`consistencyRate=0.85`。seed 中仍保留 draft profile，
  `enabled=false`、`rolloutPercent=0`；这表示内置候选已通过发布门槛，但在部署托管
  ComfyUI gateway 前不自动导流。
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
`serve:sdcpp-image` 在 `sd-cli` 退出码为 0 后还会解析 PNG 像素，拒绝纯白、纯黑或
近乎纯色的退化输出；gen worker 在写入 blob 前也会对 provider 返回的 PNG bytes
执行同样检查。这类任务应视作模型/profile 失败，而不是成功出图。

内置模型状态用独立 probe 固化，避免依赖人工会话记忆：

```bash
# 日常门禁：确认 Pornmaster active/default 可用，Redcraft 可发布但默认不导流。
# redcraft_krea2_text 是历史兼容 candidate key，当前期望 runner 是 comfyui。
bun run launch:probe:generation-model-candidates -- \
  --candidate pornmaster_zimage_default,redcraft_krea2_text \
  --report .tmp/launch-generation-model-candidates.json

# 验收当前默认内置模板：Pornmaster 必须 active、路径存在且 dry-run 通过。
bun run launch:probe:generation-model-candidates -- \
  --candidate pornmaster_zimage_default \
  --require-ready \
  --report .tmp/launch-pornmaster-zimage-ready.json

# 验收 Redcraft ComfyUI/Krea2 checkpoint candidate 能否发布：必须 ready，否则返回非 0。
# 当前不是 sd.cpp text template；发布门槛包括非退化图、20 张一致性评审与 runner policy。
bun run launch:probe:generation-model-candidates -- \
  --candidate redcraft_krea2_text \
  --require-ready \
  --report .tmp/launch-redcraft-krea2-ready.json

# 只验证 Redcraft 当前 ComfyUI CPU workflow 能否出非退化图：
# 需要先启动 ComfyUI，并加载 packages/gen/workflows/comfy-extra-models-idream.yaml 指向 ComfyUI-Shared。
cd "/Users/kk/ComfyUI-Installs/idream (1)/ComfyUI"
".venv/bin/python" main.py \
  --listen 127.0.0.1 \
  --port 8191 \
  --extra-model-paths-config /Users/kk/code/idream/packages/gen/workflows/comfy-extra-models-idream.yaml \
  --cpu \
  --force-fp32 \
  --fp32-vae \
  --fp32-text-enc \
  --preview-method none \
  --disable-auto-launch

cd /Users/kk/code/idream
bun run launch:probe:redcraft-comfyui -- \
  --report .tmp/launch-redcraft-comfyui-cpu-smoke.json \
  --output .tmp/redcraft-comfyui-cpu-smoke.png

# 验证 Redcraft 能否通过统一 gen image pipeline 写入 blob：
# 保持上面的 ComfyUI 8191 运行，另起本地 OpenAI-compatible image gateway。
COMFYUI_API_URL=http://127.0.0.1:8191 \
COMFYUI_IMAGE_PORT=8092 \
bun run --filter @idream/gen serve:comfyui-image

# 再运行：
bun run launch:probe:redcraft-image:local -- \
  --report .tmp/launch-redcraft-image-probe.json \
  --count 1

# 生成 Redcraft 的 20 张角色一致性 review 包；默认 seedMode=locked，当前已生成在 .tmp/redcraft-consistency-review。
bun run launch:probe:redcraft-consistency:local -- \
  --output .tmp/redcraft-consistency-review \
  --samples 20

```

当前输出应显示 Pornmaster `readyForPublish=true`，Redcraft `runner=comfyui`、
`readyForPublish=true`、`verificationStatus=manual_passed`、`consistencyRate=0.85`；
同时 Redcraft 仍保持 `status=draft`、`enabled=false`、`rolloutPercent=0`，表示候选
已验证但未导流。
`launch:probe:redcraft-image:local` 应完成一个 `provider=pipeline` 的 generation job，
并在 `.tmp/probe-blob/` 下写入 PNG；这只证明候选 runner 接入了统一生图链路，不替代
20 张一致性样本门禁。`launch:probe:redcraft-consistency:local` 会走同一个 Redcraft
gateway 生成 `manifest.json`、20 张样本和 `review.html`；当前样本包在
`.tmp/redcraft-consistency-review`，并已补 `manual-review.json` 与 `contact-sheet.jpg`。
本次人工 review 写回 `sampleCount=20`、`consistencyPassCount=17`、`consistencyRate=0.85`、
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
| `gen-image` | `packages/gen` | n/a | 异步图片生成 worker（当前 2 实例） |
| `gen-video` | `packages/gen` | n/a | V1.1 延后；`video_gen=false` 时不在 PM2 拓扑中启动 |
| `gen-finalizer` / `main-event-consumer` | `packages/main` | n/a | 主站侧权威写回和事件消费 |

运行命令：

```bash
bun run build
bun run pm2:start
bun run pm2:status
```

当 `ecosystem.config.js` 增删进程后，确认 `pm2 list` 与目标拓扑一致，然后执行 `pm2 save`。否则 `pm2 resurrect` 或机器重启可能恢复旧 dump（例如已延后的 `gen-video` 或重复的 `main-web`）。

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
