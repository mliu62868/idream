#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const defaultModelId = "Kokoro-82M-bf16";
const modelId = readArg("model") ?? process.env.PIPELINE_VOICE_MODEL_DEFAULT ?? defaultModelId;
const failIfChanged = hasFlag("fail-if-changed");
const modelDir = resolveKokoroModelDir(modelId);

if (!modelDir) {
  fail(
    `Kokoro model directory not found for ${modelId}. Expected it under ${modelRoot()} or set OMLX_KOKORO_MODEL_DIR.`,
  );
}

const changes = [];
ensureConfig(modelDir, changes);
ensureModelSafetensors(modelDir, changes);

if (changes.length > 0) {
  process.stdout.write(
    [
      `Prepared oMLX Kokoro model at ${modelDir}:`,
      ...changes.map((change) => `- ${change}`),
      "Restart the oMLX server once so its model cache rediscovers Kokoro as audio_tts.",
    ].join("\n") + "\n",
  );
  if (failIfChanged) process.exitCode = 2;
} else {
  process.stdout.write(`oMLX Kokoro model is ready at ${modelDir}\n`);
}

function readArg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function resolveKokoroModelDir(rawModelId) {
  const explicit = process.env.OMLX_KOKORO_MODEL_DIR;
  if (explicit) return existsSync(explicit) ? explicit : undefined;

  const root = modelRoot();
  const modelName = path.basename(rawModelId);
  const candidates = [
    path.join(root, rawModelId),
    path.join(root, ...rawModelId.split("/")),
    path.join(root, "mlx-community", modelName),
    path.join(root, modelName),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "config.json"))) return candidate;
  }

  return findModelDir(root, modelName, 3);
}

function modelRoot() {
  return (
    process.env.OMLX_MODEL_DIR ??
    process.env.OMLX_MODELS_DIR ??
    path.join(os.homedir(), ".omlx", "models")
  );
}

function findModelDir(root, modelName, maxDepth) {
  if (maxDepth < 0 || !existsSync(root)) return undefined;
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (entry.name === modelName && existsSync(path.join(candidate, "config.json"))) {
      return candidate;
    }
    const nested = findModelDir(candidate, modelName, maxDepth - 1);
    if (nested) return nested;
  }
  return undefined;
}

function ensureConfig(dir, changes) {
  const configPath = path.join(dir, "config.json");
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    fail(`Failed to read Kokoro config at ${configPath}: ${errorMessage(error)}`);
  }

  if (config.model_type === "kokoro") return;
  backupOnce(configPath, "config.json.bak-before-idream-kokoro-preflight");
  config.model_type = "kokoro";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  changes.push('set config.json model_type to "kokoro"');
}

function ensureModelSafetensors(dir, changes) {
  const canonical = path.join(dir, "model.safetensors");

  const canonicalStat = lstatIfExists(canonical);
  if (canonicalStat) {
    if (canonicalStat.isFile()) return;
    if (canonicalStat.isSymbolicLink()) {
      const targetPath = path.resolve(dir, readlinkSync(canonical));
      const targetStat = lstatIfExists(targetPath);
      if (targetStat?.isFile() && targetPath.endsWith(".safetensors")) return;
      unlinkSync(canonical);
      changes.push("removed stale model.safetensors symlink");
    } else {
      fail(`${canonical} exists but is not a file or symlink`);
    }
  }

  if (lstatIfExists(canonical)) {
    fail(`${canonical} exists but is not a file or symlink`);
  }

  const source = findKokoroWeights(dir);
  if (!source) {
    fail(`No Kokoro safetensors weights found in ${dir}`);
  }

  symlinkSync(path.basename(source), canonical);
  changes.push(`created model.safetensors -> ${path.basename(source)}`);
}

function findKokoroWeights(dir) {
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".safetensors") && name !== "model.safetensors");
  const kokoroWeights = files.find((name) => name.toLowerCase().startsWith("kokoro"));
  if (kokoroWeights) return path.join(dir, kokoroWeights);
  return files.length === 1 ? path.join(dir, files[0]) : undefined;
}

function lstatIfExists(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function backupOnce(filePath, backupName) {
  const backupPath = path.join(path.dirname(filePath), backupName);
  if (!existsSync(backupPath)) {
    writeFileSync(backupPath, readFileSync(filePath));
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
