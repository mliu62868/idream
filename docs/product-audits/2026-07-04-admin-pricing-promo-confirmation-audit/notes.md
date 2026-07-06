# Admin Pricing / Promo Confirmation Audit

Date: 2026-07-04

Surfaces:
- `/admin/pricing`
- `/admin/promo`

## Finding

Pricing publish/rollback and promo disable already used typed confirmation, but pricing draft creation had no reason/confirmation and redeem-code creation used a fixed `CREATE` token from the UI. These are revenue and entitlement control surfaces, so create actions should also require target-specific confirmation.

## Fix

- Pricing draft creation now requires an operator reason and exact `ruleKey` confirmation before `Create Draft` enables.
- The pricing API rejects draft creation unless `confirmation` matches `ruleKey`, and writes the reason to audit.
- Redeem-code creation now requires the operator to type the exact code before `Create` enables.
- The promo API rejects redeem-code creation unless `confirmation` matches `code`; it still avoids storing, returning, or auditing plaintext code.

## Chrome Evidence

- `01-pricing-create-confirmation-empty.png`: pricing reason entered with empty confirmation; create disabled.
- `02-pricing-create-confirmation-wrong.png`: wrong pricing confirmation; create disabled and DB unchanged.
- `03-pricing-create-confirmation-ready.png`: exact rule key entered; create enabled.
- `04-pricing-draft-created.png`: pricing draft appears after confirmed create.
- `05-promo-create-confirmation-empty.png`: promo form with empty confirmation; create disabled.
- `06-promo-create-confirmation-wrong.png`: generic `CREATE` token rejected by UI and API.
- `07-promo-create-confirmation-ready.png`: exact code entered; create enabled.
- `08-promo-code-created.png`: redeem code row appears after confirmed create.
- `chrome-evidence.json`: Chrome channel/user agent, server rejection checks, DB checks, and console failures.

## Verification

- `bun run --filter @idream/main test -- src/server/modules/ourdream/admin-console.test.ts -t "pricing control plane|admin promo"`
- `bun run --filter @idream/main lint`
- `bun run --filter @idream/main typecheck`
- `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3189 PW_ADMIN_BASE_URL=http://127.0.0.1:3188 bun run --filter @idream/main test:e2e -- src/e2e/admin-web.e2e.ts -g "admin pricing and promo creation require typed confirmation"`
- `PRICING_PROMO_EVIDENCE_DIR=/Users/kk/code/idream/docs/product-audits/2026-07-04-admin-pricing-promo-confirmation-audit PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3190 PW_ADMIN_BASE_URL=http://127.0.0.1:3188 bun run --filter @idream/main test:e2e -- src/e2e/admin-pricing-promo-confirmation-chrome.e2e.ts`
