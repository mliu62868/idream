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
- **Provider** — `MockVoiceModel` (writes a real playable WAV, so dev/staging works) and
  `PipelineVoiceModel` (OpenAI-compatible `/v1/audio/speech`, e.g. MOSS-TTS).
- **Launch gates** — `VOICE_PROVIDER` is a launch-critical provider: production refuses
  to start on `mock`, and `check:launch` requires a fresh live voice-model probe.

## Production cutover steps (ops)

1. **Stand up the voice gateway** — expose MOSS-TTS (or equivalent) over an
   OpenAI-compatible `/v1/audio/speech` endpoint (SGLang-Omni on shared GPU, or MLX on
   Apple Silicon). The local `sdcpp-image` gateway does **not** serve audio.
2. **Set env** (see `packages/main/.env.example`):
   ```
   VOICE_PROVIDER=pipeline
   PIPELINE_VOICE_API_URL=https://<gateway>/v1     # or reuse PIPELINE_API_URL
   PIPELINE_VOICE_API_TOKEN=<token>                # or reuse PIPELINE_API_TOKEN
   PIPELINE_VOICE_MODEL_DEFAULT=OpenMOSS/MOSS-TTS-Local-Transformer-v1.5
   VOICE_MODEL_PROBE_VOICE_ID=serena
   VOICE_MODEL_PROBE_REPORT=.tmp/launch-voice-probe.json
   ```
3. **Seed / migrate data** — run `db:seed` (or apply equivalently in prod) so the
   `voice_gen` feature flag, the `mode=voice` `PricingRule`, and the `voiceEnabled` /
   `voiceMinutes` plan features exist. Existing subscribers only gain voice after their
   plan features include `voiceEnabled` — reseed plans or edit them in the admin console.
4. **Assign character voices** — set `Character.voiceId` to a gateway voice id for the
   characters that should speak (admin CMS). Unset → the gateway default voice.
5. **Run the live probe**:
   ```
   bun run --filter @idream/main probe:voice -- --report .tmp/launch-voice-probe.json
   ```
   then `bun run check:launch` — `voice-model-live-probe` must pass.
6. **Flip the flag** — `voice_gen` ships enabled. To stage rollout, set it disabled in
   the admin console and enable when ready (kill-switch is the same flag).

## Tunable config

| Knob | Where | Default |
| --- | --- | --- |
| Voice on/off, rollout, target plans | `voice_gen` feature flag (admin) | enabled, premium+deluxe |
| Overflow price per clip | `PricingRule` mode `voice` (admin) | 2 Dreamcoins |
| Free minutes per plan | plan `voiceMinutes` feature | 30 / 120 / 360 / 1440 |
| Default delivery model | `PIPELINE_VOICE_MODEL_DEFAULT` | MOSS-TTS v1.5 |
| Signed-URL TTL for playback | `SIGNED_URL_TTL_SECONDS` | 900s |

## Known scope boundaries (intentional)

- Emotion is character-level for v1; per-message emotion tagging from the chat model is a
  follow-up (the `tone` field already carries it end-to-end).
- The play button is shown to all users and gates server-side via 402; no client-side
  entitlement pre-check.
