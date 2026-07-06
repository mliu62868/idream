# Gallery Blank Media Audit

Date: 2026-07-05

## Finding

Chrome Gallery evidence from the previous tiny-media pass still showed several normal-sized completed media cards rendering as blank white tiles. The frontend fallback only caught failed image loads, built-in placeholders, and 1x1 media dimensions, while `packages/main` persisted provider image bytes without the same PNG sanity gate already used by `packages/gen`.

## Fix

- Moved generated PNG sanity checks into `@idream/shared/media/generated-image-sanity`.
- Kept `packages/gen` using the shared checker through its existing local module.
- Added the same sanity gate to `packages/main/src/server/ai/local-pipeline.ts` before private blob persistence. Blank provider PNGs now fail the final attempt with `asset_quality_failed`, refund the generation charge, and do not create a `MediaAsset`.
- Extended Gallery image load handling so same-origin blank/near-uniform image previews render the existing `Preview unavailable` fallback instead of a blank tile.

## Chrome Evidence

- `01-after-gallery-blank-fallback.png`: Chrome on `http://127.0.0.1:3256/generate` shows Gallery cards using `Preview unavailable` for legacy blank assets while valid media still render.
- `01-after-gallery-state.json`: structured DOM evidence captured 8 Gallery cards, 5 fallback cards, and 3 image-preview cards.
- `02-chrome-console-logs.json`: warning/error console logs were `[]`.

## Verification

- `bun run --cwd packages/shared test -- src/media/generated-image-sanity.test.ts`
- `bun run --cwd packages/gen test -- src/generated-image-sanity.test.ts`
- `bun run --cwd packages/gen test -- src/pipeline.test.ts`
- `bun run --cwd packages/main test -- src/server/modules/ourdream/pipeline.test.ts -t "blank"`
- `PW_BASE_URL=http://127.0.0.1:3256 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "generator Gallery replaces tiny completed media"`
- `PW_BASE_URL=http://127.0.0.1:3256 PW_ADMIN_BASE_URL=http://127.0.0.1:3999 bun run --cwd packages/main test:e2e src/e2e/ui-workflows.e2e.ts --grep "generator UI queues an image job and surfaces completed media in the gallery"`
- `bun run --cwd packages/main lint -- src/components/ourdream/GeneratorWorkspace.tsx src/e2e/ui-workflows.e2e.ts src/server/ai/local-pipeline.ts src/server/modules/ourdream/pipeline.test.ts vitest.config.ts`
- `bun run typecheck`
- `git diff --check -- packages/main/src/components/ourdream/GeneratorWorkspace.tsx packages/main/src/e2e/ui-workflows.e2e.ts packages/main/src/server/ai/local-pipeline.ts packages/main/src/server/modules/ourdream/pipeline.test.ts packages/shared/src/media/generated-image-sanity.ts packages/shared/src/media/generated-image-sanity.test.ts packages/shared/package.json packages/shared/src/index.ts packages/gen/src/generated-image-sanity.ts packages/gen/tsconfig.json packages/gen/vitest.config.ts packages/main/vitest.config.ts`
