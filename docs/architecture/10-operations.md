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

### Local voice runner

Voice 当前使用 Pocket TTS。仓库内 gateway 在 `8062` 暴露 OpenAI-compatible
`/v1/audio/speech`，并额外提供声音克隆管理接口；它不复用 legacy 8091 image
gateway：

```bash
pm2 start ecosystem.config.js --only pocket-tts --update-env
pm2 save
curl -fsS http://127.0.0.1:8062/health
bun run launch:probe:voice:local
```

第一次启动会由 `uv` 创建隔离环境并下载固定版本 `pocket-tts==2.1.0` 及
`kyutai/pocket-tts` 权重。若 Hugging Face 要求身份，先接受模型页条件并提供
`HF_TOKEN`。未认证时公开权重仍可使用 catalog voices 做普通 TTS，但 `/health`
会报告 `voice_cloning: false`，Admin 会禁用克隆提交，不能把“进程健康”误报为
“克隆就绪”。默认配置：

```dotenv
VOICE_PROVIDER=pocket-tts
POCKET_TTS_API_URL=http://127.0.0.1:8062/v1
POCKET_TTS_MODEL=kyutai/pocket-tts
POCKET_TTS_LANGUAGE=english
POCKET_TTS_DEFAULT_VOICE_ID=alba
```

声音克隆入口在 Admin 的 Character Workspace → Voice，分成候选制作和明确启用
两段 authority。候选制作会：

- 读取最多前 30 秒的单人参考录音；
- 将 Pocket TTS voice state 持久化到 `.data/pocket-tts/voices/*.safetensors`；
- 保存原始参考音频和试听 WAV 为 `MediaAsset`；
- 创建状态为 `candidate` 的版本化 `CharacterVoiceProfile`，但不修改
  `Character.voiceId`。

操作者试听后，只有具备 `character.release.publish` 的账号才能明确启用候选。
启用事务会归档旧 active profile、激活同一份已试听候选、写 Audit/Outbox，并原子更新
`Character.voiceId`；新生成的聊天语音立即使用新声音，已有缓存 clip 保持不变。

`POCKET_TTS_API_TOKEN` 可保护 gateway；Main 和 PM2 runner 必须使用同一值。
旧 `pipeline` voice adapter 仍保留为回滚路径，但不再是当前默认。

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

以下 8091 显式命令只用于需要审计旧 OpenAI-compatible image adapter 的场景；
它要求另行提供外部 gateway，仓库没有可启动它的 `serve:sdcpp-image` 脚本。当前
workflow-native backend 的健康检查使用本节顶部 `smoke:backend` 命令。

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
Pipeline 配置。当前 `check:launch` 仍保留 legacy
`PIPELINE_IMAGE_PROBE_REPORT` 合同：报告必须证明 provider 为 `pipeline`、模型和
`PIPELINE_API_URL` 匹配、finalizer payload 为 `generation.completed`，且至少
产出 1 个 asset；否则 `check:launch` 失败。该门禁尚未随 controlled-beta 的当前
`backend -> ComfyUI :8188` runtime 一起切换；因此 2026-07-18 未运行 legacy
`:8091` gateway 时组合探针为 6/7，不能把这一项写成 backend 健康失败，也不能把
整套 launch gate 写成已通过。当前 backend 能力由 `smoke:backend` 的真实
workflow-native 出图独立证明；公开上线前仍需提供合格的 pipeline 报告，或在代码审查后
显式更新 launch 合同。门禁还要求 `WEB_SURFACE_PROBE_REPORT` 指向最近一次 web surface
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
可上线。门禁也要求 `BLOB_STORAGE_PROBE_REPORT` 指向最近一次对象存储
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
（SSE 或 JSON 均可）。voice 当前使用 `pocket-tts`，调用本地
`/v1/audio/speech` 并由 main 写入私有 blob；旧 `pipeline` voice adapter 保留为
显式回滚路径。
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
| `admin-command-worker` | `packages/main` | n/a | Admin durable command 执行 |

2026-07-18 最终备份恢复后的 runtime 是 7 个 logical apps / 8 个 processes online：
`main-web`、`admin-web`、`chat`、`gen-image`（2 processes）、`gen-finalizer`、
`main-event-consumer`、`admin-command-worker`。`/`、`/explore`、`/admin/today`
为 200，Chat `/healthz` 为 `ok`；Redis operational queues pending/failed 均为 0。

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

> `db/sql/` 是跨服务库边界的 SSoT：Chat 请求路径以 `chat_service` 连接，只读 Main 的 core/billing/compliance 视图并写请求事务/文件 intent；文件投影器以独立 `chat_projector` 连接，只有实际完成 `CHAT_FS_ROOT` 副作用后才能推进 mutation receipt。两种角色均由 grant/trigger 强制，不能用一个全权运行时连接替代。这些 DDL 不归 Prisma `db push` 管。

## 7. 备份与容灾

- 一份可恢复的 iDream checkpoint 是同一静默边界下的**一致性集合**：Main PostgreSQL、`CHAT_FS_ROOT` 与媒体 Blob。只备份数据库不能称为完整 current-state backup，因为 Chat 的 session trace / memory / relationship 权威在文件层，local/mock Blob 的媒体字节也不在 PostgreSQL。
- 备份前先停止所有写入进程并确认 Main/Chat outbox、inbox、生成队列及 `chat_file_mutations` pending 均已清空；同时确认 Main/Admin/Chat 端口无 listener。不能在请求角色仍能新增 intent、projector 仍在改文件或 worker 仍在写 Blob 时分别抓取三个副本。
- PostgreSQL 使用与目标服务兼容的 `pg_dump` / `pg_restore`；`CHAT_FS_ROOT` 和本地 `BLOB_ROOT` 分别生成归档与逐文件 manifest/checksum。使用 R2/S3 时启用版本化/跨区复制，并把精确 object-version inventory 与 DB/Chat FS checkpoint 绑定。
- 每个 checkpoint 必须写明数据库名/schema migration count、Chat FS root、Blob provider/root、静默时间、artifact id 与 SHA-256；不得覆盖已有备份。
- 恢复演练必须进入隔离的 disposable DB/Chat FS/Blob root，校验全部 checksum、目录 manifest、migration status、业务计数和无悬空引用后再删除临时目标。只证明 `pg_restore` 成功不等于 Chat 文件和媒体可恢复。
- 2026-07-18 controlled-beta 最终 checkpoint 已按上述合同完成。Artifact base 为 `/Users/kk/code/idream/local-backups/idream-main-final-20260718-60/idream-main-final-20260718-60`；bundle 目录 mode `0700`、23 个文件均为 `0600`、总大小 171M，bundle SHA checks 全部通过。源端为 migrations `60`（latest `20260718012000`）、20 users、characters / Releases / Servings / Qualifications / MediaAssets 各 16、234 base tables / 7 views / 1 sequence；Main outbox `3,936`（pending/failed `0`）、inbound `5,738`（received `0`）。Chat 为 294 sessions / 818 messages / 4 attachments、outbox `1,552` / inbox `488`（pending/failed `0`）、file mutations `5`（pending `0`）；Chat FS 为 429 files / 550,987 bytes，Blob 为 13,634 files / 162,163,688 bytes，Main/Gen effective mock root 一致。
- PostgreSQL client `18.3` 对 server `16.14` 的隔离恢复中，source/restore counts、schema、logical DB、Chat FS 与 Blob 比较全部为 `0` difference（equal），disposable restore DB 清理后 remaining `0`。恢复后 PM2 7 logical apps / 8 processes 全部 online，Main/Admin HTTP 200、Chat health `ok`。演练过程捕获并修复了 zero-dim ACL、`psql -c` substitution、null `datacl` marker 与 `bsdtar` umask mode 四类 fail-closed 缺陷；最终 artifact 不含这些失败状态。本次自动证明是 same-cluster throwaway restore；bundle 提供 role/database authority manifests 与 fresh-cluster runbook，但角色密码和外部 secrets 仍须由 secret manager 注入，不能把本地证明扩大为无前置条件的 fresh-cluster/public-production 恢复认证。
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
