# Admin Content Ops Image Loading Current Audit

Date: 2026-07-04

## Scope

Chrome audit of Admin Content Ops image-heavy pages after the full E2E run showed server-side `/user-content/...` 404 noise and Next image LCP warnings in the temporary admin dev log.

## Step List

1. Opened `http://127.0.0.1:3006/admin/content/assets` in Chrome.
   - Health: Blocked by the expected local Admin login wall.
   - Evidence: Chrome returned the `后台登录` page with no console warnings/errors.

2. Logged in with the local dev admin account and opened `Asset Library`.
   - Health: Functional with no visible broken images or horizontal overflow.
   - Evidence: `screenshots/01-admin-content-assets.png` and `chrome-evidence.json`.
   - Finding: Chrome reported a real Next LCP warning because the first visible `/user-content` image was still lazy-loaded.

3. Updated the shared `AssetImage` component to allow eager loading and marked first-row Content Ops images eager.
   - Health: Fixed.
   - Evidence: `screenshots/05-admin-content-assets-postfix-settled.png`, `screenshots/06-admin-content-placements-postfix-settled.png`, and `chrome-evidence-postfix-settled.json`.
   - Post-fix metrics: Asset Library and Placements visible `/user-content` images are complete, load with `loading="eager"`, have `brokenVisible=[]`, `incompleteVisibleUserContent=[]`, `horizontalOverflow=false`, and Chrome warnings/errors `[]`.

4. Added an `AssetImage` fallback for future missing media assets.
   - Health: Defensive improvement added.
   - Evidence: `screenshots/07-admin-content-assets-fallback.png` and `chrome-evidence-fallback.json`.
   - Limit: the current cleaned local dataset did not contain a visible missing asset after the fix, so the fallback code path was added but not visually triggered in this screenshot. The page still measured `brokenVisible=[]` and Chrome warnings/errors `[]`.

## Accessibility And UX Notes

- The page has clear sidebar current state and visible form labels for Status, Purpose, metadata fields, and action buttons.
- Screenshot review cannot prove full keyboard order or screen reader behavior; this audit only confirms the visible layout, image loading state, and Chrome runtime logs for this surface.
