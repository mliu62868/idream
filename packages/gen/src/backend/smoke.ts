// SPEC: Real end-to-end smoke — drives `providers.image.generate()` with
// IMAGE_PROVIDER=backend against a LIVE ComfyUI instance, reproducing a real
// image through the new abstraction: BackendImageModel -> BackendRegistry ->
// ComfyUIBackend -> POST /prompt. This is the same round trip
// probe-redcraft-comfyui.ts exercised directly against ComfyUI, but this time
// through the actual provider seam the gen worker uses in production.
// INTENT: Manual-only dev script, not part of `vitest run` (no live server in
// CI; see package.json's `smoke:backend` script). Forces GEN_IMAGE_PROVIDER to
// "backend" unconditionally — env.ts's getter checks GEN_IMAGE_PROVIDER before
// IMAGE_PROVIDER, and .env pins GEN_IMAGE_PROVIDER=pipeline, so a plain
// `IMAGE_PROVIDER=backend` env var alone would silently lose to .env's
// dotenv/config load. Also forces GEN_WORKFLOW_DIR to an absolute path
// resolved from this file's location, since the env.ts default
// ("packages/gen/workflows") is repo-root relative and breaks when this
// script is invoked from inside packages/gen (its `bun run` cwd).
// INVARIANTS: never commits the generated PNG; writes under the OS temp dir
// unless --out points elsewhere. Exits 1 on any failure (ok:false, missing
// body, or a thrown error) so it composes as a CLI health check.
import { Buffer } from "node:buffer";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Must happen before providers.ts/env.ts are evaluated by the imports below —
// import statements are hoisted, so these assignments run first regardless of
// where they appear in the file, but keeping them textually first avoids
// confusion about ordering.
process.env.GEN_IMAGE_PROVIDER = "backend";
process.env.GEN_WORKFLOW_DIR ??= path.resolve(here, "..", "..", "workflows");

const { providers } = await import("../providers");
const { assertGeneratedImageSanity } = await import("../generated-image-sanity");
const { logger } = await import("../logger");

const SMOKE_PROMPT =
  "adult woman, upper-body portrait, oval face, hazel eyes, long auburn hair, soft daylight, photorealistic, high detail";

async function main() {
  const outPath = resolveOutPath();
  const startedAt = Date.now();

  const result = await providers.image.generate({
    model: "redcraft-krea2-comfyui",
    prompt: SMOKE_PROMPT,
    count: 1,
    orientation: "4:5",
    seed: "42",
    controls: { steps: 10 },
  });

  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    logger.error({ error: result.error, durationMs }, "backend smoke failed");
    process.exitCode = 1;
    return;
  }

  const assets = result.data.assets;
  if (!assets.length) {
    logger.error({ durationMs }, "backend smoke returned zero assets");
    process.exitCode = 1;
    return;
  }

  await mkdir(path.dirname(outPath), { recursive: true });

  for (const [index, asset] of assets.entries()) {
    if (!asset.body) {
      logger.warn({ index, durationMs }, "backend smoke asset has no body, skipping");
      continue;
    }
    const buffer = Buffer.from(asset.body);
    assertGeneratedImageSanity(buffer, "backend smoke");

    const target = assets.length > 1 ? suffixPath(outPath, index) : outPath;
    await writeFile(target, buffer);

    logger.info(
      {
        width: asset.width,
        height: asset.height,
        bytes: buffer.byteLength,
        durationMs,
        outPath: target,
      },
      "backend smoke ok",
    );
  }
}

function resolveOutPath(): string {
  const flagIndex = process.argv.indexOf("--out");
  const explicit = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  return explicit ? path.resolve(explicit) : path.join(tmpdir(), `idream-backend-smoke-${Date.now()}.png`);
}

function suffixPath(target: string, index: number): string {
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  return `${base}-${index + 1}${ext}`;
}

main().catch((error: unknown) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, "backend smoke crashed");
  process.exitCode = 1;
});
