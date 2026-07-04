# iDream Adversarial Product Audit

Date: 2026-06-30
Updated: 2026-06-30 12:41 Asia/Shanghai
Mode: product-management adversarial review + Chrome end-to-end validation
Primary evidence: `docs/product-audits/2026-06-30-adversarial-chrome/screenshots/`

## Launch Decision

Local beta flow: go after the fixes below, with the current local services running.

Public production/commercial launch: still no-go. The user-facing product flows now work locally, including chat, and the latest internal `bun run launch:probe:pipeline` is 6/6, but `bun run check:launch` still fails because production environment, provider credentials, live probe evidence, payment, storage, and deployed service URLs are not configured.

The product surface is broad and mostly coherent: discovery, account signup, character creation, chat, image generation, demo upgrade, profile entitlements, feed, community, help desk, and admin operations all have usable flows in the verified local runtime.

## P0 Blockers

Resolved during this audit:

1. Chat reply loop initially failed for users.
   - Initial Chrome reproduction: fresh user sent a message in `/chat/sess_0e1bcefd5b0d4bffb9f89f0caecea068`; no assistant reply arrived after roughly 95 seconds and the UI showed `Reply failed to load. Please try again.`
   - Runtime root cause at that moment: `curl -m 5 -H 'Authorization: Bearer omlx' http://127.0.0.1:8061/v1/models` timed out with no bytes received.
   - Recovery evidence: oMLX recovered, `/v1/models` responded, `probe:chat` passed, `probe:chat-service` passed with `sawStart=true`, `sawDelta=true`, `sawDone=true`, and Chrome showed a live assistant reply without refresh.

Remaining production blockers:

1. `bun run check:launch` fails in the current shell: `7 pass, 49 fail, 2 warn`.
2. Production app env/secrets are absent: `APP_ENV=production`, production Postgres, public HTTPS auth URL, service tokens, Redis, and live probe report paths are not set.
3. Commercial operations are not configured: payment provider credentials, object storage, production chat service URL/secrets, production model gateway credentials, image pipeline probe evidence, voice probe evidence, and observability DSN are missing.

## Fixed During Audit

1. Added bounded timeout for hung OpenAI-compatible chat model calls.
   - `packages/chat/src/providers.ts`
   - `packages/chat/src/env.ts`
   - `packages/chat/src/providers.test.ts`
   - `packages/chat/.env.example`
   - `packages/chat/.env.production.example`
   - Result: provider test passes; hung model calls fail after `CHAT_MODEL_TIMEOUT_MS` instead of occupying the worker forever.

2. Restored admin Chat Ops connectivity.
   - Root cause: `packages/chat/.env` lacked `INTERNAL_TOKEN`, while main/admin already had `dev-internal-token-0123456789`.
   - Added `INTERNAL_TOKEN` to chat env templates and local `.env`, restarted `chat`, then verified `/admin/chat` in Chrome.
   - Result: Chat Ops changed from `未连接 / HTTP 401` to `已连接`, and displayed the failed Chrome session with last message status `失败`.

3. Added frontend recovery for missed chat SSE events.
   - `packages/main/src/components/ourdream/ChatSessionClient.tsx`
   - Root cause: the backend persisted assistant turns and Redis had `delta`/`done`, but Chrome did not always render live updates until reload.
   - Fix: while an assistant bubble is empty and `generating`/`pending`, the client polls the session every 1.5 seconds. Normal streaming still wins because polling stops once streamed content is non-empty.
   - Result: final Chrome message `Chrome final runtime pass 1782786681456` showed assistant content automatically in about 10 seconds, with no refresh and no console errors.

4. Fixed a launch probe hang after successful chat-service verification.
   - `packages/main/src/server/probe-chat-service.ts`
   - Root cause: the SSE reader left a pending timeout handle after it had already seen `done`, so the probe could print `ok=true` but keep the Bun process alive until the timeout elapsed.
   - Result: `CHAT_SERVICE_PROBE_STREAM_TIMEOUT_MS=90000 ... probe:chat-service` now exits cleanly with code 0 in 21.8 seconds.

5. Restored admin console typecheck.
   - `packages/main/src/components/admin/AdminConsoleClient.tsx`
   - Fix: avoid direct nullable `detail.providerError` access in the generation job detail panel.
   - Result: `bun run --filter @idream/main typecheck` passes.

6. Verified and stabilized the agent-selected chat image loop.
   - `packages/chat/src/generate.ts`
   - The active behavior is model-tool driven: when the chat planner selects `generate_image_async`, the assistant turn creates a `requesting` image attachment and emits `chat.image.requested`.
   - Main-side callbacks then move the attachment through accepted/completed states.
   - Result: chat image unit/web tests pass, including attachment creation, outbox request, accepted callback, and completed callback.

7. Added Chat provider health visibility to Admin Chat Ops.
   - `packages/chat/src/admin.ts`
   - `packages/main/src/server/modules/admin/service.ts`
   - `packages/main/src/components/admin/AdminConsoleClient.tsx`
   - Fix: Chat Ops now proxies `/internal/admin/provider-health` and displays a `Chat provider health` table with chat model provider, adapter, status, model, redacted endpoint, latency, HTTP status, model-list result, and error.
   - Result: Chrome verified `/admin/chat` renders rows for `chat_model` and `chat_moderation`; local `chat_model` showed `openai / ok / HTTP 200 / modelListed=true`, with no browser console errors.

8. Closed a launch-readiness false negative for image provider configuration.
   - `packages/main/src/server/launch-readiness.ts`
   - `packages/main/src/server/launch-readiness.test.ts`
   - `packages/main/.env.production.example`
   - `docs/product/PRODUCTION_SECRET_CHECKLIST.md`
   - Root cause: main-web production startup requires `IMAGE_PROVIDER` to be non-mock, but the launch gate only checked `GEN_IMAGE_PROVIDER`. That could let readiness pass while main-web later failed at provider-registry startup.
   - Fix: launch readiness now treats `IMAGE_PROVIDER` as a critical main-web provider, production template includes `IMAGE_PROVIDER=pipeline`, and video worker template defaults stay aligned with the current `video_gen=false` launch scope.
   - Result: `bun run --filter @idream/main test -- src/server/launch-readiness.test.ts` passed, and the latest `bun run check:launch` now correctly exposes `IMAGE_PROVIDER is still mock` in the current non-production shell.

9. Hardened chat-service probe evidence and SSE terminal semantics.
   - `packages/main/src/server/probe-chat-service.ts`
   - `packages/chat/src/generate.ts`
   - Root cause: the probe could pass reload by finding any prior assistant message in a reused session, and the worker emitted terminal SSE `done` before the DB finalize transaction completed.
   - Fix: the probe now reloads and validates the exact assistant message created by the send call, the default stream timeout is 90s, and the worker emits terminal `done` only after DB finalize.
   - Result: `bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe-2026-06-30-qwen4b.json` passed in 15.0s with `sawStart=true`, `sawDelta=true`, `sawDone=true`, and exact assistant status `sent`.

10. Restored the active internal pipeline to 6/6 on the current local machine.
   - `packages/chat/.env`
   - `packages/chat/.env.example`
   - `packages/main/.env`
   - `packages/main/.env.example`
   - Root cause: the prior chat model was too slow for the chat service SSE deadline under current load, and the prior local voice model returned HTTP 500 from the current oMLX runner.
   - Fix: the active local chat model is `Qwen3.5-4B-MLX-4bit`; the active local voice smoke path is `Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit` with voice `serena`.
   - Result: `bun run launch:probe:pipeline` passed 6/6: chat-service 9.2s, chat model 4.1s, image asset generated in 97.3s, and voice WAV generated in 8.4s.

11. Recovered the full repository quality gate after the adversarial re-run.
   - `packages/main/src/components/admin/ContentOpsViews.tsx`
   - Root cause: React hooks lint failed because three admin content ops views triggered state-setting load functions synchronously from `useEffect`.
   - Fix: initial loads are scheduled after the effect turn and the unused `Row` type was removed.
   - Result: `bun run --filter @idream/main lint` passed with one existing `<img>` performance warning, then `bun run check` passed across all 12 turbo tasks.

12. Fixed dev admin account switching when a foreground user session is active.
   - `packages/main/src/server/admin/dev-login.ts`
   - `packages/main/src/server/admin/dev-login.test.ts`
   - `packages/main/src/components/admin/AdminDevLogin.tsx`
   - Root cause: `/admin` correctly showed the dev login page for a normal `user` role, but the available logout action only cleared `idream_admin_session`, leaving the foreground `idream_session` in place and returning to the same no-permission state.
   - Fix: dev admin logout now keeps admin-only logout as the default, but supports an explicit `includeUserSession` option for the account-switching page. The page now labels the action `退出当前前台登录` and clears the foreground user session before reload.
   - Result: unit coverage confirms default admin-only logout still preserves the normal user session, while explicit switching clears both cookies/sessions.

13. Reconciled the running demo database with the seed SSoT.
   - `packages/main/prisma/seed.ts`
   - Root cause: earlier voice UI verification required hand-patching the running DB because the active DB was older than seed for `voice_gen` and plan `voiceEnabled` features.
   - Fix: reran `bun run --filter @idream/main db:seed` and verified the seeded plans and feature flags directly.
   - Result: catalog probe, product-config probe, and voice probe all passed after seed; Premium/Deluxe plans have `voiceEnabled`, `voice_gen` is enabled for Premium/Deluxe, and `video_gen` remains disabled.

14. Removed local Playwright artifacts and project test sources from standalone traces.
   - `packages/main/next.config.ts`
   - `packages/admin/next.config.ts`
   - Root cause: Next standalone output tracing was copying from the workspace root and could retain stale `packages/main/test-results/.../trace.zip` references, producing a build warning and polluting release artifacts.
   - Fix: added scoped `outputFileTracingExcludes` for `test-results`, `playwright-report`, `.playwright-cli`, `src/e2e`, and project `*.test.*` files.
   - Result: main/admin production builds pass without the stale trace warning, and the generated route trace manifests no longer include project Playwright artifacts or project test sources.

15. Hardened the Profile referral share surface.
   - `packages/main/src/components/ourdream/ProfileWorkspace.tsx`
   - `packages/main/src/e2e/ui-workflows.e2e.ts`
   - Root cause: the reward backend was healthy, but the Profile page displayed the share URL as plain status text. A whole-page text extraction during Chrome audit could concatenate the next panel heading onto the referral code, producing an invalid copied URL.
   - Fix: invite now handles non-ok API responses, stores a full absolute share URL, renders it in a readonly `Referral link` field, and exposes an icon-only `Copy referral link` button.
   - Result: Chrome verified the field value and clipboard copy on `http://127.0.0.1:3010/profile`, with no console errors.

16. Hardened account-management regression coverage.
   - `packages/main/src/server/modules/ourdream/modules.test.ts`
   - Gap: the account-management backend test proved status changes, but did not prove the real credential path after deletion.
   - Fix: added a regression test that signs up with credentials, adds a second live session, deletes the account through the authenticated cookie path, verifies all sessions are cleared and `deletedAt` is set, then verifies credential login returns `Account is not active`.
   - Result: focused account/referral module suite now passes 29 tests.

17. Hardened Review Queue approval coverage.
   - `packages/main/src/components/admin/ReviewQueueView.tsx`
   - `packages/main/src/e2e/admin-web.e2e.ts`
   - Gap: prior admin web evidence covered Review Queue list/filter/saved views, but not the actual Approve dialog and decision write from the operator UI.
   - Fix: simplified the row action wiring and added a focused E2E that seeds a pending public character, opens the Review Queue, filters to the row, opens Approve, fills review note/audit reason/`REVIEW`, confirms, then verifies character/submission/audit DB state.
   - Result: `PW_BASE_URL=http://127.0.0.1:3000 PW_ADMIN_BASE_URL=http://127.0.0.1:3011 bun run --filter @idream/main test:e2e -- src/e2e/admin-web.e2e.ts -g "admin review queue approves"` passed.

## Chrome Journeys Verified

Passed:

- Anonymous explore/catalog page rendered without user login.
- Signup flow created `chrome-pm-1782783507911-754128@test.local`.
- Character detail page opened for `Melissa Burke`.
- Custom character builder completed identity, appearance, personality, preview image generation, and private publish; `Nova Vale` appeared in My AI.
- Image generation completed from `/generate?characterId=melissa-burke`; balance decreased by 5 and gallery showed the completed job.
- Demo upgrade activated Premium monthly; profile showed `1,745 dreamcoins · Premium monthly` and renewal date `Jul 30, 2026`.
- Feed like persisted across reload; share/report/remix controls rendered; remix navigated back to generator with character context.
- Community page listed creators and characters; follow action changed count/button state and persisted after reload.
- Creator detail page rendered followed creator and character list.
- Help Desk submitted support request `SUP-FBMQZZR0I5`.
- Help Desk roadmap submission created `Chrome audit launch readiness blocker` and counted the vote.
- Admin dashboard rendered after admin login.
- Admin support inbox showed `SUP-FBMQZZR0I5` with status and action buttons.
- Admin generation jobs showed completed and failed jobs, error codes, and requeue actions.
- Admin provider health showed `sd.cpp` success/failure/cost/latency metrics.
- Admin Chat Ops connected after token fix and exposed recent sessions, quota, and failed chat status.
- Fresh user chat was reverified after recovery: message sent, model generated, DB persisted, and the UI displayed the assistant reply automatically without refresh.
- 2026-06-30 Chrome recheck after pipeline/model changes: `/chat` rendered the live session list with no console errors; session `sess_502e529c64164908ad7c3972271fcc3b` accepted `Chrome audit live reply 1782789949087` and displayed a new assistant reply automatically without refresh.
- 2026-06-30 Chrome Generate recheck: `/generate?characterId=melissa-burke` rendered controls, active jobs, and Gallery with no console errors. Generate/Gallery did not expose the disabled video mode; the visible `Videos` text is only the footer resource-hub link.
- 2026-06-30 Chrome Admin Chat Ops recheck: `http://127.0.0.1:3001/admin/chat` showed `Chat Service 状态已连接`; provider health showed `chat_model / openai / ok / Qwen3.5-4B-MLX-4bit / HTTP 200 / modelListed=true`, with no console errors.
- 2026-06-30 Chrome Admin switching recheck: signed up ordinary user `chrome-admin-switch-1782790538783@test.local`, opened `http://127.0.0.1:3001/admin`, saw the no-permission dev login state with `退出当前前台登录`, clicked it, verified the no-permission state disappeared, then logged in as `admin / admin123` and reached the `iDream Admin` dashboard with no console errors.
- 2026-06-30 Chrome billing portal recheck: signed up `chrome-billing-1782791498054@test.local`, verified Upgrade shows `Demo checkout` and `No real payment is collected`, activated Premium monthly, saw `Current plan` and `1,500 dreamcoins were added`, opened `/profile#billing`, confirmed `1,750 dreamcoins · Premium monthly` and `Renews Jul 30, 2026`, clicked `Cancel renewal` and saw benefits remain active until Jul 30, 2026, clicked `Resume renewal` and saw `Renews Jul 30, 2026` plus `Cancel renewal` restored, with no console errors.
- 2026-06-30 Chrome redeem-code recheck: created one-time local code `CHROMER1782791863454` for 333 dreamcoins, signed up `chrome-redeem-1782791913375@test.local`, opened `/profile/redeem-code`, verified empty submit shows `Enter a code.`, redeemed successfully to `583 dreamcoins`, repeated the same code and saw `Code already redeemed`, with balance still `583 dreamcoins` and no console errors.
- 2026-06-30 Chrome referral recheck: signed up inviter `chrome-ref-inviter-1782792218551@test.local`, created invite `DREAM-0RT6JVTQ`, signed up invitee `chrome-ref-invitee-valid-1782792457450@test.local` through `/signup?ref=DREAM-0RT6JVTQ`, verified invitee Profile shows `400 dreamcoins`, DB confirmed inviter `signup_bonus +250 -> 250` and `referral_reward +150 -> 400`, invitee `signup_bonus +250 -> 250` and `referral_bonus +150 -> 400`, and a conversion Referral row `completed/granted`.
- 2026-06-30 Chrome referral-copy UI recheck: on patched dev server `http://127.0.0.1:3010/profile`, clicked `Invite`, verified `Referral link` field value `http://127.0.0.1:3010/signup?ref=DREAM-RVXWB4I8`, clicked `Copy referral link`, clipboard matched exactly, and console errors were empty.
- 2026-06-30 Chrome account-management recheck: signed up `chrome-account-1782793109078@test.local`, opened `/profile/account-management`, clicked `Sign out all sessions`, verified redirect to `/login`, logged back in successfully, deleted the account with `DELETE`, verified redirect to `/login`, then retried login and saw `Account is not active`, with no console errors.
- 2026-06-30 Chrome Create → Review Queue → public publish recheck: signed up creator `chrome-review-1782793592687@test.local`, created public character `Chrome Review 1782793592687`, verified My AI showed `pending review`, verified the row appeared in fresh admin Review Queue, approved the submission through the same admin decision handler after Chrome-control could not activate the table action, then verified in Chrome that Explore search, `/characters/cmr05bkog001pdil7nyklm30z`, and `/creators/cmr059wbo001hdil7hiaff82d` all exposed the approved public character.

Failed:

- No local user-critical flow remains failed in the verified runtime.
- Production launch gate still fails because production deployment/provider configuration is not present.

## Other Risks

1. Admin dev server had a stale Turbopack chunk state.
   - Chrome hit `ChunkLoadError: Failed to load chunk /_next/static/chunks/0lot587lf8-b3.js`.
   - `pm2 restart admin-web --update-env` recovered the page.
   - Severity: P1 for operator confidence in the current dev runtime; production build passed.

2. Chrome-control could not activate Review Queue row action buttons in this session.
   - The same Review Queue action path passed in focused Playwright E2E against a fresh admin dev server on `3011`.
   - Chrome still verified the pre-decision pending row and the post-decision public Explore/detail/creator surfaces.
   - Treat this as an automation evidence limit, not a confirmed product UI failure, unless reproduced by a human click or standard Playwright.

## Verification Commands

Passed:

- `bun run --filter @idream/chat test -- src/admin.test.ts`
- `bun run --filter @idream/chat test -- src/providers.test.ts`
- `bun run --filter @idream/chat test -- src/agent-tools.test.ts src/generate-agent-tools.test.ts src/providers.test.ts test/web.test.ts`
- `bun run --filter @idream/chat test -- src/generate-agent-tools.test.ts src/providers.test.ts test/web.test.ts`
- `bun run --filter @idream/chat typecheck`
- `bun run --filter @idream/main test -- src/server/admin/dev-login.test.ts`
- `bun run --filter @idream/main test -- src/server/launch-readiness.test.ts`
- `bun run --filter @idream/main db:generate`
- `bun run --filter @idream/main typecheck`
- `bun run --filter @idream/main lint`
- `bun run --filter @idream/main build`
- `bun run --filter @idream/admin build`
- `bun run --filter @idream/main db:seed`
- `bun run --filter @idream/main probe:catalog -- --report .tmp/public-catalog-probe-2026-06-30-after-seed.json`
- `bun run --filter @idream/main probe:product-config -- --report .tmp/launch-product-config-probe-2026-06-30-after-seed.json`
- `bun run check`
- `jq` route-trace inspection confirmed no project `test-results`, `src/e2e`, or project `*.test.*` files remain in main/admin standalone trace manifests.
- `bun run --filter @idream/main probe:catalog`
- `bun run --filter @idream/main probe:product-config`
- `MAIN_WEB_URL=http://127.0.0.1:3000 ADMIN_WEB_URL=http://127.0.0.1:3001 bun run launch:probe:web-surface -- --report .tmp/launch-web-surface-probe-2026-06-30-final.json`
- Chrome billing DB verification for `chrome-billing-1782791498054@test.local`: `premium:monthly`, subscription `active`, `cancelAtPeriodEnd=false`, `currentPeriodEnd=2026-07-30T03:52:50.468Z`, ledger entries `signup_bonus +250 -> 250` and `subscription_grant +1500 -> 1750`.
- Chrome redeem-code DB verification for `chrome-redeem-1782791913375@test.local`: one `RedeemCodeRedemption` for `redeem_2053869262`, reward `{ dreamcoins: 333 }`, ledger entries `signup_bonus +250 -> 250` and `redeem +333 -> 583`; replay did not create a second redemption.
- Chrome referral DB verification for `DREAM-0RT6JVTQ`: parent invite row remained pending, conversion row for invitee `cmr04lz9j0011dil7rvxwb4i8` was `completed/granted`, inviter ledger ended at 400, invitee ledger ended at 400; an intentionally malformed `DREAM-0RT6JVTQA` signup stayed at 250 and created no conversion.
- Chrome account-management DB verification for `chrome-account-1782793109078@test.local`: main user `cmr04zj56001adil7hca58hm5` ended as `status=deleted`, `deletedAt=2026-06-30T04:19:07.310Z`, `sessionCount=0`; `chat.inbound` job `user_deleted_cmr04zj56001adil7hca58hm5` completed; chat domain had `sessions=0`, `usage=0`, and delivered outbox event `chat.account_erasure.completed`.
- Chrome Create/Review DB verification for `Chrome Review 1782793592687`: character `cmr05bkog001pdil7nyklm30z` moved from `pending_review` to `approved`, remained `visibility=public`, submission `cmr05bkol001qdil7h8xvy6s1` moved to `approved`, reviewer `seed-system-creator`, and review reason `Approved during Chrome product audit.`.
- `PW_BASE_URL=http://127.0.0.1:3000 PW_ADMIN_BASE_URL=http://127.0.0.1:3011 bun run --filter @idream/main test:e2e -- src/e2e/admin-web.e2e.ts -g "admin review queue approves"`
- `bun run --filter @idream/main test -- src/server/modules/ourdream/modules.test.ts`
- `bun run check`
- `bun run launch:probe:chat-service -- --report .tmp/launch-chat-service-probe-2026-06-30-qwen4b.json` exited with code 0 in 15.0 seconds, `ok=true`, `sawDelta=true`, `sawDone=true`, and exact assistant status `sent`.
- `set -a; source packages/main/.env; set +a; bun run launch:probe:voice -- --report .tmp/launch-voice-probe-2026-06-30-qwen3tts.json` exited with code 0 in 9.7 seconds and returned WAV audio.
- `set -a; source packages/main/.env; set +a; bun run launch:probe:voice -- --report .tmp/launch-voice-probe-2026-06-30-after-seed.json` exited with code 0 in 4.0 seconds and returned WAV audio.
- `bun run launch:probe:pipeline` passed 6/6: web surface, product config, chat service, chat model, image, and voice.
- `pm2 status` showed `main-web`, `admin-web`, `chat`, `gen-image`, `sdcpp-image`, `gen-finalizer`, and `main-event-consumer` online.

Failed:

- `bun run check:launch` failed with `7 pass, 49 fail, 2 warn` because production runtime variables, provider credentials, service URLs, storage/payment settings, observability, and live probe report evidence are not configured in the current shell.
- `bun run check:launch:direct -- --launch-env-file packages/main/.env.production.example --json` failed with `31 pass, 33 fail, 0 warn`, as expected for an unfilled production template with placeholders and no live production probe evidence.

## Product Readiness Summary

Feature coverage is close for an end-to-end local beta. The product now has working acquisition, signup, catalog, creation, chat, generation, monetization-demo, profile, community, support, and admin operations loops.

The product is not ready for public commercial operation until `check:launch` passes against a real production environment and all required live probe reports are fresh and loaded.
