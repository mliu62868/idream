#!/usr/bin/env node
import { lstat, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function parseArgs(argv) {
  if (argv.length === 0) return { apply: false };
  if (argv.length === 1 && argv[0] === "--apply") return { apply: true };
  throw new Error("usage: purge-legacy-chat-session-traces [--apply]");
}

function traceRoot(environment) {
  const configured = environment.CHAT_FS_ROOT?.trim() || "./data/chat";
  const chatRoot = path.resolve(
    path.isAbsolute(configured)
      ? configured
      : path.join(REPO_ROOT, "packages/chat", configured),
  );
  if (
    chatRoot === path.parse(chatRoot).root ||
    chatRoot === path.resolve(homedir()) ||
    chatRoot === REPO_ROOT
  ) {
    throw new Error("CHAT_FS_ROOT is too broad");
  }
  return path.join(chatRoot, "sessions");
}

async function inventory(directory) {
  const root = await lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!root) return { files: 0, bytes: 0 };
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error("legacy session trace root must be a real directory");
  }
  let files = 0;
  let bytes = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else {
        files += 1;
        if (entry.isFile()) bytes += (await lstat(child)).size;
      }
    }
  }
  return { files, bytes };
}

export async function purgeLegacyChatSessionTraces({
  apply,
  environment = process.env,
}) {
  const directory = traceRoot(environment);
  const evidence = await inventory(directory);
  if (apply && evidence.files > 0) {
    await rm(directory, { recursive: true, force: true });
  }
  return {
    schemaVersion: 1,
    ok: true,
    mode: apply ? "apply" : "check",
    ...evidence,
  };
}

async function main() {
  try {
    const report = await purgeLegacyChatSessionTraces({
      ...parseArgs(process.argv.slice(2)),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "trace purge failed"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
