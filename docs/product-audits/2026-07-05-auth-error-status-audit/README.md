# Auth Error Status Audit

Date: 2026-07-05

Scope: Chrome verification for login/signup form error feedback.

## Finding

Before the fix, invalid login showed `Invalid email or password` and kept the `Contact Help Desk` recovery link available, but the error text had no `role` or `aria-live` attributes. The message was visually present but weaker for assistive technology users.

## Fix

`AuthWorkspace` now renders the error text with:

- `role="alert"`
- `aria-live="assertive"`
- `data-testid="auth-status"` for regression coverage

The existing auth E2E now asserts those attributes for invalid login and duplicate signup recovery.

## Evidence

- `01-current-invalid-login-not-live.png`: pre-fix invalid-login error state.
- `current-chrome-evidence.json`: pre-fix DOM evidence with no status/error semantics.
- `02-fixed-invalid-login-alert.png`: post-fix invalid-login error state.
- `fixed-chrome-evidence.json`: post-fix DOM evidence with `role="alert"` and `ariaLive="assertive"`.
- `fixed-console-logs.json`: post-fix Chrome warning/error log capture, `[]`.
