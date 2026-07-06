# Global Search Route Suggestions Audit

Date: 2026-07-04

## Finding

The app-shell search placeholder promised "characters, guides, and generators," but the suggestion dropdown only returned live character and tag records. Users looking for help pages or generator routes had to submit to Explore first instead of opening the relevant guide/tool directly.

## Changes

- Extended `/api/v1/search/suggest` with deterministic route suggestions from the Ourdream route catalog.
- Limited route suggestions to product-relevant guide, generator, comparison, resource, type, video, and companion-content routes.
- Added route rows to the topbar suggestion dropdown using the existing compact list style, with generator/page icons and keyboard selection.
- Kept the existing Explore GET fallback for Enter without a highlighted suggestion.

## Evidence

- Chrome on `http://localhost:3223/generate?characterId=melissa-burke`: typing `character cards` opened route suggestions for `Character Cards` (`/guides/character-cards`) and `AI Games` (`/games`) with no horizontal overflow.
- Keyboard path: `ArrowDown` + `Enter` navigated to `/guides/character-cards`; the loaded page showed the `Character Cards` heading and had no horizontal overflow.
- Console warnings/errors: `[]`.
- Screenshots: `01-route-suggestions.png`, `02-route-suggestion-detail.png`.
- Evidence JSON: `chrome-evidence.json`.

## Tests

- `bun run --cwd packages/main lint -- src/components/ourdream/AppSearch.tsx src/server/modules/ourdream/service.ts src/server/modules/ourdream/flows.test.ts src/e2e/ui-workflows.e2e.ts`
- `bun run --cwd packages/main typecheck`
- `bun run --cwd packages/main test src/server/modules/ourdream/flows.test.ts` -> 14/14
- `PW_BASE_URL=http://127.0.0.1:3222 PW_WEBSERVER=1 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts -g "global header search suggestions open guide routes"` -> 1/1
