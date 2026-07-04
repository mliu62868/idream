# 2026-07-04 Login Recovery Audit

## Scope

- Browser: Chrome extension controlled tab.
- App URL: `http://127.0.0.1:3126`.
- Flow: `/login` -> invalid credentials -> recovery action -> `/helpdesk`.
- Destination: local folder screenshots and notes.

## Steps

1. Invalid login before fix
   - Screenshot: `screenshots/01-login-invalid-before.png`.
   - Health: weak.
   - Evidence: the form showed `Invalid email or password`, but the form itself had no recovery link or next action. The only support links were global navigation/footer links outside the immediate error context.
   - UX risk: a user who forgot credentials could retry blindly or abandon; the error did not point to the existing account support path.
   - Accessibility risk: the visible error existed, but the recovery path was not adjacent to the error state, increasing navigation burden for keyboard and screen-reader users.

2. Invalid login after fix
   - Screenshot: `screenshots/02-login-invalid-after-helpdesk.png`.
   - Health: healthy for controlled beta.
   - Evidence: after the same invalid login, the form shows `Need account help? Contact Help Desk`; the link is inside the form and has `href="/helpdesk"`.
   - UX strength: the user now has an immediate recovery action without inventing a fake password-reset flow that the backend/email stack does not support yet.
   - Accessibility note: the link text is explicit and adjacent to the error message; full screen-reader announcement behavior was not proven from screenshots alone.

3. Help Desk from login error
   - Screenshot: `screenshots/03-helpdesk-from-login-error.png`.
   - Health: healthy for controlled beta.
   - Evidence: clicking `Contact Help Desk` lands on `/helpdesk`; Help Desk exposes support copy for account issues, a `Support request` form, and an `Account` category. Anonymous auth links preserve `next=/helpdesk`.
   - UX strength: the error recovery path lands on an existing account-support workflow rather than a dead page.

## Verification

- Chrome console warnings/errors: `[]`.
- Focused E2E: `PW_BASE_URL=http://127.0.0.1:3126 bun run --filter @idream/main test:e2e -- src/e2e/flows.e2e.ts -g "auth UI handles invalid login"` passed, 1/1.
- `bun run --filter @idream/main lint` passed.
- `bun run --filter @idream/main typecheck` passed.
- `git diff --check` passed for the touched files and audit folder.

## Limits

- This is not a password-reset implementation. The current controlled-beta recovery path routes account-access issues to Help Desk.
- Screenshots do not prove full assistive-technology behavior; they prove visible placement, link target, and browser navigation.
