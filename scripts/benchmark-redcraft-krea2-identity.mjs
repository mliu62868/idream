#!/usr/bin/env node
// SPEC: submit the shipped RedCraft Identity graph with one explicit checkpoint
// and fixed inputs, then report wall time and the exact ComfyUI output.
// INTENT: this is the repeatable differential loop for resident-FP8 performance;
// it changes only node 1's model and runtime input slots, never product routing.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = readArgs(process.argv.slice(2));
const apiUrl = trimSlash(args.url ?? "http://127.0.0.1:8189");
const workflowPath = path.resolve(
  args.workflow ?? "packages/gen/workflows/redcraft-krea2-identity-edit.json",
);
const checkpoint = required(args, "model");
const reference = required(args, "reference");
const prompt = required(args, "prompt");
const negative = args.negative ?? "";
const seed = integer(args.seed ?? "486071801727172", "seed");
const timeoutMs = integer(args["timeout-ms"] ?? "600000", "timeout-ms");
const prefix = args.prefix ?? "idream_redcraft_krea2_identity_benchmark";

const descriptor = JSON.parse(await readFile(workflowPath, "utf8"));
const graph = structuredClone(descriptor.apiPrompt);
graph["1"].inputs.unet_name = checkpoint;
graph["5"].inputs.image = reference;
graph["9"].inputs.prompt = prompt;
graph["10"].inputs.prompt = negative;
graph["11"].inputs.seed = seed;
graph["13"].inputs.filename_prefix = prefix;

if (args.unload === "true") {
  await checkedFetch(`${apiUrl}/free`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ unload_models: true, free_memory: true }),
  });
}

const startedAt = new Date();
const started = performance.now();
const submitted = await checkedJson(`${apiUrl}/prompt`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt: graph }),
});
if (typeof submitted.prompt_id !== "string") {
  throw new Error(`ComfyUI returned no prompt_id: ${JSON.stringify(submitted)}`);
}

const history = await waitForHistory(apiUrl, submitted.prompt_id, timeoutMs);
const status = history.status?.status_str;
const completed = status === "success" && history.status?.completed === true;
const images = Object.values(history.outputs ?? {}).flatMap((output) =>
  Array.isArray(output.images) ? output.images : [],
);
const report = {
  ok: completed && images.length > 0,
  startedAt: startedAt.toISOString(),
  durationMs: Math.round(performance.now() - started),
  apiUrl,
  workflowKey: descriptor.workflowKey,
  workflowVersion: descriptor.version,
  checkpoint,
  reference,
  seed,
  steps: graph["11"].inputs.steps,
  refBoost: graph["8"].inputs.ref_boost,
  width: graph["7"].inputs.width,
  height: graph["7"].inputs.height,
  promptId: submitted.prompt_id,
  status,
  images,
};

if (args.report) {
  await writeFile(path.resolve(args.report), `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;

async function waitForHistory(base, promptId, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const payload = await checkedJson(`${base}/history/${promptId}`);
    if (payload[promptId]) return payload[promptId];
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`ComfyUI prompt ${promptId} timed out after ${timeout}ms`);
}

async function checkedJson(url, init) {
  return (await checkedFetch(url, init)).json();
}

async function checkedFetch(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? "GET"} ${url} returned HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

function readArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const [name, inline] = argument.slice(2).split("=", 2);
    values[name] = inline ?? argv[++index];
  }
  return values;
}

function required(values, name) {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function integer(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}
