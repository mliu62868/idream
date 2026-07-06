# Admin Pricing / Promo Action Confirmation Audit

Date: 2026-07-04

Scope:
- `/admin/pricing`
- `/admin/promo`
- `POST /api/v1/admin/pricing/rules/:id/publish`
- `POST /api/v1/admin/pricing/rules/:id/rollback`
- `POST /api/v1/admin/promo/redeem-codes/:id/disable`

Finding:
- Pricing publish/rollback still accepted generic `PUBLISH`/`ROLLBACK`.
- Promo redeem-code disable still accepted generic `DISABLE`.
- These actions change live pricing or disable growth codes, so the confirmation should bind to the exact rule/code id being changed.

Change:
- Pricing publish and rollback now require confirmation equal to the pricing rule id.
- Redeem-code disable now requires confirmation equal to the redeem-code id.
- Admin action modals render the exact id as the required confirmation and submit the operator's typed value.

Chrome Evidence:
- `pricing-publish-generic-disabled.png`: `PUBLISH` leaves pricing publish Confirm disabled.
- `pricing-published-with-rule-id.png`: the exact pricing rule id publishes the draft rule.
- `pricing-rollback-generic-disabled.png`: `ROLLBACK` leaves rollback Confirm disabled.
- `promo-disable-generic-disabled.png`: `DISABLE` leaves promo disable Confirm disabled.
- `promo-disabled-with-code-id.png`: the exact redeem-code id disables the code.
- `chrome-evidence.json`: records the tested rule/code ids, rejected generic tokens, accepted ids, and console failure state.

Verification:
- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "pricing control plane|admin promo"`
- `bun run --filter @idream/main typecheck`
- Temporary Chrome evidence spec passed, then was removed.
