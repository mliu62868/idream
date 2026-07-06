# Upgrade Status Audit

Date: 2026-07-05

## Finding

The Upgrade revenue path already had strong happy-path coverage, but its failure/status communication was uneven. Plan loading and empty states were visible but not stable status regions, plan-load failures were not assertive alerts, and checkout failures used the same polite status semantics as successful checkout.

## Fix

- Plan loading and no-plan states now expose `data-testid="upgrade-plans-status"`, `role="status"`, and `aria-live="polite"`.
- Plan-load failures now expose `data-testid="upgrade-plans-status"`, `role="alert"`, and `aria-live="assertive"` with the existing `Retry` action.
- Checkout success/redirect results remain polite statuses, while checkout failures now expose `role="alert"` and `aria-live="assertive"`.
- The paid activation E2E now targets the generated Gallery media card by returned asset id and accepts either a valid preview or the explicit `Preview unavailable` fallback, while still requiring the card to remain visible and actionable.

## Evidence

- `01-upgrade-current.png`: Chrome capture of `/upgrade` on the patched dev server. This capture accepted the loading state, not the settled plan-card state.
- `01-upgrade-current.json`: Chrome DOM/state sample proving `upgrade-plans-status` loading feedback is `role="status"` + `aria-live="polite"`, no horizontal overflow.
- `02-chrome-console-logs.json`: Chrome warning/error capture, `[]`.
- Fresh-server focused E2E on `http://127.0.0.1:3260`: 6/6 passed for chat quota upgrade return, generator low-balance upgrade path, anonymous Upgrade signup return, plan-load alert/retry, checkout-failure alert, and Premium activation through Generate/Gallery.

## Commands

```bash
PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3260 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "upgrade "
bun run --cwd packages/main lint -- src/components/ourdream/UpgradeWorkspace.tsx src/e2e/ui-workflows.e2e.ts
bun run typecheck
git diff --check -- packages/main/src/components/ourdream/UpgradeWorkspace.tsx packages/main/src/e2e/ui-workflows.e2e.ts docs/product-audits/2026-07-05-upgrade-status-audit/README.md docs/product-audits/current-implementation/pm-audit.md docs/product/CURRENT_FUNCTIONAL_COVERAGE.md
```
