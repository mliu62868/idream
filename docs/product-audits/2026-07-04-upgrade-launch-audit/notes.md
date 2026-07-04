# 2026-07-04 Upgrade + Launch Gate Audit

## Scope

- Browser: Chrome extension controlled tab.
- App URL: `http://127.0.0.1:3125`.
- Flow: fresh-origin anonymous `/upgrade` -> Premium monthly `Demo upgrade` -> `/signup?next=/upgrade?plan=premium&billing=monthly` -> signup -> return to Upgrade -> activate mock Premium -> Profile billing -> Generate entitlement check.
- Launch gate: `bun run check:launch -- --json`.

## Product Findings

- Fresh-origin `/upgrade` renders four plan cards and the demo billing warning: `Local mock billing activates plans immediately for testing. No real payment is collected.`
- Anonymous Premium monthly click correctly routes to `/signup?next=%2Fupgrade%3Fplan%3Dpremium%26billing%3Dmonthly`; no inline `Unauthorized` state appeared.
- Signup returns to `/upgrade?plan=premium&billing=monthly`; after plans load, the user is authenticated, `Log out` is visible, and Premium monthly remains actionable.
- Mock Premium monthly activation succeeds: `Premium monthly is active. 1,500 dreamcoins were added.`
- Premium monthly card changes to disabled `Current plan`.
- Success actions are correct: `View billing` points to `/profile#billing`; `Start generating` points to `/generate`.
- `View billing` lands on `/profile#billing`, and the Profile billing card shows `Premium monthly` plus renewal state.
- Generate entitlement is unlocked after upgrade: prompt and negative prompt controls are enabled with `Scene, pose, mood` / `Artifacts to avoid`; no `Premium control` lock text appears.
- Chrome console warnings/errors: `[]`.

## Launch Gate

- `bun run check:launch -- --json` exited non-zero as expected for the current non-production shell.
- Parsed summary: `7 pass / 49 fail / 2 warn`.
- Failing areas remain production dependencies, not local product-flow gaps:
  - Runtime/Data/Security/Queues: missing production env, Postgres URL, auth/internal/cron secrets, Redis.
  - Providers/Chat/Generation/Product: non-production providers and missing live probe reports.
  - Billing: missing BTCPay API/base URL/store/webhook/live invoice proof.
  - Compliance/Storage/Observability: missing Go.cam, R2/S3, Sentry.
- Raw report: `.tmp/check-launch-current-root-2026-07-04-upgrade-launch.json`.

## Cleanup

- Disposable user: `chrome-mobile-upgrade-1783157934935-824437@test.local`.
- Cleanup result: `before=1`, `deleted=1`, `after=0`; dreamcoin ledger, subscription, and session counts all `0`.

## Screenshots

- `screenshots/01-upgrade-signup-next.png`
- `screenshots/02-upgrade-returned-after-signup.png`
- `screenshots/03-upgrade-premium-activated.png`
- `screenshots/04-profile-billing-after-upgrade.png`
- `screenshots/05-generate-after-upgrade.png`

## Verdict

Upgrade is usable for controlled beta/local demo. It is not proof of public paid production readiness because the current production launch gate still correctly fails on missing production configuration and live provider evidence.
