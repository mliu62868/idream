#!/usr/bin/env node
// SPEC: compare the shipped MiniMax H3 graph with and without SolAttn while
// holding the checkpoint, source image, prompt, seed, envelope, and runner fixed.
// INTENT: a separate H3 process is an isolation boundary, not proof of speed;
// this harness produces the matched runtime evidence required for promotion.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const args = readArgs(process.argv.slice(2));
const apiUrl = trimSlash(args.url ?? "http://127.0.0.1:8190");
const workflowPath = path.resolve(
  args.workflow ?? "packages/gen/workflows/minimax-h3-redcraft-i2v.json",
);
const referencePath = path.resolve(required(args, "reference"));
const prompt = required(args, "prompt");
const seed = integer(args.seed ?? "1573094933", "seed");
const timeoutMs = integer(args["timeout-ms"] ?? "1200000", "timeout-ms");
const useSolAttn = boolean(args.sol ?? "true", "sol");
const verbose = boolean(args.verbose ?? "false", "verbose");
const prefix =
  args.prefix ?? `idream_minimax_h3_${useSolAttn ? "solattn" : "exact"}`;

const descriptor = JSON.parse(await readFile(workflowPath, "utf8"));
const graph = structuredClone(descriptor.apiPrompt);
const uploaded = await uploadInput(apiUrl, referencePath);
graph["16"].inputs.image = uploaded;
graph["6"].inputs.prompt = prompt;
graph["7"].inputs.noise_seed = seed;
graph["15"].inputs.filename_prefix = prefix;
graph["17"].inputs.verbose = verbose;
if (!useSolAttn) graph["2"].inputs.model = ["1", 0];

if (boolean(args.unload ?? "false", "unload")) {
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
const videos = Object.values(history.outputs ?? {}).flatMap((output) =>
  Array.isArray(output.images) ? output.images : [],
);
const report = {
  ok: status === "success" && history.status?.completed === true && videos.length > 0,
  startedAt: startedAt.toISOString(),
  durationMs: Math.round(performance.now() - started),
  apiUrl,
  workflowKey: descriptor.workflowKey,
  workflowVersion: descriptor.version,
  useSolAttn,
  solAttn: useSolAttn ? graph["17"].inputs : null,
  checkpoint: graph["1"].inputs.unet_name,
  referencePath,
  uploaded,
  seed,
  steps: graph["9"].inputs.steps,
  width: graph["6"].inputs.width,
  height: graph["6"].inputs.height,
  length: graph["6"].inputs.length,
  promptId: submitted.prompt_id,
  status,
  videos,
};

if (args.report) {
  await writeFile(path.resolve(args.report), `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;

async function uploadInput(base, filePath) {
  const form = new FormData();
  const body = await readFile(filePath);
  form.append("image", new Blob([body]), path.basename(filePath));
  form.append("type", "input");
  form.append("overwrite", "true");
  const uploaded = await checkedJson(`${base}/upload/image`, {
    method: "POST",
    body: form,
  });
  if (typeof uploaded.name !== "string") {
    throw new Error(`ComfyUI returned no uploaded image name: ${JSON.stringify(uploaded)}`);
  }
  return uploaded.subfolder
    ? `${uploaded.subfolder}/${uploaded.name}`
    : uploaded.name;
}

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
  for (let index = 0; index < argv.length; index++) {
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

function boolean(value, name) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false`);
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}
