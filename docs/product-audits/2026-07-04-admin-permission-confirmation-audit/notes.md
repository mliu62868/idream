# Admin Permission Override Confirmation Audit

Date: 2026-07-04

## Scope

Admin Users permission override form on `/admin/users`, including API rejection for generic confirmation and audit persistence.

## Flow Captured

1. Permission form: operator filters to one target user and selects user ID, permission key, and effect.
2. Empty confirmation: modal reason is present but `Confirm` remains disabled.
3. Wrong confirmation: generic `PERMISSION` remains disabled, and direct API request with `PERMISSION` returns 400 without creating an override.
4. Ready confirmation: exact `{userId}:{permissionKey}:{effect}` enables `Confirm`.
5. Granted state: override persists and `admin.permission.grant` audit reason is stored.

## UX Findings

- The operator now confirms the exact user, permission key, and effect.
- Generic action words cannot grant or revoke capabilities.
- Permission user ID, key, and effect controls now expose accessible names.
- The confirmation target is visible below the input and wraps for long user IDs.

## Accessibility Notes

- The permission override form now has explicit `Permission user ID`, `Permission key`, and `Permission effect` accessible names.
- Existing modal fields expose `Reason` and `Confirmation` textbox labels.
- Disabled/enabled state is visible and covered by browser test. Full accessibility still needs keyboard-only and screen-reader checks.

## Evidence

- `01-permission-form-filled.png`
- `02-permission-confirmation-empty.png`
- `03-permission-confirmation-wrong.png`
- `04-permission-confirmation-ready.png`
- `05-permission-granted.png`
- `chrome-evidence.json`
