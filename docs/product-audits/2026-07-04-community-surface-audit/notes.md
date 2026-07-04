# Community Surface Audit - 2026-07-04

## Scope

Chrome adversarial pass on the public Community browsing surface:

- First viewport rendering and image loading.
- Release/Gender/Style filter interaction.
- Empty result feedback for Characters.
- Console warnings/errors after the fix.

## Findings

- Before fix, the Community hero banner was above the fold but rendered with `loading="lazy"`, unlike the already-hardened Explore/Feed first-viewport image strategy.
- During filter testing, `Gender=male` + `Style=anime` returned zero character cards and left the Characters section blank.
- A `*.localhost` dev host rendered a blank body, while `localhost` and `127.0.0.1` rendered correctly. This was treated as a dev-host isolation artifact, not a product bug.

## Changes

- `CommunityWorkspace` now marks the hero banner image as `loading="eager"`.
- `CommunityWorkspace` now renders `No characters match these filters.` when the Characters result set is empty after loading.
- `ui-workflows.e2e.ts` now asserts the Community hero image is eager, records absence of LCP warnings, and mocks empty Community API responses to verify explicit empty states.

## Chrome Evidence

- `01-community-before-hero-lazy.png`: Community first viewport before the hero loading fix.
- `03-community-after-cold-restart.png`: cold-start verification with hero `loading="eager"`, image loaded, and console warnings/errors `[]`.
- `05-community-empty-state-after-fix.png`: no-result filter state showing the Characters empty state while Collections remains usable.

## Verification

- Chrome on `http://127.0.0.1:3123/community`: hero `loading="eager"`, natural size `720x144`, filters visible, console warnings/errors `[]`.
- Chrome filter smoke: `Gender=male`, `Style=anime`, 0 character cards, `No characters match these filters.`, console warnings/errors `[]`.
- `PW_BASE_URL=http://127.0.0.1:3123 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "community UI filters characters and shows collections|community shows explicit empty states when public data is unavailable"`
- `bun run --filter @idream/main lint -- src/components/ourdream/CommunityWorkspace.tsx src/e2e/ui-workflows.e2e.ts`
- `bun run --filter @idream/main typecheck`
