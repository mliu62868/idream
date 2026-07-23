# iDream Remaining Work Execution Plan

Updated: 2026-07-18

## Current State

The product is a working local MVP. After the 2026-06-26 scope decision, the active milestone is **internal demo / controlled beta**, not public launch.

Use these documents as the current source of truth:

- `docs/product/CURRENT_FUNCTIONAL_COVERAGE.md`: local flow coverage.
- `docs/product/LAUNCH_READINESS_AUDIT.md`: production blockers.
- `docs/product/PRODUCTION_SECRET_CHECKLIST.md`: production env and secret checklist.
- `docs/product-audits/current-implementation/pm-audit.md`: PM/UX gaps.
- `docs/product/ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN.md`: management-console correctness, operating model, migration gates, and 90-day remediation sequence.

### 2026-07-18 current local truth

The current revision has passed the database, static, full-test, fresh-E2E, immutable-build, PM2, HTTP, local-browser, and three-layer backup/restore portions of the controlled-beta gate. This is a local controlled-beta assessment, not a public-launch claim.

- All 60 Main migrations pass fresh replay, existing-snapshot upgrade, repeat deploy, application rollback/forward-fix rehearsal, current deploy/status, and zero drift.
- The Chat DB boundary passes its positive capability path and all 15 negative denial checks. `chat_service` is the request role; the explicit `chat_projector` connection owns durable-file projection and receipt completion.
- The final checkpoint source has 60 migrations (latest `20260718012000`), 20 users, and 16 characters / Releases / live Servings / active qualifications / media assets; 234 base tables, 7 views, and 1 sequence. All 16 authority assertions pass with zero broken chains. Main outbox is `3,936` with zero pending/failed, and Main inbound is `5,738` with zero received. Chat has 294 sessions / 818 messages / 4 attachments, outbox `1,552` and inbox `488` with zero pending/failed, and 5 file mutations with zero pending. Redis operational queues have zero pending/failed.
- Official editorial seed is governed cold-start supply that travels through DB → Release → Serving → Qualification. It is neither a test fixture nor evidence of organic activity. Actor-scoped personal pages remain truthfully empty when there are no chats, likes, follows, history, or counters; the current critical-surface gates found no deterministic P0/P1 fake-data path.
- Generate contract parsing, request-scoped stale authority, fail-closed source/profile capability handling, and retry recovery are repaired. Dynamic character metadata now reads the character SSoT while preserving the established `noindex` rule.
- Every protected Admin v2 operation now authenticates before body parsing or data access; the authority execution matrix locks unauthenticated requests to 401. Prisma 7 `P2034` and adapter-pg `TransactionWriteConflict` are classified through one serializable-conflict seam; atomic idempotent mutations retry at most three times and concurrent reconciliation/mutation regressions prove convergence to one tombstone or committed result.
- Four ComfyUI workflows are visible after sync/readback (`qwen-image-edit-img2img`, `qwen-image-edit-multi-identity`, `qwen-image-edit-multi-reference`, `redcraft-krea2-txt2img`), with successful single-reference, dual-identity, and identity-plus-source artifacts. These are local runtime proofs, not publish qualification or production-capacity evidence.
- The final full suite passed: Shared `36 files / 175 tests`, Admin `89 / 397`, Gen `14 / 117`, Main `219 passed files + 2 skipped files / 1,585 passed + 3 skipped tests`, and Chat `27 / 212`; total `385 passed files + 2 skipped files / 2,486 passed tests + 3 skipped tests`. Root lint passed `2/2`, and typecheck passed `6/6`.
- Fresh Playwright used `PW_RUN_ID=c3d4e5f6` on isolated ports 3880–3883 and passed `164/164` in 4.5m. The run launched Main, Admin, Chat, and workers from a disposable database and proves the explicit Chat projector wiring is part of the real environment, not only a unit fixture.
- Root production build passed `5/5`. A real 834px browser check then found home `scrollWidth=1047`; the TopControls breakpoint fix passed its isolated E2E `1/1`, followed by the final Main-only immutable build. Final Main is `idream-f7579f81-cc0e-419f-a259-9f6f78c962f9` / `build-TfctsWXpff2fKS`; final Admin is `idream-8838f3a3-c801-47cd-8df7-36c96cb88447` / the same build ID.
- PM2 has 7 logical apps / 8 processes online. `/`, `/explore`, and `/admin/today` return 200; Chat `/healthz` is `ok`. Main critical pages at 1440px/375px have no overflow or console error, and final 834px home has `scrollWidth=834` with filters in bounds. Admin Today, Characters, Creative, Incidents, and Cases are `zh-CN`; 375px/834px have no overflow and console errors are zero.
- `redcraft_krea2_default` is ready. The real workflow-native `BackendImageModel → ComfyUI 0.28.0` MPS smoke passed at 832×1024, 880,175 bytes, and 132,649ms. The production worker uses `GEN_IMAGE_PROVIDER=backend` against ComfyUI 8188.
- `launch:probe:pipeline --include-catalog` is honestly `6/7`: web, product config, chat service, chat model, voice, and catalog pass; only the legacy `pipeline@8091` image check fails because that gateway is not running. This is not a failure of the current workflow-native backend, and the pipeline suite must not be called passing.
- Local data protection is closed by the quiesced Main PostgreSQL + `CHAT_FS_ROOT` + local Blob checkpoint at artifact base `/Users/kk/code/idream/local-backups/idream-main-final-20260718-60/idream-main-final-20260718-60`. Its bundle directory is mode `0700`; all 23 files are mode `0600`; total size is 171M; all bundle SHA checks pass. `CHAT_FS_ROOT` contains 429 files / 550,987 bytes and Blob contains 13,634 files / 162,163,688 bytes; Main and Gen resolve the same effective mock Blob root.
- PostgreSQL client `18.3` restored against server `16.14`. Source-to-restore counts, schema, logical DB, Chat FS, and Blob comparisons are all equal with zero difference; the disposable restore DB has zero remaining instances after cleanup. PM2 was restored to 7 logical apps / 8 processes, all online; Main and Admin HTTP are 200 and Chat health is `ok`.
- The database reset incident and its recovery limit are recorded verbatim in `CURRENT_FUNCTIONAL_COVERAGE.md`; this final backup is post-incident current-state evidence, not a pre-reset archive.
- Production providers, production canaries, production data backfills, and public-launch readiness remain `NOT_EVALUATED`.

The 2026-07-11 Admin correctness review found that several Admin surfaces were interactively covered without certified state/metric semantics. The local implementation now closes the principal code-owned authority paths: shared v2 contracts/permissions; source-decoupled fail-closed Admin BFF; reconstructable Today/search/SavedViews plus pageable All Work; official Character creation and immutable Release/Serving/Visual Qualification lifecycle; Creative direction snapshots/review/placement with end-to-end lineage; Generation Request/Attempt/Transport/Artifact/Delivery/Settlement, provider-native cost facts and idempotent cancellation; Incident detect/assign/action/verify/split/merge/postmortem-close with versioned correlation policy; typed Case wait/reopen/recurrence and Incident linking; Customer 360; monotonic Chat correction facts; canonical events/facts/metrics/experiments; atomic approval/Command/Audit/Outbox; database-enforced immutable evidence; executable §19.4 reconciliation and SLO readiness; and independent Next 16 Admin routes with an accessible responsive shell. Incident, Customer Case, and Review Case now share one durable production backfill runner/CLI with persisted pause/resume, crash continuation, idempotent rerun, and mismatch-failing reports; this closes the code-owned execution seam only, while running it against a dedicated production snapshot and proving zero mismatches remain external Gate evidence. The schema-v5 final Gate now requires immutable digested artifacts signed by trusted collectors, independent role-bound Product/Engineering/Release approvals of one canonical digest, a final release envelope, fixed representative read/write canaries with Command/Audit/Outbox authority, two zero-legacy cycles and the mature observation window. Data/Design/Operations remain mandatory Gate contributors through the evidence they own and may add optional role attestations; they are not extra final Go approvers. Trust comes only from an external public-key registry; release-key possession alone cannot create collector or DRI authority. Remaining work is external/production evidence and authority: provision the release, collector and three required DRI key pairs plus independent trust registry outside the repository; run the production backfills and reach zero-mismatch shadow on a dedicated snapshot; establish real Character/exposure/journey/D7 and payment attribution coverage; ingest provider-native dispute facts; mature canonical experiment guardrails across two shadow windows; execute and immutably collect production browser/API and fixed read/write canaries; reach legacy traffic zero; sustain the error-budget observation window; collect the Data/Design/Operations Gate results; and obtain Product/Engineering/Release approval. Local code, fixture data, unsigned manifests, one-time smoke results, or release-key-only envelopes must not be counted as final cutover. The remediation plan above remains the execution SSoT.

Local Admin closure inventory on 2026-07-12: 76 v2 route files expose exactly 84 HTTP operations; 130/130 unique request/response refs are executable with pending=0; 55/55 mutations have declared idempotency or optimistic-concurrency transport with pending=0. The BFF validates every successful v2 response against that manifest in the serving path. Phase 5 catch-alls are reduced to a 983-line frontend shell and 494-line main route table. These are code-owned completion facts, not production Go evidence.

Historical launch-gate snapshot from 2026-07-11: `7 pass / 50 fail / 2 warn`.

That historical failure was expected while the deferred production providers below remained out of scope. The additional 2026-07-04 failure was the stricter `PUBLIC_CATALOG_PROBE_REPORT` requirement; its catalog report is retained at `docs/product-audits/2026-07-04-launch-catalog-gate-audit/public-catalog-probe.json` and is not presented as a current launch verdict.

Historical product/browser evidence snapshot from 2026-07-05:

- Core Playwright E2E: `flows.e2e.ts` passed `9/9`.
- Current full Playwright E2E: `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3214 PW_ADMIN_BASE_URL=http://127.0.0.1:3006 BULLMQ_PREFIX=idream:e2e:3214-full bun --cwd packages/main playwright test src/e2e` passed `137/137`.
- Chrome current-flow proof: Explore -> detail -> signup return -> Generate queued/completed/Gallery -> Chat message roundtrip -> Create private save -> mock Upgrade -> return to Generate, with console warnings/errors `[]`.
- Evidence: `docs/product-audits/2026-07-04-core-flows-current-e2e/`.
- Public-route Playwright E2E: `public-routes.e2e.ts` passed `51/51`.
- Full UI workflow Playwright E2E: `ui-workflows.e2e.ts` passed `56/56` after locator hardening for duplicate valid `Join Free` links.
- Admin web Playwright E2E: `admin-web.e2e.ts` passed `25/25` against main `3213` and admin `3005` after narrowing confirmation-dialog locators to exact textbox roles.
- Chrome public-surface proof: `/`, `/resources-hub`, `/helpdesk`, `/terms`, `/safety/introduction`, and `/profile/account-management`, with Help Desk request `SUP-VAUVQYM4DP`, no broken images, no horizontal overflow, no sampled external-link marker drift, and console warnings/errors `[]`.
- Evidence: `docs/product-audits/2026-07-04-public-surface-current-e2e/`.
- Admin Content Ops image Chrome proof: Asset Library and Placements visible `/user-content` images are eager after the LCP-warning fix, future missing media has an `AssetImage` fallback, `brokenVisible=[]`, `incompleteVisibleUserContent=[]`, horizontal overflow is false, and console warnings/errors `[]`.
- Evidence: `docs/product-audits/2026-07-04-admin-asset-library-current-audit/`.
- Public catalog post-E2E cleanliness proof: Chrome initially exposed a manual audit public collection `Chrome handoff 1783177343553` in Feed/Community; the exact local fixture was removed, `probe:catalog` now covers public media collections and browser-audit markers, and the after-cleanup probe passes with 16 public characters, 3 public collections, 13 public creators, 16 distinct images, and 0 issues. Chrome after-cleanup `/explore`, `/feed`, `/community`, plus scrolled lazy-load checks show no fixture text, no broken/incomplete visible images, no horizontal overflow, and console warn/error logs `0`. The 2026-07-05 Help Desk roadmap audit extended the same probe to public roadmap feedback items after Chrome found 3 old public `Chrome ...` feedback fixtures; after cleanup the probe passes with 3 public feedback items and 0 issues.
- Evidence: `docs/product-audits/2026-07-04-public-catalog-post-e2e-cleanliness-audit/`.
- Promo redeem cross-surface proof: Chrome first reproduced that an admin-created code `CHROME-PROMO-1783205351191` appeared in `/admin/promo` but failed from `/profile` with `Redeem code not found`; after unifying redeem-code hashing and adding max-redemption enforcement, the same pre-fix SHA-backed code redeemed successfully, balance moved `7,145 -> 7,222`, replay returned `Code already redeemed`, admin redemptions showed `1`, and DB ledger showed `redeem +77`.
- Evidence: `docs/product-audits/2026-07-04-promo-redeem-cross-surface-audit/`.
- Promo copy truthfulness proof: public promo surfaces now use neutral `Pride offer` copy/assets that route to `/upgrade` without promising unsupported sale terms. Chrome verified `/` -> visible promo DOM CUA click -> `/upgrade`, no `75%`/`Pride Sale`/`Upgrade Now`/retired sale asset matches, and console warnings/errors `[]`; `public-routes.e2e.ts` guards both active and hidden promo surfaces.
- Evidence: `docs/product-audits/2026-07-04-promo-copy-truthfulness-audit/`.
- Community leaderboard current proof: Chrome verified `/community` renders 13 Dreamers, 16 Characters, and 3 Collections; the visible `1 characters` copy drift was fixed to `1 character`, collection previews load after scroll, and `/feed` collection cards no longer have bad singular labels.
- Evidence: `docs/product-audits/2026-07-04-community-leaderboard-current-audit/`.
- Profile muted-tags preference proof: Profile now exposes content-tag muting, persists `mutedTags` in `user_preferences`, rehydrates the checked state after reload, and Explore hides user-muted category chips/results. Chrome verified `Mute Slow Burn` -> `mutedTags=["slow-burn"]` -> Explore without `Slow Burn`; focused API/UI tests and root typecheck pass.
- Evidence: `docs/product-audits/2026-07-04-muted-tags-preferences-audit/`.
- Community campaign carousel proof: Community now consumes published Content Ops `campaign` placements. Chrome verified newest-first banner rendering, next/previous carousel controls, eager hero images, CTA, accessible `Campaign N of M` label, filter/list continuity, no overflow, and no console warnings/errors.
- Evidence: `docs/product-audits/2026-07-04-community-campaign-carousel-audit/`.
- Global search suggestions proof: app-shell search now consumes `/api/v1/search/suggest`, renders character/tag/route suggestions with thumbnails or route icons, supports keyboard handoff to detail/content pages, keeps the Explore GET fallback, and filters live suggestions through public approved/non-deleted plus user-muted-tag rules. Chrome verified `/generate` topbar character and guide-route suggestion rendering, `ArrowDown` + `Enter` navigation, loaded detail/content pages, no overflow, no console warnings/errors, and fixture cleanup for the seeded character proof.
- Evidence: `docs/product-audits/2026-07-04-global-search-suggestions-audit/`.
- Evidence: `docs/product-audits/2026-07-04-global-search-route-suggestions-audit/`.
- Global search status proof: Chrome first reproduced no-result suggestion feedback as visible `No suggestions found` text that was not connected to the input and had no role/live semantics or stable test id; the fixed state connects the input with `aria-describedby="app-search-status"` and exposes the message as `role="status"` with `aria-live="polite"` and `data-testid="app-search-status"`. Focused global-search E2E now locks character suggestion, guide-route suggestion, and empty suggestion status behavior, and Chrome post-fix console warnings/errors are `[]`.
- Evidence: `docs/product-audits/2026-07-05-app-search-status-audit/`.
- Explore grid status proof: Chrome verified the ready Explore grid, forced a real load failure that exposed retryable `role="alert"` / `aria-live="assertive"` feedback and the old stale-card contradiction, and then verified the post-fix clean empty state with 0 character links, `role="status"`, `aria-live="polite"`, no horizontal overflow, and only dev HMR/React DevTools logs. Focused Explore E2E now locks initial failure, Retry to empty results, and stale-card clearing on a later failed search.
- Evidence: `docs/product-audits/2026-07-05-explore-grid-status-audit/`.
- Age Gate status proof: Chrome verified fresh `/generate` remains gate-only with no `<main>`, a real failed accept request stays on the gate and exposes retry copy as `data-testid="age-gate-status"` with `role="alert"` and `aria-live="assertive"`, and retry after server recovery opens Generate with no horizontal overflow and Chrome warning/error logs `[]`. Focused age-gate E2E passed 4/4.
- Evidence: `docs/product-audits/2026-07-05-age-gate-status-audit/`.
- Article content route proof: guide routes now render data-driven readable sections and a real FAQ target instead of repeating one generic paragraph across Overview/How it works/Best practices. Focused Playwright verified `/guides/character-cards` specific intro/body/FAQ copy, `FAQ -> #faq`, no old repeated template paragraph, no overflow, and no console warnings/errors.
- Evidence: `docs/product-audits/2026-07-04-article-content-routes-audit/`.
- Comparison route authority: the dedicated `/comparison` product page remains available. The earlier `/comparison/character-ai-alternative` template proof is historical only; that inventory path is no longer treated as authored content and now returns 404 until an explicit CMS version is published.
- Historical evidence: `docs/product-audits/2026-07-04-comparison-route-content-audit/`.
- Resources Hub readable card proof: `/resources-hub` now sources card titles/descriptions from route metadata instead of path suffixes, so visible cards show readable titles like `How To Use Character AI` and no raw slug copy like `how-to-use-character-ai`. Focused E2E and Playwright evidence verified readable copy, no overflow, and no console warnings/errors.
- Evidence: `docs/product-audits/2026-07-04-resources-hub-readable-cards-audit/`.
- Library route authority: the earlier `/games` and `/romantasy` curated-template proof is historical only. Route inventory is not publication authority; those generic paths now return 404 until dedicated content or an explicit CMS version exists.
- Historical evidence: `docs/product-audits/2026-07-04-library-curated-route-cards-audit/`.
- Chat hub entry proof: `/chat` remains the real session hub, but signed-in empty and signed-out states now include a `Start a conversation` rail with three real character routes plus Explore/Create actions. Focused E2E verified signup return and card/action hrefs; Chrome verified signed-in empty, signed-out, and featured-character handoff states with console warnings/errors `[]`.
- Evidence: `docs/product-audits/2026-07-04-chat-hub-entry-rail-audit/`.
- Chat composer empty-send proof: Chrome first reproduced that an empty composer exposed an enabled `Send message` button with no visible feedback; the fixed state keeps empty and whitespace-only drafts disabled and enables Send only after real text. Focused chat E2E now locks empty/whitespace disabled, typed enabled, send/report/reply/reload persistence, and Chrome post-fix console warnings/errors are `[]`.
- Evidence: `docs/product-audits/2026-07-04-chat-empty-send-audit/`.
- Create validation status proof: Chrome first reproduced that invalid-age feedback was visible but not exposed as a status/live region; the fixed state keeps the user on Identity and exposes `Age must be between 18 and 99.` as `role="status"` with `aria-live="polite"`. Focused Create E2E now locks the same attributes, and Chrome post-fix console warnings/errors are `[]`.
- Evidence: `docs/product-audits/2026-07-04-create-validation-status-audit/`.
- Auth error status proof: Chrome first reproduced that invalid-login feedback and the recovery link were visible but the error text/container had no role/live semantics; the fixed state exposes `Invalid email or password` as `role="alert"` with `aria-live="assertive"` while preserving `Contact Help Desk -> /helpdesk`. Focused Auth E2E now locks invalid-login and duplicate-signup error semantics, and Chrome post-fix console warnings/errors are `[]`.
- Evidence: `docs/product-audits/2026-07-05-auth-error-status-audit/`.
- Feed action semantics proof: Chrome first reproduced that the first Feed card exposed `aria-pressed="false"` on Chat, Remix, Like, Share, and Report; the fixed state keeps `aria-pressed` only on the Like toggle while Chat/Remix/Share/Report render as ordinary command buttons. Focused Feed E2E now locks both non-toggle and Like-toggle semantics, and Chrome post-fix console warnings/errors are `[]`.
- Evidence: `docs/product-audits/2026-07-05-feed-action-semantics-audit/`.
- Feed/Community status proof: Chrome first reproduced Feed `Report submitted.` and Community `Profile report submitted.` as polite live text without `role="status"` or stable test ids; the fixed state exposes `feed-status` and `community-status` as `role="status"` with `aria-live="polite"`. Focused Feed and Community E2E now lock those attributes, and Chrome post-fix console warnings/errors are `[]`.
- Evidence: `docs/product-audits/2026-07-05-feed-community-status-audit/`.
- Help Desk status proof: Chrome first reproduced support request success feedback as `role="status"` with `aria-live=null`; the fixed state exposes `helpdesk-status` as `role="status"` with `aria-live="polite"`, and the same explicit polite live-region contract now covers roadmap feedback and appeals. Focused Help Desk E2E locks all three status attributes, and Chrome post-fix console warnings/errors are `[]`.
- Evidence: `docs/product-audits/2026-07-05-helpdesk-status-audit/`.
- Help Desk roadmap status and hygiene proof: roadmap voting list loading/empty/error states now expose `feedback-list-status`; load failures are assertive retryable alerts and manual refresh lets users reload stale roadmap items. Chrome first caught 3 public roadmap fixture items, the strengthened public catalog probe failed closed, local cleanup removed them, Chrome recovered to clean roadmap items with fixture matches `[]`, and the after-cleanup probe passed with 3 public feedback items and 0 issues. Focused Help Desk E2E forces an app-level roadmap load failure, clicks Retry, then completes support request, roadmap idea/vote, and appeal submission.
- Evidence: `docs/product-audits/2026-07-05-helpdesk-roadmap-status-audit/`.
- Chat status proof: Chrome first reproduced message report success feedback as `role="status"` with `aria-live=null` and no stable test id; the fixed state exposes `chat-session-status` as `role="status"` with `aria-live="polite"`. Focused Chat E2E now locks message report and free daily quota status attributes, and Chrome post-fix console warnings/errors are `[]` (raw dev log entries are React DevTools/HMR info/log only).
- Evidence: `docs/product-audits/2026-07-05-chat-status-audit/`.
- Chat panel status proof: in-session `Your chats` drawer and `Memory and relationship` panel now expose stable status regions for loading, empty, and load-error states. Chrome captured server-down drawer/memory alerts with `Retry`, clean recovered drawer/memory states, no memory-panel warning/error logs, and no overflow; focused Chat E2E clicks `Retry` after forced drawer and memory 500s, then completes session rename/archive/delete and memory edit/delete/reset workflows.
- Evidence: `docs/product-audits/2026-07-05-chat-panel-status-audit/`.
- Chat image current proof: Chrome signed up through Melissa detail, opened Chat, requested an image, verified the generating attachment, completed job, More-like-this variation, Generate handoff with Melissa selected, ledger/jobs/media/chat attachment persistence, and cleanup. The audit first caught a Chat-only blank completed preview bug; after the fix Chat renders `Image unavailable` / `Preview unavailable` fallback while keeping More-like-this and Open in Generate actions. Focused Chat image E2E now covers both a valid completed attachment and a blank completed attachment fallback.
- Evidence: `docs/product-audits/2026-07-05-chat-image-current-audit/`.
- Profile account-management proof: Chrome verified signup return to `/profile/account-management`, sign-out-all returning to `/login`, destructive delete disabled until exact `DELETE`, wrong confirmation staying disabled, account deletion returning to `/login`, deleted-account credential login blocked with an assertive auth alert, browser warning/error logs `[]`, DB terminal state, and fixture cleanup.
- Evidence: `docs/product-audits/2026-07-05-profile-account-management-current-audit/`.
- Upgrade billing proof: Chrome verified signup return into `/upgrade?plan=premium&billing=monthly&returnTo=/profile%23billing`, Premium monthly demo activation, polite checkout status, `View billing` to `/profile#billing`, active Profile billing card with `benefitsEndAt` and explicit no-automatic-renewal copy, no cancel/resume/manage controls for prepaid providers, browser warning/error logs `[]`, DB subscription/ledger/analytics terminal state, and fixture cleanup.
- Evidence: `docs/product-audits/2026-07-05-upgrade-billing-current-audit/`.
- Character detail status proof: Chrome first reproduced that signed-in `Like` success feedback on `/characters/melissa-burke` was visible but had no live status semantics or stable test id; the fixed state exposes `Character liked.` as `role="status"` with `aria-live="polite"` and `data-testid="character-detail-status"`. Focused Character detail Like E2E now locks those attributes, and Chrome post-fix console warnings/errors are `[]`.
- Evidence: `docs/product-audits/2026-07-05-character-detail-status-audit/`.
- Generator status proof: Chrome first reproduced that a real `Generate` submit on `/generate?characterId=melissa-burke` showed `Generation queued.` without live status semantics or a stable test id; the fixed state exposes it as `role="status"` with `aria-live="polite"` and `data-testid="generator-status"`, while config-load errors use assertive alert semantics. Focused Generator E2E now locks those attributes, and Chrome post-fix console warnings/errors are `[]`.
- Evidence: `docs/product-audits/2026-07-05-generator-status-audit/`.
- Gallery current quality/CRC proof: Chrome direct-open exposed an invalid-checksum PNG that the old sanity checker accepted but Chrome decoded as `naturalWidth=0`; shared PNG sanity now validates chunk CRCs before accepting output. Final Chrome proof showed a valid `64x64` Gallery image rendering normally, tiny/blank cards rendering `Preview unavailable`, no overflow, warning/error logs `[]`, and temp audit cleanup at 0 remaining users/media.
- Evidence: `docs/product-audits/2026-07-05-gallery-current-quality-audit/`.
- Creator Follow semantics proof: Chrome first reproduced that the Creator Profile Follow button was a stateful control without `aria-pressed`; the fixed state exposes `aria-pressed="false"` before following and `aria-pressed="true"` after the click, and the creator status fallback now uses polite live status semantics. Focused creator-profile E2E now locks the toggle state, and Chrome post-fix console warnings/errors are `[]`.
- Evidence: `docs/product-audits/2026-07-05-creator-follow-semantics-audit/`.
- Admin action status proof: the Admin shell now exposes top-level errors as assertive alerts and global successful admin actions as polite status feedback via `admin-action-status`. Focused admin E2E on a fresh main/admin dev bundle now locks `role="status"` and `aria-live="polite"` while preserving the user status, permission override, billing adjustment, and audit-log flow.

Current internal Pipeline probe:

```bash
bun run launch:probe:pipeline
```

Historical local result from 2026-06-30:

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
- voice: the former pipeline/Qwen smoke remains historical evidence. Current
  authority is `VOICE_PROVIDER=pocket-tts` through the local `8062` gateway,
  with a real WAV probe plus Admin clone/profile persistence proof required
  before voice cloning is included in a demo. The 2026-07-23 local WAV probe
  passes, but the unauthenticated runner reports `voice_cloning:false`; accept
  the model terms, provide `HF_TOKEN`, restart `pocket-tts`, then capture the
  remaining real clone/profile proof.

Current 2026-07-17 runtime supplement:

- Chat boundary SQL is double-application idempotent, and the signed-BFF live SSE probe passes through DB-finalized `done` and reload.
- ComfyUI sync/readback exposes four iDream workflows. The successful artifacts are `/private/tmp/idream-qwen-img2img-smoke.png` (SHA-256 `3e0bdfa40aa9f70fa7c6fbaeb38f360254c89febf31988221ae2ef2b54fc5ea5`), `/private/tmp/idream-qwen-multi-identity-smoke/sample-01.png` (SHA-256 `965c9f20dd71cd294429bc7c87e940328d441fd48380599aee533343162cb512`), and `/private/tmp/idream-qwen-identity-source-smoke.png` (SHA-256 `b2361c115cf2b8351303cc468d82661f0a40074bee4b026927bcf4e9a889d6e5`), each 832×1216.
- Descriptor validation, ComfyUI visibility, artifact execution, profile publish qualification, and production capacity are distinct gates; no local smoke substitutes for the latter two.

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
- Keep the Pocket TTS `8062` gateway healthy, run the real voice probe, and
  verify one Admin clone creates a preview, versioned profile, and active
  `Character.voiceId` before promising voice in a demo.
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
bun run launch:probe:catalog -- --report .tmp/public-catalog-probe.json
bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json
bun run launch:probe:chat -- --report .tmp/launch-chat-probe.json
```

If voice is included in the active demo promise, also run:

```bash
pm2 start ecosystem.config.js --only pocket-tts --update-env
curl -fsS http://127.0.0.1:8062/health
bun run launch:probe:voice:local
```

Future public-launch acceptance:

```bash
bun run launch:probe:voice -- --report .tmp/launch-voice-probe.json
bun run launch:probe:catalog -- --report .tmp/public-catalog-probe.json
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

- Add a catalog health probe that fails on e2e/test fixture content in public characters, dreamers, public collections, and media. **Status: implemented as `@idream/main probe:catalog`; 2026-07-04 hardening added public media collections and manual Chrome/Playwright audit markers.**
- Separate test fixtures from demo/seed content.
- Provide an idempotent editorial import path for curated official characters, assets, Releases, Servings, and qualifications. Metrics must remain real authority facts or taskful empty states; never seed “realistic” engagement.
- Add a cleanup runbook for preview/demo DBs polluted by e2e data.

Acceptance:

```bash
bun run --filter @idream/main probe:catalog -- --report .tmp/public-catalog-probe.json
```

The probe must pass before customer-facing demos or launch.

Current local catalog/data result on 2026-07-17; the 2026-07-04 browser cleanup below is retained only as historical evidence:

- `ok=true`
- `publicCharacters=16`
- `publicCollections=3`
- `publicCreators=1` (system/editorial identity)
- `publicFeedback=3`
- `distinctImages=16`
- `excluded=0`
- `issueTotals.fail=0`
- `issueTotals.warn=0`

The current dataset contains curated official supply but zero fabricated interaction.
The historical 2026-07-04 post-E2E audit proved the probe catches manual browser
residue in public Feed/Community collections. Keep the catalog probe in the pre-demo
checklist so future seed/test-data drift is caught before customer-facing walkthroughs.
Historical report: `docs/product-audits/2026-07-04-public-catalog-post-e2e-cleanliness-audit/catalog-probe-after-cleanup.json`.

### C. Create Experience Depth — ✅ 已落地（2026-06-28）

Owner: frontend/product.

Goal: Create matches the reference product promise more closely and feels like a guided character builder.

**落地**：`CreateWorkspace.tsx` 重写为 5 步向导（Identity→Appearance→Personality→Preview→Publish），保留既有 draft API 契约（createDraft→分步 PATCH(step)→preview→submit）；每步推进 autosave 到 draft，并以 localStorage 持久化向导状态实现刷新续编（draft API 无 GET，故走客户端持久化）；Preview 步有 idle/generating/complete/failed 态；Publish 区分 private(approved)/unlisted/public(pending_review，文案明确「公开角色经审核后上线」）；新增 18+/禁止内容校验文案与 name/age 校验，且当前 step 校验反馈以 polite live region 暴露。E2E (`ui-workflows.e2e.ts`) 覆盖 private success、age validation/live-region status、refresh resume、preview failure recovery、public pending_review submit；Chrome screenshot `51-create-public-review-my-ai.png` 验证 public submit 后 My AI `PENDING REVIEW` 可见；2026-07-04 Chrome Create validation status audit 复验 invalid age 的 `role="status"` / `aria-live="polite"`。

Required work:

- Replace the dense single form with a multi-step builder: identity, appearance, personality, relationship/context, tags, advanced details, preview, visibility. **Covered.**
- Preserve the existing draft API contract and autosave each step. **Covered.**
- Add preview states: empty, generating, failed, complete. **Covered.**
- Make private/public review status explicit. **Covered.**
- Add client copy for age/forbidden-content validation without exposing policy-evasion details. **Covered.**

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

**落地**：内置预设（mode/background/pose/outfit）和 active public Community presets 在 `GeneratorWorkspace` 以选择器暴露并真实生效，Community 来源用 `Community · ...` 标识——`createGenerationJob` 经 `resolvePresetPromptFragment` 把选中预设（built_in、public community 或本人所有，含归属/可见性校验）折进 prompt（image-generation-service.test 覆盖正/反例）；My Presets 支持用户保存当前 mode/background/pose/outfit/prompt 控制、应用、二次确认删除，API round-trip、DB 归档状态与 Chrome smoke 已覆盖；Image Edit 作为 Generate 内一等工作流展示 Gallery source images，选中前禁用 `Create edit`，选中后调用既有 media variation API 排队 `sourceType=media_variation`，并给出 `Image edit queued.` 反馈；premium prompt/negative-prompt 锁定时给 `/upgrade` 升级 CTA；余额不足显式可操作提示 + 购币入口；blocked（不可重试 + Get help）/failed（退款已返还；Retry 按当前费率新建 derived job 并重新 reserve）/refunded 文案明确，并已由 focused E2E + Chrome `generate-insufficient-balance.png` / `generate-recovery-states.png` 复验。Gallery 支持 like/delete/download/report/filter/empty，Download 成功/失败都有可见状态反馈，也支持 Manage 模式批量 Make private / Delete selected；tiny/blank media 使用 fallback，invalid PNG checksum 在 main/gen 入库前拒绝；`video_gen=false` 时不再显示 `Video Beta` 或 `Videos` 死入口，video 只在配置启用且有 video models 时曝光。**未做（YAGNI）**：Collections UI、画廊排序/全文搜索——后端能力在但受控 beta 低价值。

Required work:

- Improve character selector and Freeplay flow. **Covered: Generate has a character select, query/deep-link preselection, selected-character fetch fallback, and explicit Freeplay mode.**
- Surface built-in and public Community presets by type: mode, background, pose, outfit. **Covered.**
- Expose Image Edit as a first-class source-image variation flow. **Covered.**
- Show premium prompt and negative prompt gates with upgrade path. **Covered.**
- Add clear insufficient-balance, blocked, failed, refunded, and retry states. **Covered.**
- Add gallery management: like, delete, download, report, filter, and empty states. **Covered; sorting/full-text search remains intentionally deferred for controlled beta.**
- Keep video hidden unless real video provider and launch gates are ready. **Covered for current `video_gen=false` scope.**

Acceptance:

- Image generation completes and media appears in gallery. **Covered.** Historical 2026-06-29 Chrome evidence: screenshot `45-generate-image-job-completed-gallery.png`; latest 2026-06-30 pipeline probe completed image generation with 1 asset in about 97.3s. Keep a fresh Chrome gallery proof in the pre-demo checklist whenever the visible Generate UX is part of the walkthrough.
- Premium controls unlock after Upgrade. **Covered.**
- Insufficient balance blocks submission with an actionable message. **Covered.**
- Failed provider job can retry; blocked job cannot retry and points to policy/help. **Covered.**
- Video is either hidden cleanly when disabled or passes the video provider launch gate. **Covered for disabled-video scope.**

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

### E. Billing And Entitlements — ✅ prepaid access authority landed

Owner: backend/ops.

Goal: keep purchased access, entitlements, ledger and public billing copy on one
immutable purchase authority.

Current providers sell one-time monthly/yearly prepaid access and advertise no
automatic renewal. Profile distinguishes free vs active access, shows the purchased
offer and `benefitsEndAt`, and offers Change plan / repurchase without exposing
Manage, Cancel renewal or Resume renewal controls. The cancel/resume endpoints fail
closed for providers whose `renewalCapability` is `none`.

Local/mock checkout is explicitly labeled as demo-only in
Upgrade (`Demo checkout`, `Demo upgrade`, and "No real payment is collected").
The server gates checkout auto-confirm to `PAYMENT_PROVIDER=mock`; non-auto-confirm
checkout creates an invoice/checkout URL without activating a subscription or
granting dreamcoins.

Required work:

- Remove or hide auto-confirm checkout before any external beta or public traffic. **Status: auto-confirm is now mock-provider-only and presented as demo behavior.**
- Confirm settlement, entitlement derivation and dreamcoin grant idempotency from the immutable offer snapshot. **Status: covered.**
- Keep late or replayed invoices monotonic: they cannot shorten or downgrade newer paid access. **Status: covered by billing integration regression.**
- Add billing access projection for active/inactive prepaid purchases. **Status: covered.**

Acceptance:

- Local/mock checkout remains clearly marked as demo-only. **Status: covered.**
- Profile reflects plan and dreamcoin balance. **Status: covered.**
- Profile reflects inactive billing or active prepaid `benefitsEndAt`, explicitly says there is no automatic renewal, and omits renewal-management controls. **Status: covered.**
- Entitlement derivation and dreamcoin grant behavior remain idempotent in tests. **Status: covered.**
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
- Ensure reports for character, media, message, feed item, and profile reach admin moderation. **Covered: character/media/chat-message/feed-item/profile report entry points create `ContentReport`/`ModerationEvent`, and admin moderation consumes the queue.**
- Add appeal/help entry points for blocked outputs. **Status: Help Desk now has support links, FAQ, signed-in support request intake, durable `SupportRequest` records, Roadmap voting backed by `ProductFeedbackItem`/`ProductFeedbackVote`, and an admin/support inbox with triage states, saved views, resolution notes, audit logging, derived SLA state/due/remaining fields, overdue/due-soon/on-track/paused/closed filtering, and audited SLA escalation for time-sensitive tickets. External notification routing can remain a future volume-driven enhancement.**
- Confirm hard-policy content cannot be published or generated. **Covered in local tests/probes for create/chat/generate and publish paths.**

Acceptance:

- Admin moderation queue can review reports and apply decisions. **Covered.**
- Character Review Queue supports saved search/report-filter views for recurring triage slices. **Covered.**
- Reports from character, media, message, feed item, and profile land in the queue. **Covered.**
- Known blocked fixture is blocked in local chat/create/generate tests where the local provider supports it. **Covered.**
- Age-gated UX remains clear that it is not Go.cam verification. **Covered for current deferred-provider scope.**

Future public-launch acceptance:

- Age verification probe returns a Go.cam provider session with HTTPS verification URL.

### G. Feed And Community Productization — ✅ 已落地（2026-06-28，含明确取舍）

Owner: product/frontend/backend.

Goal: Feed and Community stop looking like a catalog mirror and become credible discovery surfaces.

**落地**：新增创作者公开主页 `GET /api/v1/creators/:id` + 路由 `/creators/[id]`（displayName/头像/统计 + 其 public+approved 角色网格 + isFollowing/isSelf），Community dreamer 卡名链入该页；Community campaign carousel 已接入 Content Ops published `campaign` placements，并保留无 placement 时的静态 fallback；`characterDTO` 修正为带真实 `creatorName`（include creator User），Feed 卡片加「by {creatorName}」链接；无图角色 fallback 图按角色 id 稳定分散到现有 card image set，避免 Feed/Explore 同图重复；follow 状态持久（已有）+ UI 可切换（Community dreamer 卡 + 创作者主页乐观更新），community dreamers 回 `isFollowing`；Feed 加载/空态补齐；Feed share 深链会验证并聚焦目标卡，Remix 会通过后端返回的 URL 带上 `characterId` + `remixFeedItemId`，Generate 会拉取并选中来源角色，生成任务写入 `feed_remix` provenance，生成出的 Gallery 媒体显示 `Remixed from Feed` 来源 badge 并能点回原 Feed 卡；Profile media 卡支持创建 private/public collection 或加入已有 collection，public collection 会把自有媒体提升为 `public_pack` 并出现在 Community Collections；Feed 首页会混排公开 media collection 卡，支持 `collection:<id>` share 聚焦、report、loaded preview 和稳定分页。后端测试覆盖 creator profile + follow 状态 + 404 + owner-only media collection publish + campaign banner API + feed share/remix provenance + collection feed card/focus/report/pagination + media gallery provenance DTO + fallback art distribution；E2E 覆盖 community→creator 导航、follow 切换、campaign carousel、Profile media -> public collection -> Community card、Feed collection card、Feed share/remix/generation lineage 和 first-page eager image loading；Chrome 复验 `community-collection-published.png`、`feed-share-remix-focused.png`、`feed-remix-generate-selected.png`、`feed-lcp-fallback-eager.png`、`feed-remix-gallery-provenance.png`、`feed-collection-card-focused.png`、`01-community-campaign-initial.png`、`02-community-campaign-next.png`。**明确取舍（YAGNI / 计划允许"暂隐"）**：个性化排序/更复杂运营编排未来公开上线再增强；当前基础 collection item type、share 深链、campaign 轮播、remix 生成来源与 Gallery 回链已落地。

Required work:

- Define Feed item types and ranking beyond public character cards. **Status: basic public media collection item type is live in Feed; future work is richer personalization/merchandising ranking, not a beta blocker.**
- Define creator public profile scope or intentionally hide links. **Status: creator public profile is live via `/creators/:id` with display profile, public approved character grid, follow/isSelf state, Community dreamer links, backend tests, E2E, and Chrome evidence.**
- Add collection semantics or hide collections until ready. **Status: basic creator media collections are now live end-to-end: owner-only create/add APIs, Profile media UI, `public_pack` media promotion, Community public listing, Feed collection cards, E2E, and Chrome evidence.**
- Add follow state, share URLs, and remix lineage. **Status: follow、share 深链、collection deep link、Remix -> Generate 来源选择、generation job provenance、Gallery 来源 badge/回链已落地；未来仅剩 Feed 个性化/运营排序增强。**
- Add empty/loading/error states for low-data communities. **Covered for Feed/Community loading, empty, status/error states; future work is richer personalization/merchandising, not a beta blocker.**

Acceptance:

- Feed actions have durable state or intentionally scoped analytics-only behavior; share/remix must not silently point to the wrong character. **Covered.**
- Community filters work with real data. **Covered.**
- No launch-visible tab promises an unimplemented domain. **Covered.**

### H. Documentation Reconciliation

Owner: product/engineering.

Goal: docs do not contradict current code state.

Required work:

- Mark `CURRENT_FUNCTIONAL_COVERAGE.md` as current status. **Covered.**
- Move stale `ProductFeatureMap.md` "未实现" rows into historical context or update them. **Creator/profile/billing conflicts updated on 2026-06-29; continue this check when product scope changes.**
- Update launch runbook with current blocker ordering. **Covered for current internal-beta/public-launch split.**
- Keep generated audit output linked from product docs. **Covered through 2026-07-04 PM audit and target-confirmation sweep links.**

Acceptance:

- A new engineer can read docs and know what is implemented, blocked, deferred, and launch-critical. **Covered for current SSoT state; recheck when product scope changes.**

## Execution Order

### Phase 0 - This Week

1. Add catalog hygiene probe. **Done.**
2. Produce future public-launch secret checklist from `.env.production.example` files. **Done 2026-06-29: `docs/product/PRODUCTION_SECRET_CHECKLIST.md`.**
3. Clean preview/demo DBs of e2e/test fixture rows. **Current local dataset passes catalog probe after removing the exact 2026-07-04 manual Chrome audit collection; repeat seed + catalog probe for every preview/demo DB before use.**
4. Re-run public route, catalog, and PM screenshots. **Catalog and Chrome PM audit evidence updated again on 2026-07-04, including before/after proof for the `Chrome handoff` public collection cleanup.**

Exit criteria:

- Public catalog probe passes.
- PM screenshots no longer show test fixture content.

### Phase 1 - Internal Beta Gate

1. Keep active Pipeline-backed image and chat paths passing through `bun run launch:probe:pipeline`.
2. Keep BTCPay, R2/S3, Go.cam, and Sentry documented as deferred, not missing current tasks.
3. If voice is in the internal demo promise, require a healthy Pocket TTS gateway,
   a passing real WAV probe, and one Admin clone/profile persistence proof.
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
- If voice is visible/promised, Pocket TTS has a passing `/audio/speech` probe and
  Admin clone/profile persistence evidence.
- Deferred provider gaps are documented and not represented as publicly launch-ready.
- Product docs describe the current state without stale contradictions.

Future public launch is complete only when:

- Launch gate passes.
- Full E2E passes against production-like services.
- Public catalog probe passes.
- Payment, age verification, moderation, blob storage, chat, voice, and observability all have live probe evidence.
- Product, ops, and safety sign off.
