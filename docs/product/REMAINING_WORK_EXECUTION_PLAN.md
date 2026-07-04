# iDream Remaining Work Execution Plan

Updated: 2026-06-30

## Current State

The product is a working local MVP. After the 2026-06-26 scope decision, the active milestone is **internal demo / controlled beta**, not public launch.

Use these documents as the current source of truth:

- `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`: local flow coverage.
- `docs/product/LAUNCH_READINESS_AUDIT.md`: production blockers.
- `docs/product/PRODUCTION_SECRET_CHECKLIST.md`: production env and secret checklist.
- `docs/product-audits/current-implementation/pm-audit.md`: PM/UX gaps.

Current launch gate in the current non-production shell: `7 pass / 49 fail / 2 warn`.

That failure is expected while the deferred production providers below remain out of scope.

Current internal Pipeline probe:

```bash
bun run launch:probe:pipeline
```

Latest local result on 2026-06-30:

- web surface: pass.
- product config: pass.
- chat service BFF + conversation smoke: pass. Latest `launch:probe:chat-service`
  auto-selected `lola-moonstruck` from the main DB and verified session create,
  message send, SSE stream start/delta/done, exact assistant-message reload,
  no-memory send, and blocked-input handling. Probe stream timeout is now 90s
  by default and can be overridden with `CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS`.
  The chat worker now emits terminal SSE `done` only after DB finalize, so the
  stream terminal event and reload state agree.
- chat model via `pipeline`: pass, using `http://127.0.0.1:8061/v1` and
  `Qwen3.6-35B-A3B-uncensored-heretic-Native-MTP-Preserved-mlx-8Bit`.
- image generation via `pipeline`: pass, using `http://127.0.0.1:8091` and
  `pornmaster-zimage-turbo`; combined pipeline probe produced 1 image asset in
  about 97.3s.
- voice via `pipeline`: pass in the current local setup using
  `http://127.0.0.1:8061/v1`, `Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit`, and voice
  `serena`; combined pipeline probe returned WAV audio in about 8.4s. The
  previous local `Kokoro-82M-bf16` path currently returns HTTP 500 on this
  machine, so it is not the active smoke path. MOSS-TTS v1.5 remains the target
  for product-quality voice; use `PIPELINE_VOICE_API_URL` for the MOSS endpoint
  when that runner is available.

## Deferred External Provider Decision

Decision date: 2026-06-26.

These integrations are explicitly deferred and should not be treated as active work in the current milestone:

- Go.cam.
- BTCPay.
- R2/S3.
- Sentry.

Product consequence:

- The current target is not public launch.
- Current validation should focus on local/internal flows, controlled demo data, Pipeline-backed runtime where available, and clear documentation of known production gaps.
- Public launch gates must stay strict. Do not weaken `check:launch` to pass while these providers are missing.
- Keep existing adapters, env names, probes, and runbook notes. They remain the future public-launch checklist.

Reopen these integrations when the target changes back to public launch, external beta with real users, or paid production traffic.

## Target

Reach an internal-demo-ready state where:

1. Main user flows pass locally or in a controlled environment with the deferred providers clearly mocked, disabled, or documented.
2. Public catalog, Feed, and Community contain demo-safe content and no e2e/test fixtures.
3. Create and Generate feel deep enough to match the product promise from `https://ourdream.ai/`.
4. Pipeline-backed image/chat/voice paths are validated where they remain in current scope.
5. The product cannot be mistaken for a public-launch-ready system while Go.cam, BTCPay, R2/S3, and Sentry are deferred.

Future public launch still requires `bun run check:launch -- --launch-env-file .tmp/production-launch.env --json` to pass against real production providers.

## Workstreams

### A. Pipeline And Internal Runtime

Owner: infrastructure/backend.

Goal: keep the active Pipeline-backed runtime usable while documenting production provider gaps as deferred. Pipeline is **not** deferred.

Required work:

- Keep `bun run launch:probe:pipeline` passing for every active internal demo.
- Keep chat service BFF configured with `CHAT_SERVICE_URL` and matching `CHAT_BFF_SIGNING_SECRET`.
- Keep `launch:probe:chat-service` passing with a real conversation smoke; skipped
  conversation reports now fail launch readiness.
- Keep chat model probe running through `CHAT_MODEL_PROVIDER=pipeline` against the OpenAI-compatible local endpoint.
- Keep image generation running through `GEN_IMAGE_PROVIDER=pipeline` against the local sd.cpp gateway.
- Before any demo that includes image generation, run
  `bun run launch:probe:pipeline` and confirm image generation produces a fresh
  Gallery asset. If prior runs were interrupted, clear stale `ai.image.generate`
  active jobs, restart `gen-image` and `sdcpp-image`, and confirm Prisma schema
  is synced before the probe.
- Add or connect a Pipeline `/audio/speech` gateway before promising voice in the demo. For product target quality use MOSS-TTS v1.5; for local Apple Silicon smoke tests, the confirmed smaller path is oMLX + `Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit`.
- Use SGLang-Omni for the shared GPU runner by default; use MLX only for Apple Silicon local experiments. Do not use sd.cpp for voice.
- Keep any demo-only moderation, billing, storage, age, and observability behavior clearly marked as non-production.

Deferred from this milestone:

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
bun run check:launch -- --launch-env-file .tmp/production-launch.env --json
```

Future public launch remains blocked by external inputs:

- Production Postgres/Redis URLs.
- Pipeline gateway URL/token and capacity.
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

Latest local result on 2026-06-30 after rerunning `bun run --filter @idream/main db:seed`:

- `ok=true`
- `publicCharacters=16`
- `publicCreators=13`
- `distinctImages=16`
- `issueTotals.fail=0`
- `issueTotals.warn=0`

The earlier PM audit finding about demo data polluted by e2e/test fixtures is resolved
for the current local dataset. Keep `db:seed` + catalog probe in the pre-demo
checklist so future seed/test-data drift is caught before customer-facing
walkthroughs. Latest report: `.tmp/public-catalog-probe-2026-06-30-after-seed.json`.

### C. Create Experience Depth — ✅ 已落地（2026-06-28）

Owner: frontend/product.

Goal: Create matches the reference product promise more closely and feels like a guided character builder.

**落地**：`CreateWorkspace.tsx` 重写为 5 步向导（Identity→Appearance→Personality→Preview→Publish），保留既有 draft API 契约（createDraft→分步 PATCH(step)→preview→submit）；每步推进 autosave 到 draft，并以 localStorage 持久化向导状态实现刷新续编（draft API 无 GET，故走客户端持久化）；Preview 步有 idle/generating/complete/failed 态；Publish 区分 private(approved)/unlisted/public(pending_review，文案明确「公开角色经审核后上线」）；新增 18+/禁止内容校验文案与 name/age 校验。E2E (`ui-workflows.e2e.ts`) 覆盖 private success、age validation、refresh resume、preview failure recovery、public pending_review submit；Chrome screenshot `51-create-public-review-my-ai.png` 验证 public submit 后 My AI `PENDING REVIEW` 可见。

Required work:

- Replace the dense single form with a multi-step builder: identity, appearance, personality, relationship/context, tags, advanced details, preview, visibility.
- Preserve the existing draft API contract and autosave each step.
- Add preview states: empty, generating, failed, complete.
- Make private/public review status explicit.
- Add client copy for age/forbidden-content validation without exposing policy-evasion details.

Acceptance:

- Create a character from scratch. **Covered.**
- Refresh mid-draft and resume. **Covered.**
- Generate preview / handle preview failure. **Covered.**
- Submit private character and see it in My AI. **Covered.**
- Submit public character and see pending review. **Covered.**
- E2E covers success, validation failure, and preview failure. **Covered.**

### D. Generate Experience Depth — ✅ 已落地（2026-06-28）

Owner: frontend/product/backend.

Goal: Generate supports the practical controls users expect from the reference product.

**落地**：内置预设（mode/background/pose/outfit）和 active public Community presets 在 `GeneratorWorkspace` 以选择器暴露并真实生效，Community 来源用 `Community · ...` 标识——`createGenerationJob` 经 `resolvePresetPromptFragment` 把选中预设（built_in、public community 或本人所有，含归属/可见性校验）折进 prompt（image-generation-service.test 覆盖正/反例）；My Presets 支持用户保存当前 mode/background/pose/outfit/prompt 控制、应用、删除，API round-trip 与 Chrome smoke 已覆盖；Image Edit 作为 Generate 内一等工作流展示 Gallery source images，选中前禁用 `Create edit`，选中后调用既有 media variation API 排队 `sourceType=media_variation`，并给出 `Image edit queued.` 反馈；premium prompt/negative-prompt 锁定时给 `/upgrade` 升级 CTA；余额不足显式可操作提示 + 购币入口；blocked（不可重试 + Get help）/failed（退款已返还；Retry 按当前费率新建 derived job 并重新 reserve）/refunded 文案明确，并已由 focused E2E + Chrome `generate-insufficient-balance.png` / `generate-recovery-states.png` 复验。Gallery 支持 like/delete/download/report/filter/empty，Download 成功/失败都有可见状态反馈，也支持 Manage 模式批量 Make private / Delete selected；`video_gen=false` 时不再显示 `Video Beta` 或 `Videos` 死入口，video 只在配置启用且有 video models 时曝光。**未做（YAGNI）**：Collections UI、画廊排序/全文搜索——后端能力在但受控 beta 低价值。

Required work:

- Improve character selector and Freeplay flow.
- Surface built-in and public Community presets by type: mode, background, pose, outfit. **Covered.**
- Expose Image Edit as a first-class source-image variation flow. **Covered.**
- Show premium prompt and negative prompt gates with upgrade path.
- Add clear insufficient-balance, blocked, failed, refunded, and retry states.
- Add gallery management: like, delete, download, report, filter, and empty states.
- Keep video hidden unless real video provider and launch gates are ready.

Acceptance:

- Image generation completes and media appears in gallery. Historical 2026-06-29 Chrome evidence: screenshot `45-generate-image-job-completed-gallery.png`; latest 2026-06-30 pipeline probe completed image generation with 1 asset in about 97.3s. Keep a fresh Chrome gallery proof in the pre-demo checklist whenever the visible Generate UX is part of the walkthrough.
- Premium controls unlock after Upgrade.
- Insufficient balance blocks submission with an actionable message.
- Failed provider job can retry; blocked job cannot retry and points to policy/help.
- Video is either hidden cleanly when disabled or passes the video provider launch gate.

### D2. Character-Consistent Image Generation — Phase 1 app flow landed（2026-06-30）

Owner: product/frontend/backend/gen.

Goal: make character image generation feel like the same companion across Create preview, Generate, Chat image requests, and Gallery feedback.

Product spec: [`CHARACTER_CONSISTENT_IMAGE_GENERATION_PRD.md`](./CHARACTER_CONSISTENT_IMAGE_GENERATION_PRD.md).

Required work:

- Add `CharacterVisualProfile` as the versioned visual identity object for each character. **Done in schema and DTO.**
- Create CVP v1 from Create preview / appearance fields and mark one anchor asset as the identity image. **Backend done; official character create/update also maintains active CVP versions.**
- Update generation prompt assembly so character mode treats user prompt as scene details and always injects the active CVP identity layer. **Backend done.**
- Record visual profile id/version, consistency mode, seed, and reference asset ids on each GenerationJob or in a structured migration path through `controls`. **Backend done; also mirrored into MediaAsset metadata.**
- Update Chat image requests so Chat sends scene intent while main resolves the character identity profile. **Backend done for `chat_image` jobs.**
- Add Generate UI identity status and a Balanced / Strict / Creative consistency control. **Done in `GeneratorWorkspace.tsx`.**
- Add Gallery actions: Use as character image, Add to identity references, More like this. **Backend and UI wiring done for all three; Use as character image now versions CVP anchors; Chrome smoke passed on Generate/Gallery.**
- Add Admin visibility for official characters missing an active CVP. **Done in `OfficialCharactersView.tsx` and official character API.**
- Pass CVP anchor/reference and More-like-this source image into image worker/provider requests. **Done via `ImageGeneratePayload.referenceImages`, worker hydration, and pipeline `reference_images` request body.**
- Implement model-side reference conditioning in the pipeline service. **Partially done: local `sdcpp-image` gateway maps More-like-this source images to `--init-img`; identity refs are capability-gated and require a reference-capable profile, because current Pornmaster/Z-Image does not support identity `--ref-image`; model-profile capability flags are done via `runnerConfig.capabilities` and queue-side filtering; pending stronger face/IP adapter and style reference.**
- Add a repeatable consistency smoke runner for both text-to-image text+seed and image-to-image reference paths. **Done via `bun run launch:probe:character-consistency`; outputs generated samples, `manifest.json`, and `review.html`.**
- Run a real 20-image manual consistency smoke for at least one demo character. **Done 2026-06-30: Redcraft locked-seed package passed 17/20 (85%) against the 80% same-character threshold; see `docs/product-audits/2026-06-30-character-consistency/manual-review-summary.md`.**

Acceptance:

- Create private character -> preview anchor -> active CVP v1 exists. **Covered by `image-generation-service.test.ts`.**
- Generate image for that character -> job records visual profile version and assembled prompt uses identity + scene layers. **Covered by `image-generation-service.test.ts`.**
- Chat image request for the same character -> image job uses the same CVP, not chat-written facial traits. **Covered by `image-generation-service.test.ts`.**
- Gallery can promote a result to character image, add it to identity references, and queue More like this variations. **Backend covered by `image-generation-service.test.ts`; UI controls wired in `GeneratorWorkspace.tsx`; Chrome smoke passed on `http://127.0.0.1:3042/generate`.**
- Character generation payloads include model-usable reference descriptors for CVP anchors/references and More-like-this source images. **Covered by `image-generation-service.test.ts`, `packages/gen/src/pipeline.test.ts`, `packages/gen/src/providers.test.ts`, `providers.test.ts`, and `sdcpp-reference-images.test.ts`.**
- Local sd.cpp gateway consumes `reference_images` as executable sd-cli args. **Covered by `packages/gen/src/sdcpp-reference-images.test.ts`.**
- Model profile capabilities gate reference descriptors so text-only models keep identity prompt + seed but receive no reference images. **Covered by `image-generation-service.test.ts` and `admin-console.test.ts`.**
- Text-only and reference-backed consistency smoke can be generated without DB coupling. **Covered by `packages/gen/src/probe-character-consistency.ts`; Redcraft 20-sample manual review passed 85% for the current local/internal beta evidence.**
- 2026-06-30 real pipeline 2-sample smoke passed for both text+seed and reference-backed Sarah Mercer paths (`.tmp/consistency-sarah-text-smoke`, `.tmp/consistency-sarah-reference-smoke`); this proves the live path is executable. The separate Redcraft locked-seed 20-sample package now supplies the required manual review evidence for one demo character.
- Official characters expose active/missing identity state and version CVP on identity edits. **Covered by `official.test.ts`.**
- A 20-image manual smoke for a demo character reaches at least 80% "same character" judgment in Balanced mode. **Covered for Redcraft locked-seed Balanced: 17/20, 85%. Strict-vs-Balanced comparison remains future profile tuning rather than an internal beta blocker.**

### E. Billing And Entitlements — ✅ local portal behavior landed (2026-06-29)

Owner: backend/ops.

Goal: keep local entitlement behavior coherent for demos. Real payment provider work is deferred.

Landed for local/internal beta: Profile now distinguishes free vs active billing states.
Inactive users get a Compare plans path; active users see plan + renewal date and can
cancel or resume renewal without losing current-period entitlements. API coverage:
`billing/portal`, `billing/cancel`, and `billing/resume`; E2E covers the free and
Premium profile states. Real payment-provider portal behavior remains future
public-launch work.

Also landed on 2026-06-29: local/mock checkout is explicitly labeled as demo-only in
Upgrade (`Demo checkout`, `Demo upgrade`, and "No real payment is collected").
The server gates checkout auto-confirm to `PAYMENT_PROVIDER=mock`; non-auto-confirm
checkout creates an invoice/checkout URL without activating a subscription or
granting dreamcoins.

Required work:

- Keep BTCPay checkout creation and webhook settlement in the future public-launch checklist.
- Remove or hide auto-confirm checkout before any external beta or public traffic. **Status: auto-confirm is now mock-provider-only and presented as demo behavior.**
- Confirm entitlement derivation and dreamcoin grant idempotency. **Status: covered.**
- Add billing portal behavior for active/inactive subscriptions. **Status: local/mock behavior covered.**

Acceptance:

- Local/mock checkout remains clearly marked as demo-only. **Status: covered.**
- Profile reflects plan and dreamcoin balance.
- Profile reflects inactive billing, active renewal date, cancel-at-period-end, and resume-renewal states.
- Entitlement derivation and dreamcoin grant behavior remain idempotent in tests.
- Auto-confirm checkout is not presented as production behavior. **Status: covered for current mock/local mode.**

Future public-launch acceptance:

- BTCPay checkout creates a real invoice.
- Settled webhook activates subscription once.
- Duplicate webhook does not double-grant.
- Payment probe and billing E2E pass against the real provider.

### F. Reports, Moderation, And Compliance

Owner: trust/backend/ops.

Goal: keep reports and admin moderation usable in local/internal scope. Go.cam work is deferred.

Required work:

- Keep Go.cam age verification setup in the future public-launch checklist.
- Ensure reports for character, media, message, feed item, and profile reach admin moderation.
- Add appeal/help entry points for blocked outputs. **Status: Help Desk now has support links, FAQ, signed-in support request intake, durable `SupportRequest` records, Roadmap voting backed by `ProductFeedbackItem`/`ProductFeedbackVote`, and an admin/support inbox with triage states, saved views, resolution notes, audit logging, derived SLA state/due/remaining fields, overdue/due-soon/on-track/paused/closed filtering, and audited SLA escalation for time-sensitive tickets. External notification routing can remain a future volume-driven enhancement.**
- Confirm hard-policy content cannot be published or generated.

Acceptance:

- Admin moderation queue can review reports and apply decisions.
- Character Review Queue supports saved search/report-filter views for recurring triage slices.
- Reports from character, media, message, feed item, and profile land in the queue.
- Known blocked fixture is blocked in local chat/create/generate tests where the local provider supports it.
- Age-gated UX remains clear that it is not Go.cam verification.

Future public-launch acceptance:

- Age verification probe returns a Go.cam provider session with HTTPS verification URL.

### G. Feed And Community Productization — ✅ 已落地（2026-06-28，含明确取舍）

Owner: product/frontend/backend.

Goal: Feed and Community stop looking like a catalog mirror and become credible discovery surfaces.

**落地**：新增创作者公开主页 `GET /api/v1/creators/:id` + 路由 `/creators/[id]`（displayName/头像/统计 + 其 public+approved 角色网格 + isFollowing/isSelf），Community dreamer 卡名链入该页；`characterDTO` 修正为带真实 `creatorName`（include creator User），Feed 卡片加「by {creatorName}」链接；无图角色 fallback 图按角色 id 稳定分散到现有 card image set，避免 Feed/Explore 同图重复；follow 状态持久（已有）+ UI 可切换（Community dreamer 卡 + 创作者主页乐观更新），community dreamers 回 `isFollowing`；Feed 加载/空态补齐；Feed share 深链会验证并聚焦目标卡，Remix 会通过后端返回的 URL 带上 `characterId` + `remixFeedItemId`，Generate 会拉取并选中来源角色，生成任务写入 `feed_remix` provenance，生成出的 Gallery 媒体显示 `Remixed from Feed` 来源 badge 并能点回原 Feed 卡；Profile media 卡支持创建 private/public collection 或加入已有 collection，public collection 会把自有媒体提升为 `public_pack` 并出现在 Community Collections；Feed 首页会混排公开 media collection 卡，支持 `collection:<id>` share 聚焦、report、loaded preview 和稳定分页。后端测试覆盖 creator profile + follow 状态 + 404 + owner-only media collection publish + feed share/remix provenance + collection feed card/focus/report/pagination + media gallery provenance DTO + fallback art distribution；E2E 覆盖 community→creator 导航、follow 切换、Profile media -> public collection -> Community card、Feed collection card、Feed share/remix/generation lineage 和 first-page eager image loading；Chrome 复验 `community-collection-published.png`、`feed-share-remix-focused.png`、`feed-remix-generate-selected.png`、`feed-lcp-fallback-eager.png`、`feed-remix-gallery-provenance.png`、`feed-collection-card-focused.png`。**明确取舍（YAGNI / 计划允许"暂隐"）**：个性化排序/更复杂运营编排未来公开上线再增强；当前基础 collection item type、share 深链、remix 生成来源与 Gallery 回链已落地。

Required work:

- Define Feed item types and ranking beyond public character cards. **Status: basic public media collection item type is live in Feed; future work is richer personalization/merchandising ranking, not a beta blocker.**
- Define creator public profile scope or intentionally hide links. **Status: creator public profile is live via `/creators/:id` with display profile, public approved character grid, follow/isSelf state, Community dreamer links, backend tests, E2E, and Chrome evidence.**
- Add collection semantics or hide collections until ready. **Status: basic creator media collections are now live end-to-end: owner-only create/add APIs, Profile media UI, `public_pack` media promotion, Community public listing, Feed collection cards, E2E, and Chrome evidence.**
- Add follow state, share URLs, and remix lineage. **Status: follow、share 深链、collection deep link、Remix -> Generate 来源选择、generation job provenance、Gallery 来源 badge/回链已落地；未来仅剩 Feed 个性化/运营排序增强。**
- Add empty/loading/error states for low-data communities.

Acceptance:

- Feed actions have durable state or intentionally scoped analytics-only behavior; share/remix must not silently point to the wrong character.
- Community filters work with real data.
- No launch-visible tab promises an unimplemented domain.

### H. Documentation Reconciliation

Owner: product/engineering.

Goal: docs do not contradict current code state.

Required work:

- Mark `CURRENT_FUNCTIONAL_COVERAGE.md` as current status.
- Move stale `ProductFeatureMap.md` "未实现" rows into historical context or update them. **Creator/profile/billing conflicts updated on 2026-06-29; continue this check when product scope changes.**
- Update launch runbook with current blocker ordering.
- Keep generated audit output linked from product docs.

Acceptance:

- A new engineer can read docs and know what is implemented, blocked, deferred, and launch-critical.

## Execution Order

### Phase 0 - This Week

1. Add catalog hygiene probe. **Done.**
2. Produce future public-launch secret checklist from `.env.production.example` files. **Done 2026-06-29: `docs/product/PRODUCTION_SECRET_CHECKLIST.md`.**
3. Clean preview/demo DBs of e2e/test fixture rows. **Current local dataset passes catalog probe after `db:seed`; repeat seed + catalog probe for every preview/demo DB before use.**
4. Re-run public route, catalog, and PM screenshots. **Catalog and Chrome PM audit evidence updated on 2026-06-29.**

Exit criteria:

- Public catalog probe passes.
- PM screenshots no longer show test fixture content.

### Phase 1 - Internal Beta Gate

1. Keep active Pipeline-backed image and chat paths passing through `bun run launch:probe:pipeline`.
2. Keep BTCPay, R2/S3, Go.cam, and Sentry documented as deferred, not missing current tasks.
3. Decide whether voice is in the internal demo promise. If yes, connect MOSS-TTS v1.5 through `PIPELINE_VOICE_API_URL` and require `bun run launch:probe:pipeline -- --include-voice`.
4. Run catalog probe and clean demo data until it passes.
5. Record expected public-launch gate failures caused by deferred providers.

Exit criteria:

- Internal demo flows pass without e2e/test fixture content.
- Deferred providers are visible in docs and cannot be mistaken for completed production readiness.
- Public launch gate is still allowed to fail for the deferred provider checks.

### Phase 2 - Beta Experience Completion

1. Upgrade Create to guided flow. **Done 2026-06-28.**
2. Upgrade Generate controls and states. **Done 2026-06-28.**
3. Add blocked/failed/refund UX. **Done 2026-06-28.**
4. Dogfood full first-session journey. **Chrome audit evidence updated 2026-06-29; keep repeating before demos.**

Exit criteria:

- First-session path from age gate to signup to create/chat/generate/upgrade completes without PM caveats.

### Phase 3 - Public Launch Hardening

This phase is parked until Go.cam, BTCPay, R2/S3, and Sentry are explicitly reactivated.

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
- `codex/launch-providers`: parked future work for Go.cam, BTCPay, R2/S3, and Sentry.
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
