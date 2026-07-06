# Community Campaign Carousel Audit

Date: 2026-07-04

## Finding

`ProductFeatureMap.md` and the Community PRD described a campaign/banner carousel, and Admin Content Ops already supported `MediaAssetPlacement.slot="campaign"`. The public Community page still rendered one hard-coded static hero image, so published campaign placements had no user-facing path.

## Fix

- `GET /api/v1/community/campaigns` now returns up to 6 published campaign image placements from Content Ops.
- The public DTO exposes safe display fields from placement metadata: `eyebrow`, `title`, `ctaLabel`, `href`, and `image`.
- Community now renders a campaign carousel with static fallback content when no campaign placements are published.
- Carousel controls use icon buttons with `Previous campaign` / `Next campaign` labels, a visible `1/2` counter, and an accessible `Campaign N of M` state label.
- The hero remains above-the-fold eager image content and keeps the existing Community filters, Dreamers, Characters, and Collections sections below it.

## Verification

- `bun run --cwd packages/main lint -- src/server/modules/ourdream/service.ts src/components/ourdream/CommunityWorkspace.tsx src/server/modules/ourdream/modules.test.ts src/e2e/ui-workflows.e2e.ts`: passed.
- `bun run --cwd packages/main test src/server/modules/ourdream/modules.test.ts`: 34/34 passed.
- `bun run --cwd packages/main typecheck`: passed.
- `PW_BASE_URL=http://127.0.0.1:3216 PW_WEBSERVER=1 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts -g "community UI filters characters and shows collections"`: 1/1 passed.

Chrome verification on `http://localhost:3217`:

- Seeded two published `campaign` placements.
- Initial Community hero showed `Chrome Campaign Beta 1783210260940-433945`, CTA `/community`, image `promo-card-female`, `loading="eager"`, and `Campaign 1 of 2`.
- `Next campaign` switched the hero to `Chrome Campaign Alpha 1783210260940-433945`, image `pride-card-female`, and `Campaign 2 of 2`.
- Gender filter still changed to `Female`; Community still showed 16 character cards and 3 collections.
- Chrome console warnings/errors were `[]`; horizontal overflow was false.

Screenshots:

- `01-community-campaign-initial.png`
- `02-community-campaign-next.png`
- `03-community-filter-continuity.png`
