# Resources Hub Readable Cards Audit

Date: 2026-07-04

Scope:
- `/resources-hub`
- `packages/main/src/components/ourdream/OurdreamRoutePage.tsx`
- `packages/main/src/e2e/public-routes.e2e.ts`

Finding:
- Resources Hub cards were generated from route path suffixes for the aggregate hub, so visible card titles could leak raw slugs such as `how-to-use-character-ai`.
- PRD SE-04 expects Library pages to aggregate related entries as readable content routes.

Change:
- Resources Hub cards now use `getOurdreamRoute()` for visible title and description while keeping hrefs unchanged.
- Library cards now render route descriptions instead of one repeated generic card paragraph.
- Added a focused E2E regression for readable Resources Hub titles and slug-free visible copy.

Verification:
- `bun run --cwd packages/main lint -- src/components/ourdream/OurdreamRoutePage.tsx src/e2e/public-routes.e2e.ts`
- `bun run --cwd packages/main typecheck`
- `PW_BASE_URL=http://127.0.0.1:3228 PW_WEBSERVER=1 bun run --cwd packages/main test:e2e src/e2e/public-routes.e2e.ts -g "resources hub shows readable route titles"`
- Playwright screenshot/evidence on `http://localhost:3229/resources-hub`.

Evidence:
- `01-resources-hub-readable-cards.png`
- `playwright-evidence.json`
