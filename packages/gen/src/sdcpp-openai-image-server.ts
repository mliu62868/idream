import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import "dotenv/config";

type ImageGenerationRequest = {
  model?: unknown;
  prompt?: unknown;
  negative_prompt?: unknown;
  negativePrompt?: unknown;
  size?: unknown;
  n?: unknown;
  count?: unknown;
  seed?: unknown;
  steps?: unknown;
  num_inference_steps?: unknown;
  response_format?: unknown;
};

type JsonRecord = Record<string, unknown>;

const defaultSourceModel = resolvePathEnv("SDCPP_SOURCE_MODEL", [
  "~/Download/pornmasterZImage_turboV35Bf16.safetensors",
  "~/Downloads/pornmasterZImage_turboV35Bf16.safetensors",
]);

const config = {
  port: readIntegerEnv("SDCPP_IMAGE_PORT", readIntegerEnv("PORT", 8091)),
  apiToken: process.env.SDCPP_IMAGE_API_TOKEN ?? "",
  modelId: process.env.SDCPP_IMAGE_MODEL_ID ?? "pornmaster-zimage-turbo",
  cliPath: resolveOptionalPathEnv("SDCPP_CLI", ["~/code/sdcpp/sd-cli"]) ?? "sd-cli",
  sourceModel: defaultSourceModel,
  diffusionModel: resolveDiffusionModel(defaultSourceModel),
  llmPath: resolvePathEnv("SDCPP_LLM", [
    "~/.localai/models/z-image-components/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
  ]),
  vaePath: resolvePathEnv("SDCPP_VAE", [
    "~/.localai/models/z-image-components/split_files/vae/ae.safetensors",
  ]),
  outputDir: process.env.SDCPP_OUTPUT_DIR ?? path.resolve(process.cwd(), ".tmp/sdcpp-image-server"),
  steps: readIntegerEnv("SDCPP_STEPS", 8),
  maxCount: readIntegerEnv("SDCPP_MAX_COUNT", 1),
  timeoutMs: readIntegerEnv("SDCPP_TIMEOUT_MS", 300_000),
  cfgScale: process.env.SDCPP_CFG_SCALE ?? "1",
  sampler: process.env.SDCPP_SAMPLER ?? "euler",
  diffusionFlashAttention: readBooleanEnv("SDCPP_DIFFUSION_FA", true),
  offloadToCpu: readBooleanEnv("SDCPP_OFFLOAD_TO_CPU", true),
};

await mkdir(config.outputDir, { recursive: true });

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
}) {
  const data: Array<{ b64_json: string }> = [];
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
    });
    await runSdcpp(args);
    const image = await readFile(outputPath);
    await rm(outputPath, { force: true });
    data.push({ b64_json: image.toString("base64") });
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
}) {
  const args = [
    "--diffusion-model",
    config.diffusionModel,
    "--llm",
    config.llmPath,
    "--vae",
    config.vaePath,
    "--prompt",
    input.prompt,
    "--negative-prompt",
    input.negativePrompt,
    "--steps",
    String(input.steps),
    "-W",
    String(input.width),
    "-H",
    String(input.height),
    "--sampling-method",
    config.sampler,
    "--cfg-scale",
    config.cfgScale,
    "--seed",
    String(input.seed),
    "--output",
    input.outputPath,
  ];

  if (config.offloadToCpu) args.push("--offload-to-cpu");
  if (config.diffusionFlashAttention) args.push("--diffusion-fa");
  return args;
}

function runSdcpp(args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(config.cliPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`sd-cli timed out after ${config.timeoutMs}ms`));
    }, config.timeoutMs);

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
  if (requestedModel && requestedModel !== config.modelId) {
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
  const requestedSteps = numberFromUnknown(body.steps) ?? numberFromUnknown(body.num_inference_steps) ?? config.steps;
  const steps = clampInteger(requestedSteps, 1, 60);

  return { prompt, negativePrompt, width, height, count, seed, steps };
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

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.trunc(value)));
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

function expandHome(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
