# 2026-07-04 Core Flows Current E2E

## Scope

Adversarial PM verification of the current local product surface after the latest fixes.

This pass covers:

- Playwright core E2E for age gate, auth, chat, generation, billing, moderation, create/generate render smoke, and admin API smoke.
- Chrome end-to-end product flow after age acceptance: Explore -> character detail -> signup with return target -> Generate queued/completed -> Chat message roundtrip -> Create private character -> Upgrade checkout -> return to Generate.

## Automated E2E

Command:

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3202 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun --cwd packages/main playwright test src/e2e/flows.e2e.ts
```

Result:

- `9 passed (15.4s)`.

Coverage:

- Age gate blocks protected UI/API before acceptance.
- Age acceptance restores API cookie from prior local acceptance.
- Signup creates authenticated session and starter balance.
- Invalid login, duplicate signup recovery, logout, returning login, and authenticated redirect.
- Chat session creation, persisted messages, and rename through the real server.
- Generation, billing, and moderation queue through the real server.
- Create and Generate workspaces render.
- Admin control-plane API responds.

## Chrome Evidence

Server:

- `bun run dev --port 3203` from `packages/main`.

Final Chrome console:

- `tab.dev.logs({ levels: ["error", "warn"], limit: 80 })` returned `[]`.

Screenshots:

- `screenshots/02-explore-accepted-viewport.png` - accepted Explore first viewport; 16 character links and 0 visible image failures.
- `screenshots/03-character-detail.png` - Melissa detail with Chat, Generate, Like, Report.
- `screenshots/04-signup-form.png` - signup form for `/signup?next=/generate?characterId=melissa-burke`.
- `screenshots/05-generate-after-signup.png` - post-signup Generate page with `250 coins`, Melissa selected, authenticated header.
- `screenshots/06-generate-job-queued.png` - Chrome UI queued image generation and balance changed to `245 coins`.
- `screenshots/07-generate-completed-gallery.png` - same generation completed and Gallery media loaded from `/user-content/.../content.png`.
- `screenshots/08-chat-session-composer.png` - Chat session composer opened from character detail.
- `screenshots/08-chat-message-roundtrip.png` - sent `hello from chrome audit`, received assistant reply, action controls visible.
- `screenshots/09-create-start.png` - Create 5-step wizard start.
- `screenshots/10-create-before-submit.png` - Publish step with private visibility.
- `screenshots/11-create-saved-character.png` - `Saved Nova Vale to My AI.` plus Open character / My AI links.
- `screenshots/12-upgrade-plans.png` - Upgrade plans and demo checkout notice.
- `screenshots/13-upgrade-success-return.png` - Deluxe monthly activated, dreamcoins added, View billing / Start generating links.
- `screenshots/14-upgrade-return-generate.png` - Start generating returned to `/generate?characterId=melissa-burke`, balance `6,245 coins`, completed job and Gallery still present.

## Service-Side Facts

Chrome generation job:

- Job id: `cmr6v5mx200070sl7wsxc3ea3`.
- User: `chrome-core-1783199804918@test.local`.
- Status: `completed`.
- Cost: `5` dreamcoins.
- Asset count: `1`.
- Asset URL: `/user-content/bWVkaWFfODN5ZzN6czhoNG1yNnY2aXVs/content.png`.
- Event chain: `created -> reserved -> queued -> provider_completed -> moderating_output -> moderation_passed -> completed`.

Chrome create flow:

- Default wizard values advanced from Identity to Publish.
- Private character saved with status copy `Saved Nova Vale to My AI.`.
- Created character link: `/characters/cmr6vdvli000g0sl7ulwytvhr`.

Chrome upgrade flow:

- Demo checkout activated Deluxe monthly.
- Result copy: `Deluxe monthly is active. 6,000 dreamcoins were added.`
- `Start generating` returned to `/generate?characterId=melissa-burke`.

## Limitations

- The user's Chrome profile had already accepted the local age gate for `127.0.0.1`/`localhost`; first-visit age-gate UI proof for this pass comes from Playwright E2E, not the Chrome profile screenshot.
- This is local/internal beta proof. It does not change the separate production-provider launch blockers for real payment, blob storage, age verification provider, production secrets, Sentry, or live production probes.
