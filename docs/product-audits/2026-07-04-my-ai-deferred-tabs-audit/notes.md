# My AI Deferred Tabs Audit

Date: 2026-07-04

Scope: adversarial review of `/custom` V1.1-only tabs (`group chats`, `packs`) after launch-scope docs state these are explicit beta empty states, not implemented product areas.

## Finding

Before this pass, both deferred empty states still rendered a `/create` CTA. That made the tabs feel actionable even though group chats and packs are outside the current beta product scope.

Follow-up adversarial scan found the `/custom` route metadata still described "group chats, packs" as active personal-library capabilities. That could leak a false product promise through SEO previews or browser metadata even after the visible UI was fixed.

## Fix

- `GET /api/v1/library/group-chats` and `GET /api/v1/library/packs` now return `emptyCta: null`.
- `ProfileWorkspace` supports CTA-less empty states and does not render an action link for deferred tabs.
- `/custom` route metadata now describes these as clearly labeled deferred group-chat and pack tabs.
- Product docs now distinguish normal empty states from explanation-only deferred states.

## Verification

- `bun run --filter @idream/main lint`
- `bun run --filter @idream/main typecheck`
- `bun run --filter @idream/main test -- src/server/modules/ourdream/modules.test.ts -t "returns empty-state tabs and liked characters"`
- `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3132 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run test:e2e src/e2e/ui-workflows.e2e.ts -g "my ai shows deferred group chat"`
- `PW_BASE_URL=http://127.0.0.1:3134 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run test:e2e src/e2e/public-routes.e2e.ts -g "my ai metadata does not market"`
- Nav/footer route sweep on `http://127.0.0.1:3134`:
  - All first-party nav/footer links are present in `ourdreamRoutePaths`.
  - All first-party nav/footer paths returned `200` with non-404 titles.
  - External links returned `200`: Help Center, affiliate site, Discord invite redirect, Reddit, and X.
- Chrome manual check on `http://127.0.0.1:3133/custom`:
  - `group chats` empty state text visible; `emptyLinks: []`.
  - `packs` empty state text visible; `emptyLinks: []`; `hasCreateInEmpty: false`.
  - Console warning/error logs: `[]`.
- Chrome manual check on `http://127.0.0.1:3134/custom`:
  - `<meta name="description">` is `Personal AI library shell for recent characters, media, presets, created companions, and clearly labeled deferred group-chat and pack tabs.`
  - Old active-feature phrase `group chats, packs` is absent.
  - `packs` empty state still has `emptyLinks: []` and `hasCreateInEmpty: false`.
  - Console warning/error logs: `[]`.

## Evidence

- `screenshots/01-chrome-packs-no-action-link.png`
- `screenshots/02-chrome-metadata-and-packs-no-action-link.png`
