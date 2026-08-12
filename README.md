# iDream

iDream is an AI companion product monorepo. It contains the public web app, admin console, chat service, generation workers, shared contracts, provider adapters, launch probes, and product documentation.

Current launch status: **not public-launch ready yet**. Local product flows pass, but production launch is blocked until real chat, image/video/voice, payment, object storage, age verification, and observability providers are configured and probed. See:

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
| `fish-audio` | 8062 | Fish Audio voice gateway |
| `main-web` | 3000 | Public app and `/api/v1/*` (Next dev + Fast Refresh by default) |
| `admin-web` | 3001 | Admin console (Next dev + Fast Refresh by default) |
| `chat` | `CHAT_PORT` | Chat API/SSE |
| `gen-image` | n/a | Image worker |
| `gen-video` | n/a | Video worker |
| `gen-finalizer` | n/a | Main-side generation finalizer |
| `main-event-consumer` | n/a | Main-side event consumer |
| `admin-command-worker` | n/a | Admin durable command worker |

The default PM2 mode is development. It runs both web apps from source and
restarts source-backed services/workers when their relevant source trees change,
so normal development does not require a build:

```bash
bun run pm2:start
bun run pm2:restart
```

Use the repository wrapper after `.env`, Prisma Client, or other startup-level
changes; do not call `pm2 restart <name>` directly. To run immutable production
releases, build first and opt in explicitly:

```bash
bun run build
bun run pm2:start:production
```

Starting production over a development topology also goes through the wrapper's
launch, pause/drain, ownership, readiness, and resume gates:

```bash
bun run pm2:start:production
pm2 save
```

If the ownership gate reports a daemon orphan, use the auditable recovery path;
do not use `pkill -f` or manually guessed PIDs:

First run `bun run --cwd packages/main check:generation-cutover`. If it reports a
historical `ai.video.generate` failed residue, acknowledge that exact retained
row **before** quiescing. Otherwise quiesce pauses all Generation queues and then
times out waiting for the blocking residue instead of reaching the PM2 stop:

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
bun run check:generation-cutover # require ok=true and the row in ignoredHistory
cd ../..
```

Use the actual signed-in operator returned by `GET /api/v2/admin/bootstrap`, and
proceed only when that response includes `bootstrap.actor.id` and
`ops.deadletter.write` in `bootstrap.permissions`. The same human runs dry-run
and apply; a handoff requires a fresh dry-run. Outside the built-in development
wall, never substitute another person's, seed, or test identity. The development
login wall's `admin` shortcut maps to `seed-admin-user` only for local development;
it is not a production actor.
Acknowledgement writes only the Main command receipt and Admin audit and retains
the Bull row.

```bash
bun run generation:quiesce-for-orphan-recovery
bun run generation:plan-orphan-recovery > /secure/operator/gen-orphan-plan.json
bun run generation:apply-orphan-recovery -- \
  --plan-file /secure/operator/gen-orphan-plan.json \
  --confirmation '<exact confirmation from plan>'
```

The plan and apply commands both revalidate queue, database authority, PM2, OS
process-group, and Redis evidence. Apply only sends `SIGTERM` to the exact
fingerprinted orphan groups and leaves Generation queues paused; rerun the
normal wrapper to prove readiness and resume.

The wrapper intentionally refuses to replace a running production topology with
development. Do not bypass that refusal with `pm2 delete` or direct PM2 restart;
use the controlled teardown procedure in the operations runbook. Ordinary
development source changes do not need a mode switch. `bun run pm2:stop` is also
gated: it drains Generation, proves quiescent ownership, stops voice last, and
leaves the Generation queues paused for the next controlled start.

## Image Generation

Product services do not load `.safetensors` directly. Image generation runs through the workflow-native backend abstraction (`packages/gen/src/backend/`):

```text
main-web / packages/gen
  -> GEN_IMAGE_PROVIDER=backend
  -> BackendRegistry (workflow descriptors under GEN_WORKFLOW_DIR)
  -> ComfyUIBackend -> COMFYUI_API_URL -> ComfyUI server -> model files
  -> SdcppBackend   -> SDCPP_CLI       -> sd-cli process -> model files
  -> DrawThingsBackend -> DRAWTHINGS_CLI -> draw-things-cli -> model files
```

Each workflow descriptor (`packages/gen/workflows/*.json`) declares its `backendKind` (`comfyui`, `sdcpp`, or `drawthings`), the model files it binds, and its input slots — adding a model is "drop a descriptor," not new wiring code. For a local end-to-end smoke against a selected live backend, run `bun run --filter @idream/gen smoke:backend`.

`GEN_IMAGE_PROVIDER=pipeline` (an external OpenAI-compatible gateway reached via `PIPELINE_API_URL`) still exists but is deprecated in favor of `backend`.

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
```

Run the final direct gate:

```bash
bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env
```

`LAUNCH_SCOPE=full` is the default. A release that explicitly excludes Billing
and Age Verification may use `LAUNCH_SCOPE=core`; no other checks are omitted,
and unknown scope values fail closed. The final selected gate must pass with real
production values before public launch. The local `.tmp/launch-probe-only.env`
file is only a diagnostic input; it intentionally keeps real external providers
unconfigured and currently fails on those production dependencies.

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
