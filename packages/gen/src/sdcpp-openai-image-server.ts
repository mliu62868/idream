import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import "dotenv/config";
import { assertGeneratedImageSanity } from "./generated-image-sanity";
import {
  cleanupSdcppReferenceImages,
  materializeSdcppReferenceImages,
  parseSdcppReferenceImages,
  sdcppReferenceArgs,
  type MaterializedSdcppReferenceImage,
  type SdcppReferenceImage,
  type SdcppReferenceMode,
} from "./sdcpp-reference-images";
import {
  detectSdcppModelFamily,
  isKnownKrea2IncompatibleTextEncoder,
  isKnownKrea2IncompatibleVae,
  krea2TextEncoderCandidates,
  krea2VaeCandidates,
  normalizeSdcppSampler,
  type SdcppModelFamily,
  validateSdcppRuntimeComponents,
} from "./sdcpp-runtime";

type ImageGenerationRequest = {
  model?: unknown;
  profileId?: unknown;
  prompt?: unknown;
  negative_prompt?: unknown;
  negativePrompt?: unknown;
  controls?: unknown;
  size?: unknown;
  n?: unknown;
  count?: unknown;
  seed?: unknown;
  steps?: unknown;
  num_inference_steps?: unknown;
  scheduler?: unknown;
  response_format?: unknown;
  reference_images?: unknown;
  referenceImages?: unknown;
};

type JsonRecord = Record<string, unknown>;

const defaultSourceModel = resolvePathEnv("SDCPP_SOURCE_MODEL", [
  "~/Downloads/models/pornmasterZImage_turboV35Bf16.safetensors",
  "~/.localai/models/z-image-components/pornmasterZImage_turboV35Bf16.safetensors",
]);

const config = {
  port: readIntegerEnv("SDCPP_IMAGE_PORT", readIntegerEnv("PORT", 8091)),
  apiToken: process.env.SDCPP_IMAGE_API_TOKEN ?? "",
  modelId: process.env.SDCPP_IMAGE_MODEL_ID ?? "pornmaster-zimage-turbo",
  cliPath: resolveOptionalPathEnv("SDCPP_CLI", ["~/bin/sd-cli"]) ?? "sd-cli",
  sourceModel: defaultSourceModel,
  diffusionModel: resolveDiffusionModel(defaultSourceModel),
  llmPath: resolvePathEnv("SDCPP_LLM", [
    "~/.localai/models/z-image-components/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
  ]),
  vaePath: resolvePathEnv("SDCPP_VAE", [
    "~/.localai/models/z-image-components/split_files/vae/ae.safetensors",
  ]),
  outputDir: process.env.SDCPP_OUTPUT_DIR ?? path.resolve(process.cwd(), ".tmp/sdcpp-image-server"),
  conversionOutputDir:
    process.env.SDCPP_CONVERSION_OUTPUT_DIR ?? path.resolve(process.cwd(), ".tmp/sdcpp-models"),
  steps: readIntegerEnv("SDCPP_STEPS", 8),
  maxCount: readIntegerEnv("SDCPP_MAX_COUNT", 1),
  timeoutMs: readIntegerEnv("SDCPP_TIMEOUT_MS", 300_000),
  conversionTimeoutMs: readIntegerEnv("SDCPP_CONVERSION_TIMEOUT_MS", 900_000),
  cfgScale: process.env.SDCPP_CFG_SCALE ?? "1",
  sampler: process.env.SDCPP_SAMPLER ?? "euler",
  scheduler: process.env.SDCPP_SCHEDULER ?? "model_default",
  diffusionFlashAttention: readBooleanEnv("SDCPP_DIFFUSION_FA", true),
  offloadToCpu: readBooleanEnv("SDCPP_OFFLOAD_TO_CPU", true),
  allowRequestConfig: readBooleanEnv("SDCPP_ALLOW_REQUEST_CONFIG", true),
  referenceMode: referenceModeEnv(process.env.SDCPP_REFERENCE_MODE),
  referenceStrength: clampNumber(readNumberEnv("SDCPP_REFERENCE_STRENGTH", 0.62), 0.05, 0.95),
  maxReferenceImages: readIntegerEnv("SDCPP_MAX_REFERENCE_IMAGES", 4),
  referenceFetchTimeoutMs: readIntegerEnv("SDCPP_REFERENCE_FETCH_TIMEOUT_MS", 15_000),
};

type SdcppLoraConfig = {
  key?: string;
  path?: string;
  weight: number;
  enabled: boolean;
};

type SdcppConversionConfig = {
  enabled: boolean;
  targetFormat: "gguf";
  outputPath?: string;
  type: string;
  sourceArg: "model" | "diffusion-model";
  convertName: boolean;
  tensorTypeRules?: string;
};

type SdcppRuntimeConfig = {
  modelId: string;
  family: SdcppModelFamily;
  sourceModel: string;
  diffusionModel: string;
  llmPath: string;
  vaePath: string;
  llmVisionPath?: string;
  clipLPath?: string;
  clipGPath?: string;
  t5xxlPath?: string;
  modelFormat: string;
  loraModelDir?: string;
  loraApplyMode?: string;
  loras: SdcppLoraConfig[];
  conversion?: SdcppConversionConfig;
  steps: number;
  sampler: string;
  scheduler: string;
  cfgScale: string;
  backend?: string;
};

await mkdir(config.outputDir, { recursive: true });
await mkdir(config.conversionOutputDir, { recursive: true });

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    sendJson(response, 500, {
      error: {
        code: "internal",
        message: error instanceof Error ? error.message : String(error),
        type: "server_error",
      },
    });
  });
});

server.listen(config.port, "127.0.0.1", () => {
  console.log(`sdcpp image pipeline listening on http://127.0.0.1:${config.port}`);
  console.log(`model id: ${config.modelId}`);
});

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/readyz") {
    sendJson(response, 200, {
      ok: true,
      model: config.modelId,
      runner: "sdcpp",
      sourceModel: config.sourceModel,
      diffusionModel: config.diffusionModel,
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, { object: "list", data: [{ id: config.modelId, object: "model" }] });
    return;
  }
  if (
    request.method === "POST" &&
    (url.pathname === "/v1/images/generations" || url.pathname === "/images/generations")
  ) {
    if (!authorize(request)) {
      sendJson(response, 401, {
        error: { code: "unauthorized", message: "Missing or invalid bearer token", type: "auth_error" },
      });
      return;
    }
    const body = await readJson(request);
    const result = await generateImages(parseImageRequest(body));
    sendJson(response, 200, result);
    return;
  }
  sendJson(response, 404, { error: { code: "not_found", message: "Not found", type: "invalid_request_error" } });
}

function authorize(request: IncomingMessage) {
  if (!config.apiToken) return true;
  return request.headers.authorization === `Bearer ${config.apiToken}`;
}

async function generateImages(input: {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  count: number;
  seed: number;
  steps: number;
  runtime: SdcppRuntimeConfig;
  referenceImages: SdcppReferenceImage[];
}) {
  const data: Array<{ b64_json: string; width: number; height: number }> = [];
  validateSdcppRuntimeComponents({
    family: input.runtime.family,
    llmPath: input.runtime.llmPath,
    vaePath: input.runtime.vaePath,
    fileExists: existsSync,
  });
  const runtime = await prepareRuntime(input.runtime);
  const referenceImages = await materializeSdcppReferenceImages({
    images: input.referenceImages,
    dir: path.join(config.outputDir, "references"),
    timeoutMs: config.referenceFetchTimeoutMs,
  });
  try {
    for (let index = 0; index < input.count; index += 1) {
      const outputPath = path.join(config.outputDir, `${Date.now()}-${randomUUID()}.png`);
      const seed = input.seed + index;
      const args = buildSdcppArgs({
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        width: input.width,
        height: input.height,
        seed,
        steps: input.steps,
        outputPath,
        runtime,
        referenceImages,
      });
      await runSdcpp(args);
      const image = await readFile(outputPath);
      assertGeneratedImageSanity(image, `${runtime.modelId} seed ${seed}`);
      await rm(outputPath, { force: true });
      data.push({ b64_json: image.toString("base64"), width: input.width, height: input.height });
    }
  } finally {
    await cleanupSdcppReferenceImages(referenceImages);
  }
  return { created: Math.floor(Date.now() / 1000), data };
}

function buildSdcppArgs(input: {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  outputPath: string;
  runtime: SdcppRuntimeConfig;
  referenceImages: MaterializedSdcppReferenceImage[];
}) {
  const loraPrompt = loraPromptPrefix(input.runtime.loras);
  const args = [
    "--diffusion-model",
    input.runtime.diffusionModel,
    "--llm",
    input.runtime.llmPath,
    "--vae",
    input.runtime.vaePath,
    "--prompt",
    loraPrompt ? `${loraPrompt} ${input.prompt}` : input.prompt,
    "--negative-prompt",
    input.negativePrompt,
    "--steps",
    String(input.steps),
    "-W",
    String(input.width),
    "-H",
    String(input.height),
    "--sampling-method",
    normalizeSdcppSampler(input.runtime.sampler),
    ...schedulerArgs(input.runtime.scheduler),
    "--cfg-scale",
    input.runtime.cfgScale,
    "--seed",
    String(input.seed),
    "--output",
    input.outputPath,
    ...sdcppReferenceArgs({
      images: input.referenceImages,
      mode: config.referenceMode,
      strength: config.referenceStrength,
    }),
  ];

  if (input.runtime.clipLPath) args.push("--clip_l", input.runtime.clipLPath);
  if (input.runtime.clipGPath) args.push("--clip_g", input.runtime.clipGPath);
  if (input.runtime.t5xxlPath) args.push("--t5xxl", input.runtime.t5xxlPath);
  if (input.runtime.llmVisionPath) args.push("--llm_vision", input.runtime.llmVisionPath);
  if (input.runtime.loraModelDir) args.push("--lora-model-dir", input.runtime.loraModelDir);
  if (input.runtime.loraApplyMode) args.push("--lora-apply-mode", input.runtime.loraApplyMode);
  if (input.runtime.backend) args.push("--backend", input.runtime.backend);
  if (config.offloadToCpu) args.push("--offload-to-cpu");
  if (config.diffusionFlashAttention) args.push("--diffusion-fa");
  return args;
}

function schedulerArgs(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "model_default") return [];
  return ["--scheduler", trimmed];
}

function runSdcpp(args: string[], timeoutMs = config.timeoutMs) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(config.cliPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`sd-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`sd-cli exited with ${code ?? "unknown"}\n${stderr || stdout}`.trim()));
    });
  });
}

function parseImageRequest(value: unknown) {
  if (!isRecord(value)) throw new Error("Request body must be a JSON object");
  const body = value as ImageGenerationRequest;
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  const runtime = runtimeConfigFromRequest(body);
  if (requestedModel && requestedModel !== runtime.modelId) {
    throw new Error(`Unsupported model: ${requestedModel}`);
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required");

  const negativePrompt =
    typeof body.negative_prompt === "string"
      ? body.negative_prompt
      : typeof body.negativePrompt === "string"
        ? body.negativePrompt
        : "";
  const { width, height } = parseSize(typeof body.size === "string" ? body.size : "512x512");
  const requestedCount = numberFromUnknown(body.n) ?? numberFromUnknown(body.count) ?? 1;
  const count = clampInteger(requestedCount, 1, Math.max(1, config.maxCount));
  const seed = clampInteger(numberFromUnknown(body.seed) ?? Date.now(), 0, 2_147_483_647);
  const requestedSteps = numberFromUnknown(body.steps) ?? numberFromUnknown(body.num_inference_steps) ?? runtime.steps;
  const steps = clampInteger(requestedSteps, 1, 60);
  const referenceImages = parseSdcppReferenceImages(
    body.reference_images ?? body.referenceImages,
    config.maxReferenceImages,
  );

  return { prompt, negativePrompt, width, height, count, seed, steps, runtime, referenceImages };
}

function parseSize(size: string) {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(size);
  if (!match) throw new Error(`Unsupported size: ${size}`);
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`Unsupported size: ${size}`);
  if (width < 64 || height < 64 || width > 2048 || height > 2048) {
    throw new Error(`Size must be between 64x64 and 2048x2048: ${size}`);
  }
  if (width % 8 !== 0 || height % 8 !== 0) throw new Error(`Size must be divisible by 8: ${size}`);
  return { width, height };
}

function runtimeConfigFromRequest(body: ImageGenerationRequest): SdcppRuntimeConfig {
  const fallback = defaultRuntimeConfig();
  if (!config.allowRequestConfig || !isRecord(body.controls) || !isRecord(body.controls.sdcpp)) {
    return fallback;
  }
  const requestConfig = body.controls.sdcpp;
  const modelId = stringField(requestConfig, "apiModelId") ?? stringField(requestConfig, "profileKey") ?? fallback.modelId;
  const sourceModel = expandOptionalPath(stringField(requestConfig, "sourceModelPath")) ?? fallback.sourceModel;
  const convertedModel =
    expandOptionalPath(stringField(requestConfig, "convertedModelPath")) ??
    expandOptionalPath(stringField(requestConfig, "conversionOutputPath"));
  const explicitDiffusion =
    expandOptionalPath(stringField(requestConfig, "diffusionModelPath")) ??
    expandOptionalPath(stringField(requestConfig, "modelPath"));
  const family = detectSdcppModelFamily([
    modelId,
    stringField(requestConfig, "profileKey"),
    sourceModel,
    convertedModel,
    explicitDiffusion,
  ]);
  const conversion = conversionFromRequest(requestConfig);
  const loras = lorasFromRequest(requestConfig.loras);
  const loraModelDir =
    expandOptionalPath(stringField(requestConfig, "loraModelDir")) ?? commonLoraDir(loras);
  const explicitLlmPath = expandOptionalPath(stringField(requestConfig, "llmPath"));
  const explicitVaePath = expandOptionalPath(stringField(requestConfig, "vaePath"));
  return {
    modelId,
    family,
    sourceModel,
    diffusionModel: convertedModel ?? explicitDiffusion ?? sourceModel,
    llmPath: runtimeComponentPath({
      family,
      kind: "llm",
      explicit: explicitLlmPath,
      fallback: fallback.llmPath,
    }),
    vaePath: runtimeComponentPath({
      family,
      kind: "vae",
      explicit: explicitVaePath,
      fallback: fallback.vaePath,
    }),
    llmVisionPath: expandOptionalPath(stringField(requestConfig, "llmVisionPath")),
    clipLPath: expandOptionalPath(stringField(requestConfig, "clipLPath")),
    clipGPath: expandOptionalPath(stringField(requestConfig, "clipGPath")),
    t5xxlPath: expandOptionalPath(stringField(requestConfig, "t5xxlPath")),
    modelFormat: stringField(requestConfig, "modelFormat") ?? fallback.modelFormat,
    loraModelDir,
    loraApplyMode: stringField(requestConfig, "loraApplyMode"),
    loras,
    conversion,
    steps: integerField(requestConfig, "steps") ?? fallback.steps,
    sampler: stringField(requestConfig, "sampler") ?? fallback.sampler,
    scheduler:
      stringField(requestConfig, "scheduler") ??
      topLevelScheduler(body) ??
      fallback.scheduler,
    cfgScale:
      typeof requestConfig.cfgScale === "number" && Number.isFinite(requestConfig.cfgScale)
        ? String(requestConfig.cfgScale)
        : stringField(requestConfig, "cfgScale") ?? fallback.cfgScale,
    backend: sdcppBackendForRuntime(family, stringField(requestConfig, "backend") ?? fallback.backend),
  };
}

function topLevelScheduler(body: ImageGenerationRequest) {
  return typeof body.scheduler === "string" && body.scheduler.trim()
    ? body.scheduler.trim()
    : undefined;
}

function commonLoraDir(loras: SdcppLoraConfig[]) {
  const dirs = new Set(
    loras
      .map((lora) => (lora.path ? path.dirname(lora.path) : ""))
      .filter((dir) => dir.length > 0),
  );
  return dirs.size === 1 ? [...dirs][0] : undefined;
}

function defaultRuntimeConfig(): SdcppRuntimeConfig {
  const family = detectSdcppModelFamily([config.modelId, config.sourceModel, config.diffusionModel]);
  return {
    modelId: config.modelId,
    family,
    sourceModel: config.sourceModel,
    diffusionModel: config.diffusionModel,
    llmPath: config.llmPath,
    vaePath: config.vaePath,
    modelFormat: modelFormatFromPath(config.diffusionModel),
    loras: [],
    steps: config.steps,
    sampler: config.sampler,
    scheduler: config.scheduler,
    cfgScale: config.cfgScale,
    backend: sdcppBackendForRuntime(family, undefined),
  };
}

function sdcppBackendForRuntime(family: SdcppModelFamily, explicit: string | undefined) {
  if (explicit) return explicit;
  return family === "krea2" ? "vae=cpu" : undefined;
}

function conversionFromRequest(requestConfig: JsonRecord): SdcppConversionConfig | undefined {
  if (!isRecord(requestConfig.conversion) || requestConfig.conversion.enabled !== true) return undefined;
  const conversion = requestConfig.conversion;
  return {
    enabled: true,
    targetFormat: "gguf",
    outputPath: expandOptionalPath(stringField(conversion, "outputPath")),
    type: stringField(conversion, "type") ?? "q8_0",
    sourceArg: stringField(conversion, "sourceArg") === "diffusion-model" ? "diffusion-model" : "model",
    convertName: conversion.convertName === true,
    tensorTypeRules: stringField(conversion, "tensorTypeRules"),
  };
}

function lorasFromRequest(value: unknown): SdcppLoraConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((item) => {
    const key = stringField(item, "key");
    const loraPath = expandOptionalPath(stringField(item, "path"));
    if (!key && !loraPath) return [];
    return [{
      key,
      path: loraPath,
      weight: numberFromUnknown(item.weight) ?? 1,
      enabled: item.enabled !== false,
    }];
  });
}

async function prepareRuntime(runtime: SdcppRuntimeConfig): Promise<SdcppRuntimeConfig> {
  const conversion = runtime.conversion;
  if (!conversion?.enabled) return runtime;
  if (runtime.modelFormat !== "safetensors" && !runtime.sourceModel.endsWith(".safetensors")) return runtime;
  const target = conversion.outputPath ?? defaultConvertedPath(runtime.sourceModel, conversion.type);
  if (!target.endsWith(".gguf")) throw new Error(`Conversion output must end with .gguf: ${target}`);
  if (existsSync(target)) return { ...runtime, diffusionModel: target, modelFormat: "gguf" };
  if (runtime.family === "krea2") {
    throw new Error(
      `Krea2 conversion target is missing: ${target}. ` +
        "Run it through sdcpp with the Krea2 safetensors diffusion model directly, or provide an existing .gguf file.",
    );
  }

  await mkdir(path.dirname(target), { recursive: true });
  // Convert to a unique temp path then atomically rename into place. An interrupted or
  // crashed conversion (SIGTERM on timeout, process death, or a second concurrent request)
  // must never leave a partial/corrupt .gguf at `target`, which the existsSync(target) guard
  // above would then treat as a valid converted model on every later request. `target` only
  // appears once the conversion fully succeeds; the temp file is removed on failure.
  const tmpTarget = `${target}.converting-${randomUUID()}.gguf`;
  const sourceFlag = conversion.sourceArg === "diffusion-model" ? "--diffusion-model" : "--model";
  const args = [
    "--mode",
    "convert",
    sourceFlag,
    runtime.sourceModel,
    "--type",
    conversion.type,
    "--output",
    tmpTarget,
  ];
  if (conversion.convertName) args.push("--convert-name");
  if (conversion.tensorTypeRules) args.push("--tensor-type-rules", conversion.tensorTypeRules);
  try {
    await runSdcpp(args, config.conversionTimeoutMs);
    await rename(tmpTarget, target);
  } catch (error) {
    await rm(tmpTarget, { force: true }).catch(() => {});
    throw error;
  }
  return { ...runtime, diffusionModel: target, modelFormat: "gguf" };
}

function runtimeComponentPath(input: {
  family: SdcppModelFamily;
  kind: "llm" | "vae";
  explicit?: string;
  fallback: string;
}) {
  if (input.family !== "krea2") return input.explicit ?? input.fallback;
  const candidates = input.kind === "llm"
    ? krea2TextEncoderCandidates(os.homedir())
    : krea2VaeCandidates(os.homedir());
  const existing = candidates.find((candidate) => existsSync(candidate));
  const incompatible = input.explicit
    ? input.kind === "llm"
      ? isKnownKrea2IncompatibleTextEncoder(input.explicit)
      : isKnownKrea2IncompatibleVae(input.explicit)
    : false;
  if (existing && (!input.explicit || incompatible)) return existing;
  if (input.explicit) return input.explicit;
  return candidates[0] ?? input.fallback;
}

function defaultConvertedPath(sourceModel: string, type: string) {
  const basename = path.basename(sourceModel).replace(/\.[^.]+$/, "");
  return path.join(config.conversionOutputDir, `${basename}-${type}.gguf`);
}

function loraPromptPrefix(loras: SdcppLoraConfig[]) {
  return loras
    .filter((lora) => lora.enabled)
    .map((lora) => {
      const key = lora.key ?? (lora.path ? path.basename(lora.path).replace(/\.[^.]+$/, "") : "");
      return key ? `<lora:${key}:${lora.weight}>` : "";
    })
    .filter(Boolean)
    .join(" ");
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function sendJson(response: ServerResponse, status: number, body: JsonRecord) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function readIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readNumberEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name];
  if (!value) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function numberFromUnknown(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringField(value: JsonRecord, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function integerField(value: JsonRecord, key: string) {
  const child = numberFromUnknown(value[key]);
  return child === null ? undefined : Math.trunc(child);
}

function modelFormatFromPath(value: string) {
  const lowered = value.toLowerCase();
  if (lowered.endsWith(".gguf")) return "gguf";
  if (lowered.endsWith(".safetensors")) return "safetensors";
  return "external";
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function referenceModeEnv(value: string | undefined): SdcppReferenceMode {
  if (value === "disabled" || value === "ref_image" || value === "init_img") return value;
  return "auto";
}

function appendBounded(current: string, next: string) {
  const combined = current + next;
  return combined.length > 16_000 ? combined.slice(-16_000) : combined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDiffusionModel(sourceModel: string) {
  const explicit = process.env.SDCPP_DIFFUSION_MODEL;
  if (explicit) return expandHome(explicit);

  const converted = process.env.SDCPP_CONVERTED_DIFFUSION_MODEL;
  if (converted) return expandHome(converted);

  return sourceModel;
}

function resolvePathEnv(name: string, candidates: string[]) {
  const explicit = process.env[name];
  if (explicit) return expandHome(explicit);

  const resolved = candidates.map(expandHome);
  const existing = resolved.find((candidate) => existsSync(candidate));
  if (existing) return existing;

  throw new Error(`${name} is required. Tried: ${resolved.join(", ")}`);
}

function resolveOptionalPathEnv(name: string, candidates: string[]) {
  const explicit = process.env[name];
  if (explicit) return expandHome(explicit);

  return candidates.map(expandHome).find((candidate) => existsSync(candidate));
}

function expandOptionalPath(value: string | undefined) {
  return value ? expandHome(value) : undefined;
}

function expandHome(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
