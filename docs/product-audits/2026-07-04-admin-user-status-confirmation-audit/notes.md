# Admin User Status Confirmation Audit

Date: 2026-07-04

## Scope

Admin Users suspend/restore actions on `/admin/users`, including API rejection for generic status confirmation and audit persistence.

## Flow Captured

1. Active user row: operator filters to one target user and sees status `active`.
2. Empty suspend confirmation: modal reason is present but `Confirm` remains disabled.
3. Wrong suspend confirmation: generic `SUSPENDED` remains disabled, and direct API request with `SUSPENDED` returns 400 without changing status.
4. Ready suspend confirmation: exact `{userId}:suspended` enables `Confirm`.
5. Suspended row: user status changes to `suspended` and action status confirms completion.
6. Ready restore confirmation: exact `{userId}:active` enables `Confirm`.
7. Restored row: user status changes back to `active` and two `user.status.write` audit reasons are stored.

## UX Findings

- The operator now confirms both which user changes and the target status.
- Generic status words cannot trigger account status mutation.
- The required confirmation target is visible below the input and wraps for long user IDs.

## Accessibility Notes

- Existing modal fields expose `Reason` and `Confirmation` textbox labels.
- Disabled/enabled state is visible and covered by browser test. Full accessibility still needs keyboard-only and screen-reader checks.

## Evidence

- `01-user-active-row.png`
- `02-suspend-confirmation-empty.png`
- `03-suspend-confirmation-wrong.png`
- `04-suspend-confirmation-ready.png`
- `05-user-suspended-row.png`
- `06-restore-confirmation-ready.png`
- `07-user-restored-row.png`
- `chrome-evidence.json`
