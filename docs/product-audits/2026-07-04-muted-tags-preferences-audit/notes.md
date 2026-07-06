# Profile Muted Tags Preference Audit

Date: 2026-07-04

## Finding

`user_preferences.mutedTags` existed in the schema and API, but the user-facing product loop was incomplete: Profile only exposed `Product updates`, Explore only hid `isMutedByDefault` tags, and signed-in users could not manage or apply their own muted tag preferences.

## Fix

- `PATCH /api/v1/profile/preferences` and `PATCH /api/v1/me/preferences` now normalize `mutedTags` to slug values.
- `GET /api/v1/tags` now includes `isMutedByUser` for signed-in users.
- `GET /api/v1/characters` excludes characters tagged with the signed-in user's muted tags.
- Profile exposes a compact `Muted tags` checkbox list inside the existing notifications/preferences panel.
- Explore hides user-muted category chips and resets a muted direct category URL back to the default category.

## Verification

- `bun run --cwd packages/main test src/server/modules/ourdream/modules.test.ts`: 33/33 passed.
- `bun run --cwd packages/main lint -- src/server/modules/ourdream/service.ts src/components/ourdream/ProfileWorkspace.tsx src/components/ourdream/ExploreWorkspace.tsx src/server/modules/ourdream/modules.test.ts src/e2e/ui-workflows.e2e.ts`: passed.
- `bun run --cwd packages/main typecheck`: passed.
- `PW_BASE_URL=http://127.0.0.1:3210 PW_WEBSERVER=1 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts -g "profile UI handles redeem"`: 1/1 passed.
- `git diff --check`: passed.
- `bun run typecheck`: 6/6 passed.

Chrome verification on `http://localhost:3211`:

- Signed up `chrome-muted-1783209064897-147430@test.local`.
- Opened `/profile`, waited for tag controls, and saw `Mute Slow Burn`.
- Checked `Mute Slow Burn`, clicked `Save preferences`, and saw `Preferences updated.`.
- Reloaded `/profile`; `Mute Slow Burn` remained checked.
- Database confirmed `user_preferences.mutedTags=["slow-burn"]`.
- Opened `/`; Explore category buttons were `For You`, `All`, `Elf`; `Slow Burn` was absent.
- Opened `/?tags=slow-burn`; the UI corrected back to `/` and did not expose the muted category chip.
