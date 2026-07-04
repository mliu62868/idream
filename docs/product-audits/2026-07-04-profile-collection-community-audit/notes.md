# Profile Collection -> Community Audit

Date: 2026-07-04

## Audit Scope

Flow audited with Chrome on `http://profile-collection-1781783155039074.localhost:3122`:

1. Fresh visitor opens signup and accepts the age gate.
2. New user signs up and enters the authenticated product shell.
3. A generated media fixture appears in Profile / My AI media library.
4. User creates a public collection from that media.
5. Owner views the focused collection on Community.
6. Fresh anonymous origin opens the same public Community collection after age gate acceptance.

## Step Evidence

| Step | Screenshot | Health |
| --- | --- | --- |
| Age gate before signup | `screenshots/01-age-gate-on-signup.png` | Healthy; protected product surface blocks before acceptance. |
| Authenticated shell after signup | `screenshots/02-after-signup-shell.png` | Healthy; signup created a session and returned to the app shell. |
| Profile overview | `screenshots/03-profile-overview-before-media-tab.png` | Healthy; My AI account controls rendered for the signed-in user. |
| Profile media library | `screenshots/04-profile-media-tab-with-asset.png` | Healthy; media card rendered a real image and collection controls. |
| Collection publish feedback | `screenshots/05-profile-collection-published-toast.png` | Healthy; UI showed `Collection published to Community.` and refreshed collection membership. |
| Owner Community view | `screenshots/06-community-owner-focused-collection.png` | Healthy; focused public collection rendered with `data-focused=true`, status copy, and a loaded preview image. |
| Anonymous public age gate | `screenshots/07-public-community-age-gate.png` | Healthy; fresh public origin still requires age gate acceptance. |
| Anonymous public Community before fix | `screenshots/08-public-community-focused-collection-current.png` | Bug found; collection card and status rendered, but preview image had `naturalWidth=0`. Direct media request returned `401 Unauthorized`. |
| Anonymous public Community after fix | `screenshots/09-public-community-focused-collection-fixed.png` | Fixed; same anonymous public view shows the preview image with `naturalWidth=800`, `naturalHeight=1003`, and console warnings/errors `[]`. |

## Finding

Public collections were only visually complete for the collection owner. The Community API returned the public collection and preview URL to anonymous age-gated visitors, but `/user-content/:id/content.webp` still required a logged-in readable-media owner/platform permission. That left public collection cards with broken preview images for anonymous visitors and other users.

## Fix

- `contentMedia` now serves `public_pack` media with `safetyStatus` `passed` or `unknown` to age-gated requests before falling back to owner/platform readable-media permission.
- Private media still requires an authenticated owner session and age verification.
- Existing `/api/v1/media/:id/download` entitlement remains owner/platform scoped.

## Verification

- Chrome owner view: `Chrome Collection 1781783155039074` rendered on `/community?collection=cmr64nfi60007f5l7e1ekua1k` with preview image `800x1003`, focused state, and console warnings/errors `[]`.
- Chrome anonymous public view before fix: same Community collection rendered, but preview image `naturalWidth=0`; direct curl with only `AdultContentAcceptedOD=true` returned `401 Unauthorized`.
- Chrome anonymous public view after fix: direct curl returned `200 OK`, `content-type: image/webp`, 115967 bytes; Chrome rendered the preview image at `800x1003` with console warnings/errors `[]`.
- Focused unit: `bun run --filter @idream/main test -- src/server/modules/ourdream/gaps.test.ts -t "public collection preview"` passed.
- Focused lint: `bun run --filter @idream/main lint -- src/server/modules/ourdream/service.ts src/server/modules/ourdream/gaps.test.ts` passed.
