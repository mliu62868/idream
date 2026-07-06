# Admin Billing Adjustment Confirmation Audit

Date: 2026-07-04

## Scope

Admin Billing manual ledger adjustment on `/admin/billing`, including API rejection for generic confirmation and ledger/audit persistence.

## Flow Captured

1. Adjustment form: operator enters target user ID and delta.
2. Empty confirmation: modal reason is present but `Confirm` remains disabled until confirmation is typed.
3. Wrong confirmation: generic `ADJUST` remains disabled, and direct API request with `ADJUST` returns 400 without creating a ledger row.
4. Ready state: exact `{userId}:{delta}` enables `Confirm`.
5. Saved state: form clears, one `admin_adjust` ledger row persists, and audit log stores the operator reason.

## UX Findings

- The operator now confirms both who gets coins and how many coins move.
- Generic action words from other admin flows cannot trigger a ledger mutation.
- The confirmation target is visible in the modal below the input.

## Accessibility Notes

- Existing modal fields expose `Reason` and `Confirmation` labels.
- Disabled/enabled state is visible and covered by browser test. Full accessibility still needs keyboard-only and screen-reader checks.

## Evidence

- `01-billing-adjustment-form.png`
- `02-billing-confirmation-empty.png`
- `03-billing-confirmation-wrong.png`
- `04-billing-confirmation-ready.png`
- `05-billing-adjustment-saved.png`
- `chrome-evidence.json`
