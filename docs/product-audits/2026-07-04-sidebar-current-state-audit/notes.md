# Sidebar Current-State Audit

Date: 2026-07-04

## Scope

Adversarial navigation semantics pass for signed-in app-shell routes that can visually collide:

- `/custom` My AI workspace
- `/profile`
- `/profile/notifications`
- `/creators/seed-creator-some1cool`

The review focused on one product contract: the sidebar must expose exactly one truthful current destination for the user's current context.

## Finding

Before this pass, `/profile*` shared `/custom` as its active destination, while the sidebar Profile link could also act as a current destination. Creator profiles also hardcoded Explore as the active destination even though the flow belongs to Community.

This created misleading navigation state for signed-in users:

- My AI and Profile could blur together.
- Creator profiles appeared as Explore instead of Community.
- Assistive technology could receive the wrong `aria-current` signal.

## Fix

- `activeHrefForPath()` now maps `/custom*` to My AI and `/profile*` to Profile separately.
- The sidebar Profile and Upgrade footer links now participate in the same `aria-current` contract as the primary navigation links.
- Creator profiles now mark Community as current in both desktop sidebar and mobile bottom nav.
- Focused E2E coverage now asserts exactly one current sidebar destination for `/custom`, `/profile`, `/profile/notifications`, and `/upgrade`.
- The Community workflow E2E now asserts creator profiles mark Community current and do not mark Explore current.

## Chrome Evidence

Chrome verified the signed-in shell on `http://127.0.0.1:3145`:

| Route | Expected current sidebar item | Observed current sidebar item | Console warnings/errors | Screenshot |
| --- | --- | --- | --- | --- |
| `/custom` | `My AI` | `My AI` | `[]` | `screenshots/01-chrome-custom-my-ai-current.png` |
| `/profile` | `Profile` | `Profile` | `[]` | `screenshots/02-chrome-profile-current.png` |
| `/profile/notifications` | `Profile` | `Profile` | `[]` | `screenshots/03-chrome-profile-notifications-current.png` |
| `/creators/seed-creator-some1cool` | `Community` | `Community` | `[]` | `screenshots/04-chrome-creator-community-current.png` |

Chrome DOM health for all four routes:

- `is404=false`
- `brokenImages=[]`
- `<main>` present
- Screenshot visually inspected after capture

## Verification

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3143 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/public-routes.e2e.ts -g "account shell routes expose"
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3144 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "community UI lists dreamers"
bun run --filter @idream/main lint
bun run --filter @idream/main typecheck
```

All commands passed. One earlier attempt to run the Community E2E in parallel with an existing Next dev server failed because Next refused a second dev server for the same package; rerunning sequentially passed.
