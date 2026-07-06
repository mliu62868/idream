# Compliance Confirmation Audit

Date: 2026-07-04

Scope: admin Compliance DSAR export/erase and age-verification override flows.

## Finding

The server-side compliance APIs already enforced reason and typed confirmation, and backend tests covered permissions/idempotence. The admin UI still used prompt-style confirmation and auto-submitted fixed confirmation tokens for destructive operations, which made the operator flow too easy to execute accidentally.

## Fix

- DSAR erase now opens an inline confirmation panel.
- Age verification Verify/Fail now opens an inline override confirmation panel.
- Confirm buttons stay disabled until the operator enters a reason plus `ERASE`/target user ID or `OVERRIDE`/verification ID.
- Successful age override updates the visible queue optimistically and suppresses transient silent-refresh errors, so operators do not see a confusing `Unauthorized` after a successful POST.

## Verification

- `bun run --filter @idream/main lint`
- `bun run --filter @idream/main typecheck`
- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "admin compliance"`
- `PW_BASE_URL=http://127.0.0.1:3160 PW_ADMIN_BASE_URL=http://127.0.0.1:3161 bun run --filter @idream/main test:e2e -- src/e2e/admin-web.e2e.ts -g "admin compliance UI requires typed confirmations"`
- Google Chrome channel E2E: admin dev login -> DSAR export -> typed erase -> DB `User.status=deleted` -> age verification typed override -> DB `AgeVerification.status=verified` -> success message visible -> no `Unauthorized`.

The Chrome extension control session could load the admin page, switch to admin, read state, and capture screenshots, but its click injection did not fire the Compliance child-view button handlers. Final browser closure therefore used Playwright with the Google Chrome channel. The only Chrome console item was `/favicon.ico` 404, treated as non-flow resource noise.

## Screenshots

- `screenshots/04-chrome-channel-admin-compliance-baseline.png`
- `screenshots/05-chrome-channel-dsar-confirm-ready.png`
- `screenshots/06-chrome-channel-age-override-ready.png`
- `screenshots/07-chrome-channel-compliance-success.png`
