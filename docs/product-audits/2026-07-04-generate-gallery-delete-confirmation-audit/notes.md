# Generate Gallery Delete Confirmation Audit

Date: 2026-07-04

## Scope

Adversarial PM/UX check for Generate Gallery media management. The reviewed flow is a signed-in user deleting generated media from `/generate`, both from an individual Gallery card and from the Manage bulk toolbar.

## Finding

Generate Gallery media deletion was weaker than the newer Profile media destructive-action pattern:

- Individual `Delete` immediately removed the card and called `DELETE /api/v1/media/:id`.
- `Delete selected` in Manage mode immediately called the bulk delete endpoint.
- A failed individual DELETE only refreshed the list and gave no clear failure copy.

Generated media is a paid/creative output, so accidental deletion from a single mis-click is a product-quality issue.

## Fix

- Individual card delete now requires a second `Confirm delete` click.
- First click keeps the card visible and shows `Press Confirm delete to remove this media.`.
- DELETE failures now show `Delete failed.` and refresh the Gallery.
- Bulk `Delete selected` now requires a second `Confirm delete selected` click for the exact selected set.
- Selection changes, tab changes, Gallery refreshes, or leaving Manage mode clear the pending bulk confirmation.

## Verification

- `bun run --filter @idream/main lint`
- `bun run --filter @idream/main typecheck`
- `git diff --check -- packages/main/src/components/ourdream/GeneratorWorkspace.tsx packages/main/src/e2e/ui-workflows.e2e.ts`
- `PW_BASE_URL=http://127.0.0.1:3163 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "generator UI queues an image job and surfaces completed media in the gallery"`
- Chrome channel evidence run via a temporary Playwright spec on `http://127.0.0.1:3163`.

## Chrome Evidence

- Chrome version: `149.0.7827.201`
- Evidence JSON: `chrome-evidence.json`
- Screenshots:
  - `screenshots/01-gallery-media-before-delete.png`
  - `screenshots/02-gallery-single-delete-confirmation.png`
  - `screenshots/03-gallery-single-deleted.png`
  - `screenshots/04-gallery-bulk-delete-confirmation.png`
  - `screenshots/05-gallery-bulk-deleted.png`
- Console/page failures: `[]`
- DB check: first click left both `MediaAsset.deletedAt=null`; confirm click set `deletedAt` for single and bulk deletion fixtures.

## UX Notes

The flow keeps compact icon actions for normal Gallery browsing while making destructive intent explicit before any asset is deleted. Bulk confirmation is tied to the selected ID set so changing the selection requires a fresh confirmation.
