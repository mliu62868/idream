# Library Curated Route Cards Audit

Date: 2026-07-04

Scope:
- `/games`
- `/romantasy`
- `packages/main/src/components/ourdream/OurdreamRoutePage.tsx`
- `packages/main/src/e2e/public-routes.e2e.ts`

Finding:
- Library routes with no child-path prefix rendered an empty card grid. `/games` and `/romantasy` therefore had hero copy and a character strip, but no actual resource/story route cards despite their route descriptions promising game-style or fantasy-romance entries.

Change:
- Added `libraryCardsForRoute()` and curated route cards for `/games` and `/romantasy` using existing catalog routes.
- Kept all card hrefs on existing routes; no new public route was invented.
- Added focused E2E coverage that verifies the curated cards remain present.

Verification:
- `bun run --cwd packages/main lint -- src/components/ourdream/OurdreamRoutePage.tsx src/e2e/public-routes.e2e.ts`
- `bun run --cwd packages/main typecheck`
- `PW_BASE_URL=http://127.0.0.1:3230 PW_WEBSERVER=1 bun run --cwd packages/main test:e2e src/e2e/public-routes.e2e.ts -g "library routes without child paths still expose curated cards"`
- Playwright screenshots/evidence on `http://localhost:3231/games` and `http://localhost:3231/romantasy`.

Evidence:
- `01-games-curated-cards.png`
- `02-romantasy-curated-cards.png`
- `playwright-evidence.json`
