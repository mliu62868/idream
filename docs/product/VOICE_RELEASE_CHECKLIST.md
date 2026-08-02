# Voice Generation — Release Checklist

On-demand TTS for assistant chat turns. The full code path (API → billing → UI →
provider → launch gates) is implemented and tested. This checklist covers the steps
to take it from `mock` to a **publishable production** state.

## What ships in code (already done)

- **API** — `POST /api/v1/generation/voice`
  `{characterId, messageId, sessionId?, text, intent: "prewarm" | "play"}`
  → `{assetId, contentUrl, durationMs}`. Auth + age-gate + `voice_gen` flag +
  `voice_enabled` entitlement gated. Per-message cached (one clip per `messageId`).
- **Chat delivery** — each completed assistant turn prewarms its clip in the
  background without delaying text. Prewarm uses included `voice_minutes` only and
  never spends Dreamcoins automatically; explicit Play reuses the cache and retains
  the existing overflow-price path when the allowance is exhausted.
- **Billing** — plan `voice_minutes` allowance is spent first (rolling 30-day window);
  overflow falls back to a per-clip Dreamcoin charge (`PricingRule` mode `voice`,
  default 2). Debit + asset write are atomic; concurrent double-clicks are de-duped.
- **Delivery / tone** — the `VoiceClipPort.synthesize` authority carries the character tone plus a
  persisted Fish delivery contract: preset, intensity, speed, temperature, top-p,
  top-k, and repetition penalty.
- **UI** — play / loading / stop control on each assistant message in chat; 402 routes
  to upgrade.
- **Provider** — `FishAudioVoiceModel` is the active product adapter and calls the
  resident Fish Audio S2 Pro process on `8062`. It uses oMLX's bundled `mlx-audio`
  runtime and the downloaded `fish-audio-s2-pro-8bit` weights directly. Main requires
  `runtime=mlx_audio`, `model_loaded=true`, `acceleration=mlx`, and
  `system_voice_ready=true`; a missing system reference returns HTTP 503.
  Pocket TTS and Pipeline remain explicit rollback adapters.
- **Voice clone authority** — Admin Character Workspace → Voice uploads a reference,
  renders a preview, and creates a versioned candidate `CharacterVoiceProfile` without
  changing `Character.voiceId`. A separate publish-authority action activates the
  reviewed candidate, archives the previous active profile, updates the character
  pointer, and records Audit/Outbox evidence.
- **Durable recovery** — `VoiceClipRequest` persists immutable synthesis and provider
  authority. Character operations can reclaim only an expired running lease; takeover
  keeps the same provider idempotency key and records the operator command and audit
  evidence. `VoiceIdentityPort` separately owns preview/clone/delete/runtime inspection.
- **Launch gates** — `VOICE_PROVIDER` is a launch-critical provider: production refuses
  to start on `mock`, and `check:launch` requires a fresh live voice-model probe.

## Production cutover steps (ops)

1. **Prepare the model** — use oMLX Admin → Downloads to download
   `mlx-community/fish-audio-s2-pro-8bit` and verify the model and codec weights.
2. **Prepare the system female identity** — import a reviewed WAV and exact
   transcript manifest without overwriting an existing authority:
   ```
   bun run voice:fish:prepare-system -- \
     --audio /voices/curated-adult-female-reference.wav \
     --manifest /voices/curated-adult-female-reference.json
   ```
3. **Start the runtime** — remove the retired `pocket-tts` PM2 process, then run
   `fish-audio` from `ecosystem.config.js`. It exposes
   `/v1/audio/speech` plus the private voice registry and persists reference WAV +
   transcript manifests under `.data/fish-audio/voices`.
4. **Set env** (see `packages/main/.env.production.example`):
   ```
   VOICE_PROVIDER=fish-audio
   FISH_AUDIO_API_URL=http://127.0.0.1:8062/v1
   FISH_AUDIO_API_TOKEN=<shared-internal-token>
   FISH_AUDIO_MODEL=fish-audio-s2-pro-8bit
   FISH_AUDIO_MODEL_PATH=/models/mlx-community/fish-audio-s2-pro-8bit
   FISH_AUDIO_DEFAULT_VOICE_ID=fish-female-default
   FISH_AUDIO_SYSTEM_REFERENCE_AUDIO=/voices/curated-adult-female-reference.wav
   FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST=/voices/curated-adult-female-reference.json
   VOICE_MODEL_PROBE_REPORT=.tmp/launch-voice-probe.json
   ```
5. **Seed / migrate data** — deploy Prisma migrations and run `db:seed` (or apply
   equivalently in prod) so `CharacterVoiceProfile`, the
   `voice_gen` feature flag, the `mode=voice` `PricingRule`, and the `voiceEnabled` /
   `voiceMinutes` plan features exist. Existing subscribers only gain voice after their
   plan features include `voiceEnabled` — reseed plans or edit them in the admin console.
6. **Clone and verify one character** — use Admin Character Workspace → Voice to create
   a candidate and confirm its preview plays while `Character.voiceId` remains unchanged.
   Then activate the reviewed candidate and confirm the profile is active and the
   character pointer matches its Fish voice id and its persisted delivery settings.
   Unset characters continue to use the configured adult female system direction.
7. **Run the live probe**:
   ```
   bun run --filter @idream/main probe:voice -- --report .tmp/launch-voice-probe.json
   ```
   then `bun run check:launch` — `voice-model-live-probe` must confirm both playable
   WAV output and the clone→synthesize→delete path through the resident MLX runtime.
8. **Flip the flag** — `voice_gen` ships enabled. To stage rollout, set it disabled in
   the admin console and enable when ready (kill-switch is the same flag).

## Tunable config

| Knob | Where | Default |
| --- | --- | --- |
| Voice on/off, rollout, target plans | `voice_gen` feature flag (admin) | enabled, premium+deluxe |
| Overflow price per clip | `PricingRule` mode `voice` (admin) | 2 Dreamcoins |
| Free minutes per plan | plan `voiceMinutes` feature | 30 / 120 / 360 / 1440 |
| Default delivery model | `FISH_AUDIO_MODEL` | `fish-audio-s2-pro-8bit` |
| System female identity | `FISH_AUDIO_DEFAULT_VOICE_ID` | `fish-female-default` |
| System reference audio | `FISH_AUDIO_SYSTEM_REFERENCE_AUDIO` | required curated WAV |
| System reference transcript | `FISH_AUDIO_SYSTEM_REFERENCE_MANIFEST` | required JSON with exact `ref_text` |
| Fish runtime API | `FISH_AUDIO_API_URL` | `http://127.0.0.1:8062/v1` |
| Voice reference directory | `FISH_AUDIO_VOICE_DIR` | `.data/fish-audio/voices` |
| Signed-URL TTL for playback | `SIGNED_URL_TTL_SECONDS` | 900s |

## Known scope boundaries (intentional)

- Delivery is character-level for v1; per-message emotion tagging from the chat model
  remains a follow-up.
- The play button is shown to all users and gates server-side via 402; no client-side
  entitlement pre-check.
- The resident MLX Audio runtime is Apple Silicon/macOS-only.
- Voice states created by retired gateways must be recreated from their Admin reference
  audio; only reference WAV + manifest pairs are valid in the current registry.
