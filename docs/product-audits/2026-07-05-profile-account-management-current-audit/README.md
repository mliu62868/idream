# Profile Account Management Current Audit

Date: 2026-07-05

Scope: signed-in Profile account-management flow, including sign out all sessions, delete confirmation, account deletion, deleted-account login recovery, and cleanup.

## Steps

1. Signup return to `/profile/account-management`: pass. Chrome landed on the Profile page, showed the Account management panel, showed `Sign out all sessions`, showed the delete confirmation field, kept `Delete` disabled, and had no horizontal overflow.
2. Sign out all sessions: pass. Clicking `Sign out all sessions` returned the user to `/login`; DB evidence later showed the user had zero sessions.
3. Fresh signup return to `/profile/account-management`: pass. A second disposable user landed on the same panel with the destructive delete action disabled.
4. Wrong delete confirmation: pass. Typing `NOPE` kept `Delete` disabled.
5. Exact delete confirmation: pass. Typing `DELETE` enabled `Delete`.
6. Delete account: pass. Clicking `Delete` returned to `/login`; DB evidence showed the user was `status=deleted`, had `deletedAt`, and had zero sessions.
7. Deleted-account login: pass. Reusing the deleted credentials stayed on `/login` and showed `Account is not active` as `role="alert"` with `aria-live="assertive"`.

## Evidence

- `chrome-evidence.json`: current Chrome state for all 7 steps; `browserLogs=[]`.
- `db-evidence-before-cleanup.json`: sign-out user active with zero sessions; deleted user `status=deleted`, `deletedAt` set, and zero sessions.
- `db-cleanup.json`: temporary Chrome users removed, `remainingUsers=0`.
- Screenshots `01` through `07`: visual evidence for each step.

## Verification

- `PW_BASE_URL=http://127.0.0.1:3272 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "profile account management signs out sessions and deletes the account"` passed.
- `bun run --cwd packages/main test -- src/server/modules/ourdream/modules.test.ts -t "delete request clears live sessions and blocks credential login|signs out all sessions and processes a delete request"` passed, `2` tests.

No product/code defect was found in this slice.
