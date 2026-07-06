# Promo Redeem Cross-Surface Audit

Date: 2026-07-04

## Scope

Adversarial product audit of the operator-to-user promo flow:

1. Admin creates a redeem code in `/admin/promo`.
2. User redeems that same code from `/profile`.
3. Balance, replay handling, admin redemptions count, and DB ledger agree.

## Finding

Before the fix, `/admin/promo` created `CHROME-PROMO-1783205351191` successfully, but `/profile` returned `Redeem code not found` for the same plaintext code. Root cause: admin creation stored a SHA-256 hash while user redemption looked up the older `redeem_...` hash. The redeem path also did not enforce code-wide `maxRedemptions`.

## Fix

- Added shared `redeemCodeHash` / legacy SHA candidate helpers in `packages/main/src/server/lib/redeem-codes.ts`.
- Switched admin promo creation and user redemption to the shared candidate lookup.
- Kept new records on canonical `redeem_...` hash while allowing old SHA admin-created codes to redeem.
- Added transactional `FOR UPDATE` locking plus `maxRedemptions` count enforcement before creating a redemption and ledger entry.
- Added focused tests for admin-created code redemption, legacy SHA redemption, replay, and code-wide max-redemption rejection.

## Evidence

- Before fix:
  - `04-admin-promo-created-before-fix.jpg`: admin code created; plaintext code not shown in list.
  - `06-front-redeem-fails-before-fix.jpg`: same code returns `Redeem code not found`.
- After fix:
  - `07-front-redeem-succeeds-after-fix.jpg`: same pre-fix SHA-backed code now redeems.
  - `08-front-replay-conflict-after-fix.jpg`: replay shows `Code already redeemed`.
  - `09-admin-redemptions-after-fix.jpg`: admin list shows reward 77, max 1, redemptions 1, no plaintext code.
  - `10-db-redemption-after-fix.json`: DB shows `legacyHashMatched=true`, `redemptions=1`, and ledger `delta=77`, `balanceAfter=7222`.
  - `11-chrome-states.json`: DOM and console evidence; warn/error logs are empty for the tested states.

## Verification

- `bun run --cwd packages/main test src/server/modules/ourdream/modules.test.ts -t "redeem codes"`: 4 passed.
- `bun run --cwd packages/main test src/server/modules/ourdream/admin-console.test.ts`: 51 passed.
- `bun run typecheck`: 6 successful.
- Full `modules.test.ts` currently still has an unrelated existing `returns community leaderboards` assertion failure in this dirty worktree; the promo/redeem describe is green.

## Current Status

Pass for local/internal beta. Public launch status remains gated by the production provider/live-probe checklist, not by this promo flow.
