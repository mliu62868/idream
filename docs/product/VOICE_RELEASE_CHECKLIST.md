# Voice Generation — Release Checklist

On-demand TTS for assistant chat turns. The full code path (API → billing → UI →
provider → launch gates) is implemented and tested. This checklist covers the steps
to take it from `mock` to a **publishable production** state.

## What ships in code (already done)

- **API** — `POST /api/v1/generation/voice/quote` accepts the selected reply and
  returns a signed `quoteToken` plus its maximum Dreamcoin cost. Explicit Play sends
  it to `POST /api/v1/generation/voice`
  `{characterId, messageId, sessionId?, text, intent: "play", quoteToken}`
  → `{assetId, contentUrl, durationMs}`. Auth + age-gate + `voice_gen` flag +
  `voice_enabled` entitlement gated. Per-message cached (one clip per `messageId`).
- **Chat delivery** — play-only: completed assistant turns do not automatically
  synthesize audio. A new Play displays and accepts the quoted upper bound before
  synthesis; accepted recovery and previously delivered clips reuse their durable
  authority. The compatibility `prewarm` API uses included minutes only and never
  spends Dreamcoins or automatically resumes a paid Play.
- **Billing** — plan `voice_minutes` allowance is spent first (rolling 30-day window);
  overflow falls back to a per-clip Dreamcoin charge (`PricingRule` mode `voice`,
  default 2). Accepted rate, maximum cost, allowance and window are persisted on
  `VoiceClipRequest` across retries/reclaim; actual cost never exceeds acceptance.
  Debit + asset write are atomic; concurrent double-clicks are de-duped.
- **Delivery / tone** — the `VoiceClipPort.synthesize` authority carries the character tone plus a
  persisted delivery contract. Fish applies its sampling controls; Pocket 3.0.2 deliberately uses
  each official voice's native English delivery and reports those controls as not applied.
- **UI** — play / loading / stop control on each assistant message in chat; 402 routes
  to upgrade.
- **Provider** — `PocketTtsVoiceModel` is the default English product adapter and calls the
  official resident CPU runtime on `8063`. `VOICE_PROVIDER=pocket-tts` owns speech for
  Characters without an active voice profile and exposes 21 official English voices.
  `FishAudioVoiceModel` remains available on `8062` for optional reference-audio cloning;
  set `VOICE_IDENTITY_PROVIDER=fish-audio` when new candidates should use Fish. Activated
  profiles retain their persisted provider and never drift with later configuration changes.
- **System default authority** — `AppSetting.voice.defaults` schema v3 pins the provider together
  with its voice mapping. A legacy Fish-only setting or a setting for a different current provider
  is not reused after cutover; Main falls back to `POCKET_TTS_DEFAULT_VOICE_ID` until an operator
  saves a reviewed Pocket mapping.
- **Voice identity authority** — Admin Character Workspace → Voice either uploads a Fish
  reference or selects an official Pocket English voice. Pocket compiles a unique,
  durable alias for each candidate so multiple Characters can reuse one catalog voice
  without sharing `providerVoiceId`. Both paths render a preview and create a versioned
  candidate `CharacterVoiceProfile` without changing `Character.voiceId`. A separate
  publish-authority action activates the
  reviewed candidate, archives the previous active profile, updates the character
  pointer, and records Audit/Outbox evidence.
- **Durable recovery** — `VoiceClipRequest` persists immutable synthesis and provider
  authority. Character operations can reclaim only an expired running lease; takeover
  keeps the same provider idempotency key and records the operator command and audit
  evidence. `VoiceIdentityPort` separately owns preview/preset/clone/delete/runtime
  inspection.
- **Launch gates** — `VOICE_PROVIDER` is a launch-critical provider: production refuses
  to start on `mock`, and `check:launch` requires a fresh live voice-model probe. For the
  Pocket default, that report must prove catalog discovery plus preset alias → synthesize →
  delete; PM2 readiness owns the Pocket process and `/health`. If Fish is configured as the
  identity provider, the same report additionally proves Fish clone → synthesize → delete.

## Production cutover steps (ops)

1. **Prepare Pocket TTS** — install the locked runtime from
   `scripts/pocket-tts-requirements.lock`, retain the pinned model revision, and verify
   `/health` reports `runtime=pocket_tts`, `acceleration=cpu`, `catalog_ready=true`, and
   all 21 official English voices.
2. **Optional Fish cloning** — only when reference-audio identity cloning is required,
   download `mlx-community/fish-audio-s2-pro-8bit` and prepare a reviewed WAV plus exact
   transcript manifest without overwriting an existing authority:
   ```
   bun run voice:fish:prepare-system -- \
     --audio /voices/curated-adult-female-reference.wav \
     --manifest /voices/curated-adult-female-reference.json
   ```
3. **Start the runtimes** — run the repository-owned `pocket-tts` process from
   `ecosystem.config.js`. It exposes `/v1/audio/speech`, the official catalog, and the
   durable role-alias registry. The gated PM2 wrapper requires Pocket whenever it owns
   system or Character speech. Fish remains separately managed and becomes readiness-critical
   only when configured for system rollback or Character identity cloning.
4. **Set env** (see `packages/main/.env.production.example`):
   ```
   VOICE_PROVIDER=pocket-tts
   POCKET_TTS_API_URL=http://127.0.0.1:8063/v1
   POCKET_TTS_API_TOKEN=<shared-internal-token>
   POCKET_TTS_LANGUAGE=english
   POCKET_TTS_DEFAULT_VOICE_ID=alba
   # Optional reference-audio candidate provider.
   # VOICE_IDENTITY_PROVIDER=fish-audio
   VOICE_MODEL_PROBE_REPORT=.tmp/launch-voice-probe.json
   ```
5. **Seed / migrate data** — deploy Prisma migrations and run `db:seed` (or apply
   equivalently in prod) so `CharacterVoiceProfile`, the
   `voice_gen` feature flag, the `mode=voice` `PricingRule`, and the `voiceEnabled` /
   `voiceMinutes` plan features exist. Existing purchases use their immutable checkout
   offer: changing the catalog Plan does not rewrite purchased access. Any additional
   benefit must be an explicit independent grant; only historical subscriptions without
   a stored purchase snapshot retain the legacy Plan lookup.
6. **Create and verify one character voice** — use Admin Character Workspace → Voice
   to select an official Pocket English voice (or upload a Fish reference), create a
   candidate, and confirm its preview plays while `Character.voiceId` remains unchanged.
   Then activate the reviewed candidate and confirm the profile is active and the
   character pointer matches its provider-specific voice id and persisted provider.
   Activation preflights that exact candidate's runtime and voice, independent of the
   current system provider; an unavailable Fish or Pocket runtime fails closed.
   Unset characters continue to use the reviewed Pocket system fallback identity.
7. **Run the live probe**:
   ```
   bun run --filter @idream/main probe:voice -- --report .tmp/launch-voice-probe.json
   ```
   then `bun run check:launch` — `voice-model-live-probe` must confirm playable Pocket
   output, the official English catalog, and preset alias → synthesize → delete. With
   Fish identity enabled, the same JSON report must also contain the nested Fish clone →
   synthesize → delete probe.
8. **Flip the flag** — `voice_gen` ships enabled. To stage rollout, set it disabled in
   the admin console and enable when ready (kill-switch is the same flag).

## Tunable config

| Knob | Where | Default |
| --- | --- | --- |
| Voice on/off, rollout, target plans | `voice_gen` feature flag (admin) | enabled, premium+deluxe |
| Overflow price per clip | `PricingRule` mode `voice` (admin) | 2 Dreamcoins |
| Free minutes per plan | plan `voiceMinutes` feature | 30 / 120 / 360 / 1440 |
| Default delivery model | `POCKET_TTS_MODEL` | `pocket-tts` |
| System fallback identity | `POCKET_TTS_DEFAULT_VOICE_ID` | `alba` |
| Pocket runtime API | `POCKET_TTS_API_URL` | `http://127.0.0.1:8063/v1` |
| Pocket language | `POCKET_TTS_LANGUAGE` | `english` |
| Pocket voice registry | `POCKET_TTS_VOICE_DIR` | `.data/pocket-tts/voices` |
| Optional Character identity override | `VOICE_IDENTITY_PROVIDER` | unset; `fish-audio` enables reference cloning |
| Fish runtime API | `FISH_AUDIO_API_URL` | `http://127.0.0.1:8062/v1` |
| Fish voice reference directory | `FISH_AUDIO_VOICE_DIR` | `.data/fish-audio/voices` |
| Signed-URL TTL for playback | `SIGNED_URL_TTL_SECONDS` | 900s |

## Known scope boundaries (intentional)

- Delivery is character-level for v1; per-message emotion tagging from the chat model
  remains a follow-up.
- The play button is shown to all users and gates server-side via 402; no client-side
  entitlement pre-check.
- Fish's resident MLX Audio runtime is Apple Silicon/macOS-only; Pocket's official
  runtime is CPU-only and currently owns English speech only.
- On the 2026-08-31 local review host, Pocket 3.0.2 reported
  `has_voice_cloning=false` and `catalog_ready=true` with 21 English voices. Real Alba
  and Anna role aliases synthesized distinct 2.88s / 3.52s WAV files in 404ms / 439ms.
  Reference-audio cloning remains optional and gated; the official catalog path does
  not depend on those weights. This is controlled local evidence, not production
  canary approval.
- Voice states created by retired gateways must be recreated from their Admin reference
  audio; only reference WAV + manifest pairs are valid in the current registry.
