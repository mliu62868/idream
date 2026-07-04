# Auth Return Audit - Account Anchors

Date: 2026-07-04

## Finding

Post-auth redirects preserved app/workspace paths, but the shared redirect guard rejected safe same-origin hash targets such as `/profile#billing`. That could strand a user who entered signup from a billing/account deep link by returning them to `/` instead of the intended account section.

## Fix

- Expanded safe auth return prefixes to cover first-party product, support, safety, and content routes exposed by the app shell.
- Preserved hash fragments during `safeInternalAuthRedirect` and `authNextTargetFromPath` matching.
- Kept protocol-relative, external, `/api`, `/admin`, `/login`, and `/signup` loop targets blocked.
- Updated app-shell auth links to include the current browser hash when building `next`.
- Updated the anonymous Profile/My AI sign-in card to preserve the current profile path, query, and hash instead of always returning to plain `/profile`.

## Verification

- `bun run --filter @idream/main test -- src/components/ourdream/authRedirect.test.ts`: pass, 3 tests.
- `bun run --filter @idream/main lint -- src/components/ourdream/ProfileWorkspace.tsx src/components/ourdream/authRedirect.ts src/components/ourdream/AuthNav.tsx src/e2e/ui-workflows.e2e.ts`: pass.
- `bun run --filter @idream/main typecheck`: pass.
- `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3114 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "profile prompts anonymous visitors"`: pass, 1 test.
- `PW_WEBSERVER=1 PW_BASE_URL=http://127.0.0.1:3114 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "profile subroutes preserve anonymous auth return targets"`: pass, 1 test.
- Chrome on `http://127.0.0.1:3113/signup?next=%2Fprofile%23billing`: signup created `chrome-auth-return-1783150068570@example.com` and landed on `http://127.0.0.1:3113/profile#billing`; `#billing` remained in `window.location.hash`, the `billing` section existed with `Billing Portal` content, authenticated `Log out` was visible, and console warnings/errors were `[]`.
- Chrome on `http://127.0.0.1:3115/profile#billing`: the anonymous Profile auth card exposed `/signup?next=%2Fprofile%23billing`; clicking the visible `Join Free` CTA opened the encoded signup URL, signup created `chrome-profile-auth-card-1783150574125@example.com` and returned to `http://127.0.0.1:3115/profile#billing`; `#billing` remained in `window.location.hash`, the `Billing Portal` section was visible, authenticated `Log out` was visible, console warnings/errors were `[]`, and the disposable user was deleted (`remaining=0`).
- Chrome on `http://127.0.0.1:3115/profile/redeem-code`: the anonymous Profile auth card exposed `/signup?next=%2Fprofile%2Fredeem-code`; clicking the card CTA opened the encoded signup URL, signup created `chrome-profile-subroute-1783151171226-529558@test.local` and returned to `http://127.0.0.1:3115/profile/redeem-code`; authenticated `Log out`, the redeem panel, billing card, and notifications panel were visible, focus landed on `Redeem code input`, console warnings/errors were `[]`, and the disposable user was deleted (`remaining=0`).

## Evidence

- Screenshot: `screenshots/profile-billing-return-after-signup.png`
- Screenshot: `screenshots/profile-auth-card-billing-return-after-signup.png`
- Screenshot: `screenshots/profile-subroute-redeem-return-after-signup.png`
