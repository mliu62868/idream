// SPEC: Real end-to-end smoke — drives `providers.image.generate()` with
// IMAGE_PROVIDER=backend against a LIVE registered backend, reproducing a real
// image through BackendImageModel -> BackendRegistry -> GenBackend. The default
// targets ComfyUI; pass a Draw Things model id to drive draw-things-cli through
// the same provider seam the gen worker uses in production.
// Defaults to the txt2img redcraft path; pass --model <modelId> to target any
// other registered descriptor (e.g. qwen-image-edit), --ref <image path> to
// drive an img2img/edit workflow off a local reference image, and --prompt to
// override the default smoke prompt. Multi-reference workflows use repeated
// --ref plus one matching --ref-role per reference so semantic graph slots are
// exercised explicitly instead of inferred from array order.
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
// body, or a thrown error) so it composes as a CLI health check. --ref is
// read once into memory (smoke-scale images only, no streaming).
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSmokeReferences } from "./smoke-args";

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
  const modelId = resolveArg("--model") ?? "redcraft-krea2-comfyui";
  const promptOverride = resolveArg("--prompt");
  const referenceSpecs = resolveSmokeReferences(process.argv.slice(2));
  const referenceImages = referenceSpecs.length > 0
    ? await Promise.all(referenceSpecs.map(async (reference, index) => ({
        assetId: `smoke-ref-${index + 1}`,
        role: reference.role,
        b64Json: (await readFile(reference.path)).toString("base64"),
        contentType: contentTypeFromPath(reference.path),
      })))
    : undefined;
  const hasReferences = referenceSpecs.length > 0;

  const startedAt = Date.now();

  const result = await providers.image.generate({
    model: modelId,
    prompt: promptOverride ?? SMOKE_PROMPT,
    count: 1,
    // INTENT: edit/img2img descriptors (e.g. qwen-image-edit) declare their own
    // default width/height (832x1216) on the width/height slots. Passing the
    // txt2img default orientation "4:5" here would inject explicit width/height
    // values that override those declared defaults, so whenever a reference
    // image drives the run, omit orientation entirely (undefined) and let the
    // descriptor's own declared slot defaults apply instead.
    orientation: hasReferences ? undefined : "4:5",
    seed: "42",
    // Same reasoning as orientation above: redcraft's txt2img default is 10
    // steps, but qwen-image-edit's P0-validated recipe is 4 steps — don't
    // clobber a ref-driven descriptor's own steps default.
    controls: hasReferences ? {} : { steps: 10 },
    ...(referenceImages ? { referenceImages } : {}),
  });

  const durationMs = Date.now() - startedAt;

  if (!result.ok) {
    logger.error({ model: modelId, error: result.error, durationMs }, "backend smoke failed");
    process.exitCode = 1;
    return;
  }

  const assets = result.data.assets;
  if (!assets.length) {
    logger.error({ model: modelId, durationMs }, "backend smoke returned zero assets");
    process.exitCode = 1;
    return;
  }

  await mkdir(path.dirname(outPath), { recursive: true });

  for (const [index, asset] of assets.entries()) {
    if (!asset.body) {
      logger.warn({ model: modelId, index, durationMs }, "backend smoke asset has no body, skipping");
      continue;
    }
    const buffer = Buffer.from(asset.body);
    assertGeneratedImageSanity(buffer, "backend smoke");

    const target = assets.length > 1 ? suffixPath(outPath, index) : outPath;
    await writeFile(target, buffer);

    logger.info(
      {
        model: modelId,
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

function resolveArg(flag: string): string | undefined {
  const flagIndex = process.argv.indexOf(flag);
  return flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
}

function suffixPath(target: string, index: number): string {
  const ext = path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  return `${base}-${index + 1}${ext}`;
}

function contentTypeFromPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, "backend smoke crashed");
  process.exitCode = 1;
});
