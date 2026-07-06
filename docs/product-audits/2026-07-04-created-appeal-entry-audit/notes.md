# Created Character Appeal Entry Audit

Date: 2026-07-04

## Scope

Adversarial check for the creator-side appeal path after a created character reaches a non-public review outcome. The product expectation is that a creator can start an appeal from the item that needs review, without manually copying raw IDs into Help Desk.

## Before

Chrome on `http://127.0.0.1:3134/custom` with a seeded `removed` created character showed the Created tab action row as:

- `Edit character`
- `Make private`
- `Duplicate character`
- `Delete character`

There was no contextual `Appeal` entry beside the removed character. Screenshot: `screenshots/01-before-created-removed-no-appeal.png`.

## Fix

- `ProfileWorkspace` now shows an `Appeal` link for created characters with `status=removed` or `status=rejected`.
- The link targets `/helpdesk?...#appeals` and preloads `appealTargetType=character`, `appealTargetId`, and editable default appeal text.
- `HelpDeskWorkspace` now reads those query params client-side, pre-fills the appeal form, scrolls to `#appeals`, and focuses the appeal details field.

## Evidence

- Focused lint: `bun run --filter @idream/main lint` passed.
- Focused typecheck: `bun run --filter @idream/main typecheck` passed.
- Focused E2E: `PW_BASE_URL=http://127.0.0.1:3134 bun run test:e2e src/e2e/ui-workflows.e2e.ts -g "created removed character links to a prefilled Help Desk appeal"` passed.
- Chrome after fix: Created tab showed `Appeal decision for E2E Chrome Removed Appeal After`; screenshot `screenshots/02-after-created-removed-appeal-cta.png`.
- Chrome after fix: Help Desk appeal form opened at `#appeals` with target type `Character`, target id `e2e-ui-chrome-created-appeal-after-1783166737631-162507`, and prefilled appeal details; screenshot `screenshots/03-after-helpdesk-appeal-prefilled.png`.
- Chrome after fix: submitting created `Appeal cmr6bghr2000q57l7wtzm84ql submitted.`; screenshot `screenshots/04-after-helpdesk-appeal-submitted.png`.
- DB verification: appeal row was `targetType=character`, `targetId=e2e-ui-chrome-created-appeal-after-1783166737631-162507`, `status=open`, and `appealText="Please review this character decision again. Character: E2E Chrome Removed Appeal After."`.
- Chrome console warnings/errors: none on the verified page. Network had `200` for `GET /api/v1/library/created`, Help Desk RSC navigation, `GET /api/v1/feedback/items`, and `POST /api/v1/appeals`; one `/api/v1/me` request was aborted during navigation.

## Cleanup

Manual Chrome fixtures with prefix `e2e-ui-chrome-created-appeal-` were removed: `deletedUsers=1`, `deletedCharacters=2`. The focused E2E fixture was handled by existing `afterEach` cleanup.
