# Upgrade Copy Drift Audit

Date: 2026-07-04

## Scope

Checked `/upgrade` against the current `video_gen=false` beta scope after aligning product and architecture docs with `packages/main/prisma/seed.ts`.

## Evidence

- Chrome URL: `http://127.0.0.1:3137/upgrade`
- Screenshot: `screenshots/01-chrome-upgrade-plan-cards-no-video-copy.png`
- Chrome console warnings/errors: `[]`
- Plan-card DOM check:
  - `articleCount=4`
  - `containsDreamcoins=true`
  - `containsChatBenefit=true`
  - `containsVideoInCards=false`

## Step Health

1. Upgrade page load: healthy. The page rendered the product shell, demo checkout notice, and four plan cards.
2. Plan-card benefits: healthy for current beta. Cards show `includedDreamcoins` and chat/model benefits, and do not promise disabled video generation or video quota.
3. Product docs: corrected. `ProductFeatureMap`, `ECONOMY_AND_PRICING`, `PRD`, and billing architecture now distinguish plan entitlements from launch-visible video surfaces.

## Verification

```bash
bun run --filter @idream/main lint
bun run --filter @idream/main typecheck
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3136 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/public-routes.e2e.ts -g "active app copy does not promise video tools|my ai metadata does not market"
```

Result: all passed.
