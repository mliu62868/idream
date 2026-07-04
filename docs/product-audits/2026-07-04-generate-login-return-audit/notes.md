# Generate Login Return Audit

Date: 2026-07-04

## Finding

The signup branch for anonymous Generate intent already had coverage. This audit checked the parallel returning-user path: an anonymous visitor on a character-scoped Generate URL using the header `Login` link should return to the same generator context after authentication.

## Verification

- Chrome on `http://generate-login-return-1783153186978.localhost:3117/generate?characterId=melissa-burke`: anonymous Generate rendered `Login`, `Join Free`, `0 coins`, `Character=Melissa Burke`, Active Jobs, and Gallery.
- The header `Login` link pointed to `/login?next=%2Fgenerate%3FcharacterId%3Dmelissa-burke`.
- The login page preserved `next=/generate?characterId=melissa-burke`.
- Logging in as existing user `chrome-generate-login-1783153186978@test.local` returned to `/generate?characterId=melissa-burke`.
- After login, the authenticated shell showed `Log out`, balance `250 coins`, Generate controls, Gallery, and `Character=Melissa Burke`.
- Chrome console warnings/errors were `[]`.
- Fixture cleanup deleted the disposable user and age-gate row, leaving `remainingUsers=0` and `remainingAge=0`.

## Evidence

- Screenshot: `screenshots/01-generate-anon-login-next.png`
- Screenshot: `screenshots/02-login-form-with-generate-next.png`
- Screenshot: `screenshots/03-generate-returned-after-login.png`
