# iDream Production Secret Checklist

Updated: 2026-09-01

Purpose: one place to prepare the production values required by `packages/main/.env.production.example`, `packages/chat/.env.production.example`, and `packages/gen/.env.production.example`.

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
| `PIPELINE_API_TOKEN` | main-web；gen 仅在显式 legacy provider 时 | Main 的 OpenAI-compatible text/voice adapter；deprecated external image/video pipeline 只有显式选择时才使用，workflow-native backend 不依赖它 |
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
| `BULLMQ_PREFIX` | Same production prefix across main/chat/gen |
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
| `GEN_VIDEO_PROVIDER` | Keep `mock` while `video_gen=false`; enabled production video uses the workflow-native `backend` route |
| `ADMIN_MODEL_DIAGNOSTICS_ENABLED` | Keep `false` for normal production Admin; set `true` only during engineering diagnostics |
| `ADMIN_MODEL_LIBRARY_DIR` | Optional diagnostics-only server-side model import directory |

## Chat Service Values

| Key | Notes |
| --- | --- |
| `CHAT_FS_ROOT` | Absolute durable-storage path for AgentRun evidence; include it in the same checkpoint as PostgreSQL, DSH workspaces and Blob |
| `CHAT_PORT` | Chat service HTTP/SSE port |
| `CHAT_MODEL_PROVIDER` | `pipeline` or another production model provider |
| `CHAT_MODEL_BASE_URL` | OpenAI-compatible chat gateway URL |
| `CHAT_MODEL_NAME` | Production chat model alias |
| `CHAT_MODEL_API_KEY` | Chat gateway token |

## Main Text/Voice and Legacy External Pipeline Values

| Key | Notes |
| --- | --- |
| `PIPELINE_API_URL` | Main OpenAI-compatible admin-text/fallback adapter URL；只有显式 legacy media provider 才复用它，当前 workflow-native image/video backend 不依赖该 URL |
| `PIPELINE_IMAGE_MODEL_DEFAULT` | Legacy pipeline image alias only; not the current backend model authority |
| `PIPELINE_CHAT_MODEL_DEFAULT` | Main text adapter alias；split Chat runtime 使用 `CHAT_MODEL_*`，不以该值为模型权威 |
| `PIPELINE_VIDEO_MODEL_DEFAULT` | Legacy pipeline video alias only; workflow-native video release does not require it |
| `PIPELINE_TIMEOUT_MS` | Main/legacy adapter timeout budget |
| `PIPELINE_VOICE_API_URL` | Explicit rollback voice gateway only |
| `PIPELINE_VOICE_API_TOKEN` | Explicit rollback voice gateway token only |
| `PIPELINE_VOICE_MODEL_DEFAULT` | Explicit rollback voice model alias only |
| `FISH_AUDIO_API_URL` | Fish Audio gateway, normally `http://127.0.0.1:8062/v1` |
| `FISH_AUDIO_API_TOKEN` | Shared internal token used by Main and the Fish gateway |
| `FISH_AUDIO_MODEL` | Exact voice model id, currently `fish-audio-s2-pro-8bit` |
| `FISH_AUDIO_MODEL_PATH` | Deployed Fish Audio S2 Pro 8-bit model directory |
| `FISH_AUDIO_SYSTEM_REFERENCE_AUDIO` | Reviewed system-voice reference WAV |
| `FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST` | Exact transcript/identity manifest for that WAV |

## Generation Worker Values

| Key | Notes |
| --- | --- |
| `GEN_IMAGE_PROVIDER` | `backend` for the current production worker |
| `COMFYUI_API_URL` | Workflow-native ComfyUI API; current local runtime is `http://127.0.0.1:8188` |
| `GEN_WORKFLOW_DIR` | Descriptor root; normally the deployed `packages/gen/workflows` directory |
| `GEN_VIDEO_PROVIDER` | Keep `mock` while `video_gen=false`; production video uses the workflow-native `backend` route |
| `VIDEO_GENERATION_PROBE_REFERENCE` | Reviewed production-like character image used only by the explicit video launch probe |
| `GEN_MODERATION_PROVIDER` | Current product scope uses `mock`; service URL/API key are not required unless this changes |
| `PIPELINE_IMAGE_SIZE_DEFAULT` | Production default image size |
| `GEN_BLOB_PROVIDER` | Must match main-web object storage |

Current image readiness is proven with `bun run --filter @idream/gen smoke:backend`;
the 2026-07-18 Redcraft smoke reached ComfyUI 0.28.0/MPS and produced an
832×1024, 880,175-byte image in 132,649ms. The repository has no
`serve:sdcpp-image` script. A failed legacy 8091 pipeline probe is not a backend
failure, but the combined pipeline suite remains failed until every selected
step passes.

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

现有 `bun run recovery:rehearse` 仍基于旧 Chat PG/inbox/file-mutation checkpoint contract，尚未包含独立 DSH workspace authority。ADR-20 cutover 后必须先刷新 recovery producer/executor/launch gate，再用它签发当前 bundle；旧 bundle 只保留为历史恢复证据，不能重签后用于当前 revision。

After reviewing a newly published bundle, bind that exact checksum manifest in the launch env:

```bash
shasum -a 256 <bundle-dir>/<bundle-name>.sha256
# Copy the lowercase digest to RECOVERY_REHEARSAL_APPROVED_SHA256.
```

只有新 producer 同时恢复并比较四层 authority 后，才能把其 manifest digest 写入 `RECOVERY_REHEARSAL_APPROVED_SHA256`。本地 mock Blob checkpoint 不能替代 production non-mock recovery，role password 与 external secret 始终由 secret manager 注入。

## Probe Report Variables

These must point at fresh reports before public launch:

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

Current local evidence is `.tmp/check-launch-2026-08-13-final-source.json`: `LAUNCH_SCOPE=core`, 44 pass / 23 fail / 0 warn / 67 total. Payment and age verification are excluded. The 23 failures are exactly `app-env-production`, `main-web-url`, `better-auth-url`, `better-auth-secret`, `internal-token`, `cron-secret`, `service-token-separation`, `web-surface-live-probe`, `redis-url`, `bullmq-prefix`, `blob-provider-non-mock`, `main-chat-pipeline-api-token`, `chat-bff-signing-secret`, `admin-bff-signing-secret`, `chat-model-api-key`, `blob-bucket`, `blob-endpoint`, `blob-access-key`, `blob-secret-key`, `sentry-dsn`, `sentry-browser-app-env`, `sentry-browser-dsn`, and `sentry-live-probe`. Recovery and Admin text live evidence pass locally. Four package-specific Sentry probes bind their explicit failed canaries to the same source revision, so source-revision authority passes; production still requires real Sentry credentials and verified ingest/query before `sentry-live-probe` can pass. Old reports or server runtime identities without the expected revision fail closed.
