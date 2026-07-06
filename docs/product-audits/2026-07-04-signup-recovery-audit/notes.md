# Signup Recovery Audit

Date: 2026-07-04

Flow: existing user lands on `/signup?next=/generate?characterId=melissa-burke`, submits an already-registered email, then recovers through login and returns to the generator.

## Steps

1. Initial signup with generator `next`
   - Health: pass.
   - Chrome opened `/signup?next=%2Fgenerate%3FcharacterId%3Dmelissa-burke`, submitted a disposable account, and returned to `/generate?characterId=melissa-burke`.
   - Product note: successful signup already preserved the user intent.

2. Duplicate signup before fix
   - Health: fail.
   - Screenshot: `screenshots/01-signup-existing-before.png`.
   - Chrome submitted the same email again and saw `Email already registered`.
   - UX issue: the form had no local recovery action. The only visible Login link was the global header link with `href="/login"`, so the generator `next` intent would be lost.
   - Accessibility risk from screenshot: the error was visible text, but the recovery action was absent, so keyboard and screen-reader users had no nearby next step tied to the error.

3. Duplicate signup after fix
   - Health: pass.
   - Screenshot: `screenshots/02-signup-existing-after-login-link.png`.
   - The form now shows `Already registered? Log in instead`.
   - Verified href: `/login?next=%2Fgenerate%3FcharacterId%3Dmelissa-burke`.
   - Product note: recovery now stays in the user context instead of forcing them to rediscover the generator route.

4. Login recovery page
   - Health: pass.
   - Screenshot: `screenshots/03-login-from-existing-signup.png`.
   - Clicking `Log in instead` opened `/login?next=%2Fgenerate%3FcharacterId%3Dmelissa-burke`.
   - The login form stayed focused on the same conversion path.

5. Returned generator after login
   - Health: pass.
   - Screenshot: `screenshots/04-returned-generate-after-login.png`.
   - Logging in with the same account returned to `/generate?characterId=melissa-burke`.
   - The Generate workspace showed Melissa Burke selected, authenticated shell controls, balance, Active Jobs, and Gallery.

## Limits

- Chrome's DOM snapshot API failed on this page with an extension-side snapshot error, so the audit used narrow page reads, locators, URLs, and saved screenshots instead.
- This audit proves the local Chrome flow and adds focused E2E coverage; public launch readiness still depends on the broader production provider gates.

## Verification

- Chrome console warnings/errors: `[]`.
- `PW_BASE_URL=http://127.0.0.1:3127 bun run --filter @idream/main test:e2e -- src/e2e/flows.e2e.ts -g "auth UI handles invalid login"`: pass, 1 test.
- `bun run --filter @idream/main lint`: pass.
- `bun run --filter @idream/main typecheck`: pass.
- `git diff --check`: pass.

## Cleanup

Disposable user `chrome-signup-duplicate-1783159018551@test.local` was deleted after the Chrome pass.
