# Voice Generation — Release Checklist

On-demand TTS for assistant chat turns. The full code path (API → billing → UI →
provider → launch gates) is implemented and tested. This checklist covers the steps
to take it from `mock` to a **publishable production** state.

## What ships in code (already done)

- **API** — `POST /api/v1/generation/voice` `{characterId, messageId, sessionId?, text}`
  → `{assetId, contentUrl, durationMs}`. Auth + age-gate + `voice_gen` flag +
  `voice_enabled` entitlement gated. Per-message cached (one clip per `messageId`).
- **Billing** — plan `voice_minutes` allowance is spent first (rolling 30-day window);
  overflow falls back to a per-clip Dreamcoin charge (`PricingRule` mode `voice`,
  default 2). Debit + asset write are atomic; concurrent double-clicks are de-duped.
- **Delivery / tone** — `VoiceModel.synthesize` carries a `tone` instruction; the first
  version sources a character-level default. Per-message emotion can be layered later.
- **UI** — play / loading / stop control on each assistant message in chat; 402 routes
  to upgrade.
- **Provider** — `PocketTtsVoiceModel` is the active product adapter and calls the
  co-located registry adapter on `8062`; that adapter forwards inference to oMLX
  `pocket-tts-4bit` on `8061`. Main rejects a healthy-but-legacy gateway without
  `runtime=omlx` and `acceleration=mlx`. `MockVoiceModel` remains for isolated tests and
  `PipelineVoiceModel` remains as an explicit rollback adapter.
- **Voice clone authority** — Admin Character Workspace → Voice uploads a reference,
  renders a preview, and creates a versioned candidate `CharacterVoiceProfile` without
  changing `Character.voiceId`. A separate publish-authority action activates the
  reviewed candidate, archives the previous active profile, updates the character
  pointer, and records Audit/Outbox evidence.
- **Launch gates** — `VOICE_PROVIDER` is a launch-critical provider: production refuses
  to start on `mock`, and `check:launch` requires a fresh live voice-model probe.

## Production cutover steps (ops)

1. **Prepare oMLX** — use oMLX Admin → Downloads to download
   `mlx-community/pocket-tts-4bit`; confirm `/v1/models` exposes
   `pocket-tts-4bit`.
2. **Start the adapter** — run the co-located Pocket TTS process from
   `ecosystem.config.js`. It exposes `/v1/audio/speech` plus the private voice registry,
   persists reference WAV + transcript manifests under `.data/pocket-tts/voices`,
   and forwards each request to oMLX.
3. **Set env** (see `packages/main/.env.production.example`):
   ```
   VOICE_PROVIDER=pocket-tts
   POCKET_TTS_API_URL=http://127.0.0.1:8062/v1
   POCKET_TTS_API_TOKEN=<shared-internal-token>
   POCKET_TTS_MODEL=pocket-tts-4bit
   POCKET_TTS_DEFAULT_VOICE_ID=alba
   POCKET_TTS_OMLX_API_URL=http://127.0.0.1:8061/v1
   POCKET_TTS_OMLX_API_TOKEN=<omlx-api-token>
   POCKET_TTS_OMLX_RUNTIME_VERSION=0.5.3
   VOICE_MODEL_PROBE_REPORT=.tmp/launch-voice-probe.json
   ```
4. **Seed / migrate data** — deploy Prisma migrations and run `db:seed` (or apply
   equivalently in prod) so `CharacterVoiceProfile`, the
   `voice_gen` feature flag, the `mode=voice` `PricingRule`, and the `voiceEnabled` /
   `voiceMinutes` plan features exist. Existing subscribers only gain voice after their
   plan features include `voiceEnabled` — reseed plans or edit them in the admin console.
5. **Clone and verify one character** — use Admin Character Workspace → Voice to create
   a candidate and confirm its preview plays while `Character.voiceId` remains unchanged.
   Then activate the reviewed candidate and confirm the profile is active and the
   character pointer matches its Pocket voice id. Unset characters continue to use the
   catalog default.
6. **Run the live probe**:
   ```
   bun run --filter @idream/main probe:voice -- --report .tmp/launch-voice-probe.json
   ```
   then `bun run check:launch` — `voice-model-live-probe` must confirm both playable
   WAV output and the clone→synthesize→delete path through oMLX.
7. **Flip the flag** — `voice_gen` ships enabled. To stage rollout, set it disabled in
   the admin console and enable when ready (kill-switch is the same flag).

## Tunable config

| Knob | Where | Default |
| --- | --- | --- |
| Voice on/off, rollout, target plans | `voice_gen` feature flag (admin) | enabled, premium+deluxe |
| Overflow price per clip | `PricingRule` mode `voice` (admin) | 2 Dreamcoins |
| Free minutes per plan | plan `voiceMinutes` feature | 30 / 120 / 360 / 1440 |
| Default delivery model | `POCKET_TTS_MODEL` | `pocket-tts-4bit` |
| Default catalog voice | `POCKET_TTS_DEFAULT_VOICE_ID` | `alba` |
| oMLX API | `POCKET_TTS_OMLX_API_URL` | `http://127.0.0.1:8061/v1` |
| Voice reference directory | `POCKET_TTS_VOICE_DIR` | `.data/pocket-tts/voices` |
| Signed-URL TTL for playback | `SIGNED_URL_TTL_SECONDS` | 900s |

## Known scope boundaries (intentional)

- Emotion is character-level for v1; per-message emotion tagging from the chat model is a
  follow-up (the `tone` field already carries it end-to-end).
- The play button is shown to all users and gates server-side via 402; no client-side
  entitlement pre-check.
- The oMLX runtime is Apple Silicon/macOS-only and Pocket TTS currently serves English.
- Voice states created by retired gateways must be recreated from their Admin reference
  audio; only reference WAV + manifest pairs are valid in the current registry.
