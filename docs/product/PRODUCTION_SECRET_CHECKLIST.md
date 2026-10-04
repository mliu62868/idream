# iDream Production Secret Checklist

Updated: 2026-10-04（核对配置与恢复契约；未运行生产验收）

Purpose: prepare the production values required by the Main, Admin, Chat and Gen `.env.production.example` templates. This is a deployment checklist, not a feature specification or a current readiness result. Runtime ownership and commands follow [the operations guide](../architecture/10-operations.md); actual evidence follows [current coverage](CURRENT_FUNCTIONAL_COVERAGE.md).

Do not commit filled values. Put them in the deployment secret manager for the relevant service.

## Generate Internal Secrets

Run:

```bash
bun run --silent launch:secrets
```

Store these generated values:

| Key | Used by | Must match |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | main-web | main-web only |
| `INTERNAL_TOKEN` | main-web, workers/internal callers | every caller that uses internal APIs |
| `CRON_SECRET` | main-web cron endpoints | cron scheduler |
| `CHAT_BFF_SIGNING_SECRET` | main-web, chat | exactly the same in both services |
| `ADMIN_BFF_SIGNING_SECRET` | main-web, admin | exactly the same in both services |
| `PIPELINE_API_TOKEN` | main-web text adapter | Main OpenAI-compatible admin-text authentication; workflow-native image/video backends do not use it |
| `AGE_VERIFY_API_KEY` | main-web | age gateway |
| `AGE_VERIFY_WEBHOOK_SECRET` | main-web | age gateway callback signer |
| `BTCPAY_WEBHOOK_SECRET` | main-web | BTCPay webhook signer |

## Shared Runtime Values

| Key | Notes |
| --- | --- |
| `APP_ENV=production` | Required by launch gate |
| `NODE_ENV=production` | Required by service runtime |
| `LAUNCH_SCOPE` | `full` by default; `core` excludes only Billing and Age Verification from this release while every other launch check remains mandatory |
| `BETTER_AUTH_URL` | Public HTTPS main origin |
| `MAIN_WEB_URL` | Public HTTPS main origin |
| `ADMIN_WEB_URL` | Public HTTPS admin origin |
| `DATABASE_URL` | Main Postgres URL, app role |
| `REDIS_URL` / `CHAT_REDIS_URL` / `GEN_REDIS_URL` | Same Redis deployment unless intentionally split |
| `BULLMQ_PREFIX` | Same production job prefix across Main/Gen; Chat does not use BullMQ |
| `SENTRY_DSN` | Production error capture DSN |

## Main Web Values

| Key | Notes |
| --- | --- |
| `CHAT_SERVICE_URL` | Internal chat service URL |
| `CHAT_PROVIDER` | Production adapter value expected by launch gate |
| `IMAGE_PROVIDER` | Main-web adapter only; dedicated `gen-image` owns image jobs, so do not use this value to infer worker readiness |
| `VOICE_PROVIDER` | Production adapter value expected by launch gate |
| `MODERATION_PROVIDER` | Current product scope uses `mock`; change only if the product config explicitly changes |
| `PAYMENT_PROVIDER` | Production adapter value expected by launch gate |
| `BLOB_PROVIDER` | Production adapter value expected by launch gate |
| `AGE_VERIFICATION_PROVIDER` | Production adapter value expected by launch gate |
| `GEN_IMAGE_PROVIDER` | Generation worker image adapter; current workflow-native architecture uses `backend` |
| `GEN_VIDEO_PROVIDER` | Current production template uses `backend`; feature/profile/entitlement gates independently decide whether new video requests are available |
| `ADMIN_MODEL_DIAGNOSTICS_ENABLED` | Keep `false` for normal production Admin; set `true` only during engineering diagnostics |
| `ADMIN_MODEL_LIBRARY_DIR` | Optional diagnostics-only server-side model import directory |

Main must sit behind exactly one public ingress proxy that sets or appends `X-Forwarded-For`. Anonymous rate limits read its **rightmost** entry (the address that ingress observed), so a client-supplied header cannot choose its own bucket; exposing Main directly, or adding a second proxy hop without adjusting `rateLimitIdentity`, breaks that guarantee.

## Chat Service Values

| Key | Notes |
| --- | --- |
| `CHAT_FS_ROOT` | Absolute durable-storage path for AgentRun evidence; include it in the same checkpoint as PostgreSQL, DSH workspaces and Blob |
| `CHAT_PORT` | Chat service HTTP/SSE port |
| `CHAT_MODEL_PROVIDER` | Current production template uses `openai` for the self-hosted OpenAI-compatible runtime; this is separate from Main's `CHAT_PROVIDER` and retired media runner values |
| `CHAT_MODEL_BASE_URL` | OpenAI-compatible chat gateway URL |
| `CHAT_MODEL_NAME` | Production chat model alias |
| `CHAT_MODEL_API_KEY` | Chat gateway token |

## Main Text, Voice and Retained Environment Names

The external image/video pipeline adapter and `pipeline`/`mlx`/`external` media runner values were retired on 2026-09-12. Retained environment names below serve identified text adapters, probe defaults or download budgets; they do not restore that media execution route. A template containing an old name is not evidence that its old runner exists.

| Key | Notes |
| --- | --- |
| `PIPELINE_API_URL` | Main OpenAI-compatible admin-text adapter URL; workflow-native image/video backends do not use this URL |
| `PIPELINE_IMAGE_MODEL_DEFAULT` | Retained Gen image/probe fallback model id; product requests use frozen active profile/workflow/model pins |
| `PIPELINE_CHAT_MODEL_DEFAULT` | Main text adapter alias；split Chat runtime 使用 `CHAT_MODEL_*`，不以该值为模型权威 |
| `PIPELINE_VIDEO_MODEL_DEFAULT` | Retained Gen video/probe fallback model id; not a legacy runner selection |
| `PIPELINE_TIMEOUT_MS` | Main text/probe and asset-download timeout budget; Gen workflow execution uses its own image/video budgets |
| `PIPELINE_VOICE_API_URL` | Explicit rollback voice gateway only |
| `PIPELINE_VOICE_API_TOKEN` | Explicit rollback voice gateway token only |
| `PIPELINE_VOICE_MODEL_DEFAULT` | Explicit rollback voice model alias only |
| `FISH_AUDIO_API_URL` | Fish Audio gateway, normally `http://127.0.0.1:8062/v1` |
| `FISH_AUDIO_API_TOKEN` | Shared internal token used by Main and the Fish gateway |
| `FISH_AUDIO_MODEL` | Exact voice model id, currently `breeze-tts-2-mlx-8bit` |
| `FISH_AUDIO_MODEL_PATH` | Deployed Breeze TTS 2 MLX 8-bit model directory |
| `FISH_AUDIO_SYSTEM_REFERENCE_AUDIO` | Reviewed system-voice reference WAV |
| `FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST` | Exact transcript/identity manifest for that WAV |
| `POCKET_TTS_API_URL` / `POCKET_TTS_API_TOKEN` | Official preset-voice runtime URL/token used by the current default Voice provider |
| `POCKET_TTS_MODEL` / `POCKET_TTS_DEFAULT_VOICE_ID` | Exact deployed model and system voice; character active profiles and old requests keep their own pins |

## Generation Worker Values

| Key | Notes |
| --- | --- |
| `GEN_IMAGE_PROVIDER` | `backend` for the current production worker |
| `COMFYUI_API_URL` | Workflow-native ComfyUI API; current local runtime is `http://127.0.0.1:8188` |
| `GEN_WORKFLOW_DIR` | Descriptor root; normally the deployed `packages/gen/workflows` directory |
| `GEN_VIDEO_PROVIDER` | Production template uses `backend`; video publication still requires its independent capability/profile/pricing/entitlement gates |
| `VIDEO_GENERATION_PROBE_REFERENCE` | Reviewed production-like character image used only by the explicit video launch probe |
| `GEN_MODERATION_PROVIDER` | Current product scope uses `mock`; service URL/API key are not required unless this changes |
| `PIPELINE_IMAGE_SIZE_DEFAULT` | Production default image size |
| `GEN_BLOB_PROVIDER` | Must match main-web object storage |

Use `bun run --filter @idream/gen smoke:backend` for a scoped backend diagnostic, then validate the actual published product request, delivery, persistence and billing chain. A smoke result alone does not certify current image quality, product readiness or capacity. Model/workflow/defaults come from the selected immutable request and deployed configuration, not a historical Redcraft sample or legacy port 8091.

## Payment Values

| Key | Notes |
| --- | --- |
| `BTCPAY_BASE_URL` | Public/controlled BTCPay instance URL |
| `BTCPAY_STORE_ID` | Production store id |
| `BTCPAY_API_KEY` | Greenfield API key |
| `BTCPAY_WEBHOOK_SECRET` | Generated/stored webhook secret |

## Age Verification Values

| Key | Notes |
| --- | --- |
| `AGE_VERIFY_SERVICE_URL` | Age gateway service URL |
| `AGE_VERIFY_API_KEY` | Age gateway API token |
| `AGE_VERIFY_WEBHOOK_SECRET` | Callback signature secret |
| `AGE_VERIFY_LINK_BACK_URL` | Canonical public HTTPS return page (`/age-verification/return`); it polls the signed-in status and resumes only a validated internal `next` path |
| `AGE_VERIFY_CALLBACK_URL` | Public HTTPS webhook URL |

## Blob Storage Values

| Key | Notes |
| --- | --- |
| `BLOB_ENDPOINT` | R2/S3-compatible endpoint |
| `BLOB_BUCKET` | Private generated-media bucket |
| `BLOB_REGION` | `auto` for R2 or provider region |
| `BLOB_ACCESS_KEY_ID` | Object storage access key |
| `BLOB_SECRET_ACCESS_KEY` | Object storage secret |
| `RECOVERY_BLOB_ENDPOINT` | Independent recovery R2/S3 endpoint; must differ from the live endpoint |
| `RECOVERY_BLOB_BUCKET` | Independently versioned recovery bucket; must differ from the live bucket |
| `RECOVERY_BLOB_REGION` | Recovery authority region (`auto` for R2) |
| `RECOVERY_BLOB_ACCESS_KEY_ID` | Recovery-only object storage access key |
| `RECOVERY_BLOB_SECRET_ACCESS_KEY` | Recovery-only object storage secret |
| `RECOVERY_BLOB_RETENTION_DAYS` | Positive Object Lock retention policy applied to every recovery version |
| `RECOVERY_DATABASE_URL` | Temporary recovery actor URL; superuser on the exact Main host/port/database, never source identity |

## Backup And Restore Values

Treat these as one quiesced recovery checkpoint:

| Value | Requirement |
| --- | --- |
| Main PostgreSQL | Version-compatible dump plus migration count and restore verification |
| `CHAT_FS_ROOT` | AgentRun archive plus per-file manifest/checksum; product sessions/Turns/Scene stay in Main PG |
| DSH workspace roots | Canonical and private igrep workspace archives plus manifests; derived memory, restored separately from AgentRun |
| Local `BLOB_ROOT` | Archive plus per-object manifest/checksum when `BLOB_PROVIDER=mock`; for R2/S3 bind the checkpoint to versioned object inventory instead |
| Checkpoint metadata | Quiesced timestamp, artifact ids, SHA-256 values, provider/root identifiers, and disposable-restore result |
| `RECOVERY_REHEARSAL_BUNDLE` | Absolute or workspace-relative path to the published flat bundle whose basename prefixes every artifact |
| `RECOVERY_REHEARSAL_APPROVED_SHA256` | Lowercase SHA-256 of `<bundle>/<bundle>.sha256`, copied into the launch env only after explicit operator review |
| `RECOVERY_REHEARSAL_MAX_AGE_MINUTES` | Maximum accepted age of the bundle checksum manifest; default `1440` |

Do not call a database-only dump a complete iDream backup. Stop new Turn admission and pause/drain Generation；确认没有 active/unknown attempt 后，在同一 checkpoint 捕获 Main PostgreSQL、AgentRun、DSH workspaces 和 Blob。稳定 scheduled/pending/failed durable intent 是产品事实，source/restore 必须逐项相等，不能为让备份通过而提前投递或删除。

发布 bundle 必须包含可由 `pg_restore --list` 读取的 Main PostgreSQL archive、Main schema/logical manifests、可重建 checksum manifest 的 AgentRun/DSH archives、新鲜 quiescence receipt，以及 local Blob archive 或独立 versioned recovery bucket inventory。远端 inventory 必须绑定 exact version、checksum、metadata 和 retention。

现有 recovery producer/executor/launch gate 使用 schema2，包含 Main PG、AgentRun、DSH canonical/private、Blob 与 durable intent/receipt；代码契约见 `packages/main/src/server/readiness/recovery-rehearsal-{producer,executor,authority}.ts`。本机完整恢复证据见当前覆盖，不代表目标环境已恢复。新 bundle 必须匹配实际 source、迁移/checksum、根目录、队列/权限、manifest SHA 与有效期；旧 schema1/PG-only bundle 不能签发当前恢复资格。

After reviewing a newly published bundle, bind that exact checksum manifest in the launch env:

```bash
shasum -a 256 <bundle-dir>/<bundle-name>.sha256
# Copy the lowercase digest to RECOVERY_REHEARSAL_APPROVED_SHA256.
```

只有实际恢复并比较四层 authority、queue receipt 与权限后，才能把该 bundle 的 manifest digest 写入 `RECOVERY_REHEARSAL_APPROVED_SHA256`。本地 mock Blob checkpoint 不能替代 production non-mock recovery，role password 与 external secret 始终由 secret manager 注入。

## Probe Report Variables

These must point at fresh reports before public launch:

H3 currently remains disabled. Its two report rows apply only after independent visual qualification and an explicit release decision; do not run them merely to fill this checklist. Other reports follow the approved target release scope and active configuration.

| Key | Command that refreshes it |
| --- | --- |
| `WEB_SURFACE_PROBE_REPORT` | `bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe.json` |
| `PRODUCT_CONFIG_PROBE_REPORT` | `bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json` |
| `PUBLIC_CATALOG_PROBE_REPORT` | `bun run launch:probe:catalog -- --report .tmp/public-catalog-probe.json` |
| `CHAT_SERVICE_PROBE_REPORT` | `bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json` |
| `PIPELINE_IMAGE_PROBE_REPORT` | `bun run --filter @idream/gen probe:image -- --model <active-product-config-model> --report .tmp/launch-image-probe.json` using the production Gen adapter/workflow/blob env |
| `VIDEO_GENERATION_PROBE_REPORT` | `bun run launch:probe:video -- --model redgraft-ltx25-i2v --reference <reviewed-character-image> --report .tmp/launch-video-probe.json` |
| `VIDEO_H3_GENERATION_PROBE_REPORT` | `bun run launch:probe:video -- --model minimax-h3-redcraft-i2v --reference <reviewed-character-image> --report .tmp/launch-video-h3-probe.json` |
| `GENERATION_VIDEO_PERSISTENCE_PROBE_REPORT` | Run `probe:generation-persistence` for the completed LTX product job. |
| `GENERATION_VIDEO_H3_PERSISTENCE_PROBE_REPORT` | Run `probe:generation-persistence` for the completed H3 product job. |
| `VOICE_MODEL_PROBE_REPORT` | `bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json` |
| `PAYMENT_PROVIDER_PROBE_REPORT` | Complete and replay a real product checkout, then run `bun run launch:probe:payment -- --checkout-id <checkout-id> --report .tmp/launch-payment-probe.json` |
| `AGE_VERIFICATION_PROBE_REPORT` | Complete and replay a real signed callback, then run `bun run launch:probe:age -- --age-verification-id <verification-id> --report .tmp/launch-age-probe.json` |
| `BLOB_STORAGE_PROBE_REPORT` | `bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json` |
| `SENTRY_MAIN_PROBE_REPORT` | `bun run launch:probe:sentry:main -- --report .tmp/launch-sentry-main-probe.json` |
| `SENTRY_ADMIN_PROBE_REPORT` | `bun run launch:probe:sentry:admin -- --report .tmp/launch-sentry-admin-probe.json` |
| `SENTRY_CHAT_PROBE_REPORT` | `bun run launch:probe:sentry:chat -- --report .tmp/launch-sentry-chat-probe.json` |
| `SENTRY_GEN_PROBE_REPORT` | `bun run launch:probe:sentry:gen -- --report .tmp/launch-sentry-gen-probe.json` |

## Final Gate

After all production values and probe reports are present:

Set the same immutable `SENTRY_RELEASE` (or `IDREAM_SOURCE_REVISION`) in Main,
Admin, Chat, and Gen before starting them. Every required probe must be rerun
from that release; Chat's signed runtime endpoint, Admin's BFF response header,
and Main's Admin-text runtime identity are compared with the expected release.

```bash
bun run check:launch -- --launch-env-file .tmp/production-main.env --admin-env-file .tmp/production-admin.env --chat-env-file .tmp/production-chat.env --gen-env-file .tmp/production-gen.env --report .tmp/check-launch.json --json
```

Set `LAUNCH_SCOPE=core` in the explicit launch env only when Billing and Age
Verification are outside the approved release scope. Unknown values fail closed.
Public launch remains red until this command passes against production-like services.

Read [current coverage](CURRENT_FUNCTIONAL_COVERAGE.md) for dated local results and [remaining work](REMAINING_WORK_EXECUTION_PLAN.md) for unresolved target gates. Every report and service identity must bind the expected release and target authority; unavailable target inputs remain unverified rather than passing.
