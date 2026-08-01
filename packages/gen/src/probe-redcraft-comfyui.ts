import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertGeneratedImageSanity } from "./generated-image-sanity";

type ProbeOptions = {
  url: string;
  workflowPath: string;
  prompt: string;
  reportPath: string | null;
  outputPath: string | null;
  width: number;
  height: number;
  steps: number;
  seed: number;
  timeoutMs: number;
};

type ProbeReport = {
  ok: boolean;
  checkedAt: string;
  durationMs: number;
  comfyuiUrl: string;
  workflowPath: string;
  promptId: string | null;
  outputPath: string | null;
  image: {
    filename: string;
    subfolder: string;
    type: string;
    width: number;
    height: number;
    bytes: number;
  } | null;
  error: { code: string; message: string; retryable: boolean } | null;
};

type ComfyWorkflow = {
  apiPrompt: Record<string, ComfyNode>;
  defaults?: Record<string, unknown>;
};

type ComfyNode = {
  class_type: string;
  inputs: Record<string, unknown>;
};

type PromptSubmitResponse = {
  prompt_id?: unknown;
  node_errors?: unknown;
};

type HistoryResponse = Record<string, unknown>;

type HistoryItem = {
  status?: {
    completed?: unknown;
    status_str?: unknown;
    messages?: unknown;
  };
  outputs?: unknown;
};

type ComfyImageOutput = {
  filename: string;
  subfolder: string;
  type: string;
};

const defaultPrompt =
  "adult woman portrait, consistent character, oval face, hazel eyes, long auburn hair, natural daylight, realistic photo, high detail";

async function main() {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();
  const options = readOptions();
  let report: ProbeReport;

  try {
    const workflow = await readWorkflow(options.workflowPath);
    const prompt = buildPrompt(workflow, options);
    const submit = await postJson<PromptSubmitResponse>(options.url, "/prompt", {
      prompt,
      client_id: `idream-redcraft-comfyui-${randomUUID()}`,
    });
    const promptId = typeof submit.prompt_id === "string" ? submit.prompt_id : null;
    if (!promptId) {
      throw new ProbeError(
        "comfyui_prompt_rejected",
        `ComfyUI did not return prompt_id: ${JSON.stringify(submit.node_errors ?? submit)}`,
        false,
      );
    }

    const historyItem = await waitForHistory(options, promptId);
    const image = firstImageOutput(historyItem);
    if (!image) {
      throw new ProbeError("comfyui_missing_output", "ComfyUI history did not include an output image", false);
    }

    const bytes = await fetchComfyImage(options.url, image);
    assertGeneratedImageSanity(Buffer.from(bytes), `redcraft comfyui ${promptId}`);
    if (options.outputPath) {
      await mkdir(path.dirname(options.outputPath), { recursive: true });
      await writeFile(options.outputPath, bytes);
    }

    report = {
      ok: true,
      checkedAt,
      durationMs: Date.now() - startedAt,
      comfyuiUrl: options.url,
      workflowPath: options.workflowPath,
      promptId,
      outputPath: options.outputPath,
      image: {
        ...image,
        width: options.width,
        height: options.height,
        bytes: bytes.byteLength,
      },
      error: null,
    };
  } catch (error) {
    const probeError = toProbeError(error);
    report = {
      ok: false,
      checkedAt,
      durationMs: Date.now() - startedAt,
      comfyuiUrl: options.url,
      workflowPath: options.workflowPath,
      promptId: null,
      outputPath: options.outputPath,
      image: null,
      error: {
        code: probeError.code,
        message: probeError.message,
        retryable: probeError.retryable,
      },
    };
  }

  if (options.reportPath) {
    await mkdir(path.dirname(options.reportPath), { recursive: true });
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

function readOptions(): ProbeOptions {
  return {
    url: trimTrailingSlash(readArg("url") ?? process.env.COMFYUI_API_URL ?? "http://127.0.0.1:8191"),
    workflowPath: resolveWorkspacePath(
      readArg("workflow") ?? "packages/gen/workflows/redcraft-krea2-redmix3-txt2img.json",
    ),
    prompt: readArg("prompt") ?? defaultPrompt,
    reportPath: optionalResolvedPath(readArg("report")),
    outputPath: optionalResolvedPath(readArg("output")),
    width: numberArg("width", 256),
    height: numberArg("height", 384),
    steps: numberArg("steps", 2),
    seed: numberArg("seed", 123456789),
    timeoutMs: numberArg("timeout-ms", 10 * 60 * 1000),
  };
}

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function numberArg(name: string, fallback: number) {
  const value = readArg(name);
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function readWorkflow(workflowPath: string): Promise<ComfyWorkflow> {
  const parsed = JSON.parse(await readFile(workflowPath, "utf8")) as unknown;
  const workflow = asRecord(parsed);
  const apiPrompt = asRecord(workflow.apiPrompt);
  if (Object.keys(apiPrompt).length === 0) {
    throw new ProbeError("invalid_workflow", "Workflow is missing apiPrompt", false);
  }
  const nodes: Record<string, ComfyNode> = {};
  for (const [id, rawNode] of Object.entries(apiPrompt)) {
    const node = asRecord(rawNode);
    const classType = typeof node.class_type === "string" ? node.class_type : "";
    const inputs = asRecord(node.inputs);
    if (!classType || Object.keys(inputs).length === 0) {
      throw new ProbeError("invalid_workflow", `Workflow node ${id} is invalid`, false);
    }
    nodes[id] = { class_type: classType, inputs };
  }
  return { apiPrompt: nodes, defaults: asRecord(workflow.defaults) };
}

function buildPrompt(workflow: ComfyWorkflow, options: ProbeOptions) {
  const prompt = structuredClone(workflow.apiPrompt) as Record<string, ComfyNode>;
  setNodeInput(prompt, "4", "text", options.prompt);
  setNodeInput(prompt, "6", "width", options.width);
  setNodeInput(prompt, "6", "height", options.height);
  setNodeInput(prompt, "7", "steps", options.steps);
  setNodeInput(prompt, "7", "seed", options.seed);
  return prompt;
}

function setNodeInput(
  prompt: Record<string, ComfyNode>,
  nodeId: string,
  inputName: string,
  value: string | number,
) {
  const node = prompt[nodeId];
  if (!node) throw new ProbeError("invalid_workflow", `Workflow node ${nodeId} is missing`, false);
  node.inputs[inputName] = value;
}

async function waitForHistory(options: ProbeOptions, promptId: string): Promise<HistoryItem> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    await sleep(2_000);
    const history = await getJson<HistoryResponse>(options.url, `/history/${encodeURIComponent(promptId)}`);
    const item = asRecord(history[promptId]) as HistoryItem;
    const status = asRecord(item.status);
    if (status.completed === true) return item;
    if (status.status_str === "error") {
      throw new ProbeError("comfyui_execution_failed", JSON.stringify(status.messages ?? status), false);
    }
  }
  throw new ProbeError("comfyui_execution_timeout", "Timed out waiting for ComfyUI prompt", true);
}

function firstImageOutput(historyItem: HistoryItem): ComfyImageOutput | null {
  const outputs = asRecord(historyItem.outputs);
  for (const rawOutput of Object.values(outputs)) {
    const output = asRecord(rawOutput);
    const images = Array.isArray(output.images) ? output.images : [];
    for (const rawImage of images) {
      const image = asRecord(rawImage);
      const filename = typeof image.filename === "string" ? image.filename : "";
      const subfolder = typeof image.subfolder === "string" ? image.subfolder : "";
      const type = typeof image.type === "string" ? image.type : "output";
      if (filename) return { filename, subfolder, type };
    }
  }
  return null;
}

async function postJson<T>(baseUrl: string, pathname: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new ProbeError("comfyui_http_error", `ComfyUI returned HTTP ${response.status}`, true);
  }
  return json as T;
}

async function getJson<T>(baseUrl: string, pathname: string): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`);
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    throw new ProbeError("comfyui_http_error", `ComfyUI returned HTTP ${response.status}`, true);
  }
  return json as T;
}

async function fetchComfyImage(baseUrl: string, image: ComfyImageOutput) {
  const url = new URL(`${baseUrl}/view`);
  url.searchParams.set("filename", image.filename);
  url.searchParams.set("subfolder", image.subfolder);
  url.searchParams.set("type", image.type);
  const response = await fetch(url);
  if (!response.ok) {
    throw new ProbeError("comfyui_image_fetch_failed", `ComfyUI image fetch returned HTTP ${response.status}`, true);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resolveWorkspacePath(filePath: string) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot(), filePath);
}

function optionalResolvedPath(filePath: string | undefined) {
  return filePath ? resolveWorkspacePath(filePath) : null;
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (current.endsWith("idream")) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ProbeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProbeError";
  }
}

function toProbeError(error: unknown) {
  if (error instanceof ProbeError) return error;
  if (error instanceof Error) return new ProbeError("redcraft_comfyui_probe_failed", error.message, true);
  return new ProbeError("redcraft_comfyui_probe_failed", String(error), true);
}

main().catch((error: unknown) => {
  const probeError = toProbeError(error);
  process.stderr.write(`${probeError.code}: ${probeError.message}\n`);
  process.exitCode = 1;
});
