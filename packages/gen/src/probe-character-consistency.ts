import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "./env";
import { providers } from "./providers";

type ConsistencyMode = "balanced" | "strict" | "creative";
type SeedMode = "locked" | "vary";

type SmokeOptions = {
  characterName: string;
  identityPrompt: string;
  negativePrompt: string | null;
  referencePaths: string[];
  outputDir: string;
  samples: number;
  mode: ConsistencyMode;
  model: string;
  orientation: string;
  width: number;
  height: number;
  seed: string;
  seedMode: SeedMode;
  providerOverride: string | null;
  pipelineUrlOverride: string | null;
  pipelineTokenOverride: string | null;
};

type SmokeReference = {
  index: number;
  role: "identity_anchor" | "identity_reference";
  file: string;
  sourcePath: string;
  contentType: string;
  weight: number;
};

type SmokeSample = {
  index: number;
  scene: string;
  prompt: string;
  seed: string;
  file: string | null;
  width: number | null;
  height: number | null;
  providerKey: string | null;
  error: string | null;
};

const placeholderImagePng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ),
);

const defaultScenes = [
  "standing near a rain-streaked apartment window at night, soft city lights",
  "morning coffee at a small kitchen table, relaxed candid framing",
  "walking through a neon street market, three-quarter portrait",
  "reading on a velvet sofa under warm lamplight",
  "close-up portrait with wind moving the hair, shallow depth of field",
  "wearing a black evening dress in a quiet hotel lounge",
  "casual hoodie selfie in a bedroom mirror, natural expression",
  "sitting in a car passenger seat at golden hour",
  "profile view on a balcony with ocean light behind",
  "laughing softly in a bookstore aisle, handheld photo style",
  "wearing a satin blouse in a studio portrait with grey backdrop",
  "snowy street portrait, scarf, visible breath, cinematic realism",
  "sunlit picnic blanket in a city park, seated pose",
  "low-light club hallway portrait, colored rim light",
  "work desk scene with laptop glow, thoughtful expression",
  "full-body fashion portrait against concrete architecture",
  "soft bathroom mirror portrait after shower, natural skin detail",
  "lying on white sheets in morning light, calm intimate mood",
  "restaurant booth at night, candlelight, direct eye contact",
  "outdoor rooftop portrait at dusk, hair and face clearly visible",
];

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readRepeatedArg(name: string) {
  const prefix = `--${name}=`;
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index] ?? "";
    if (arg.startsWith(prefix)) values.push(arg.slice(prefix.length));
    if (arg === `--${name}` && process.argv[index + 1]) values.push(process.argv[index + 1] ?? "");
  }
  return values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function readOptions(): SmokeOptions {
  const samples = Number.parseInt(readArg("samples") ?? "20", 10);
  const mode = readArg("mode") ?? "balanced";
  const seedMode = readArg("seed-mode") ?? "locked";
  const orientation = readArg("orientation") ?? "4:5";
  const providerOverride = readArg("provider") ?? null;
  const characterName = readArg("character-name") ?? readArg("name") ?? "Consistency Smoke Character";
  const identityPrompt = readArg("identity-prompt");
  if (!identityPrompt) {
    throw new Error("--identity-prompt is required");
  }
  const defaultWidth = widthForOrientation(orientation);
  const defaultHeight = heightForOrientation(orientation);
  return {
    characterName,
    identityPrompt,
    negativePrompt: readArg("negative-prompt") ?? null,
    referencePaths: readRepeatedArg("reference"),
    outputDir: resolveWorkspacePath(readArg("output") ?? ".tmp/character-consistency-smoke"),
    samples: Number.isFinite(samples) ? Math.max(1, Math.min(samples, 40)) : 20,
    mode: mode === "strict" || mode === "creative" ? mode : "balanced",
    model: readArg("model") ?? (providerOverride === "mock" ? "mock-image" : env.PIPELINE_IMAGE_MODEL_DEFAULT),
    orientation,
    width: positiveIntArg("width", defaultWidth),
    height: positiveIntArg("height", defaultHeight),
    seed: readArg("seed") ?? `consistency-${Date.now()}`,
    seedMode: seedMode === "vary" ? "vary" : "locked",
    providerOverride,
    pipelineUrlOverride: readArg("pipeline-url") ?? null,
    pipelineTokenOverride: readArg("pipeline-token") ?? null,
  };
}

async function main() {
  const options = readOptions();
  applyRuntimeOverrides(options);
  const startedAt = Date.now();
  await mkdir(options.outputDir, { recursive: true });
  const references = await referenceImages(options.referencePaths, options.outputDir);
  const scenes = defaultScenes.slice(0, options.samples);
  const samples: SmokeSample[] = [];

  for (const [index, scene] of scenes.entries()) {
    const prompt = buildPrompt(options, scene);
    const sampleSeed = seedForSample(options, index);
    try {
      const result = await providers.image.generate({
        prompt,
        negativePrompt: options.negativePrompt,
        count: 1,
        seed: sampleSeed,
        model: options.model,
        orientation: options.orientation,
        requestId: `consistency_smoke_${randomUUID()}`,
        controls: {
          source: "character-consistency-smoke",
          consistencyMode: options.mode,
          width: options.width,
          height: options.height,
        },
        ...(references.providerImages.length > 0 ? { referenceImages: references.providerImages } : {}),
      });
      if (!result.ok) {
        samples.push(failedSample(index, scene, prompt, sampleSeed, result.error.message));
        continue;
      }
      const [asset] = result.data.assets;
      if (!asset) {
        samples.push(failedSample(index, scene, prompt, sampleSeed, "provider returned no image"));
        continue;
      }
      const contentType = asset.contentType ?? "image/png";
      const body = await imageBody(asset);
      const filename = `sample-${String(index + 1).padStart(2, "0")}${extensionForContentType(contentType)}`;
      await writeFile(path.join(options.outputDir, filename), body);
      samples.push({
        index: index + 1,
        scene,
        prompt,
        seed: sampleSeed,
        file: filename,
        width: asset.width,
        height: asset.height,
        providerKey: asset.key ?? asset.sourceUrl ?? null,
        error: null,
      });
    } catch (error) {
      samples.push(failedSample(index, scene, prompt, sampleSeed, error instanceof Error ? error.message : String(error)));
    }
  }

  const manifest = {
    ok: samples.every((sample) => !sample.error),
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    product: "character-consistency-smoke",
    qualityReviewReady: env.IMAGE_PROVIDER !== "mock" && scenes.length >= 20,
    threshold: {
      sameCharacterRate: 0.8,
      minimumSamples: 20,
      strictMustNotBeWorseThanBalanced: true,
    },
    input: {
      characterName: options.characterName,
      identityPrompt: options.identityPrompt,
      negativePrompt: options.negativePrompt,
      referenceCount: references.reviewReferences.length,
      direction: references.providerImages.length > 0
        ? "image-to-image-reference"
        : "text-to-image-text-seed",
      mode: options.mode,
      model: options.model,
      orientation: options.orientation,
      width: options.width,
      height: options.height,
      seed: options.seed,
      seedMode: options.seedMode,
      provider: env.IMAGE_PROVIDER,
      pipelineUrl: env.IMAGE_PROVIDER === "pipeline" ? env.PIPELINE_API_URL ?? null : null,
      providerOverride: options.providerOverride,
      pipelineUrlOverride: options.pipelineUrlOverride,
    },
    references: references.reviewReferences,
    samples,
  };
  await writeFile(path.join(options.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(options.outputDir, "review.html"), reviewHtml(manifest));
  process.stdout.write(`${JSON.stringify({ ...manifest, review: path.join(options.outputDir, "review.html") }, null, 2)}\n`);
  if (!manifest.ok) process.exitCode = 1;
}

function seedForSample(options: SmokeOptions, index: number) {
  if (options.seedMode === "vary") return `${options.seed}-${index + 1}`;
  return options.seed;
}

function applyRuntimeOverrides(options: SmokeOptions) {
  if (options.providerOverride) process.env.GEN_IMAGE_PROVIDER = options.providerOverride;
  if (options.pipelineUrlOverride) process.env.PIPELINE_API_URL = options.pipelineUrlOverride;
  if (options.pipelineTokenOverride) process.env.PIPELINE_API_TOKEN = options.pipelineTokenOverride;
}

function buildPrompt(options: SmokeOptions, scene: string) {
  return [
    `Locked identity: ${options.identityPrompt}`,
    consistencyFragment(options.mode),
    `Requested scene: ${scene}`,
    "Keep the same adult character identity across face shape, eyes, hairstyle, body type, and signature traits.",
    "Do not invent a different person.",
  ].join(". ");
}

function consistencyFragment(mode: ConsistencyMode) {
  if (mode === "strict") return "Identity consistency: strict; prioritize the same face and hair over scene variation";
  if (mode === "creative") return "Identity consistency: creative; preserve core face, hair, and signature traits while allowing styling variation";
  return "Identity consistency: balanced; preserve identity while allowing pose, outfit, lighting, and scene variation";
}

async function referenceImages(paths: string[], outputDir: string) {
  const pairs = await Promise.all(
    paths.map(async (filePath, index) => {
      const absolutePath = path.resolve(filePath);
      if (!existsSync(absolutePath)) throw new Error(`Reference image not found: ${absolutePath}`);
      const body = await readFile(absolutePath);
      const contentType = contentTypeFromPath(absolutePath);
      const role = index === 0 ? "identity_anchor" as const : "identity_reference" as const;
      const weight = index === 0 ? 1.2 : 0.85;
      const file = `reference-${String(index + 1).padStart(2, "0")}${extensionForContentType(contentType)}`;
      await writeFile(path.join(outputDir, file), body);
      return {
        providerImage: {
          assetId: `local-reference-${index + 1}`,
          role,
          b64Json: Buffer.from(body).toString("base64"),
          contentType,
          weight,
        },
        reviewReference: {
          index: index + 1,
          role,
          file,
          sourcePath: absolutePath,
          contentType,
          weight,
        },
      };
    }),
  );
  return {
    providerImages: pairs.map((pair) => pair.providerImage),
    reviewReferences: pairs.map((pair) => pair.reviewReference),
  };
}

async function imageBody(asset: { body?: Uint8Array; sourceUrl?: string }) {
  if (asset.body) return asset.body;
  if (!asset.sourceUrl) return new Uint8Array(placeholderImagePng);
  const response = await fetch(asset.sourceUrl);
  if (!response.ok) throw new Error(`failed to download provider asset: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function failedSample(index: number, scene: string, prompt: string, seed: string, error: string): SmokeSample {
  return {
    index: index + 1,
    scene,
    prompt,
    seed,
    file: null,
    width: null,
    height: null,
    providerKey: null,
    error,
  };
}

function widthForOrientation(orientation: string) {
  if (orientation === "1:1" || orientation === "square") return 1024;
  if (orientation === "16:9") return 1280;
  return 1024;
}

function heightForOrientation(orientation: string) {
  if (orientation === "1:1" || orientation === "square") return 1024;
  if (orientation === "16:9") return 720;
  return 1280;
}

function positiveIntArg(name: string, fallback: number) {
  const value = readArg(name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 128 ? parsed : fallback;
}

function extensionForContentType(contentType: string) {
  const lower = contentType.toLowerCase();
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("gif")) return ".gif";
  return ".png";
}

function contentTypeFromPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".webp") return "image/webp";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  return "image/png";
}

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function reviewHtml(manifest: Record<string, unknown>) {
  const input = manifest.input as Record<string, unknown>;
  const references = Array.isArray(manifest.references)
    ? (manifest.references as SmokeReference[])
    : [];
  const samples = manifest.samples as SmokeSample[];
  const referenceCards = references.length
    ? references.map((reference) => `
    <article class="reference-card">
      <img src="./${escapeHtml(reference.file)}" alt="Reference ${reference.index}">
      <div><strong>#${reference.index}</strong> ${escapeHtml(reference.role)} · weight ${reference.weight}</div>
    </article>
  `).join("\n")
    : `<p class="empty">No reference images in this run. Judge against the locked identity text and seed-stable outputs.</p>`;
  const cards = samples.map((sample) => `
    <article class="card" data-sample="${sample.index}">
      <header><strong>#${sample.index}</strong><span>${escapeHtml(sample.scene)}</span></header>
      <div class="seed">Seed: ${escapeHtml(sample.seed)}</div>
      ${sample.file ? `<img src="./${escapeHtml(sample.file)}" alt="Sample ${sample.index}">` : `<div class="error">${escapeHtml(sample.error ?? "missing image")}</div>`}
      <fieldset>
        <label><input type="radio" name="same-${sample.index}" value="yes"> Same character</label>
        <label><input type="radio" name="same-${sample.index}" value="no"> Different character</label>
      </fieldset>
      <textarea placeholder="Notes"></textarea>
    </article>
  `).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Character Consistency Smoke Review</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f7f7f4; color: #171717; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    .meta { display: grid; gap: 6px; margin-bottom: 20px; color: #525252; }
    .summary { position: sticky; top: 0; z-index: 1; background: #fffffff2; border-bottom: 1px solid #d8d8d0; padding: 12px 24px; display: flex; gap: 16px; align-items: center; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
    .baseline { background: #fff; border: 1px solid #deded7; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
    .identity { margin: 0 0 12px; font-size: 14px; line-height: 1.5; }
    .reference-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
    .reference-card { display: grid; gap: 8px; font-size: 12px; color: #525252; }
    .reference-card img { width: 100%; aspect-ratio: 4 / 5; object-fit: cover; border-radius: 6px; background: #eee; }
    .empty { margin: 0; color: #525252; }
    .card { background: #fff; border: 1px solid #deded7; border-radius: 8px; overflow: hidden; }
    .card header { min-height: 64px; padding: 10px; display: grid; gap: 4px; font-size: 13px; }
    .seed { padding: 0 10px 10px; font-size: 11px; color: #737373; overflow-wrap: anywhere; }
    .card img { width: 100%; aspect-ratio: 4 / 5; object-fit: cover; display: block; background: #eee; }
    fieldset { border: 0; display: grid; gap: 6px; padding: 10px; margin: 0; font-size: 13px; }
    textarea { box-sizing: border-box; width: calc(100% - 20px); margin: 0 10px 10px; min-height: 56px; resize: vertical; }
    .error { min-height: 260px; display: grid; place-items: center; padding: 16px; color: #9f1239; background: #fff1f2; }
    button { border: 1px solid #171717; background: #171717; color: #fff; border-radius: 6px; padding: 8px 12px; cursor: pointer; }
    output { font-weight: 700; }
  </style>
</head>
<body>
  <div class="summary">
    <output id="score">0 / ${samples.length} same character · 0%</output>
    <button id="copy">Copy review JSON</button>
  </div>
  <main>
    <h1>Character Consistency Smoke Review</h1>
    <section class="meta">
      <div>Character: ${escapeHtml(String(input.characterName ?? ""))}</div>
      <div>Direction: ${escapeHtml(String(input.direction ?? ""))} · Mode: ${escapeHtml(String(input.mode ?? ""))} · Model: ${escapeHtml(String(input.model ?? ""))} · Size: ${escapeHtml(String(input.width ?? ""))}x${escapeHtml(String(input.height ?? ""))} · References: ${escapeHtml(String(input.referenceCount ?? 0))}</div>
      <div>Pass criterion: at least 80% samples judged as the same character.</div>
    </section>
    <section class="baseline">
      <p class="identity"><strong>Locked identity:</strong> ${escapeHtml(String(input.identityPrompt ?? ""))}</p>
      <div class="reference-grid">${referenceCards}</div>
    </section>
    <section class="grid">${cards}</section>
  </main>
  <script>
    const score = document.querySelector("#score");
    const copy = document.querySelector("#copy");
    function collect() {
      const cards = [...document.querySelectorAll(".card")];
      const samples = cards.map(card => {
        const index = Number(card.dataset.sample);
        const selected = card.querySelector("input:checked");
        const notes = card.querySelector("textarea").value;
        return { index, sameCharacter: selected ? selected.value === "yes" : null, notes };
      });
      const answered = samples.filter(sample => sample.sameCharacter !== null);
      const passed = samples.filter(sample => sample.sameCharacter === true).length;
      const rate = samples.length ? Math.round((passed / samples.length) * 100) : 0;
      score.textContent = passed + " / " + samples.length + " same character · " + rate + "%";
      return { reviewedAt: new Date().toISOString(), pass: rate >= 80 && answered.length === samples.length, sameCharacterRate: rate / 100, samples };
    }
    document.addEventListener("change", collect);
    document.addEventListener("input", collect);
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(JSON.stringify(collect(), null, 2));
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy review JSON"; }, 1200);
    });
    collect();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
