# Admin Content Governance Confirmation Audit

Date: 2026-07-04

## Scope

Admin Content character governance actions on `/admin/content`, including `Make private`, `Remove`, API rejection for generic confirmations, and audit persistence.

## Flow Captured

1. Public approved row: operator filters to one target character and sees `public` / `approved`.
2. Visibility wrong confirmation: generic `VISIBILITY` remains disabled, and direct API request with `VISIBILITY` returns 400 without changing visibility.
3. Visibility ready confirmation: exact `{characterId}:visibility:private` enables `Confirm`.
4. Private row: character visibility changes to `private`.
5. Status wrong confirmation: generic `STATUS` remains disabled, and direct API request with `STATUS` returns 400 without changing status.
6. Status ready confirmation: exact `{characterId}:status:removed` enables `Confirm`.
7. Removed row: character status changes to `removed`, and both visibility/status audit rows are stored.

## UX Findings

- The operator now confirms both the character and the exact field/value being changed.
- Generic action words cannot hide or remove public content.
- The required confirmation target is visible below the input and wraps for long character IDs.

## Accessibility Notes

- Existing modal fields expose `Reason` and `Confirmation` textbox labels.
- Disabled/enabled state is visible and covered by browser test. Full accessibility still needs keyboard-only and screen-reader checks.

## Evidence

- `01-content-row-public-approved.png`
- `02-visibility-confirmation-wrong.png`
- `03-visibility-confirmation-ready.png`
- `04-content-row-private.png`
- `05-status-confirmation-wrong.png`
- `06-status-confirmation-ready.png`
- `07-content-row-removed.png`
- `chrome-evidence.json`
