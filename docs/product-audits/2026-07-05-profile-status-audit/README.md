# Profile Status And Media Fallback Audit

Date: 2026-07-05

## Scope

Adversarial PM/product pass on signed-in `/profile`, focused on visible action feedback and private media-library preview quality.

## Finding

- Before fix, the `Referral invite ready.` message was a visible `P` with `role="status"` but no explicit `aria-live` and no stable test id.
- The Profile media grid could still render blank white image cards for old/invalid media, even after Generate Gallery had been hardened.
- Chrome post-fix UI evidence verified `data-testid="profile-status"` + `aria-live="polite"` and `Preview unavailable` fallback cards with no horizontal overflow.
- Chrome console capture then exposed a second-order runtime regression: `ReferenceError: isBlankImagePreview is not defined` from the Profile image `onLoad` handler. The helper was moved into module scope before `LibraryCard`, and the focused Profile E2E now fails on `console.error` or `pageerror`.

## Evidence

- `01-before-profile-status.png` / `01-before-profile-status.json`: Profile referral status before the semantic fix.
- `02-after-profile-status-and-media.png` / `02-after-profile-status-and-media.json`: status live region and blank-media fallback evidence after the UI fix.
- `03-chrome-console-logs.json`: Chrome warning/error capture that found the helper scope regression before the final code patch.

## Verification

```bash
PW_BASE_URL=http://127.0.0.1:3257 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "profile UI handles redeem"
bun run --cwd packages/main lint -- src/components/ourdream/ProfileWorkspace.tsx src/e2e/ui-workflows.e2e.ts
bun run typecheck
```

Results: focused Profile E2E passed with console/pageerror assertions, targeted lint passed, and root typecheck passed.
