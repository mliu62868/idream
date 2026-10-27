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
| `asr` | 8064 | Optional resident MLX Whisper speech input |
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

For an unresponsive local Main/Admin listener, `bun run probe:web-orphan`
collects a redacted macOS process-group and socket snapshot. It is read-only:
successful collection does not establish ownership or prove that Web requests
have drained, and it does not authorize a signal. The Generation orphan
recovery below does not recover Web or voice listeners.

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

Chat embeds Pi `1.3.0` (`pi-ai`, `pi-durable`, and `chord`) and calls the
provider-neutral igrep `0.1.161` CLI. Install workspace dependencies, then verify
the pinned packages, public Pi API, and CLI surface:

```bash
bun run pi-companion:setup
bun run pi-companion:check
bun run test:pi-gate
```

Each attempt owns a fresh Pi `MemoryStorage` conversation. This storage is
process-local: restart recovery uses Main's immutable snapshot and the existing
AgentRun input/proposal protocol. A saved proposal, including historical runtime
attribution, is replayed exactly without another model request. There is no Pi
session database or persistent inbox. Tools execute sequentially; model retries
and background compaction are disabled.

Main's committed Turns own long-term memory. Chat alone invokes official
`mem ingest`, `maintain`, `wake`, `reproject`, and the neutral memory JSON API.
Normal execution exposes read-only `memory_search`; normal and private attempts
can use explicitly configured `igrep_web_search`, search their authorized snapshot,
and recall original evicted messages with
`session_recall`. Pi performs context compaction. The host binds Main seed and
omitted originals plus public Pi entries/contributions to stable attempt-scoped
IDs, preserving speaker identity and UTF-8 bytes. Exact ID reads return stored
originals; query recall uses public igrep JSONL search in `ultra` mode. Summaries,
system instructions, reasoning, and recall's own output cannot become original
user evidence. Current Scene, preferences and the user request are reprojected
from the immutable Turn at each provider request. When the same recall projection
contains omitted originals, a context notice makes that gap explicit without
exposing their text or forcing a retrieval. This includes Main history that Pi
never received and therefore could not include in its summary.

Every physical model request, including compaction, contributes its raw provider
usage receipt. Missing receipts keep usage unknown; a missing reasoning subtotal
stays null while known prompt/completion totals remain usable. Reasoning is already
included in completion totals and is never added again.
Companion generation enables hidden reasoning on the configured Ornith 8-bit model.
Its reasoning and answer share the prepared model output budget; Quick's 256-token
answer setting must not cap that combined request. Reply length remains a product
preference: this provider has no independent hard cap for visible tokens while
thinking is enabled. Compaction, structured extraction, warmup and igrep helpers
keep reasoning disabled. Tool choice remains automatic; unfinished reasoning is
never force-closed into a user reply.
The responding Character's history stays in the assistant role; other Characters'
ordinary lines use the incoming user role with their speaker name. Original Main
roles and speaker identities remain unchanged in the recall archive. Per-turn context ends at an
explicit boundary before the current user message so recalled questions are not
treated as new requests. Verified resident profile lines use this same context
boundary, including any historical user instructions they quote; only the static
memory policy enters the system prompt. Empty output at the token limit is a
classified failure, and content-free physical usage receipts remain in the local
AgentRun journal even if no terminal candidate can be committed. All helper LLM/ASK/final-sort,
embedding and rerank routes are explicitly bound or disabled; shared caches and
ambient credentials are excluded. Private execution does not read or write
cross-session memory. Attempt-local Pi state and workspace copies are discarded
on teardown; startup retains the narrowly scoped cleanup of orphaned historical
DSH recall directories.

Canonical igrep source/session bytes and the existing `deepseek-harness` intake
and backup format remain unchanged. Projection verifies searchable dialogue and
role-bearing session sources against Main. The dialogue v3 transport is decoded
strictly; only structured date insertions may accompany unchanged source text.
Each normal attempt runs zero-model `mem reproject` on its owned copy before
wake/recall; incomplete recall warnings fail rather than certify empty memory.

The setup commands certify installed surfaces only. Full Chat readiness also
executes real provider warmup, memory lifecycle/isolation, empty and populated
rebuilds, and production Pi compaction/recall/tool bridges with controlled model
responses. Release qualification still requires same-revision real journeys.
Apply running-process updates through the controlled PM2 wrapper above. The
existing `chat-runtime:cutover` command migrates local `DSH_*` settings to `PI_*`
while preserving configured memory roots and retiring plugin/bootstrap paths.

## Default Speech Runtime

Ming 3.0 0.5B MLX 8-bit provides the default speech runtime. Its existing
`fish-audio` provider name, reference registry and erasure contract stay stable.
Pocket TTS remains available for existing Character catalog identities.

```bash
bun run voice:ming:install
bun run test:voice:ming
```

Set `VOICE_PROVIDER=fish-audio`, `FISH_AUDIO_MODEL=ming-3.0-tts-0.5b-8bit`,
`FISH_AUDIO_MODEL_PATH` and `FISH_AUDIO_CAMPLUS_MODEL_PATH` in Main's environment.
Configure a verified adult reference WAV and exact transcript using
`FISH_AUDIO_SYSTEM_REFERENCE_AUDIO` / `FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST`, or
set `FISH_AUDIO_DEFAULT_VOICE_ID` to an existing registry identity. After pending
voice work has settled, apply the configuration with `bun run pm2:restart` and
save the matching system voice in Admin. Runtime restarts load only local assets.

Ming uses the full reference for CAM++ speaker conditioning and structured
emotion/speed/volume captions. A verified short acoustic prompt can be recorded
as `ming_prompt` in the reference manifest, with `reference_sha256`, `start_s`,
`end_s` and exact `ref_text`; unverified automatic cropping is not used. The
sampler is fixed at CFG 2, temperature 0 and 10 steps. Breeze's token sampling
controls do not apply. Long text is split within Ming's conditioning budget.

For reproducible Breeze comparisons, its separate hashed environment remains
available through `bun run voice:fish:install` and the explicit
`FISH_AUDIO_MODEL=breeze-tts-2-mlx-8bit` setting. A gateway runs one model at a
time; old-model idempotency requests may replay exact cached audio but cannot
silently regenerate with the current model.

Active Character voice versions pin both the reference identity and model.
When changing the runtime model, prepare a new version from the same reference,
verify its preview, then activate it. Keep the archived profile, original registry
reference, cached audio and VoiceClipRequest facts for historical playback.
Retired Fish S2 Pro requests can only replay their exact completed cache entry.

## Chat Voice Input

Single and group chats support English dictation into an editable draft. Click the
microphone, record for up to 60 seconds, select Done, review the text, then Send.
Transcription does not create a Turn or consume messages, Dreamcoins, or TTS
minutes. Existing drafts are appended; changed drafts or group recipients require
confirmation. Cancel, leaving the page, and account changes revoke delivery and
release microphone tracks. Backgrounding stops capture and asks whether to
transcribe the clip. Retry audio and server-side candidates expire from memory within two minutes;
no recording is stored in the product database or media storage.

Enable in `packages/main/.env` (production uses the secret manager):

```dotenv
ASR_PROVIDER=mlx-whisper
ASR_API_URL=http://127.0.0.1:8064
ASR_API_TOKEN=<random-private-token>
```

On Apple Silicon with Metal, install `uv` and `ffmpeg`, then prepare the hashed dependencies and fixed model
snapshot before starting through the controlled PM2 wrapper:

```bash
bun run voice:asr:install
bun run test:voice:asr
bun run pm2:restart
```

The optional process runs one offline Metal worker with float16 weights, a private
Bearer token, and readiness checks for `mlx-whisper==0.4.3`,
`mlx-community/whisper-large-v3-mlx`, and model revision
`49e6aa286ad60c14352c404340ded53710378a11`. Greedy English decoding uses no prompt,
hotword substitutions, or context from previous recordings. Configure an internal URL reachable by
Main and keep port 8064 private. Limit each recording to 8 MiB; decoded audio is
also bounded to 60 seconds. All Main instances share the gateway's per-user
admission (one active request, ten new requests/minute), one inference slot, four
queue positions, a two-second queue wait, and a thirty-second execution deadline.
Cancellation suppresses delivery immediately but retains the inference slot until
native execution returns. Temporary decoded files are removed after native
execution; results are memory-only and fetched candidates are deleted.

For an existing Parakeet deployment, replace `ASR_PROVIDER=parakeet-redux` with
`mlx-whisper`, rename `PARAKEET_ASR_API_URL/TOKEN` to `ASR_API_URL/TOKEN`, and remove
`PARAKEET_ASR_DEVICE`. Optional host, port, and temporary-directory variables now
use `ASR_HOST`, `ASR_PORT`, and `ASR_TEMP_DIR`. The controlled PM2 restart checks
that the old gateway has no active transcription before retiring `parakeet-asr`
and starting `asr`; do not restart the old process directly. The model files are
about 3.08 GB and GPU contention must be included in real Call qualification.

Frozen controlled audio can be checked through the actual gateway decode and
inference path with `bun run probe:voice:asr regress --manifest <manifest.json>
--output <new-result.json>`. Each manifest row supplies `id`, `path`, `sha256`,
`reference`, and optional `critical_tokens` / `forbidden_tokens`. References only
score results; they are never sent to the model. Critical-word failures and empty
speech results fail independently of the aggregate WER. The output is never
overwritten, and partial runs remain marked `incomplete`.

ASR for voice input and calls supports English only (`en`). TTS language support
remains provider-specific. The resident ASR model's broader language capability
does not expand the product's supported languages.
A supported recording browser and HTTPS (or localhost)
are required. Unsupported providers leave the microphone entry hidden; configured
but unavailable models show a disabled entry with a retry availability action.

The [ASR regression report](.scratch/asr-cup-cop-2026-10-25/REPORT.md) records the
preserved failures, controlled model comparison, and real Voice Call delivery and
billing checks for this runtime. The small human-speech corpus improved overall
but includes one additional word error in its held-out subset. It does not certify
real whispers, natural noise, physical mobile microphones, or human listening quality.

## Image Generation

Product services do not load `.safetensors` directly. Image generation runs through the workflow-native backend abstraction (`packages/gen/src/backend/`):

```text
main-web / packages/gen
  -> GEN_IMAGE_PROVIDER=backend
  -> BackendRegistry (workflow descriptors under GEN_WORKFLOW_DIR)
  -> ComfyUIBackend -> COMFYUI_IMAGE_API_URL / COMFYUI_VIDEO_API_URL
     -> isolated ComfyUI runners -> shared model files
  -> DrawThingsBackend -> DRAWTHINGS_CLI -> draw-things-cli -> model files
```

Each workflow descriptor (`packages/gen/workflows/*.json`) declares its `backendKind` (`comfyui` or `drawthings`), the model files it binds, and its input slots — adding a model is "drop a descriptor," not new wiring code. For a local end-to-end smoke against a selected live backend, run `bun run --filter @idream/gen smoke:backend`.

The retired `pipeline`, `mlx`, and `external` runner values are invalid. Use `GEN_IMAGE_PROVIDER=backend` with a workflow-native backend.

## Launch Checks

Generate production secrets:

```bash
bun run --silent launch:secrets
```

Check cold-start preparation before collecting runtime evidence:

```bash
bun run launch:prepare:runtime -- \
  --launch-env-file .tmp/production-launch.env \
  --admin-env-file .tmp/production-admin.env \
  --chat-env-file .tmp/production-chat.env \
  --gen-env-file .tmp/production-gen.env \
  --report .tmp/runtime-preparation.json --json
```

Use the actual four service files. This read-only stage checks configuration,
source, database authority, pins and recovery preparation; its report always has
`ok=false` and `launchQualified=false`. A zero exit code means `prepared=true`,
which never replaces `check:launch`. A first production target still needs a
verified restricted bootstrap; the current wrapper has no such action.

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
Pi runtime, igrep, Chat commit authority, and tool bridge, so it is deliberately
excluded from launch readiness.

Run the final direct gate:

```bash
bun run check:launch -- --launch-env-file .tmp/production-launch.env --admin-env-file .tmp/production-admin.env --chat-env-file .tmp/production-chat.env --gen-env-file .tmp/production-gen.env
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
