# Mobile First-Session Audit

Date: 2026-07-04

## Scope

Adversarial Chrome audit of a fresh 390px mobile first-session path:

1. Fresh origin age gate.
2. Explore mobile surface.
3. Melissa Burke detail.
4. Anonymous Chat intent through signup.
5. Returned character detail.
6. Chat session create, message send, assistant reply.
7. Chat -> Generate handoff with Melissa preselected.
8. Generate submit and queued/completed job feedback.

## Result

The mobile first-session path is usable after the fixes in this slice. Signup returns to the intended character, Chat creates a session with persisted user/assistant turns, Generate keeps Melissa selected from the handoff, and generated job feedback is visible in the mobile viewport after submit.

## Findings And Fixes

- Finding: before the fix, submitting Generate from a scrolled mobile viewport switched to Jobs but left the user near Related Pages/footer, so `Active Jobs` and `Queued` feedback were off-screen.
- Fix: `GeneratorWorkspace` now switches to Jobs and scrolls the generator workspace top into view after normal generation and image variation submits.
- Finding: the identity timeline used `next/image` for private `/user-content/*` references, which made the optimizer request the private image without the browser session and produced `400 The requested resource isn't a valid image.`
- Fix: identity timeline private media now uses the same `unoptimized={isPrivateMediaUrl(source)}` path as Gallery and Feed previews, so the browser loads `/user-content/*` directly.

## Chrome Evidence

Screenshots:

- `screenshots/01-mobile-age-gate.png`
- `screenshots/02-mobile-explore-after-age.png`
- `screenshots/03-mobile-character-detail.png`
- `screenshots/04-mobile-signup-chat-return.png`
- `screenshots/05-mobile-returned-character-after-signup.png`
- `screenshots/06-mobile-chat-session-composer.png`
- `screenshots/07-mobile-chat-reply-complete.png`
- `screenshots/08-mobile-generate-preselected.png`
- `screenshots/09-mobile-generation-queued.png` before the scroll fix, showing feedback out of view.
- `screenshots/10-mobile-generation-queued-after-fix.png` after the scroll fix, showing `Active Jobs`, `Queued`, and `Completed` in the mobile viewport.

Post-fix clean reload:

- Identity timeline image URLs are direct `/user-content/.../content.png`.
- Image requests returned 200.
- Chrome console `error`/`warn`/`issue` messages: none.

## Database Evidence

Manual Chrome user before cleanup:

- Email: `mobile-first-1783164958@test.local`.
- User id: `cmr6afu890004hgl7pq5rwl3b`.
- Chat session: `sess_c43ac5e1eed14dcbae1bccef442f4dd4`.
- Chat messages: 1 user sent, 1 assistant sent, 1 assistant version.
- Chat usage: `messagesUsed=1`.
- Generation jobs: `cmr6ahk0f000ahgl7dmqic3cc` and `cmr6apko2000fhgl7m9980ecr`, both completed at 5 dreamcoins each.
- Ledger: `+250 signup_bonus`, `-5 generation_spend`, `-5 generation_spend`.
- Media assets: two private `/user-content/.../content.png` images with local storage keys.
- Melissa Burke `character_visual_profiles` did not reference these media ids, and no `media_asset_placements` referenced them.

Cleanup result:

- Main: user/email, generation jobs, generation events, media assets, ledger, age gate, sessions, and accounts all verified count `0`.
- Chat: session, messages, and usage all verified count `0`.
- Local blob files for both generated images were removed.

## Regression Coverage

```bash
PW_BASE_URL=http://127.0.0.1:3132 PW_ADMIN_BASE_URL=http://127.0.0.1:3001 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "mobile generator keeps queued job feedback"
bun run --filter @idream/main typecheck
bun run --filter @idream/main lint
```

Result: focused E2E 1/1 passed; typecheck passed; lint passed.

## Remaining Observation

On the 390px Explore grid, the first tap on a character card appeared to focus the card and keyboard Enter navigated to detail. This did not block the tested flow, but it should stay on the PM audit watchlist for a future mobile tap-target pass.
