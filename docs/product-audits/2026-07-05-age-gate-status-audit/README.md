# Age Gate Status Audit

Date: 2026-07-05

## Scope

Adversarial check of the first protected app entry state at `/generate`: initial gate, failed accept action, and retry recovery.

## Finding

The age gate already kept protected content hidden and showed retry copy when acceptance failed, but the failure copy was plain visible text. That made a real first-session error easier to miss for assistive technology and harder to lock with stable tests.

## Fix

- Age-gate accept failures now render as `data-testid="age-gate-status"`.
- The failure node uses `role="alert"` and `aria-live="assertive"`.
- The retry path keeps the user on the gate until a later accept succeeds.

## Chrome Evidence

- `01-age-gate-initial.png` / `.json`: fresh localhost origin at `/generate`; gate visible, no `<main>`, no status yet.
- `02-age-gate-accept-failure.png` / `.json`: after a real failed accept request, protected content remains hidden, the retry copy is visible, `role="alert"`, `aria-live="assertive"`, and horizontal overflow is false.
- `03-age-gate-retry-success.png` / `.json`: after restoring the same dev server and clicking again, the Generate workspace renders with `<main>`, the gate status is gone, and horizontal overflow is false.
- `04-chrome-console-logs.json`: Chrome warning/error logs after recovery are `[]`.

## Automated Evidence

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3262 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 BULLMQ_PREFIX=idream:e2e:3262-age-gate bun run --cwd packages/main test:e2e src/e2e/flows.e2e.ts --grep "age gate"
bun run --cwd packages/main lint -- src/components/ourdream/AgeGate.tsx src/e2e/flows.e2e.ts
bun run typecheck
```

Results: age-gate E2E `4/4` passed, lint passed, root typecheck passed.
