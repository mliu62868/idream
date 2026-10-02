# iDream

iDream is an 18+ AI roleplay and AI companion platform built for complete product parity with [OurDream.ai](https://ourdream.ai/). The target covers Explore, the full multi-step creator, Chat, image/video/voice generation, My AI/Profile, Feed/Community/creator economy, paid access, Affiliate, support, and public content surfaces. This monorepo contains the public web app, admin console, Chat execution service, generation workers, shared contracts, provider adapters, launch probes, and product documentation. OurDream defines the product-completeness benchmark; [the PRD](docs/product/PRD.md), iDream source code, and same-revision evidence define our exact contract and current state.

Current launch status: **not public-launch ready yet**. Group Chat, opt-in proactive messages, Advanced seed/model controls, Comics, the independent Coin Store, and published Affiliate terms/application/dashboard UI have implementations; their complete journeys and release qualification remain separate work. Existing local journeys have controlled evidence, but complete OurDream parity still requires a dated feature-by-feature matrix, remaining features such as purchasable Packs and creator/affiliate settlement, and same-revision quality, real-payment, public-content, provider/storage/capacity/observability evidence. Chat Video has a separately gated implementation and still needs its own real journey qualification. The complete multi-step Create flow and all My AI core tabs remain first-class targets; Quick Start is only an optional prefill. WPCU remains the official North Star, so no WSCU Metric Registry cutover is pending. 文档总入口见 [`docs/README.md`](docs/README.md)。See:

- [Current functional coverage](docs/product/CURRENT_FUNCTIONAL_COVERAGE.md)
- [OurDream public parity snapshot (2026-09-01)](docs/research/OURDREAM_PRODUCT_PARITY_SNAPSHOT_2026-09-01.md)
- [Remaining work](docs/product/REMAINING_WORK_EXECUTION_PLAN.md)
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
| `packages/chat` | AgentRun execution/SSE service with local recovery evidence; no product database |
| `packages/gen` | Image/video workers and workflow-native backends |
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
| `parakeet-asr` | 8064 | Optional resident Parakeet Redux speech input |
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

## Chat Runtime

Chat embeds DSH `0.2.0-rc.2` and the official igrep plugin. After updating the
system igrep CLI, refresh its dedicated profiles and verify the installed code:

```bash
bun run dsh-companion:setup
bun run dsh-companion:check
```

Main's committed Turns own memory. Chat projects them through official igrep
ingest/maintain, reads wake once before the first model request, and uses fast
recall plus the read-only `memory_search` tool. Plugin auto-ingest, auto-wake,
maintenance timers, and session archives are disabled. Private execution exposes
neither memory nor session recall. Bootstrap compares the shipped and installed
JavaScript because the plugin package version can stay `0.1.0` across CLI releases.
For igrep `0.1.150`, projection verifies both searchable `[timestamp, content]`
dialogue tuples and the separate role-bearing session sources against Main.
The dialogue v3 transport is decoded strictly; only structured date insertions
may accompany the unchanged source text. Canonical session text, roles and
timestamps must still match Main exactly. This does not certify the semantic
correctness of igrep's relative-date interpretation.
Each normal attempt runs official zero-model `mem reproject` on its owned copy
before wake/recall, restoring source-file witnesses changed by copying. Incomplete
recall warnings fail the attempt; they cannot masquerade as an empty memory.
Full runtime certification exercises both empty and populated rebuilds.
Apply a running-process update through the controlled PM2 wrapper described above.

## Chat Voice Input

Single and group chats support dictation into an editable draft. Click the
microphone, record for up to 60 seconds, select Done, review the text, then Send.
Transcription does not create a Turn or consume messages, Dreamcoins, or TTS
minutes. Existing drafts are appended; changed drafts or group recipients require
confirmation. Cancel, leaving the page, and account changes revoke delivery and
release microphone tracks. Backgrounding stops capture and asks whether to
transcribe the clip. Retry audio and server-side candidates expire from memory within two minutes;
no recording is stored in the product database or media storage.

Enable in `packages/main/.env` (production uses the secret manager):

```dotenv
ASR_PROVIDER=parakeet-redux
PARAKEET_ASR_API_URL=http://127.0.0.1:8064
PARAKEET_ASR_API_TOKEN=<random-private-token>
```

Install `uv` and `ffmpeg`, then prepare the hashed dependencies and fixed model
snapshot before starting through the controlled PM2 wrapper:

```bash
bun run voice:asr:install
bun run test:voice:asr
bun run pm2:restart
```

The optional process runs one offline CPU Photon worker, with a private Bearer
token and readiness checks for `moondream==2.6.1` and model revision
`2bf128600aac4b16946f7ed8372e56117fe5e23b`. Configure an internal URL reachable by
Main and keep port 8064 private. Limit each recording to 8 MiB; decoded audio is
also bounded to 60 seconds. All Main instances share the gateway's per-user
admission (one active request, ten new requests/minute), one inference slot, four
queue positions, a two-second queue wait, and a thirty-second execution deadline.
Cancellation suppresses delivery immediately but retains the inference slot until
native execution returns. Temporary decoded files are removed after native
execution; results are memory-only and fetched candidates are deleted.

Supported language codes: `bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt
ro ru sk sl es sv uk`. This list does not imply every European language or equal
accuracy across languages. A supported recording browser and HTTPS (or localhost)
are required. Unsupported providers leave the microphone entry hidden; configured
but unavailable models show a disabled entry with a retry availability action.

Photon 2.6.1 attempts to send periodic runtime usage metadata to Moondream (model, hardware,
hostname and request/token counts); its reporter has no documented off switch.
The gateway sends no audio/text to cloud inference, but offline Hugging Face flags
do not disable Photon usage telemetry. Deployments requiring no outbound metadata
must enforce egress policy and verify it separately. Public read-speech evaluation
does not certify real whispers, natural noise, or physical mobile microphones;
see the [qualification report](.scratch/chat-voice-input/qualification/REPORT.md)
for measured coverage before rollout.

## Image Generation

Product services do not load `.safetensors` directly. Image generation runs through the workflow-native backend abstraction (`packages/gen/src/backend/`):

```text
main-web / packages/gen
  -> GEN_IMAGE_PROVIDER=backend
  -> BackendRegistry (workflow descriptors under GEN_WORKFLOW_DIR)
  -> ComfyUIBackend -> COMFYUI_IMAGE_API_URL / COMFYUI_VIDEO_API_URL
     -> isolated ComfyUI runners -> shared model files
  -> SdcppBackend   -> SDCPP_CLI       -> sd-cli process -> model files
  -> DrawThingsBackend -> DRAWTHINGS_CLI -> draw-things-cli -> model files
```

Each workflow descriptor (`packages/gen/workflows/*.json`) declares its `backendKind` (`comfyui`, `sdcpp`, or `drawthings`), the model files it binds, and its input slots — adding a model is "drop a descriptor," not new wiring code. For a local end-to-end smoke against a selected live backend, run `bun run --filter @idream/gen smoke:backend`.

The retired `pipeline`, `mlx`, and `external` runner values are invalid. Use `GEN_IMAGE_PROVIDER=backend` with a workflow-native backend.

## Launch Checks

Generate production secrets:

```bash
bun run --silent launch:secrets
```

Run launch probes:

```bash
bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe.json
bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json
bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json
bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json
bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json
bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json
bun run launch:probe:age -- --report .tmp/launch-age-probe.json
```

`bun run diagnose:chat-provider -- --report .tmp/chat-provider-diagnostic.json`
is an optional raw OpenAI-compatible transport diagnostic. It bypasses the embedded
DSH runtime, igrep, Chat commit authority, and tool bridge, so it is deliberately
excluded from launch readiness.

Run the final direct gate:

```bash
bun run check:launch -- --launch-env-file .tmp/production-launch.env
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
