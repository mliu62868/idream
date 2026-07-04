# iDream Product Audit - 2026-06-29

## Verdict

Current local/internal beta surface is usable after the fixes in this audit. The core customer loop now works end to end:

1. Fresh visitor sees age gate, accepts, and reaches Explore.
2. Authenticated user can browse catalog, open character detail, chat, create a character, generate an image, view generated media, and use Profile/Feed/Community/Upgrade surfaces.
3. Admin can sign in locally, view dashboard, generation jobs, provider health, and moderation queues.
4. Local pipeline probes pass for web, product config, chat service, chat model, image generation, and voice generation.

Public production launch is still a no-go until production environment variables, external production services, object storage, payment, age verification, observability, and launch-probe evidence are configured. `bun run check:launch` correctly fails in the current local/dev environment.

## Fixed During Audit

- Generated image gallery was broken after a completed job. Root causes were split local blob roots and image content-type defaulting to WebP for PNG bytes. Fixed shared blob-root resolution, aligned local env examples to `BLOB_ROOT=data/blob`, inferred image content type from provider bytes, copied existing local blobs, and verified `/user-content/.../content.png` renders.
- Chat model launch probe timed out because the main pipeline chat adapter did not disable model thinking. Added `chat_template_kwargs.enable_thinking=false`; latest probe returns in 468 ms.
- Voice launch probe failed with 401 because the orchestration script dropped the voice API token. Fixed token fallback wiring; voice probe now returns WAV audio.
- Admin web initially rendered as a Next error shell from stale/missing standalone output. Rebuilt with the normal package build/prep step and hard-restarted `admin-web`; admin login/dashboard/deep links render.
- Profile rendered voice clips as broken images and displayed repeated `Media unavailable`. Added first-class voice/audio cards with `<audio controls>`; Profile now has 0 unavailable media cards and 5 audio controls.
- Web-surface probe now recognizes the intended local dev admin login wall as protected admin state instead of requiring the production access-denied copy.
- Community marketplace depth was weak. Seed now creates 13 public creator accounts from the catalog, assigns each public character/media asset to its creator, seeds 3 public collections with 4 preview items each, renders collection preview grids, and keeps followed public creators in the community dreamer list for logged-in users.
- Checkout activation was too easy to miss in the UI and did not emit the full subscription analytics contract. Upgrade now marks the selected plan as current immediately, shows the dreamcoin grant and next-step links, emits `subscription_started` exactly once for auto-confirm and webhook activation, and clears both public and admin session cookies on logout.
- Profile billing was a static portal button with no inactive/active subscription behavior. The local billing card now routes inactive users to Compare plans, shows active plan renewal date, supports cancel-at-period-end and resume-renewal actions, and keeps current-period entitlements active after canceling renewal.
- Mock checkout could still look like production payment. Upgrade now labels local billing as `Demo checkout`, changes mock CTAs to `Demo upgrade`, says no real payment is collected, and the server only honors auto-confirm when `PAYMENT_PROVIDER=mock`. Non-auto-confirm checkout creates an invoice URL without subscription activation or dreamcoin grant.
- Chat service probe evidence was read-only and allowed the conversation smoke to be skipped. The probe now auto-selects a public approved local character when no `CHAT_SERVICE_PROBE_CHARACTER_ID` is provided, runs create/send/SSE stream/get/no-memory/blocked-input checks, and launch readiness fails skipped or incomplete conversation reports.
- Generate still exposed a disabled `Video Beta` affordance and `Videos` gallery tab while video is intentionally off for launch. The generator now only exposes image mode/gallery tabs when `video_gen=false`; video UI appears only when config has enabled video models. Generated asset storage keys are job-scoped, preventing provider placeholder key collisions, and Playwright-managed E2E runs now isolate BullMQ with a per-port prefix.
- Primary product copy still promised video tools after the video UI was hidden. Home stats/FAQs, Generate metadata, the generic feature grid, Resources Hub metadata, Comparison cards, and Profile media empty states now use image/media wording unless video is actually enabled elsewhere; `/generate` is now titled `NSFW AI Image Generator`.
- PM2 saved process state still contained old topology (`gen-video` and duplicate `main-web`) even though `ecosystem.config.js` had removed deferred video. Ran `pm2 save`, verified the saved dump now has no `gen-video` and exactly one `main-web`, and updated operations docs to require `pm2 save` after topology changes.
- Global header search looked interactive but was static on app-shell pages. Replaced it with a `next/form` GET search into Explore, so submitting from `/generate` lands on `/?q=...` and shows matching character results.
- The footer `AI Girlfriend Types` link pointed at `/type`, but `/type` was not in the generated route path set even though route metadata existed. Added `/type` to the linked route set and expanded public-route smoke coverage for footer/hub routes.
- Feed action UX had two browser-only weak spots: Share/Report feedback could fail silently on async errors, and Remix depended on a tracking POST before navigation. Share now copies or surfaces the link, Report shows an explicit submitted state, Remix navigates from the local character id while tracking is fire-and-forget, and the Feed sidebar active state now highlights Feed instead of Explore.
- Feed like persistence had a hydration gap. The API persisted likes and returned `character.liked`, but the Feed client did not seed its liked-state set from fetched items, so reload visually reverted `Liked` back to `Like`. Feed now hydrates liked state from the API payload and regression coverage asserts the post-refresh state.
- Admin model import was partially wired. Completed the model-import API handlers for listing, registering server paths, and multipart uploads; bridged Web `File.stream()` to Node streams; defaulted the library to repo-local `data/model-imports` through the standalone launcher; and verified the Generation Config import controls in Chrome.
- Create had broad product claims but narrow UI regression evidence. Added E2E coverage for age validation, refresh-resume draft state, preview failure recovery, public submission review status, and My AI created-tab visibility; then verified the public review path in Chrome.
- Help Desk was only a generic marketing route despite product docs promising FAQ/support/ticket paths. Replaced it with a real Help Desk workspace: support links, FAQ, bugs/features/changelog premium area, and a signed-in age-gated support request form that returns a `SUP-...` reference and records `support_request_submitted`.
- Support intake stopped at an analytics event and reference number. Added a durable `SupportRequest` model, admin permissions, Support Requests API/UI, status transitions, resolution notes, and `support.request.update` audit logging.
- Terms was a thin two-paragraph page while the feature map promised a policy index. Reworked `/terms` into a real Terms & Policies hub with 12 local Safety Center policy/report/privacy/appeal links plus account/support action links.
- My AI promised group chat and pack tabs as deferred empty-state domains, but the UI omitted `packs` and used a generic empty state for group chats. Added the `packs` tab and explicit beta empty states for both tabs with stable Create CTAs.
- Profile docs promised direct redeem-code, notifications, and account-management paths, but those URLs rendered not-found content. Added `/profile/redeem-code`, `/profile/notifications`, and `/profile/account-management` route-map entries, metadata, and client-side panel focus.
- Community had filter controls and collection data but the character leaderboard was visually unlabelled and filter behavior had no browser regression evidence. Added a Characters section heading, stable character-card test ids, and E2E/Chrome coverage for gender filtering plus collection cards.
- Chat session management had a current-session delete dead end: deleting the open chat from the session drawer removed it from the drawer but left the user on a deleted chat URL until refresh. The drawer now redirects current-session deletion to `/chat`; E2E covers rename, archive, and delete-current redirect.
- Chat memory management had API/file-layer tests but no browser-level UI closure. Added E2E coverage with real chat file-layer seed data for relationship badge load, memory edit, memory delete, and relationship reset; verified the same flow in Chrome.
- Generator gallery actions had report coverage but weak UI closure for saved-state actions. The image-generation E2E now continues through Like -> Liked tab, bulk Make private, and bulk Delete selected after media is generated.

## Browser Evidence

Screenshots are in `docs/product-audits/2026-06-29-chrome-audit/screenshots/`.

Key evidence:

- `19-age-gate-fresh-session.png`
- `20-home-explore-fresh.png`
- `03-character-detail.png`
- `05-chat-after-message.png`
- `12-create-after-save.png`
- `30-generate-post-restart.png`
- `26-profile-audio-media-fixed.png`
- `27-feed.png`
- `28-community.png`
- `31-community-marketplace-seeded.png`
- `32-community-collections-seeded.png`
- `33-community-richer-after-followed-merge.png`
- `29-upgrade.png`
- `34-upgrade-checkout-success.png`
- `35-profile-billing-after-checkout.png`
- `36-generate-premium-controls-after-checkout.png`
- `37-profile-billing-free-state.png`
- `38-profile-billing-active-state.png`
- `39-profile-billing-canceled-state.png`
- `40-profile-billing-resumed-state.png`
- `41-upgrade-demo-checkout-labelled.png`
- `42-upgrade-demo-checkout-success.png`
- `43-profile-billing-after-demo-checkout.png`
- `44-generate-image-only-no-video-dead-promise.png`
- `45-generate-image-job-completed-gallery.png`
- `46-global-header-search-form.png`
- `47-global-search-results.png`
- `48-feed-share-report-actions.png`
- `49-feed-remix-generate-character.png`
- `50-admin-model-import-controls.png`
- `51-create-public-review-my-ai.png`
- `52-helpdesk-support-request.png`
- `53-terms-policy-index.png`
- `54-my-ai-packs-empty-state.png`
- `55-profile-account-management-subroute.png`
- `56-community-filters-collections.png`
- `57-feed-like-persistence.png`
- `58-generate-no-video-promise.png`
- `59-type-footer-route.png`
- `60-comparison-no-video-tools.png`
- `61-chat-memory-panel-chrome.png`
- `62-chat-session-drawer-chrome.png`
- `21-admin-dev-login-fixed.png`
- `22-admin-dashboard.png`
- `23-admin-generation-jobs.png`
- `24-admin-provider-health.png`
- `25-admin-moderation.png`

## Command Evidence

- `bun run check`: pass, all 12 turbo tasks successful; latest rerun after standalone model-library path changes had no Turbopack tracing warnings.
- `bun run test`: pass, 401 tests across shared/main/chat/gen.
- `bun run launch:probe:catalog -- --report .tmp/public-catalog-probe-community-after-merge.json`: pass, 16 public characters, 13 public creators, 16 distinct images, 0 issues.
- `bun run --filter @idream/main probe:catalog -- --report .tmp/public-catalog-probe-current.json`: pass on 2026-06-29, 16 public characters, 13 public creators, 16 distinct images, 0 fail, 0 warn.
- `bun run launch:probe:pipeline -- --report .tmp/internal-pipeline-probes-after-community.json`: pass 6/6.
- `bun run launch:probe:pipeline`: pass on 2026-06-29 after chat-service probe timeout hardening; `.tmp/internal-pipeline-probes.json` is `ok=true`, 6/6.
- Chrome community check: pass; `/community` renders 13 dreamer cards, 16 character cards, 3 public collection cards, real collection preview images, and 0 visible broken images.
- Chrome checkout check: pass; fresh signup `chrome-checkout-1782709511276-483857@test.local` completed Premium monthly auto-confirm checkout, saw `Premium monthly is active. 1,500 dreamcoins were added.`, profile showed `1,750 dreamcoins · Premium monthly`, Generate showed enabled prompt and negative prompt controls, and no visible broken images were found.
- Checkout DB evidence: pass; the fresh checkout account has one active Premium monthly subscription, ledger rows `+250 signup_bonus` and `+1500 subscription_grant`, balance `1750`, active subscription entitlements, and analytics `{ signup: 1, checkout_started: 1, subscription_started: 1 }`.
- Chrome billing-management check: pass on `http://localhost:3024`; fresh signup `chrome-billing-1782710434048-312839@test.local` showed Free + `No active subscription` + `Compare plans`, upgraded to Premium monthly, showed `Renews Jul 29, 2026`, canceled renewal, showed `Renewal canceled · benefits active until Jul 29, 2026`, then resumed renewal and returned to `Cancel renewal`; 0 visible broken images in each state.
- `bun run --filter @idream/main test:unit -- src/server/modules/ourdream/billing.test.ts src/server/modules/ourdream/chat-gen-extra.test.ts`: pass, 13 tests.
- `PW_BASE_URL=http://127.0.0.1:3023 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "upgrade UI activates Premium|profile UI handles redeem"`: pass, 2 tests.
- `bun run --filter @idream/main typecheck` and `bun run --filter @idream/main lint`: pass after billing-management changes.
- Chrome demo-checkout labeling check: pass on `http://localhost:3026`; fresh signup `chrome-demo-1782711126882@example.test` saw `Demo checkout`, "No real payment is collected", and `Demo upgrade` CTAs, upgraded Premium monthly, saw `Premium monthly is active. 1,500 dreamcoins were added.`, then Profile showed `Premium monthly`, `Renews Jul 29, 2026`, and `Cancel renewal`.
- Demo-checkout DB evidence: pass; that Chrome account has one active Premium monthly subscription, `subscription:grant:mock-invoice-...` ledger idempotency key, and active subscription entitlements (`plan`, `premium_controls`, `unlimited_messages`, `image_generation`, `voice_enabled`, `voice_minutes`).
- `bun run --filter @idream/main test:unit -- src/server/modules/ourdream/billing.test.ts`: pass, 11 tests, including mock billing-mode metadata and non-auto-confirm invoice-without-activation behavior.
- `PW_BASE_URL=http://127.0.0.1:3025 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "upgrade UI activates Premium"`: pass, 1 test.
- `bun run --filter @idream/main lint` and `bun run --filter @idream/main typecheck`: pass after demo-checkout labeling changes.
- `bun run check`: pass after demo-checkout labeling changes, all 12 turbo tasks successful.
- Web surface probe: pass; home/generate render, API age gate returns 403, admin page protected by dev login wall, admin API fails closed at 401.
- Chat service probe: pass; health/signed BFF/unsigned rejection verified, and conversation smoke completed against auto-selected DB character `lola-moonstruck` with create session 201, send 202, SSE start/delta/done, get session assistant reload, no-memory send 202, and blocked-input handling.
- `bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe.json`: pass after probe hardening, `conversation.attempted=true`, `conversation.ok=true`, `characterSource=database`.
- Chat service probe stream timeout hardening: the probe now waits 30s by default, configurable via `CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS`; this prevents false failures when the local chat model takes longer than the old 8s stream window.
- Chrome generate check: pass on `http://127.0.0.1:3032`; seeded local session saw no exact `Video`, `Video Beta`, or `Videos` buttons when video is disabled, clicked `Generate`, saw balance decrement 250 -> 245, `Generation queued.`, worker drain completed `ai.image.generate` and `app.ai.finalize`, then Chrome showed `Generation complete.`, Active Jobs `Completed`, one Gallery image card, and 0 console errors. Authenticated `/user-content/.../content.png` returned `200 image/png` with a PNG header.
- Chrome main-port drift check: pass on `http://127.0.0.1:3000/generate`; exact button counts are `Video=0`, `Video Beta=0`, `Videos=0`, `Images=1`, `Liked=1`, `Generate=1`; generation config/jobs/media/presets/characters APIs returned 200 and Chrome had 0 console errors.
- Chrome no-video-promise copy check: pass on latest-source dev server `http://localhost:3038`; Home no longer contains `chat, image, and video tools`, `generating images and videos`, or `image and video generation access`; `/generate` title is `NSFW AI Image Generator | ourdream.ai`, meta description is image-only, exact `Video`/`Videos` button counts are 0, Chrome console errors were 0, screenshot `58-generate-no-video-promise.png`.
- Chrome comparison copy check: pass on latest-source dev server `http://localhost:3038/comparison`; page title `Compare AI Girlfriend Platforms | ourdream.ai`, cards now show `Image generation tools`, the old `Image and video tools` phrase is absent, no not-found content, Chrome console errors were 0, screenshot `60-comparison-no-video-tools.png`.
- Chrome chat memory/session-drawer check: pass on latest-source dev server `http://127.0.0.1:3038`; logged in with a fresh test account, opened Melissa Burke chat, saw seeded `Close` relationship badge and `User likes rainy bookstores.` memory, edited it to `User likes late-night jazz.`, deleted the memory, reset relationship to `Getting to know each other`, renamed the session, archived it, deleted the current chat, landed on `/chat`, and saw 0 Chrome console errors. Screenshots `61-chat-memory-panel-chrome.png` and `62-chat-session-drawer-chrome.png`.
- PM2 dump check: pass after `pm2 save`; `/Users/kk/.pm2/dump.pm2` contains `admin-web`, `chat`, two `gen-image`, `sdcpp-image`, `gen-finalizer`, `main-event-consumer`, and one `main-web`; no `gen-video` remains.
- Chrome global search check: pass on `http://127.0.0.1:3000/generate`; exactly one app-shell search box, submitted `Melissa Burke`, landed on `http://127.0.0.1:3000/?q=Melissa+Burke`, found one `/characters/melissa-burke` result link, and Chrome console errors were 0.
- `PW_BASE_URL=http://127.0.0.1:3033 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "global header search|explore UI syncs filters"`: pass, 2 tests.
- `bun run --filter @idream/main lint` and `bun run --filter @idream/main typecheck`: pass after global-search wiring.
- `bun run check`: pass after global-search wiring, all 12 turbo tasks successful.
- Chrome `/type` footer route check: pass on latest-source dev server `http://localhost:3038/type`; page title `AI Girlfriend Types | ourdream.ai`, main hub rendered with related `/type/...` links, no not-found content, Chrome console errors were 0, screenshot `59-type-footer-route.png`.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/public-routes.e2e.ts -g "(/resources-hub renders|/type renders|/comparison renders|/videos renders|/ai-instructions renders|/games renders|/romantasy renders|active app copy)"`: pass, 8 tests, including footer/hub route smoke and the disabled-video copy guard.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/public-routes.e2e.ts -g "active app copy"`: pass, 1 test, including the `/comparison` card copy guard.
- `bun run check`: pass after comparison-card image-generation wording.
- PM2 production-entry smoke after `bun pm2 restart main-web --update-env`: `/comparison` returned `Compare AI Girlfriend Platforms | ourdream.ai`, contained `image generation tools`, did not contain `image and video tools`, and had no not-found copy.
- `bun run check`: pass after adding `/type` to the route path set; Next generated static pages increased from 172 to 173.
- PM2 production-entry smoke after `bun pm2 restart main-web --update-env`: `/type` returned `AI Girlfriend Types | ourdream.ai`, no not-found copy, and `/type/anime-ai-girlfriend` was present in the rendered HTML.
- Chrome feed action/nav check: pass on rebuilt `http://127.0.0.1:3000/feed`; Feed sidebar item is active, Share produced a visible link confirmation, Report produced `Report submitted.`, Remix landed on `http://127.0.0.1:3000/generate?characterId=melissa-burke`, and Chrome console errors were 0.
- Chrome admin model-import controls check: pass on PM2 production admin `http://127.0.0.1:3001/admin/generation/config`; `Upload Main Model`, `Upload LoRA`, and `Register Path` controls rendered, model library root displayed `/Users/kk/code/idream/data/model-imports`, and Chrome console errors were 0.
- `PW_BASE_URL=http://127.0.0.1:3037 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "feed UI supports share|global header search|explore UI syncs filters"`: pass, 3 tests, including Feed active nav and Remix navigation when the tracking endpoint is forced to fail.
- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "local sdcpp model|managed sd_cpp"`: pass, 2 tests covering local model/LoRA registration and managed sdcpp profile metadata.
- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "model import|relative admin model library|managed sd_cpp"`: pass, 2 tests covering managed sdcpp profile metadata and repo-root relative model-library resolution.
- `bun run --filter @idream/main build`: pass after Feed/nav/admin model-import changes; rebuilt standalone was restarted under PM2 before Chrome verification.
- `bun run --filter @idream/admin build`: pass after admin model-import standalone path changes; `pm2 restart main-web admin-web --update-env` applied the rebuilt standalone servers.
- Chrome Create review check: pass on `http://127.0.0.1:3000/create`; age validation blocked age 17, refresh resumed the draft on Appearance with the entered name, public submit showed `submitted for review`, My AI created tab showed the new character with `PENDING REVIEW`, and Chrome console errors were 0.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "create UI"`: pass, 2 tests, including private creation, draft resume, validation failure, preview failure recovery, public pending-review submission, and My AI visibility.
- Chrome Help Desk check: pass on latest-source dev server `http://localhost:3038/helpdesk`; signed-in Chrome session submitted a generation support request, saw `Support request SUP-0OMQYX5VD0 received.`, screenshot `52-helpdesk-support-request.png` saved, and Chrome console errors were 0.
- Chrome PM2 Help Desk smoke: pass on `http://localhost:3000/helpdesk`; signed-in Chrome session submitted a generation support request, saw `Support request SUP-8KMQZ0TOTT received.`, and Chrome console errors were 0.
- `bun run --filter @idream/main test -- src/server/modules/ourdream/modules.test.ts`: pass after Help Desk support request API coverage, 26 tests.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "help desk"`: pass, 1 test.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/public-routes.e2e.ts -g "/helpdesk"`: pass, 1 test.
- `bun run --filter @idream/main lint` and `bun run --filter @idream/main typecheck`: pass after Help Desk changes.
- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts src/server/modules/ourdream/modules.test.ts`: pass after support inbox persistence/triage coverage, 63 tests.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3011 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/admin-web.e2e.ts`: pass after support inbox UI coverage, 7 tests.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3010 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/admin-web.e2e.ts`: pass after Review Queue saved-view UI coverage, 8 tests.
- Chrome admin Review Queue saved-view check: pass on `http://127.0.0.1:3010/admin/content/review-queue`; saved a reported-only search view, reloaded, applied it, saw `1/5` with only the seeded row, deleted the view, confirmed DB deletion, and Chrome console errors were 0.
- Chrome admin Support Requests saved-view check: pass on `http://127.0.0.1:3010/admin/support`; saved an active generation-ticket view for `SUP-CHR29489790`, reloaded, applied it, saw `1/2` with only the seeded row, confirmed persisted filters `{query,status,category}`, deleted the view, confirmed DB deletion, and Chrome console errors were 0.
- `bun run check`: pass after Review Queue saved-view UI changes.
- `bun run test`: pass with serialized Turbo package execution; root suite covers shared/main/chat/gen, with main 28 files / 280 tests and chat 15 files / 84 tests green.
- `bun run --filter @idream/main typecheck`, `bun run --filter @idream/main lint`, `bun run --filter @idream/main build`, `bun run --filter @idream/admin typecheck`, `bun run --filter @idream/admin lint`, and `bun run --filter @idream/admin build`: pass after support inbox changes.
- Chrome PM2 admin Support Requests check: pass on `http://127.0.0.1:3001/admin/support`; seeded ticket `SUP-CHR27348473` appeared as `received`, Resolve changed it to `resolved`, resolution notes persisted, `support.request.update` audit log was written, PM2 main/admin were online, and Chrome console errors were 0.
- Chrome Terms policy-index check: pass on latest-source dev server `http://localhost:3038/terms`; page title `Terms & Policies | ourdream.ai`, 12 policy links, 4 account/support action links, key hrefs `/safety/policies/acceptable-use`, `/safety/moderation/appeals`, `/helpdesk`, 0 broken images, 0 console errors, screenshot `53-terms-policy-index.png`.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/public-routes.e2e.ts -g "/terms"`: pass, 2 tests, including the 12-link policy index assertion.
- `bun run check`: pass after the Terms policy-index change.
- PM2 production-entry smoke after `bun pm2 restart main-web --update-env`: `http://127.0.0.1:3000/terms` returned 200 and contained `terms-policy-links`, `12 policy routes`, `/safety/policies/acceptable-use`, `/safety/moderation/appeals`, and `/helpdesk`.
- Chrome My AI deferred-tabs check: pass on latest-source dev server `http://localhost:3038/custom`; `group chats` and `packs` buttons were present, both tabs opened explicit beta empty states, Create CTAs pointed to `/create`, Chrome console errors were 0, screenshot `54-my-ai-packs-empty-state.png`.
- `bun run --filter @idream/main test -- src/server/modules/ourdream/modules.test.ts -t "library tabs"`: pass, 1 test, including group-chats and packs empty-state API assertions.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "my ai shows deferred"`: pass, 1 test.
- `bun run check`: pass after the My AI packs/group-chats empty-state change.
- PM2 production-entry smoke after `bun pm2 restart main-web --update-env`: `http://127.0.0.1:3000/custom` returned 200 and server-rendered `group chats` plus `packs`.
- Chrome Profile subroute check: pass on latest-source dev server for `/profile/redeem-code`, `/profile/notifications`, and `/profile/account-management`; each path rendered its own title, was not not-found, showed the target panel, focused the expected control, had 0 Chrome console errors, and saved screenshot `55-profile-account-management-subroute.png`.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/public-routes.e2e.ts -g "profile/(redeem-code|notifications|account-management)"`: pass, 3 tests.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "profile subroutes deep-link"`: pass, 1 test.
- `bun run check`: pass after Profile subroute route-map and deep-link changes.
- PM2 production-entry smoke after `bun pm2 restart main-web --update-env`: `/profile/redeem-code`, `/profile/notifications`, and `/profile/account-management` all returned 200 with correct page titles and no not-found content.
- Chrome Community filters/collections check: pass on latest-source dev server `http://localhost:3038/community`; after seeding one female and one male audit character, Gender female showed the seeded female card, Gender male narrowed to the seeded male card, Characters and Collections headings were visible, 3 collection cards rendered, Chrome console errors were 0, screenshot `56-community-filters-collections.png`.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "community UI filters"`: pass, 1 test.
- `bun run check`: pass after Community character-section and filter regression changes.
- PM2 production-entry smoke after `bun pm2 restart main-web --update-env`: `/community` returned 200 with `Community | ourdream.ai` title and no not-found content.
- Chrome Feed like-persistence check: pass on latest-source dev server `http://localhost:3038/feed`; seeded audit card `Mara Voss 1782721859470`, clicked `Like`, reloaded `/feed`, and the same card still showed `Liked` with `aria-pressed=true`; Chrome console errors were 0, screenshot `57-feed-like-persistence.png`. The temporary `chrome-feed-audit-*` seed was removed after verification.
- `bun run --filter @idream/main test -- src/server/modules/ourdream/modules.test.ts -t "feed actions"`: pass, 2 tests, including API payload `character.liked=true` after like.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "feed UI supports"`: pass, 1 test, including `Liked` state after page reload.
- `bun run check`: pass after Feed liked-state hydration change.
- PM2 production-entry smoke after `bun pm2 restart main-web --update-env`: `/feed` returned 200 with `Feed | ourdream.ai` title and expected route metadata.
- `IMAGE_PROVIDER=mock VIDEO_PROVIDER=mock PW_BASE_URL=http://127.0.0.1:3031 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "generator UI queues an image job|generator UI queues a video job"`: pass, 2 tests, with isolated BullMQ prefix for Playwright-managed web servers.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts`: pass, 21 tests, including chat drawer rename/archive/delete-current redirect, chat memory edit/delete/reset, generator gallery Like/Liked, and generator bulk media actions.
- `PW_BASE_URL=http://127.0.0.1:3038 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 PW_WEBSERVER=1 bun run --filter @idream/main test:e2e -- src/e2e/public-routes.e2e.ts -g "(/generate renders|active app copy)"`: pass, 2 tests, including the disabled-video copy guard.
- `bun run check`: pass after the no-video-promise copy and metadata changes.
- PM2 production-entry smoke after `bun pm2 restart main-web --update-env`: `/` no longer contains old video-tool phrases, `/generate` returns `NSFW AI Image Generator | ourdream.ai`, and `/generate` metadata description is image-only.
- Chrome PM2 `/generate` smoke: pass on `http://localhost:3000/generate`; title `NSFW AI Image Generator | ourdream.ai`, generator content visible, exact `Video`/`Video Beta`/`Videos` button count 0, no Next/error shell, and 0 Chrome console errors.
- `bun run --filter @idream/gen test -- src/pipeline.test.ts`: pass, 13 tests, including job-scoped generated asset storage keys and provider-key metadata preservation.
- `bun run --filter @idream/main test -- src/server/jobs/queue.test.ts src/server/modules/ourdream/pipeline.test.ts`: pass, 9 tests, including queue cleanup and pipeline finalize behavior.
- Chat model probe: pass, pipeline, `diffusiongemma-26B-A4B-it-4bit`, latest combined probe 9.8 s.
- Image probe: pass, pipeline, 74.8 s, one asset finalized under `/Users/kk/code/idream/data/blob`.
- Voice probe: pass, pipeline, `Kokoro-82M-bf16`, WAV output, 218,444 bytes.
- `bun run check:launch:direct -- --launch-env-file .tmp/launch-probe-only.env --json`: fail as expected for the public-production launch gate; latest probe-env result is `29 pass / 28 fail / 0 warn`.

## Remaining Product Gaps

- Public production launch gate is not satisfied. The local product works, but production needs real deploy env, durable storage, payment credentials, age verification callback setup, Sentry, and production probe reports.
- Marketplace depth is now acceptable for a seeded internal beta: 13 public creators, 16 public characters, and 3 public collections render in Community. Public operation still needs ongoing creator supply, curation rules, and merchandising cadence.
- Image generation latency is high locally: latest live image probe took 66.7 s. The UI now survives it, but production should set user expectations and monitor P95 latency.
- Video remains intentionally disabled by product config; unavailable video controls, the `Videos` gallery tab, and primary app copy promising video tools are no longer shown. Keep video hidden until pricing/templates/provider path are complete, or expose it only after the provider gate passes.
- Admin moderation data is functional but seeded/backlogged: dashboard showed 211 open reports and Moderation page showed 100 rows. Review Queue saved views now cover recurring search/report filters; public traffic still needs real triage staffing and runbook rehearsal.
- Checkout and local billing management now work end to end in Chrome with mock payment. Public billing still depends on production payment-provider setup and real provider portal operations.
- Help Desk now supports durable request intake, Roadmap voting with durable feedback items/votes, and an admin Support Requests inbox with triage states, saved views, and audit logging. SLA automation remains future scope if support volume justifies it.

## Go / No-Go

- Internal local beta: go after keeping these fixes.
- Public launch: no-go until `check:launch` is made green with production configuration and provider evidence.
