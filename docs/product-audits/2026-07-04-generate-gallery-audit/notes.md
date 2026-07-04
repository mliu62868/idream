# 2026-07-04 Generate Gallery Ownership Audit

## Scope

Chrome-controlled end-to-end review of the Generate handoff and Gallery action surface for an official, non-owned character.

Local target:

- Main app: `http://generate-gallery-1783144847227.localhost:3098`
- Character: `/characters/melissa-burke`
- Generator: `/generate?characterId=melissa-burke`
- Disposable user: `chrome-generate-gallery-1783144921664@test.local`

## Finding

Before the fix, a user could start from Melissa Burke, enter Generate with Melissa preselected, sign up through the preserved `next` URL, complete an image job, and see the generated media in Gallery. The broken part was the Gallery action surface: generated media tied to the official Melissa character exposed `Use as character image` and `Add to identity`, but those actions are valid only for user-owned characters and returned `Owned character not found`.

This was a product-flow bug, not a backend authorization bug. The backend correctly rejected identity updates for non-owned characters; the frontend was exposing non-actionable controls.

## Fix

- Character DTOs now include `creatorId` and `canEditIdentity` from the viewer context.
- Generate Gallery hides `Use as character image` and `Add to identity` unless the media target character is editable by the current user.
- `Create variation` remains available for image media, including official-character generated media.
- The focused generator E2E now covers a generated image for a public character owned by another user and asserts the identity-edit actions are hidden while variation remains visible.

## Chrome Evidence

Screenshots live in `docs/product-audits/2026-07-04-generate-gallery-audit/screenshots/`.

- `01-character-detail-generate-cta-before-fix.png`: character detail has contextual Generate CTA.
- `02-generate-melissa-selected-anonymous-before-fix.png`: generator opens with Melissa selected for anonymous user.
- `03-generate-signup-next-before-fix.png`: Join Free preserves `/generate?characterId=melissa-burke`.
- `04-generate-returned-ready-before-fix.png`: signup returns to the same generator context.
- `05-gallery-generated-before-fix.png`: completed generation appears in Gallery from `/user-content`.
- `06-official-character-identity-dead-action-before-fix.png`: before-fix dead identity action returned `Owned character not found`.
- `07-official-character-identity-actions-hidden-after-fix.png`: after-fix Gallery renders without identity-edit dead controls.
- `08-official-character-hover-controls-after-fix.png`: hovered card exposes only valid actions: `Create variation`, `Like`, `Download`, `Report`, and `Delete`.

Chrome readback after the fix:

```json
{
  "actionCounts": {
    "useAsCharacterImage": 0,
    "addToIdentity": 0,
    "createVariation": 1
  },
  "cardImageCount": 1,
  "hasOwnedCharacterNotFound": false,
  "consoleProblems": []
}
```

## Verification

```bash
PW_BASE_URL=http://127.0.0.1:3098 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "generator UI queues an image job"
bun run --filter @idream/main typecheck
bun run --filter @idream/main lint
git diff --check
```

Result: all passed.
