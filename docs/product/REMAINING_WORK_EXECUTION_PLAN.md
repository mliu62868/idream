# iDream Remaining Work Execution Plan

Updated: 2026-06-27

## Current State

The product is a working local MVP. After the 2026-06-26 scope decision, the active milestone is **internal demo / controlled beta**, not public launch.

Use these documents as the current source of truth:

- `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`: local flow coverage.
- `docs/product/LAUNCH_READINESS_AUDIT.md`: production blockers.
- `docs/product-audits/current-implementation/pm-audit.md`: PM/UX gaps.

Current launch gate with probe env: `28 pass / 29 fail / 0 warn`.

That failure is expected while the deferred production providers below remain out of scope.

Current internal Pipeline probe:

```bash
bun run launch:probe:pipeline
```

Latest local result on 2026-06-26:

- web surface: pass.
- product config: pass.
- chat service BFF: pass.
- chat model via `pipeline`: pass, using `http://127.0.0.1:8061/v1`.
- image generation via `pipeline`: pass, using `http://127.0.0.1:8091` and `pornmaster-zimage-turbo`.
- voice via `pipeline`: adapter exists, and MOSS-TTS v1.5 remains the selected target. Use `PIPELINE_VOICE_API_URL` for the MOSS endpoint. The old explicit voice probe against image gateway `http://127.0.0.1:8091` returns HTTP 404, which confirms sd.cpp is not the TTS runner. On 2026-06-27, a smaller local oMLX smoke path passed with `Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit` at `http://127.0.0.1:8061/v1` and speaker `serena`.

## Deferred External Provider Decision

Decision date: 2026-06-26.

These integrations are explicitly deferred and should not be treated as active work in the current milestone:

- Safety Gateway.
- Go.cam.
- BTCPay.
- R2/S3.
- Sentry.

Product consequence:

- The current target is not public launch.
- Current validation should focus on local/internal flows, controlled demo data, Pipeline-backed runtime where available, and clear documentation of known production gaps.
- Public launch gates must stay strict. Do not weaken `check:launch:direct` to pass while these providers are missing.
- Keep existing adapters, env names, probes, and runbook notes. They remain the future public-launch checklist.

Reopen these integrations when the target changes back to public launch, external beta with real users, or paid production traffic.

## Target

Reach an internal-demo-ready state where:

1. Main user flows pass locally or in a controlled environment with the deferred providers clearly mocked, disabled, or documented.
2. Public catalog, Feed, and Community contain demo-safe content and no e2e/test fixtures.
3. Create and Generate feel deep enough to match the product promise from `https://ourdream.ai/`.
4. Pipeline-backed image/chat/voice paths are validated where they remain in current scope.
5. The product cannot be mistaken for a public-launch-ready system while Safety Gateway, Go.cam, BTCPay, R2/S3, and Sentry are deferred.

Future public launch still requires `bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env --json` to pass against real production providers.

## Workstreams

### A. Pipeline And Internal Runtime

Owner: infrastructure/backend.

Goal: keep the active Pipeline-backed runtime usable while documenting production provider gaps as deferred. Pipeline is **not** deferred.

Required work:

- Keep `bun run launch:probe:pipeline` passing for every active internal demo.
- Keep chat service BFF configured with `CHAT_SERVICE_URL` and matching `CHAT_BFF_SIGNING_SECRET`.
- Keep chat model probe running through `CHAT_MODEL_PROVIDER=pipeline` against the OpenAI-compatible local endpoint.
- Keep image generation running through `GEN_IMAGE_PROVIDER=pipeline` against the local sd.cpp gateway.
- Add or connect a Pipeline `/audio/speech` gateway before promising voice in the demo. For product target quality use MOSS-TTS v1.5; for local Apple Silicon smoke tests, the confirmed smaller path is oMLX + `Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit`.
- Use SGLang-Omni for the shared GPU runner by default; use MLX only for Apple Silicon local experiments. Do not use sd.cpp for voice.
- Keep any demo-only moderation, billing, storage, age, and observability behavior clearly marked as non-production.

Deferred from this milestone:

- Configure `MODERATION_PROVIDER=safety-gateway` and `CHAT_MODERATION_PROVIDER=safety-gateway`.
- Configure `PAYMENT_PROVIDER=btcpay` with Greenfield API key, store id, base URL, and webhook secret.
- Configure `BLOB_PROVIDER=r2` or `s3` with private bucket credentials.
- Configure `AGE_VERIFICATION_PROVIDER=gocam` with public HTTPS link-back and callback URLs.
- Configure `SENTRY_DSN`.

Acceptance:

```bash
bun run launch:probe:pipeline
bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe.json
bun run launch:probe:product-config -- --report .tmp/launch-product-config-probe.json
bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json
bun run launch:probe:chat -- --report .tmp/launch-chat-probe.json
```

If voice is included in the active demo promise, also run:

```bash
PIPELINE_VOICE_API_URL=http://127.0.0.1:8000/v1 \
PIPELINE_VOICE_MODEL_DEFAULT=OpenMOSS/MOSS-TTS-Local-Transformer-v1.5 \
bun run launch:probe:voice:local
```

For the confirmed smaller oMLX smoke path:

```bash
set -a; source packages/chat/.env; set +a
PIPELINE_VOICE_API_URL=http://127.0.0.1:8061/v1 \
PIPELINE_VOICE_API_TOKEN="$CHAT_MODEL_API_KEY" \
PIPELINE_VOICE_MODEL_DEFAULT=Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit \
bun run launch:probe:voice:local
```

Then run the combined pipeline gate:

```bash
bun run launch:probe:pipeline -- --include-voice
```

Future public-launch acceptance:

```bash
bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json
bun run launch:probe:blob -- --report .tmp/launch-blob-probe.json
bun run launch:probe:payment -- --report .tmp/launch-payment-probe.json
bun run launch:probe:age -- --report .tmp/launch-age-probe.json
bun run launch:probe:safety -- --report .tmp/launch-safety-probe.json
bun run check:launch:direct -- --launch-env-file .tmp/production-launch.env --json
```

Future public launch remains blocked by external inputs:

- Production Postgres/Redis URLs.
- Pipeline gateway URL/token and capacity.
- Safety Gateway URL/token. **Deferred.**
- BTCPay store and webhook configuration. **Deferred.**
- R2/S3 bucket and keys. **Deferred.**
- Go.cam gateway credentials and public HTTPS callbacks. **Deferred.**
- Sentry project DSN. **Deferred.**

### B. Public Catalog And Data Hygiene

Owner: product/backend.

Goal: public Explore, Feed, and Community never show test-like data.

Required work:

- Add a catalog health probe that fails on e2e/test fixture content in public characters, dreamers, and media. **Status: implemented as `@idream/main probe:catalog`.**
- Separate test fixtures from demo/seed content.
- Provide a production seed/import path with curated characters and realistic metrics.
- Add a cleanup runbook for preview/demo DBs polluted by e2e data.

Acceptance:

```bash
bun run --filter @idream/main probe:catalog -- --report .tmp/public-catalog-probe.json
```

The probe must pass before customer-facing demos or launch.

Current local result on 2026-06-26:

- `ok=false`
- `publicCharacters=177`
- `publicCreators=66`
- `distinctImages=16`
- `issueTotals.fail=859`

This confirms the PM audit finding: current demo data is polluted by e2e/test fixtures and should not be used for a customer-facing walkthrough.

### C. Create Experience Depth

Owner: frontend/product.

Goal: Create matches the reference product promise more closely and feels like a guided character builder.

Required work:

- Replace the dense single form with a multi-step builder: identity, appearance, personality, relationship/context, tags, advanced details, preview, visibility.
- Preserve the existing draft API contract and autosave each step.
- Add preview states: empty, generating, failed, complete.
- Make private/public review status explicit.
- Add client copy for age/forbidden-content validation without exposing policy-evasion details.

Acceptance:

- Create a character from scratch.
- Refresh mid-draft and resume.
- Generate preview.
- Submit private character and see it in My AI.
- Submit public character and see pending review.
- E2E covers success, validation failure, and preview failure.

### D. Generate Experience Depth

Owner: frontend/product/backend.

Goal: Generate supports the practical controls users expect from the reference product.

Required work:

- Improve character selector and Freeplay flow.
- Surface built-in presets by type: mode, background, pose, outfit.
- Show premium prompt and negative prompt gates with upgrade path.
- Add clear insufficient-balance, blocked, failed, refunded, and retry states.
- Add gallery management: like, delete, download, report, filter, and empty states.
- Keep Video Beta disabled unless real video provider and moderation are ready.

Acceptance:

- Image generation completes and media appears in gallery.
- Premium controls unlock after Upgrade.
- Insufficient balance blocks submission with an actionable message.
- Failed provider job can retry; blocked job cannot retry and points to policy/help.
- Video is either disabled cleanly or passes video provider launch gate.

### E. Billing And Entitlements

Owner: backend/ops.

Goal: keep local entitlement behavior coherent for demos. Real payment provider work is deferred.

Required work:

- Keep BTCPay checkout creation and webhook settlement in the future public-launch checklist.
- Remove or hide auto-confirm checkout before any external beta or public traffic.
- Confirm entitlement derivation and dreamcoin grant idempotency.
- Add billing portal behavior for active/inactive subscriptions.

Acceptance:

- Local/mock checkout remains clearly marked as demo-only.
- Profile reflects plan and dreamcoin balance.
- Entitlement derivation and dreamcoin grant behavior remain idempotent in tests.
- Auto-confirm checkout is not presented as production behavior.

Future public-launch acceptance:

- BTCPay checkout creates a real invoice.
- Settled webhook activates subscription once.
- Duplicate webhook does not double-grant.
- Payment probe and billing E2E pass against the real provider.

### F. Safety, Moderation, And Compliance

Owner: trust/backend/ops.

Goal: keep reports and admin moderation usable in local/internal scope. Real Safety Gateway and Go.cam work is deferred.

Required work:

- Keep real text/media Safety Gateway setup in the future public-launch checklist.
- Keep Go.cam age verification setup in the future public-launch checklist.
- Ensure reports for character, media, message, feed item, and profile reach admin moderation.
- Add appeal/help entry points for blocked outputs.
- Confirm hard-policy content cannot be published or generated.

Acceptance:

- Admin moderation queue can review reports and apply decisions.
- Reports from character, media, message, feed item, and profile land in the queue.
- Known blocked fixture is blocked in local chat/create/generate tests where the local provider supports it.
- Age-gated UX remains clear that it is not Go.cam verification.

Future public-launch acceptance:

- Benign moderation probe passes against Safety Gateway.
- Age verification probe returns a Go.cam provider session with HTTPS verification URL.
- Known blocked fixture is blocked through the real provider path.

### G. Feed And Community Productization

Owner: product/frontend/backend.

Goal: Feed and Community stop looking like a catalog mirror and become credible discovery surfaces.

Required work:

- Define Feed item types and ranking beyond public character cards.
- Define creator public profile scope or intentionally hide links.
- Add collection semantics or hide collections until ready.
- Add follow state, share URLs, and remix lineage.
- Add empty/loading/error states for low-data communities.

Acceptance:

- Feed actions have durable state or intentionally scoped analytics-only behavior.
- Community filters work with real data.
- No launch-visible tab promises an unimplemented domain.

### H. Documentation Reconciliation

Owner: product/engineering.

Goal: docs do not contradict current code state.

Required work:

- Mark `CURRENT_FUNCTIONAL_COVERAGE.md` as current status.
- Move stale `ProductFeatureMap.md` "未实现" rows into historical context or update them.
- Update launch runbook with current blocker ordering.
- Keep generated audit output linked from product docs.

Acceptance:

- A new engineer can read docs and know what is implemented, blocked, deferred, and launch-critical.

## Execution Order

### Phase 0 - This Week

1. Add catalog hygiene probe. **Done.**
2. Produce future public-launch secret checklist from `.env.production.example` files.
3. Clean preview/demo DBs of e2e/test fixture rows.
4. Re-run public route, catalog, and PM screenshots.

Exit criteria:

- Public catalog probe passes.
- PM screenshots no longer show test fixture content.

### Phase 1 - Internal Beta Gate

1. Keep active Pipeline-backed image and chat paths passing through `bun run launch:probe:pipeline`.
2. Keep Safety Gateway, BTCPay, R2/S3, Go.cam, and Sentry documented as deferred, not missing current tasks.
3. Decide whether voice is in the internal demo promise. If yes, connect MOSS-TTS v1.5 through `PIPELINE_VOICE_API_URL` and require `bun run launch:probe:pipeline -- --include-voice`.
4. Run catalog probe and clean demo data until it passes.
5. Record expected public-launch gate failures caused by deferred providers.

Exit criteria:

- Internal demo flows pass without e2e/test fixture content.
- Deferred providers are visible in docs and cannot be mistaken for completed production readiness.
- Public launch gate is still allowed to fail for the deferred provider checks.

### Phase 2 - Beta Experience Completion

1. Upgrade Create to guided flow.
2. Upgrade Generate controls and states.
3. Add blocked/failed/refund UX.
4. Dogfood full first-session journey.

Exit criteria:

- First-session path from age gate to signup to create/chat/generate/upgrade completes without PM caveats.

### Phase 3 - Public Launch Hardening

This phase is parked until Safety Gateway, Go.cam, BTCPay, R2/S3, and Sentry are explicitly reactivated.

1. Full E2E against production-like services.
2. Chrome smoke on main/admin.
3. Admin moderation runbook rehearsal.
4. Payment webhook replay test.
5. Storage signed URL access test.

Exit criteria:

- Product, ops, and safety sign off.
- Launch gate, E2E, smoke, and runbooks are green.

## Parallelization Plan

If using agent teams, each teammate must work in a separate worktree branch and merge at the end:

- `codex/pipeline-runtime`: active Pipeline runtime and internal beta probes.
- `codex/launch-providers`: parked future work for Safety Gateway, Go.cam, BTCPay, R2/S3, and Sentry.
- `codex/catalog-hygiene`: public catalog probe, fixture cleanup, seed curation.
- `codex/create-flow`: guided Create UX.
- `codex/generate-flow`: Generate presets/states/gallery.
- `codex/docs-reconcile`: docs cleanup and runbook.

Merge order:

1. `catalog-hygiene`.
2. `docs-reconcile`.
3. `pipeline-runtime`.
4. `create-flow`.
5. `generate-flow`.

Do not merge `launch-providers` into the current milestone unless the deferred provider decision is reversed.

## Final Done Definition

The current internal-demo milestone is complete when:

- Full E2E passes.
- Public catalog probe passes.
- PM screenshot audit shows no test data and no dead promises.
- Active Pipeline-backed runtime paths have probe evidence from `bun run launch:probe:pipeline`.
- If voice is visible/promised, Pipeline voice has a passing `/audio/speech` probe.
- Deferred provider gaps are documented and not represented as publicly launch-ready.
- Product docs describe the current state without stale contradictions.

Future public launch is complete only when:

- Launch gate passes.
- Full E2E passes against production-like services.
- Public catalog probe passes.
- Payment, age verification, moderation, blob storage, chat, voice, and observability all have live probe evidence.
- Product, ops, and safety sign off.
