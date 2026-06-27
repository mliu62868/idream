# iDream PM Audit - Current Implementation

Date: 2026-06-26

## Scope

Product-manager review of the current local implementation against the Ourdream reference surface and the current product readiness documents.

Evidence used:
- Local browser screenshots in `docs/product-audits/current-implementation/screenshots/`.
- Current source for core workspaces: Explore, Create, Generate, Upgrade, Profile, Feed, Community.
- `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`.
- `docs/product/LAUNCH_READINESS_AUDIT.md`.
- Current public HTML from `https://ourdream.ai/`, `/create`, `/generate`, `/upgrade`, and `/community`.

## Step Health

1. Age gate: Healthy for local MVP. Blocks protected content before acceptance and has clear Terms / leave-site affordances.
2. Explore: Functionally present, but content quality is not production healthy. The local screen shows repeated test-like characters, duplicated imagery, and inflated stats.
3. Signup: Healthy for a local MVP. It creates a session and grants starter dreamcoins.
4. Create: Partially reasonable. It reaches real draft, preview, submit, and My AI persistence APIs, but the UX is a single dense form instead of the reference site's guided creation flow.
5. Generate: Partially reasonable. It has balance, model, mode, job polling, gallery, media actions, and premium gates, but the control set is much thinner than the reference product's presets, scene controls, and batch/video richness.
6. Upgrade: Locally complete, not production-complete. The local UI activates plans through mock/auto-confirm style checkout; real payment is still a launch blocker.
7. Profile / My AI: Solid MVP account surface. Balance, redeem, referral, language, preferences, billing entry, account deletion, and media tab are represented.
8. Feed: Present but thin. It has Chat, Remix, Like, Share, Report actions, but the visible content repeats catalog/test fixtures.
9. Community: Present but thin. Dreamers leaderboard and follow/report actions exist, but visual merchandising and data quality are not launch-ready.
10. Safety / external target comparison: Reference site still emphasizes age gate, Explore, Create, Generate, My AI, Upgrade, Help, and Safety. Local implementation aligns at the top-level entry map, but production trust gates remain incomplete.

## PM Conclusion

The current implementation is complete enough to call it a local end-to-end MVP, not complete enough to call it a public launch candidate.

Scope update on 2026-06-26: Safety Gateway, Go.cam, BTCPay, R2/S3, and Sentry are explicitly deferred. That turns the active target into internal demo / controlled beta readiness, not public launch readiness.

The strongest product work is the breadth of task coverage: age gate, signup, explore, character detail, create, chat, generation, upgrade, profile, reports, admin, and probes are all represented with automated evidence. This is no longer a static clone.

Pipeline is current-scope work, not deferred. On 2026-06-26, `bun run launch:probe:pipeline` passed for web surface, product config, chat service, chat model via `pipeline`, and image generation via `pipeline`. Voice target is MOSS-TTS v1.5 through `PIPELINE_VOICE_API_URL`; on 2026-06-27 a smaller local oMLX smoke path passed with `Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit`. MOSS still needs its own `/v1/audio/speech` gateway before it can be promised as the demo voice model.

The biggest future public-launch gap is production trust. Payment, age verification, real provider configuration, object storage, moderation credentials, durable chat settings, and Sentry are still blocking public launch. This is correctly reflected by the `28 pass / 29 fail` launch gate, and the gate should stay strict while these providers are deferred.

The biggest experience gap is depth and data quality. The reference product has richer creation and generation configuration, stronger marketplace/community merchandising, and live-looking roleplay content. The local product currently exposes repetitive test data and simplified controls, which makes it feel unfinished even when the underlying flows work.

## Priority Recommendations

P0 for current internal demo / controlled beta:
- Clean the seeded/public catalog data before any customer-facing demo. Remove test names, duplicated images, unrealistic metrics, and fixture copy from Explore, Feed, and Community.
- Decide the launch promise for video and voice. If video stays disabled, hide or clearly mark it; if it ships, require real provider and moderation evidence.

Future P0 before public launch:
- Reactivate Safety Gateway, Go.cam, BTCPay, R2/S3, and Sentry.
- Replace mock/public-launch blockers: payment, age verification, object storage, moderation provider config, chat durable storage/signing, and observability.

P1 before beta:
- Turn Create from a dense form into a guided flow closer to the target product: appearance, personality, relationship, voice, tags, advanced details, preview, and publish/private review.
- Expand Generate controls toward the target model: character selector, Freeplay, presets for background/pose/outfit, custom prompt, negative prompt, model/style, orientation, count, gallery management, and failure/refund explanation.
- Add user-facing blocked/failed paths with next action: retry when allowed, edit prompt, appeal/report, or contact support.

P2 after beta:
- Strengthen Feed and Community semantics: real ranking, creator profiles, follow graph, collections, remix lineage, share URLs, and moderation state.
- Reconcile product docs. `CURRENT_FUNCTIONAL_COVERAGE.md` is the current truth; older feature-map/backlog language still reads as if several shipped local flows are missing.

## Verification

Commands run:

```bash
bun run --filter @idream/main test:unit -- src/server/modules/ourdream/gaps.test.ts src/server/modules/ourdream/service.test.ts
bun run check:launch:direct -- --launch-env-file .tmp/launch-probe-only.env --json
```

Results:
- Unit subset: 2 files passed, 8 tests passed.
- Launch gate with probe env: 28 pass, 29 fail, 0 warn.

## Evidence Limits

Screenshots prove visible state only. They do not prove WCAG compliance, real production provider reliability, payment settlement, moderation accuracy, age-verification compliance, or long-running generation/chat reliability.

The external target site was reviewed through public HTML without accepting its age gate or completing any external action.
