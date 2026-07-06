# Profile Media Delete Confirmation Audit

Date: 2026-07-04

## Scope

Adversarial PM/UX check for Profile / My AI media management. The reviewed flow is a signed-in user deleting generated media from the Profile `media` tab.

## Finding

Profile media deletion was a one-click destructive action. The nearby Created-character delete flow already required a second `Confirm delete` click, so media deletion was weaker than the product's own destructive-action pattern. The handler also refreshed the library without checking whether the DELETE response succeeded.

## Fix

- Added per-media delete confirmation state in `ProfileWorkspace`.
- First click now keeps the card visible and shows `Press Confirm delete to remove this media.`.
- The delete button changes to `Confirm delete`; only that second click calls `DELETE /api/v1/media/:id`.
- Failed DELETE responses now surface `Delete failed.` instead of silently refreshing.
- Successful deletion shows `Media deleted.`, clears confirmation state, and refreshes the current library tab.

## Verification

- `bun run --filter @idream/main lint`
- `bun run --filter @idream/main typecheck`
- `git diff --check -- packages/main/src/components/ourdream/ProfileWorkspace.tsx packages/main/src/e2e/ui-workflows.e2e.ts`
- `PW_BASE_URL=http://127.0.0.1:3162 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "profile UI handles redeem, referral, billing, and media actions"`
- Chrome channel evidence run via a temporary Playwright spec on `http://127.0.0.1:3162`.

## Chrome Evidence

- Chrome version: `149.0.7827.201`
- Evidence JSON: `chrome-evidence.json`
- Screenshots:
  - `screenshots/01-profile-media-before-delete.png`
  - `screenshots/02-profile-media-delete-confirmation.png`
  - `screenshots/03-profile-media-deleted.png`
- Console/page failures: `[]`
- DB check: first click left `MediaAsset.deletedAt=null`; confirm click set `deletedAt`.

## UX Notes

The flow now matches the existing Created-character destructive-action pattern while keeping the media toolbar compact. It avoids modal friction and native browser dialogs, but prevents accidental loss from a single mis-click.
