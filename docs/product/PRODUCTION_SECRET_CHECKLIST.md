# iDream Production Secret Checklist

Updated: 2026-06-30

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
| `IMAGE_PROVIDER` | Main-web production image adapter; use `pipeline` so in-process jobs cannot fall back to mock assets |
| `VOICE_PROVIDER` | Production adapter value expected by launch gate |
| `MODERATION_PROVIDER` | Current product scope uses `mock`; change only if the product config explicitly changes |
| `PAYMENT_PROVIDER` | Production adapter value expected by launch gate |
| `BLOB_PROVIDER` | Production adapter value expected by launch gate |
| `AGE_VERIFICATION_PROVIDER` | Production adapter value expected by launch gate |
| `GEN_IMAGE_PROVIDER` | Generation worker image adapter; `pipeline` for the current architecture |
| `GEN_VIDEO_PROVIDER` | Keep `mock` while `video_gen=false`; set `pipeline` only when the video gateway is tested and video is enabled |
| `ADMIN_MODEL_DIAGNOSTICS_ENABLED` | Keep `false` for normal production Admin; set `true` only during engineering diagnostics |
| `ADMIN_MODEL_LIBRARY_DIR` | Optional diagnostics-only server-side model import directory |

## Chat Service Values

| Key | Notes |
| --- | --- |
| `CHAT_DATABASE_URL` | Must use the `chat_service` Postgres role |
| `CHAT_FS_ROOT` | Absolute durable-storage path |
| `CHAT_PORT` | Chat service HTTP/SSE port |
| `CHAT_MODEL_PROVIDER` | `pipeline` or another production model provider |
| `CHAT_MODEL_BASE_URL` | OpenAI-compatible chat gateway URL |
| `CHAT_MODEL_NAME` | Production chat model alias |
| `CHAT_MODEL_API_KEY` | Chat gateway token |
| `CHAT_MODERATION_PROVIDER` | Current product scope uses `mock`; service URL/API key are not required unless this changes |

## Pipeline Values

| Key | Notes |
| --- | --- |
| `PIPELINE_API_URL` | Stable OpenAI-compatible image/chat gateway |
| `PIPELINE_VOICE_API_URL` | OpenAI-compatible voice gateway |
| `PIPELINE_IMAGE_MODEL_DEFAULT` | Current local alias: `pornmaster-zimage-turbo` |
| `PIPELINE_CHAT_MODEL_DEFAULT` | Chat model alias exposed by pipeline |
| `PIPELINE_VOICE_MODEL_DEFAULT` | Voice model alias exposed by voice gateway |
| `PIPELINE_VIDEO_MODEL_DEFAULT` | Required only when video is launched |
| `PIPELINE_TIMEOUT_MS` | Image/chat timeout budget |
| `PIPELINE_VOICE_TIMEOUT_MS` | Voice timeout budget |

## Generation Worker Values

| Key | Notes |
| --- | --- |
| `GEN_IMAGE_PROVIDER` | `pipeline` |
| `GEN_VIDEO_PROVIDER` | Keep `mock` while `video_gen=false`; set `pipeline` only with tested video gateway |
| `GEN_MODERATION_PROVIDER` | Current product scope uses `mock`; service URL/API key are not required unless this changes |
| `PIPELINE_IMAGE_SIZE_DEFAULT` | Production default image size |
| `GEN_BLOB_PROVIDER` | Must match main-web object storage |

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

## Probe Report Variables

These must point at fresh reports before public launch:

| Key | Command that refreshes it |
| --- | --- |
| `WEB_SURFACE_PROBE_REPORT` | `bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe.json` |
| `PRODUCT_CONFIG_PROBE_REPORT` | `bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json` |
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
