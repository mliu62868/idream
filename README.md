# iDream

iDream is an AI companion product monorepo. It contains the public web app, admin console, chat service, generation workers, shared contracts, provider adapters, launch probes, and product documentation.

Current launch status: **not public-launch ready yet**. Local product flows pass, but production launch is blocked until real chat, moderation, payment, object storage, age verification, and observability providers are configured and probed. See:

- [Current functional coverage](docs/product/CURRENT_FUNCTIONAL_COVERAGE.md)
- [Launch readiness audit](docs/product/LAUNCH_READINESS_AUDIT.md)
- [Operations runbook](docs/architecture/10-operations.md)

## Stack

- Next.js 16, React 19, TypeScript strict
- Tailwind CSS v4
- Prisma 7
- BullMQ + Redis
- Postgres for production-like tests
- Playwright E2E
- PM2 self-hosted process topology

## Packages

| Package | Purpose |
| --- | --- |
| `packages/main` | Public product app, API/BFF, auth, billing, admin API, finalizer |
| `packages/admin` | Admin web console on port 3001 |
| `packages/chat` | Split chat API/SSE service and chat storage |
| `packages/gen` | Image/video generation workers and pipeline adapters |
| `packages/shared` | Cross-service contracts, media/storage/moderation helpers |

## Common Commands

```bash
bun install
bun run dev
bun run dev:admin
bun run build
bun run test
bun run check
bun run pm2:start
bun run pm2:status
```

Useful package-level commands:

```bash
bun run --filter @idream/main test
bun run --filter @idream/main test:e2e
bun run --filter @idream/main db:push
bun run --filter @idream/main db:seed
bun run --filter @idream/chat test
bun run --filter @idream/gen test
```

## Local Services

PM2 starts the product topology from `ecosystem.config.js`:

| PM2 app | Default port | Description |
| --- | --- | --- |
| `main-web` | 3000 | Public app and `/api/v1/*` |
| `admin-web` | 3001 | Admin console |
| `chat` | `CHAT_PORT` | Chat API/SSE |
| `gen-image` | n/a | Image worker |
| `gen-video` | n/a | Video worker |
| `gen-finalizer` | n/a | Main-side generation finalizer |
| `main-event-consumer` | n/a | Main-side event consumer |
| `sdcpp-image` | 8091 | Local OpenAI-compatible image gateway wrapper |

After `bun run build`, restart web processes before browser verification:

```bash
pm2 restart main-web admin-web
```

## Image Generation

Product services do not load `.safetensors` directly and do not call sd.cpp directly. The product boundary is the OpenAI-compatible pipeline gateway:

```text
main-web / packages/gen
  -> GEN_IMAGE_PROVIDER=pipeline
  -> PIPELINE_API_URL
  -> pipeline gateway
  -> optional local sd.cpp runner
  -> model files
```

For local image smoke, the current runner can wrap:

```text
~/Downloads/pornmasterZImage_turboV35Bf16.safetensors
```

behind `sdcpp-image`, while product code only sees `PIPELINE_API_URL`, `PIPELINE_API_TOKEN`, and model alias `pornmaster-zimage-turbo`.

`sdcpp-image` defaults to `/Users/kk/Downloads/pornmasterZImage_turboV35Bf16.safetensors` as `SDCPP_SOURCE_MODEL`. If the runner needs a converted artifact, set `SDCPP_CONVERTED_DIFFUSION_MODEL` or `SDCPP_DIFFUSION_MODEL`; keep `SDCPP_SOURCE_MODEL` pointed at the original safetensors so model provenance remains explicit.

## Launch Checks

Generate production secrets:

```bash
bun run --silent launch:secrets
```

Run launch probes:

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
```

Run the final direct gate:

```bash
bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env
```

The final gate must pass with real production values before public launch. The local `.tmp/launch-probe-only.env` file is only a diagnostic input; it intentionally keeps real external providers unconfigured and currently fails on those production dependencies.

## Production Env Templates

Start from these templates and move filled values into a secret manager:

- `packages/main/.env.production.example`
- `packages/chat/.env.production.example`
- `packages/gen/.env.production.example`

Do not commit filled production env files.

## Verification Evidence

The current E2E coverage includes:

- age gate
- signup/session
- Explore search/filter/pagination
- character detail
- Create -> My AI
- chat send/persist/report
- image/video generation
- Upgrade entitlement and dreamcoins
- community dreamers/report
- profile settings/redeem/referral/language/media/account deletion
- public route smoke
- admin web and admin API

See [Current functional coverage](docs/product/CURRENT_FUNCTIONAL_COVERAGE.md) for the full map.

## Agent Notes

Project-specific agent instructions live in `AGENTS.md`. This repo uses Next.js 16, so read the local Next docs in `node_modules/next/dist/docs/` before making framework-sensitive changes.
