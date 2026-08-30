#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtimeKeys = [
  "DSH_BOOTSTRAP_STATE_PATH",
  "DSH_IGREP_CANONICAL_ROOT",
  "DSH_IGREP_COMMAND",
  "DSH_IGREP_PLUGIN_URL",
  "DSH_IGREP_PRIVATE_ROOT",
  "DSH_OPENROUTER_PROVIDER_ONLY",
  "DSH_MAX_STEPS",
  "DSH_MAX_NORMAL_AGENTS",
  "DSH_MAX_PRIVATE_AGENTS",
  "IGREP_LLM_API_KEY",
  "IGREP_LLM_MODEL",
  "IGREP_LLM_URL",
];
const retiredKeys = new Set([
  "DSH_AGENT_ENABLED",
  "DSH_AGENT_TOKEN",
  "DSH_AGENT_URL",
  "DSH_PROFILE_NORMAL",
  "DSH_PROFILE_PRIVATE",
  "CHAT_COMPANION_RUNTIME",
  "CHAT_MEMORY_BACKEND",
  "CHAT_COMPANION_DSH_ROLLOUT_BPS",
  "CHAT_COMPANION_DSH_ROLLOUT_SALT",
  "CHAT_COMPANION_DSH_SHADOW_ENABLED",
  "DSH_PROVIDER_API_KEY",
  "DSH_READY_BASE_URL",
  "DSH_READY_MODEL",
  "DSH_READY_PROVIDER",
]);

function parseEnv(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function runCutover(repoRoot, options = {}) {
  const legacyPackage = path.join(repoRoot, "packages/chat-agent");
  const legacyEnv = path.join(legacyPackage, ".env");
  const chatEnv = path.join(repoRoot, "packages/chat/.env");
  const quarantineRoot = path.join(repoRoot, ".data/quarantine");
  if ((await exists(legacyPackage)) && !(await exists(legacyEnv))) {
    throw new Error("legacy packages/chat-agent/.env is required for local cutover");
  }
  if (!(await exists(chatEnv))) {
    throw new Error("packages/chat/.env is required for local cutover");
  }

  const chatText = await readFile(chatEnv, "utf8");
  const legacyValues = await exists(legacyEnv)
    ? parseEnv(await readFile(legacyEnv, "utf8"))
    : new Map();
  const chatValues = parseEnv(chatText);
  const additions = [];
  for (const key of runtimeKeys) {
    if (chatValues.has(key)) continue;
    const value = legacyValues.get(key);
    if (value !== undefined) additions.push(`${key}=${value}`);
  }
  const retained = chatText
    .split(/\r?\n/u)
    .filter((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line);
      return !match || !retiredKeys.has(match[1]);
    })
    .join("\n")
    .trimEnd();
  const next = additions.length > 0
    ? `${retained}\n\n# Embedded DSH/igrep runtime.\n${additions.join("\n")}\n`
    : `${retained}\n`;
  if (next !== chatText) {
    const temporary = `${chatEnv}.cutover-${(options.nonce ?? randomUUID)()}`;
    await writeFile(temporary, next, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, chatEnv);
  }

  let quarantine = null;
  if (await exists(legacyPackage)) {
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    await chmod(quarantineRoot, 0o700);
    quarantine = path.join(
      quarantineRoot,
      `chat-agent-package-${(options.now ?? (() => new Date()))().toISOString().replaceAll(":", "-")}`,
    );
    await rename(legacyPackage, quarantine);
  }
  return {
    migratedKeys: additions.map((line) => line.slice(0, line.indexOf("="))),
    retiredKeys: [...retiredKeys].filter((key) => chatValues.has(key)),
    quarantine,
  };
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === scriptPath) {
  const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  process.stdout.write(`${JSON.stringify(await runCutover(repoRoot))}\n`);
}
