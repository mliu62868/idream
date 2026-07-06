# Create -> Review -> Public Discovery Audit

Date: 2026-07-04

## Scope

Chrome product audit of the complete public character path:

1. Fresh visitor opens Create and accepts the age gate.
2. Anonymous user starts a character draft and is routed through signup.
3. Signup returns to the Create builder with the draft preserved.
4. Creator submits the character as public, creating a pending review submission.
5. My AI exposes the pending status in Created.
6. Public Explore search hides the character before approval.
7. Admin Review Queue approves the submission through the real UI.
8. Public Explore and character detail expose the approved character.
9. Test/audit fixture cleanup leaves public search and admin pending queue clean.

## Step Health

1. Age gate and anonymous Create entry: Healthy. Fresh origin saw the gate first, then the builder after acceptance.
2. Signup return and draft preservation: Healthy. `/signup?next=%2Fcreate` returned to `/create` with `Chrome Publish 1783169001` still present.
3. Public submit state: Healthy. Publish defaults private; selecting public showed review copy and submitted to pending review.
4. My AI pending state: Healthy. Created tab showed the submitted card with `pending review`.
5. Pre-approval public discovery: Healthy. Fresh public search returned `No characters found`.
6. Admin approval: Healthy. Admin filtered the target row, approved with review note, audit reason, and `REVIEW` confirmation; the row left the pending queue.
7. Post-approval public discovery: Healthy after fix. Explore showed the card, detail loaded, and card attribution now uses the creator display name instead of `@ourdream`.
8. Fixture hygiene: Healthy after fix/cleanup. E2E cleanup now deletes matching `CharacterSubmission` rows, local stale Chrome fixtures were removed, DB counts for stale E2E/Chrome pending submissions are 0, and admin Review Queue shows 0 pending submissions.
9. Browser console/issues: Healthy after fix. Refreshed public search and admin review pages have no Chrome console errors, warnings, or issues.

## Fixes Made

- Fixed character DTO creator attribution: API card data now uses creator display/name, with `@ourdream` only for official fallback records.
- Added accessible card labels and explicit heading age text so card names and ages are not concatenated.
- Extended public Explore E2E to assert seeded community creator attribution and absence of `@ourdream`.
- Extended service smoke coverage to assert API `creator` and `creatorName`.
- Fixed E2E fixture cleanup to delete `CharacterSubmission` rows for E2E characters before archiving/removing characters/users.
- Added `name` metadata to touched public/admin form controls so Chrome issue checks are clean.

## Screenshots

- `screenshots/01-create-age-gate.png`
- `screenshots/02-create-anonymous-builder.png`
- `screenshots/03-create-signup-next.png`
- `screenshots/04-create-returned-draft-after-signup.png`
- `screenshots/05-create-preview-step.png`
- `screenshots/06-create-public-submit-ready.png`
- `screenshots/07-create-submitted-for-review.png`
- `screenshots/08-my-ai-pending-review-created-tab.png`
- `screenshots/09-preapproval-public-search-hidden.png`
- `screenshots/10-admin-review-queue-unfiltered-with-stale-fixtures.png`
- `screenshots/11-admin-review-queue-filtered-target.png`
- `screenshots/12-admin-approved-row-removed.png`
- `screenshots/13-postapproval-public-search-visible.png`
- `screenshots/14-postapproval-character-detail.png`
- `screenshots/15-postfix-public-card-creator-attribution.png`
- `screenshots/16-admin-review-queue-clean-after-fixture-cleanup.png`
- `screenshots/17-post-cleanup-public-search-empty.png`

## Verification

```bash
bun run --filter @idream/main test -- src/server/modules/ourdream/service.test.ts
PW_BASE_URL=http://127.0.0.1:3130 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "explore UI syncs filters|create UI resumes a draft"
bun run --filter @idream/main lint
bun run --filter @idream/main typecheck
```

Results:

- Service smoke: 2/2 passed.
- Focused UI workflow E2E: 2/2 passed.
- `@idream/main` lint: passed.
- `@idream/main` typecheck: passed.
- DB post-cleanup counts: `staleE2EPendingSubmissions=0`, `chromePendingSubmissions=0`, `chromeCharacters=0`.
- Chrome public search after cleanup: `No characters found`, no console messages.
- Chrome admin Review Queue after cleanup: `Pending submissions 0`, no console messages.

