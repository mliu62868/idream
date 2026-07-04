# Explore Mobile Navigation Audit

Date: 2026-07-04

## Finding

Explore used its own mobile navigation menu while non-Explore app pages used the shared app-shell menu. At 390px on `/`, the Explore menu exposed `Create`, `Explore`, `Chat`, `Generate`, `My AI`, `Feed`, `Community`, `Help Desk`, and `Upgrade`, but omitted `Safety Center`, `Discord`, `More`, and `Profile`. It also had no `App navigation` accessible name, so the mobile navigation contract differed between the primary discovery page and the rest of the app shell.

Evidence:

- Before screenshot: `screenshots/before-explore-mobile-menu-chrome-channel.png`
- Before state: `screenshots/before-explore-mobile-menu-chrome-channel.json`

## Fix

Replaced the hard-coded Explore mobile menu in `TopControls` with the shared `MobileAppMenu` component. Explore now exposes the same mobile app navigation contract as `/generate` and other app-shell pages.

Changed files:

- `packages/main/src/components/ourdream/TopControls.tsx`
- `packages/main/src/components/ourdream/MobileAppMenu.tsx`
- `packages/main/src/e2e/ui-workflows.e2e.ts`

## Verification

Commands:

```bash
bun run lint -- src/components/ourdream/MobileAppMenu.tsx src/components/ourdream/TopControls.tsx src/components/ourdream/OurdreamRoutePage.tsx src/e2e/ui-workflows.e2e.ts
bun run typecheck
PW_BASE_URL=http://127.0.0.1:3112 bun run test:e2e -- src/e2e/ui-workflows.e2e.ts -g "mobile app shell menu exposes the full product navigation|mobile explore menu shares the full product navigation"
```

Results:

- Lint: pass.
- Typecheck: pass.
- Focused E2E: pass, 2/2.
- Chrome-channel mobile pass: 390px `/` menu is labeled `App navigation` and exposes `Safety Center`, `Discord`, `More`, `Profile`, and `Upgrade`.

After evidence:

- `screenshots/after-explore-mobile-menu-chrome-channel.png`
- `screenshots/after-explore-mobile-menu-chrome-channel.json`

## Status

Closed for local/internal beta. Public launch status remains governed by the production provider and launch-probe gates.
