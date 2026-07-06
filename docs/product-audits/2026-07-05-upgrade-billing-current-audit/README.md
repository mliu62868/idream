# Upgrade Billing Current Audit

Date: 2026-07-05

Scope: signup return into Upgrade, Premium monthly demo activation, Profile billing handoff, renewal cancel/resume, Manage status, DB terminal state, and fixture cleanup.

## Steps

1. Signup return: pass. Chrome opened `/signup?next=/upgrade?plan=premium&billing=monthly&returnTo=/profile%23billing`, registered a disposable user, and returned to `/upgrade?plan=premium&billing=monthly&returnTo=/profile%23billing`.
2. Upgrade ready state: pass. The page showed the demo checkout notice, signed-in header, plan cards, and no horizontal overflow.
3. Premium monthly activation: pass. The Premium monthly card had one `Demo upgrade` button; activation showed `Premium monthly is active. 1,500 dreamcoins were added.` as `role="status"` with `aria-live="polite"` and exposed `View billing -> /profile#billing`.
4. Profile billing handoff: pass. Clicking `View billing` landed on `/profile#billing`; the Billing Portal card showed `Premium monthly`, `Renews Aug 4, 2026`, `Manage`, `Change plan`, and `Cancel renewal`.
5. Cancel renewal: pass. Clicking `Cancel renewal` kept the plan active, changed the card to `Renewal canceled · benefits active until Aug 4, 2026`, changed the action to `Resume renewal`, and showed a polite `profile-status`.
6. Resume renewal: pass. Clicking `Resume renewal` restored `Renews Aug 4, 2026`, changed the action back to `Cancel renewal`, and showed `Renewal resumed.` as a polite status.
7. Manage status: pass. Clicking `Manage` stayed on `/profile#billing` and showed `Subscription management is available for the active local plan.` as `role="status"` with `aria-live="polite"`.

## Evidence

- `chrome-evidence.json`: step-by-step Chrome state, final URL, and browser warning/error log capture.
- `db-evidence-before-cleanup.json`: disposable user, subscription, entitlements, ledger, checkout session, session/account, and analytics terminal state before cleanup.
- `db-cleanup.json`: disposable user cleanup, `remainingUsers=0`, and `remainingAnalytics=0`.
- Screenshots `01` through `07`: visual proof for signup, Upgrade activation, Profile billing active/canceled/resumed/manage states.

## Verification

- `PW_BASE_URL=http://127.0.0.1:3273 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "upgrade UI activates Premium, grants dreamcoins, and unlocks prompt controls"` passed.
- `bun run --cwd packages/main test -- src/server/modules/ourdream/billing.test.ts -t "cancels and resumes renewal without removing current-period entitlements|activates a subscription, derives entitlements, and grants included dreamcoins"` passed, `2` tests.

No product/code defect was found in this slice.
