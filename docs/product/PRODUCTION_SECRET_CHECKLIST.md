# iDream Production Secret Checklist

Updated: 2026-07-18

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
| `PIPELINE_API_TOKEN` | main-web, chat, gen | pipeline gateway |
| `AGE_VERIFY_API_KEY` | main-web | age gateway |
| `AGE_VERIFY_WEBHOOK_SECRET` | main-web | age gateway callback signer |
| `BTCPAY_WEBHOOK_SECRET` | main-web | BTCPay webhook signer |

## Shared Runtime Values

| Key | Notes |
| --- | --- |
| `APP_ENV=production` | Required by launch gate |
| `NODE_ENV=production` | Required by service runtime |
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
| `GEN_VIDEO_PROVIDER` | Keep `mock` while `video_gen=false`; set `pipeline` only when the video gateway is tested and video is enabled |
| `ADMIN_MODEL_DIAGNOSTICS_ENABLED` | Keep `false` for normal production Admin; set `true` only during engineering diagnostics |
| `ADMIN_MODEL_LIBRARY_DIR` | Optional diagnostics-only server-side model import directory |

## Chat Service Values

| Key | Notes |
| --- | --- |
| `CHAT_DATABASE_URL` | Request connection; must use the `chat_service` Postgres role |
| `CHAT_PROJECTOR_DATABASE_URL` | File-projector connection; must use the distinct `chat_projector` Postgres role and must not reuse the request credential |
| `CHAT_FS_ROOT` | Absolute durable-storage path; include it in the same recovery checkpoint as PostgreSQL and Blob |
| `CHAT_PORT` | Chat service HTTP/SSE port |
| `CHAT_MODEL_PROVIDER` | `pipeline` or another production model provider |
| `CHAT_MODEL_BASE_URL` | OpenAI-compatible chat gateway URL |
| `CHAT_MODEL_NAME` | Production chat model alias |
| `CHAT_MODEL_API_KEY` | Chat gateway token |
| `CHAT_MODERATION_PROVIDER` | Current product scope uses `mock`; service URL/API key are not required unless this changes |

## Pipeline and Voice Values

| Key | Notes |
| --- | --- |
| `PIPELINE_API_URL` | OpenAI-compatible chat or legacy image adapter URL; current image worker does not require 8091 |
| `PIPELINE_IMAGE_MODEL_DEFAULT` | Legacy pipeline image alias only; not the current backend model authority |
| `PIPELINE_CHAT_MODEL_DEFAULT` | Chat model alias exposed by pipeline |
| `PIPELINE_VIDEO_MODEL_DEFAULT` | Required only when video is launched |
| `PIPELINE_TIMEOUT_MS` | Image/chat timeout budget |
| `PIPELINE_VOICE_API_URL` | Explicit rollback voice gateway only |
| `PIPELINE_VOICE_API_TOKEN` | Explicit rollback voice gateway token only |
| `PIPELINE_VOICE_MODEL_DEFAULT` | Explicit rollback voice model alias only |
| `POCKET_TTS_API_URL` | Co-located Pocket TTS gateway, normally `http://127.0.0.1:8062/v1` |
| `POCKET_TTS_API_TOKEN` | Shared internal token used by Main and the Pocket TTS process |
| `POCKET_TTS_MODEL` | Pocket TTS model id, currently `kyutai/pocket-tts` |
| `HF_TOKEN` | Hugging Face token with accepted Pocket TTS clone-model access |

## Generation Worker Values

| Key | Notes |
| --- | --- |
| `GEN_IMAGE_PROVIDER` | `backend` for the current production worker |
| `COMFYUI_API_URL` | Workflow-native ComfyUI API; current local runtime is `http://127.0.0.1:8188` |
| `GEN_WORKFLOW_DIR` | Descriptor root; normally the deployed `packages/gen/workflows` directory |
| `GEN_VIDEO_PROVIDER` | Keep `mock` while `video_gen=false`; set `pipeline` only with tested video gateway |
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
| `AGE_VERIFY_LINK_BACK_URL` | Public HTTPS return URL |
| `AGE_VERIFY_CALLBACK_URL` | Public HTTPS webhook URL |

## Blob Storage Values

| Key | Notes |
| --- | --- |
| `BLOB_ENDPOINT` | R2/S3-compatible endpoint |
| `BLOB_BUCKET` | Private generated-media bucket |
| `BLOB_REGION` | `auto` for R2 or provider region |
| `BLOB_ACCESS_KEY_ID` | Object storage access key |
| `BLOB_SECRET_ACCESS_KEY` | Object storage secret |

## Backup And Restore Values

Treat these as one quiesced recovery checkpoint:

| Value | Requirement |
| --- | --- |
| Main PostgreSQL | Version-compatible dump plus migration count and restore verification |
| `CHAT_FS_ROOT` | Archive plus per-file manifest/checksum; contains canonical session, memory, relationship, and boundary state |
| Local `BLOB_ROOT` | Archive plus per-object manifest/checksum when `BLOB_PROVIDER=mock`; for R2/S3 bind the checkpoint to versioned object inventory instead |
| Checkpoint metadata | Quiesced timestamp, artifact ids, SHA-256 values, provider/root identifiers, and disposable-restore result |

Do not call a database-only dump a complete iDream backup. Stop writers and verify outbox/inbox, generation queues, and pending Chat file mutations are drained before capturing the three layers.

The 2026-07-18 controlled-beta checkpoint satisfies this local contract:

- Artifact base: `/Users/kk/code/idream/local-backups/idream-main-final-20260718-60/idream-main-final-20260718-60`; bundle directory mode `0700`, 23 files all mode `0600`, total size 171M, and all bundle SHA checks pass.
- Source snapshot: 60 migrations (latest `20260718012000`), 20 users, 16 characters / Releases / live Servings / active qualifications / media assets, 234 base tables, 7 views, and 1 sequence. Main outbox is `3,936` with zero pending/failed; Main inbound is `5,738` with zero received. Chat has 294 sessions / 818 messages / 4 attachments, outbox `1,552` and inbox `488` with zero pending/failed, and 5 file mutations with zero pending.
- `CHAT_FS_ROOT` is 429 files / 550,987 bytes. Local Blob is 13,634 files / 162,163,688 bytes, and Main/Gen resolve the same effective mock root.
- PostgreSQL client `18.3` restored against server `16.14`. Source-to-restore counts, schema, logical DB, Chat FS, and Blob comparisons all report zero difference; the disposable restore DB has zero remaining instances after cleanup.
- After restore, all 7 logical PM2 apps / 8 processes are online; Main/Admin HTTP return 200 and Chat health is `ok`.

This checkpoint closes local current-state recovery only. The automated proof was a same-cluster throwaway restore; the bundle includes role/database authority manifests and a fresh-cluster runbook, while role passwords and external secrets remain intentionally excluded and must come from the secret manager. It is post-incident evidence, not a pre-reset archive, and does not change public-production readiness from `NOT_EVALUATED`.

## Probe Report Variables

These must point at fresh reports before public launch:

| Key | Command that refreshes it |
| --- | --- |
| `WEB_SURFACE_PROBE_REPORT` | `bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe.json` |
| `PRODUCT_CONFIG_PROBE_REPORT` | `bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json` |
| `PUBLIC_CATALOG_PROBE_REPORT` | `bun run launch:probe:catalog -- --report .tmp/public-catalog-probe.json` |
| `CHAT_SERVICE_PROBE_REPORT` | `bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json` |
| `CHAT_MODEL_PROBE_REPORT` | `bun run launch:probe:chat -- --report .tmp/launch-chat-probe.json` |
| `PIPELINE_IMAGE_PROBE_REPORT` | `bun run launch:probe:image:local` |
| `VOICE_MODEL_PROBE_REPORT` | `bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json` |
| `PAYMENT_PROVIDER_PROBE_REPORT` | `bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json` |
| `AGE_VERIFICATION_PROBE_REPORT` | `bun run launch:probe:age -- --report .tmp/launch-age-probe.json` |
| `BLOB_STORAGE_PROBE_REPORT` | `bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json` |

## Final Gate

After all production values and probe reports are present:

```bash
bun run check:launch -- --launch-env-file .tmp/production-launch.env --json
```

Public launch remains red until this command passes against production-like services.
