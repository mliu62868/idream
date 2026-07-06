# Gallery Current Quality Audit

Date: 2026-07-05

Scope: Generate Gallery media quality and browser-decodable PNG validation.

## Finding

Chrome direct image inspection exposed a provider-style PNG that passed the old image sanity checks but decoded in the browser with `naturalWidth=0`. The issue was invalid PNG chunk checksums: dimensions and pixels looked parseable to the local checker, but Chrome treated the file as undecodable.

That meant a corrupt PNG could be persisted as media and then surface as a blank or fallback Gallery card instead of being rejected before blob persistence.

## Fix

- Shared generated-image sanity now validates PNG chunk CRCs before accepting provider output.
- The gen package reuses the shared checker, so invalid PNG checksums fail both main and worker paths.
- PNG fixtures in focused tests now write real CRCs, so Gallery/E2E media fixtures are browser-decodable.
- Gallery behavior remains: valid images render normally, while tiny or visually blank completed media show `Preview unavailable`.

## Chrome Evidence

Final Chrome proof used CRC-valid seeded media on `http://127.0.0.1:3260/generate`:

- `01-gallery-quality-state.json`: valid media rendered as a complete `64x64` image; tiny and blank media rendered fallback cards; console warning/error logs were `[]`; horizontal overflow was `false`.
- `01-gallery-quality.png`: visual proof of one valid image card plus two fallback cards.
- `direct-valid-image.png`: diagnostic direct-open image tab from the earlier decode investigation, not the final pass artifact.

Temporary Chrome audit data was removed after capture:

```json
{
  "deletedUser": true,
  "mediaFiles": 9,
  "remaining": 0,
  "remainingMedia": 0
}
```

## Verification

- `bun run --cwd packages/shared test -- src/media/generated-image-sanity.test.ts` passed.
- `bun run --cwd packages/gen test -- src/generated-image-sanity.test.ts src/pipeline.test.ts` passed, `19` tests.
- `bun run --cwd packages/gen typecheck` passed.
- `bun run --cwd packages/main test -- src/server/modules/ourdream/pipeline.test.ts` passed, `6` tests.
- `PW_BASE_URL=http://127.0.0.1:3260 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "generator Gallery replaces tiny completed media"` passed.
- `PW_BASE_URL=http://127.0.0.1:3260 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "generator UI queues an image job and surfaces completed media in the gallery"` passed.
- `bun run --cwd packages/shared typecheck` passed.
- `bun run typecheck` passed, `6/6` workspaces.
