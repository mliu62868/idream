import { isAbsolute, resolve } from "node:path";

export interface SidecarConfig {
  host: string;
  port: number;
  authToken: string;
  canonicalRoot: string;
  privateRoot: string;
  igrepCommand: string;
  igrepPluginUrl: string;
  providerApiKey: string;
  readyProvider: string;
  readyModel: string;
  readyBaseUrl: string;
  openRouterProviderOnly?: string[];
  maxSteps: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function tcpPort(raw: string | undefined): number {
  const value = positiveInteger(raw, 3101, "CHAT_AGENT_PORT");
  if (value > 65_535) throw new Error("CHAT_AGENT_PORT must be at most 65535");
  return value;
}

function absolutePath(value: string, name: string): string {
  const path = resolve(value);
  if (!isAbsolute(path)) throw new Error(`${name} must resolve to an absolute path`);
  return path;
}

export function loadSidecarConfig(env: NodeJS.ProcessEnv = process.env): SidecarConfig {
  const providerOnly = env.DSH_OPENROUTER_PROVIDER_ONLY
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const readyProvider = required(env, "DSH_READY_PROVIDER");
  if (readyProvider === "openrouter" && !providerOnly?.length) {
    throw new Error("DSH_OPENROUTER_PROVIDER_ONLY is required for OpenRouter");
  }
  return {
    host: env.CHAT_AGENT_HOST?.trim() || "127.0.0.1",
    port: tcpPort(env.CHAT_AGENT_PORT),
    // INVARIANT: Chat and sidecar authenticate one bridge with one shared secret.
    authToken: required(env, "DSH_AGENT_TOKEN"),
    canonicalRoot: absolutePath(
      env.DSH_IGREP_CANONICAL_ROOT ?? "data/chat-agent-memory",
      "DSH_IGREP_CANONICAL_ROOT",
    ),
    privateRoot: absolutePath(
      env.DSH_IGREP_PRIVATE_ROOT ?? "data/chat-agent-private",
      "DSH_IGREP_PRIVATE_ROOT",
    ),
    igrepCommand: env.DSH_IGREP_COMMAND?.trim() || "igrep",
    igrepPluginUrl: required(env, "DSH_IGREP_PLUGIN_URL"),
    providerApiKey: required(env, "DSH_PROVIDER_API_KEY"),
    readyProvider,
    readyModel: required(env, "DSH_READY_MODEL"),
    readyBaseUrl: required(env, "DSH_READY_BASE_URL"),
    ...(providerOnly?.length ? { openRouterProviderOnly: providerOnly } : {}),
    maxSteps: positiveInteger(env.DSH_MAX_STEPS, 8, "DSH_MAX_STEPS"),
  };
}
