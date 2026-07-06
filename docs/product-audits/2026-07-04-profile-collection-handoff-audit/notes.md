# Profile Collection Handoff Audit

Date: 2026-07-04

## Audit Scope

Flow audited in Chrome on `http://127.0.0.1:3151`:

1. Signed-up user opens Profile media.
2. User creates a public collection from owned generated media.
3. Profile success state offers a direct Community handoff.
4. Owner clicks the handoff and lands on the focused Community collection.
5. Logged-out visitor opens the same public Community collection.

## Step Evidence

| Step | Screenshot | Health |
| --- | --- | --- |
| Profile media ready | `screenshots/01-profile-media-ready.png` | Healthy; signed-in Profile media tab rendered the owned image card and collection controls. |
| Published handoff | `screenshots/02-profile-collection-published-link.png` | Fixed; `Collection published to Community.` now appears with a visible `View in Community` link whose `href` includes the returned collection id. |
| Owner Community landing | `screenshots/03-community-owner-focused-collection.png` | Healthy; clicking the Profile link opened `/community?collection=cmr6hr0880005oml7vrdwa4d4`, focused the matching card, and rendered the preview image. |
| Anonymous public landing | `screenshots/04-community-anonymous-focused-collection.png` | Healthy; after logout, the same URL showed Login/Join Free while keeping the focused public collection and loaded preview image visible. |

## Finding

Publishing a public collection succeeded technically, but Profile discarded the API response collection id. The user saw only `Collection published to Community.` and had to manually navigate to Community and find the collection. That was avoidable friction, especially on mobile after a successful create action.

## Fix

- `ProfileWorkspace` now reads the created collection id from `/api/v1/media/collections`.
- Public collection success now surfaces a `View in Community` link to `/community?collection=<id>`.
- The status message is exposed with `role="status"` so the async completion state is announced.
- The Profile media E2E now clicks the real handoff instead of manually navigating to `/community`.
- A new 390px E2E verifies the handoff link is visible, does not create horizontal overflow, and lands on a focused Community collection.

## Verification

- Chrome Profile publish: collection `Chrome handoff 1783177343553`, link `/community?collection=cmr6hr0880005oml7vrdwa4d4`, status `Collection published to Community.`, no horizontal overflow.
- Chrome owner Community: focused card id `cmr6hr0880005oml7vrdwa4d4`, text `Chrome handoff 1783177343553`, preview image `naturalWidth=1`, `naturalHeight=1`.
- Chrome anonymous Community: logged-out state showed Login/Join Free, same focused id, same loaded preview image, console warnings/errors `[]`.
- Focused E2E: `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3150 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "profile UI handles redeem|mobile profile media publish"` passed, 2 tests.

## Evidence Limits

Screenshots confirm visible UI state and Chrome loaded image dimensions. They do not prove full WCAG compliance or production CDN behavior; those remain covered by automated accessibility-oriented assertions and launch/provider probes.
