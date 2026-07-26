#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceAudio = requiredPath("--audio");
const sourceManifest = requiredPath("--manifest");
const outputDirectory = resolvePath(
  readArg("--output-dir") ?? ".data/fish-audio/system",
);
const targetAudio = path.join(outputDirectory, "female-reference.wav");
const targetManifest = path.join(outputDirectory, "female-reference.json");

const [audio, manifestText] = await Promise.all([
  readFile(sourceAudio),
  readFile(sourceManifest, "utf8"),
]);
validateWav(audio);
const source = parseManifest(manifestText);

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await Promise.all([
  assertMissing(targetAudio),
  assertMissing(targetManifest),
]);

const suffix = randomUUID();
const temporaryAudio = path.join(outputDirectory, `.female-reference.${suffix}.wav`);
const temporaryManifest = path.join(
  outputDirectory,
  `.female-reference.${suffix}.json`,
);
const manifest = {
  format: "idream_fish_audio_system_reference_v1",
  model: "fish-audio-s2-pro-8bit",
  language: source.language,
  ref_text: source.refText,
  source_filename: path.basename(sourceAudio),
  source_sha256: createHash("sha256").update(audio).digest("hex"),
};

try {
  await copyFile(sourceAudio, temporaryAudio);
  await chmod(temporaryAudio, 0o600);
  await writeFile(
    temporaryManifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await rename(temporaryAudio, targetAudio);
  await rename(temporaryManifest, targetManifest);
} finally {
  await Promise.all([
    unlink(temporaryAudio).catch(() => undefined),
    unlink(temporaryManifest).catch(() => undefined),
  ]);
}

process.stdout.write(`${JSON.stringify({
  audio: targetAudio,
  manifest: targetManifest,
  bytes: audio.byteLength,
  sha256: manifest.source_sha256,
})}\n`);

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredPath(name) {
  const value = readArg(name);
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return resolvePath(value);
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function validateWav(audio) {
  if (
    audio.byteLength < 1_024 ||
    audio.byteLength > 15 * 1024 * 1024 ||
    audio.subarray(0, 4).toString("ascii") !== "RIFF" ||
    audio.subarray(8, 12).toString("ascii") !== "WAVE"
  ) {
    throw new Error("System voice reference must be a valid 1 KB to 15 MB WAV");
  }
}

function parseManifest(value) {
  let raw;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("System voice source manifest must be valid JSON");
  }
  const refText =
    raw && typeof raw === "object" && typeof raw.ref_text === "string"
      ? raw.ref_text.trim()
      : "";
  if (refText.length < 3 || refText.length > 2_000) {
    throw new Error("System voice source manifest requires ref_text");
  }
  const language =
    typeof raw.language === "string" && raw.language.trim()
      ? raw.language.trim()
      : "auto";
  return { language, refText };
}

async function assertMissing(filePath) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite existing system voice asset: ${filePath}`);
}
