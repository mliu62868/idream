# Generate Gallery Per-Media Permission Audit

Date: 2026-07-04

Scope: Chrome E2E verification for Gallery identity-action permissions after moving identity edit eligibility from client-side loaded character selectors to server-returned per-media ownership.

## Setup

- Server: `http://127.0.0.1:3099`
- Chrome origin: `http://gallery-permission-1783146791036-335985.localhost:3099/generate?characterId=melissa-burke`
- Disposable signup user: `chrome-gallery-permission-1783146791036-335985@test.local`
- Selected character: `melissa-burke`
- Seeded media:
  - Official/non-owned media: `chrome-gallery-official-media-1783146857814-190816`, assigned to official character `melissa-burke`.
  - Owned media: `chrome-gallery-owned-media-1783146857814-190816`, assigned to user-owned private character `chrome-gallery-owned-character-1783146857814-190816`.

## Chrome Evidence

Chrome signup returned to `/generate?characterId=melissa-burke` with `Melissa Burke` selected. After seeding both media assets and reloading Generate, a scoped DOM read on the two `data-media-id` cards returned:

```json
{
  "official": {
    "actions": ["Create variation", "Like", "Download", "Report", "Delete"]
  },
  "owned": {
    "actions": [
      "Use as character image",
      "Add to identity",
      "Create variation",
      "Like",
      "Download",
      "Report",
      "Delete"
    ]
  },
  "selectedCharacter": "melissa-burke",
  "totalGalleryCards": 2
}
```

Interpretation:

- Official/non-owned character media no longer exposes dead identity-edit actions.
- Variation/download/report/delete remain available for the official media.
- User-owned character media still exposes identity actions even though the owned character is not the currently selected Melissa character and is outside the 12-item character selector load.

Screenshots:

- `screenshots/01-owned-card-hover.png`
- `screenshots/02-official-card-hover.png`
- `screenshots/03-owned-card-hover-crop.png`

Console warnings/errors: `[]`

Fixture cleanup: `user=0`, `media=0`, `character=0`; seeded local blob files were removed.

## Regression Coverage

Focused E2E now covers both sides of the permission rule:

```bash
PW_BASE_URL=http://127.0.0.1:3099 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --filter @idream/main test:e2e -- src/e2e/ui-workflows.e2e.ts -g "generator UI queues an image job"
```

Result: `1 passed`.
