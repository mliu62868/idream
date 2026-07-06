# Global Search Suggestions Audit

Date: 2026-07-04

## Finding

`/api/v1/search/suggest` existed in the public API spec and backend, but the app-shell search UI only submitted a plain GET search. That left a product-level affordance invisible to users and created a second inconsistency: suggestions did not honor signed-in muted-tag preferences while Explore did.

## Changes

- Added a client topbar search component with character/tag suggestions, image thumbnails, keyboard navigation, and existing app-shell styling.
- Kept the existing `next/form` GET fallback so pressing Enter without a highlighted suggestion still opens Explore results.
- Updated `search/suggest` to require the same public approved, non-deleted, user-muted-tag filtering used by Explore.

## Evidence

- Chrome on `http://localhost:3221/generate?characterId=melissa-burke`: typing `Chrome Search Suggest 1783213991361-466318 Alpha` opened one suggestion with a loaded 40px image, no horizontal overflow, and `href=/characters/chrome-search-suggest-char-1783213991361-466318`.
- Keyboard path: `ArrowDown` + `Enter` used App Router navigation and navigated to `/characters/chrome-search-suggest-char-1783213991361-466318`; the loaded detail page contained the character name and had no horizontal overflow.
- Console warnings/errors: `[]`.
- Screenshots: `01-search-suggestions.png`, `02-search-suggestion-detail.png`.
- Temporary Chrome fixture cleanup removed 1 character stat row, 1 character row, and 1 creator row.

## Tests

- `bun run --cwd packages/main lint -- src/components/ourdream/AppSearch.tsx src/components/ourdream/OurdreamRoutePage.tsx src/server/modules/ourdream/service.ts src/server/modules/ourdream/modules.test.ts src/server/modules/ourdream/flows.test.ts src/e2e/ui-workflows.e2e.ts`
- `bun run --cwd packages/main typecheck`
- `bun run --cwd packages/main test src/server/modules/ourdream/modules.test.ts` -> 35/35
- `bun run --cwd packages/main test src/server/modules/ourdream/flows.test.ts` -> 14/14
- `PW_BASE_URL=http://127.0.0.1:3220 PW_WEBSERVER=1 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts -g "global header search suggestions open character detail"` -> 1/1
