# Gallery Tiny Media Audit

Date: 2026-07-05

Scope: Chrome end-to-end verification for completed private Gallery media on `/generate?characterId=melissa-burke`.

## Finding

Before the fix, completed media with a served 1x1 image rendered as a full-size white Gallery tile:

- Affected card: `chrome-profile-search-1783072875011`
- Natural image size: `1x1`
- Rendered card size: `228x285`
- Fallback: absent

From a user/product perspective, the Gallery looked like it contained blank completed outputs even though the asset technically loaded.

## Fix Verification

After the fix, tiny completed image previews are replaced with the existing Gallery unavailable state:

- Affected card: `chrome-profile-search-1783072875011`
- Fallback text: `Preview unavailable`
- Rendered image element: absent
- Download, report, delete, and identity actions remain available on the media card where applicable.

The implementation uses API `width/height` when available and falls back to the loaded image's `naturalWidth/naturalHeight` so bad metadata does not leave a blank tile.

## Artifacts

- `01-before-tiny-media-blank.jpg`
- `01-before-tiny-media-blank.json`
- `02-after-preview-fallback.jpg`
- `02-after-preview-fallback.json`

## Verification

- `PW_BASE_URL=http://127.0.0.1:3255 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "generator Gallery replaces tiny completed media"`
- `PW_BASE_URL=http://127.0.0.1:3255 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "generator UI queues an image job and surfaces completed media in the gallery"`
- `bun run --cwd packages/main lint -- src/components/ourdream/GeneratorWorkspace.tsx src/e2e/ui-workflows.e2e.ts`
- `bun run typecheck`
- `git diff --check`
