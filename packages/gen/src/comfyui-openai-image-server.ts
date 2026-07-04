import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import "dotenv/config";
import { assertGeneratedImageSanity } from "./generated-image-sanity";

type ImageGenerationRequest = {
  model?: unknown;
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
  response_format?: unknown;
};

type JsonRecord = Record<string, unknown>;

type ComfyWorkflow = {
  apiPrompt: Record<string, ComfyNode>;
};

type ComfyNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

type ComfyImageOutput = {
  filename: string;
  subfolder: string;
  type: string;
};

const config = {
  port: readIntegerEnv("COMFYUI_IMAGE_PORT", readIntegerEnv("PORT", 8092)),
  apiToken: process.env.COMFYUI_IMAGE_API_TOKEN ?? "",
  modelId: process.env.COMFYUI_IMAGE_MODEL_ID ?? "redcraft-krea2-comfyui",
  comfyuiUrl: trimTrailingSlash(process.env.COMFYUI_API_URL ?? "http://127.0.0.1:8191"),
  workflowPath:
    process.env.COMFYUI_WORKFLOW_PATH ??
    path.resolve(workspaceRoot(), "packages/gen/workflows/redcraft-krea2-comfyui-text.json"),
  outputDir: process.env.COMFYUI_IMAGE_OUTPUT_DIR ?? path.resolve(process.cwd(), ".tmp/comfyui-image-server"),
  maxCount: readIntegerEnv("COMFYUI_IMAGE_MAX_COUNT", 1),
  steps: readIntegerEnv("COMFYUI_IMAGE_STEPS", 2),
  timeoutMs: readIntegerEnv("COMFYUI_IMAGE_TIMEOUT_MS", 600_000),
};

await mkdir(config.outputDir, { recursive: true });

const workflow = await readWorkflow(config.workflowPath);

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
  console.log(`ComfyUI image pipeline listening on http://127.0.0.1:${config.port}`);
  console.log(`model id: ${config.modelId}`);
  console.log(`ComfyUI API: ${config.comfyuiUrl}`);
  console.log(`workflow: ${config.workflowPath}`);
});

async function route(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/readyz") {
    const ready = await comfyReady();
    sendJson(response, ready.ok ? 200 : 503, {
      ok: ready.ok,
      model: config.modelId,
      runner: "comfyui",
      comfyuiUrl: config.comfyuiUrl,
      workflowPath: config.workflowPath,
      error: ready.error,
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

async function comfyReady() {
  try {
    const response = await fetch(`${config.comfyuiUrl}/object_info`);
    if (!response.ok) return { ok: false, error: `ComfyUI /object_info HTTP ${response.status}` };
    const info = await response.json() as unknown;
    const missing = requiredModelIssues(info);
    return missing.length === 0
      ? { ok: true, error: null }
      : { ok: false, error: `missing required ComfyUI models: ${missing.join(", ")}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function generateImages(input: {
  prompt: string;
  width: number;
  height: number;
  count: number;
  seed: number;
  steps: number;
}) {
  const data: Array<{ b64_json: string; width: number; height: number }> = [];
  for (let index = 0; index < input.count; index += 1) {
    const seed = input.seed + index;
    const prompt = buildPrompt({
      prompt: input.prompt,
      width: input.width,
      height: input.height,
      steps: input.steps,
      seed,
    });
    const promptId = await submitPrompt(prompt);
    const image = await waitForImage(promptId);
    const bytes = await fetchComfyImage(image);
    assertGeneratedImageSanity(Buffer.from(bytes), `${config.modelId} ${promptId} seed ${seed}`);
    await writeFile(path.join(config.outputDir, `${promptId}.png`), bytes);
    data.push({ b64_json: Buffer.from(bytes).toString("base64"), width: input.width, height: input.height });
  }
  return { created: Math.floor(Date.now() / 1000), data };
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
  const { width, height } = parseSize(typeof body.size === "string" ? body.size : "256x384");
  const requestedCount = numberFromUnknown(body.n) ?? numberFromUnknown(body.count) ?? 1;
  const count = clampInteger(requestedCount, 1, Math.max(1, config.maxCount));
  const seed = clampInteger(numberFromUnknown(body.seed) ?? Date.now(), 0, 2_147_483_647);
  const requestedSteps = numberFromUnknown(body.steps) ?? numberFromUnknown(body.num_inference_steps) ?? config.steps;
  const steps = clampInteger(requestedSteps, 1, 20);
  return { prompt, width, height, count, seed, steps };
}

async function readWorkflow(workflowPath: string): Promise<ComfyWorkflow> {
  const parsed = JSON.parse(await readFile(workflowPath, "utf8")) as unknown;
  const workflow = jsonRecord(parsed);
  const apiPrompt = jsonRecord(workflow.apiPrompt);
  if (Object.keys(apiPrompt).length === 0) throw new Error(`Workflow is missing apiPrompt: ${workflowPath}`);
  const nodes: Record<string, ComfyNode> = {};
  for (const [id, rawNode] of Object.entries(apiPrompt)) {
    const node = jsonRecord(rawNode);
    const classType = stringField(node, "class_type");
    const inputs = jsonRecord(node.inputs);
    if (!classType || Object.keys(inputs).length === 0) {
      throw new Error(`Workflow node ${id} is invalid`);
    }
    nodes[id] = { class_type: classType, inputs };
  }
  return { apiPrompt: nodes };
}

function buildPrompt(input: {
  prompt: string;
  width: number;
  height: number;
  steps: number;
  seed: number;
}) {
  const prompt = structuredClone(workflow.apiPrompt) as Record<string, ComfyNode>;
  setNodeInput(prompt, "4", "text", input.prompt);
  setNodeInput(prompt, "6", "width", input.width);
  setNodeInput(prompt, "6", "height", input.height);
  setNodeInput(prompt, "7", "steps", input.steps);
  setNodeInput(prompt, "7", "seed", input.seed);
  setNodeInput(prompt, "9", "filename_prefix", `idream_redcraft_${Date.now()}_${randomUUID()}`);
  return prompt;
}

function setNodeInput(
  prompt: Record<string, ComfyNode>,
  nodeId: string,
  inputName: string,
  value: string | number,
) {
  const node = prompt[nodeId];
  if (!node) throw new Error(`Workflow node ${nodeId} is missing`);
  node.inputs[inputName] = value;
}

async function submitPrompt(prompt: Record<string, ComfyNode>) {
  const response = await fetch(`${config.comfyuiUrl}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt,
      client_id: `idream-comfyui-gateway-${randomUUID()}`,
    }),
  });
  const json = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) throw new Error(`ComfyUI /prompt HTTP ${response.status}`);
  const promptId = stringField(json, "prompt_id");
  if (!promptId) throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(json)}`);
  return promptId;
}

async function waitForImage(promptId: string): Promise<ComfyImageOutput> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < config.timeoutMs) {
    await sleep(2_000);
    const response = await fetch(`${config.comfyuiUrl}/history/${encodeURIComponent(promptId)}`);
    const history = await response.json().catch(() => ({})) as JsonRecord;
    if (!response.ok) throw new Error(`ComfyUI /history HTTP ${response.status}`);
    const item = jsonRecord(history[promptId]);
    const status = jsonRecord(item.status);
    if (status.status_str === "error") {
      throw new Error(`ComfyUI prompt failed: ${JSON.stringify(status.messages ?? status)}`);
    }
    if (status.completed !== true) continue;
    const image = firstImageOutput(item);
    if (!image) throw new Error(`ComfyUI prompt ${promptId} completed without image output`);
    return image;
  }
  throw new Error(`ComfyUI prompt timed out after ${config.timeoutMs}ms: ${promptId}`);
}

function firstImageOutput(historyItem: JsonRecord): ComfyImageOutput | null {
  const outputs = jsonRecord(historyItem.outputs);
  for (const rawOutput of Object.values(outputs)) {
    const output = jsonRecord(rawOutput);
    const images = Array.isArray(output.images) ? output.images : [];
    for (const rawImage of images) {
      const image = jsonRecord(rawImage);
      const filename = stringField(image, "filename");
      const subfolder = stringField(image, "subfolder") ?? "";
      const type = stringField(image, "type") ?? "output";
      if (filename) return { filename, subfolder, type };
    }
  }
  return null;
}

async function fetchComfyImage(image: ComfyImageOutput) {
  const url = new URL(`${config.comfyuiUrl}/view`);
  url.searchParams.set("filename", image.filename);
  url.searchParams.set("subfolder", image.subfolder);
  url.searchParams.set("type", image.type);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`ComfyUI /view HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function requiredModelIssues(value: unknown) {
  const info = jsonRecord(value);
  const unet = optionsFor(info, "UNETLoader", "unet_name");
  const clip = optionsFor(info, "CLIPLoader", "clip_name");
  const vae = optionsFor(info, "VAELoader", "vae_name");
  const issues: string[] = [];
  if (!unet.includes("redcraftKREA2RedMix_krea2Edition.safetensors")) issues.push("Redcraft UNET");
  if (!clip.includes("qwen3vl_4b_fp8_scaled.safetensors")) issues.push("Qwen3VL fp8 text encoder");
  if (!vae.includes("qwen_image_vae.safetensors")) issues.push("qwen_image_vae");
  return issues;
}

function optionsFor(value: JsonRecord, nodeName: string, inputName: string) {
  const node = jsonRecord(value[nodeName]);
  const input = jsonRecord(node.input);
  const required = jsonRecord(input.required);
  const field = required[inputName];
  if (!Array.isArray(field)) return [];
  const options = field[0];
  return Array.isArray(options) ? options.filter((option): option is string => typeof option === "string") : [];
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

function readIntegerEnv(name: string, fallback: number) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function jsonRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
