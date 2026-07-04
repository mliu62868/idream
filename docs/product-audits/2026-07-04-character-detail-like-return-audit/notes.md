# Character Detail Like Return Audit

Date: 2026-07-04

## Finding

This audit checked an under-documented branch of the character detail flow: an anonymous visitor clicking `Like` on `/characters/melissa-burke` should not land in a dead `Unauthorized` state. The product flow already returned the visitor through signup, but Chrome exposed a Profile/My AI LCP warning after the liked character appeared in the library.

## Verification

- Chrome on `http://character-like-return-1783153942543.localhost:3120/characters/melissa-burke`: fresh visitor saw only the age gate before adult content rendered.
- After age-gate acceptance, anonymous character detail showed Melissa Burke with Chat, Generate, Like, and Report.
- Clicking `Like` as anonymous routed to `/signup?next=%2Fcharacters%2Fmelissa-burke`; the login/signup shell did not mark Explore active.
- Signup as `chrome-character-like-1783153942543@test.local` returned to `/characters/melissa-burke`.
- Clicking `Like` after return changed the action to `Liked` and showed `Character liked.`.
- Profile/My AI showed Melissa Burke in the recent library, proving the liked character became visible in account state.
- Initial Profile verification produced a Next LCP warning for `/images/ourdream/card-melissa-burke.webp`; `ProfileWorkspace` now marks the first three visible library images `loading="eager"`.
- A fresh post-fix Chrome tab loaded `/profile`, showed Melissa Burke with `imageLoading=eager`, and had console warnings/errors `[]`.
- Fixture cleanup deleted the disposable user, session, like, and anonymous age-gate row, leaving `remainingUsers=0` and `remainingLikes=0`.

## Evidence

- Screenshot: `screenshots/01-age-gate-character-detail.png`
- Screenshot: `screenshots/02-character-detail-anon-before-like.png`
- Screenshot: `screenshots/03-signup-after-anon-like.png`
- Screenshot: `screenshots/04-returned-character-detail-after-signup.png`
- Screenshot: `screenshots/05-character-liked-after-return.png`
- Screenshot: `screenshots/06-profile-liked-character-visible.png`
