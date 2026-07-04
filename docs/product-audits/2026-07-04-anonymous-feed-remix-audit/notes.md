# Anonymous Feed Remix Signup Audit

Date: 2026-07-04

## Finding

Chrome exposed product friction after anonymous Feed Remix: Generate carried the correct `characterId` and `remixFeedItemId`, but the insufficient-balance banner framed the next step as `Get coins`. For an anonymous viewer, the smoother next action is signup because the free account receives starter coins and must preserve the remix intent.

## Fix

- `GET /api/v1/generation/config` now includes `viewer.authenticated`.
- `GeneratorWorkspace` switches the insufficient-balance CTA to `Join Free` for anonymous viewers.
- The signup link preserves the full Generate query, including `remixFeedItemId`.
- Signed-in zero-balance users still see the existing `Get coins` upgrade path.

## Verification

- `PW_BASE_URL=http://127.0.0.1:3110 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "feed remix signup redirect preserves anonymous generator intent"`: 1/1 passed.
- `PW_BASE_URL=http://127.0.0.1:3110 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "feed remix signup redirect preserves|feed like signup redirect returns|feed UI supports share"`: 3/3 passed.
- `bun run --filter @idream/main lint`: passed.
- `bun run --filter @idream/main typecheck`: passed.
- Chrome final loop: Feed Remix -> `Join free to get starter coins for this remix.` -> signup -> returned to `/generate?characterId=melissa-burke&remixFeedItemId=character%3Amelissa-burke` with Generate enabled and console warnings/errors `[]`.
- Temporary Chrome signup user `chrome-feed-remix-signup-1783148025708@test.local` cleaned up with `remaining=0`.

## Evidence

- `screenshots/anonymous-feed-remix-generate-state.png`
- `screenshots/anonymous-feed-remix-join-free-final.png`
- `screenshots/anonymous-feed-remix-returned-enabled-final.png`

