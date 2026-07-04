# Mobile App-Shell Navigation Audit

Date: 2026-07-04

## Finding

At a 390px mobile viewport, non-Explore app pages exposed only the fixed bottom shortcuts: `Explore`, `Chat`, `Create`, and `Generate`. The desktop sidebar was correctly hidden, but the alternate full app navigation was only present in the Explore-specific `TopControls` shell. From `/generate`, mobile users could not discover `Feed`, `Community`, `Profile`, or `Upgrade` from the app shell.

Evidence:

- Before: `screenshots/before-generate-mobile-chrome-channel.png`
- Before state JSON: `screenshots/before-generate-mobile-chrome-channel.json`

## Fix

Added a reusable client-only `MobileAppMenu` to the shared non-Explore app topbar. It uses the existing app nav data, includes account destinations, supports external links, highlights active internal routes, and leaves the bottom nav as fast-access shortcuts.

Changed files:

- `packages/main/src/components/ourdream/MobileAppMenu.tsx`
- `packages/main/src/components/ourdream/OurdreamRoutePage.tsx`
- `packages/main/src/e2e/ui-workflows.e2e.ts`

## Verification

Commands:

```bash
bun run lint -- src/components/ourdream/MobileAppMenu.tsx src/components/ourdream/OurdreamRoutePage.tsx src/e2e/ui-workflows.e2e.ts
bun run typecheck
PW_BASE_URL=http://127.0.0.1:3111 bun run test:e2e -- src/e2e/ui-workflows.e2e.ts -g "mobile app shell menu exposes the full product navigation"
```

Results:

- Lint: pass.
- Typecheck: pass.
- Focused E2E: pass, 1/1.
- Chrome-channel mobile pass: 390px `/generate` menu exposes `Feed`, `Community`, `Profile`, and `Upgrade`; clicking `Community` lands on `/community`.

After evidence:

- `screenshots/after-generate-mobile-menu-chrome-channel.png`
- `screenshots/after-community-mobile-chrome-channel.png`
- `screenshots/after-mobile-menu-chrome-channel.json`

## Status

Closed for local/internal beta. Public launch status remains governed by the production provider and launch-probe gates.
