# Admin Feature Flag Confirmation Audit

Date: 2026-07-04

Scope:
- `/admin/generation/config?tab=settings`
- `PATCH /api/v1/admin/feature-flags/:key`

Finding:
- Feature flag toggles previously accepted the generic `FLAG` confirmation token.
- Because feature flags can change product capabilities globally, the confirmation must bind to the specific flag and target state.

Change:
- Regular feature flag writes now require `${flagKey}:enabled` or `${flagKey}:disabled`.
- The admin modal renders the same target-state confirmation and submits the typed confirmation value.
- Hard-policy flags still fail before mutation with 403.

Chrome Evidence:
- `wrong-confirmation-disabled.png`: the modal rejects `FLAG` by keeping Confirm disabled.
- `flag-enabled.png`: `${flagKey}:enabled` completes the toggle and leaves an audit row.
- `chrome-evidence.json`: records the tested route, accepted/rejected confirmations, final flag state, audit action, and screenshot paths.

Verification:
- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "admin writes are audited"`
- `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3198 PW_ADMIN_BASE_URL=http://127.0.0.1:3197 bun run --filter @idream/main test:e2e -- src/e2e/admin-web.e2e.ts -g "admin feature flag toggle"`
- Temporary Chrome evidence spec passed, then was removed.
