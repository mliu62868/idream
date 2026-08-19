import { isAbsolute, relative, resolve, sep } from "node:path";

export interface SidecarConfig {
  host: string;
  port: number;
  authToken: string;
  canonicalRoot: string;
  shadowRoot: string;
  privateRoot: string;
  igrepCommand: string;
  igrepPluginUrl: string;
  igrepLlm: IgrepLlmConfig;
  bootstrapStatePath: string;
  providerApiKey: string;
  readyProvider: string;
  readyModel: string;
  readyBaseUrl: string;
  openRouterProviderOnly?: string[];
  maxSteps: number;
  maxConcurrentAgents: { normal: number; private: number };
}

export interface IgrepLlmConfig {
  url: string;
  model: string;
  apiKey: string;
}

/**
 * INVARIANT: every official igrep plugin or CLI child inherits the sidecar's
 * validated maintenance model, never a user's ~/.igreprc defaults.
 */
export function bindIgrepLlmEnvironment(
  config: IgrepLlmConfig,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  environment.IGREP_LLM_URL = config.url;
  environment.IGREP_LLM_MODEL = config.model;
  environment.IGREP_LLM_API_KEY = config.apiKey;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function httpUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }
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

function loopbackHost(raw: string | undefined): string {
  const host = raw?.trim() || "127.0.0.1";
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host.toLowerCase())) {
    throw new Error("CHAT_AGENT_HOST must be a loopback host");
  }
  return host;
}

function absolutePath(value: string, name: string): string {
  const path = resolve(value);
  if (!isAbsolute(path)) throw new Error(`${name} must resolve to an absolute path`);
  return path;
}

function pathsOverlap(left: string, right: string): boolean {
  const path = relative(left, right);
  return path === "" || (
    !path.startsWith(`..${sep}`) &&
    path !== ".." &&
    !path.startsWith(sep)
  );
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
  const canonicalRoot = absolutePath(
    env.DSH_IGREP_CANONICAL_ROOT ?? "data/chat-agent-memory",
    "DSH_IGREP_CANONICAL_ROOT",
  );
  const privateRoot = absolutePath(
    env.DSH_IGREP_PRIVATE_ROOT ?? "data/chat-agent-private",
    "DSH_IGREP_PRIVATE_ROOT",
  );
  const shadowRoot = absolutePath(
    env.DSH_IGREP_SHADOW_ROOT ?? "data/chat-agent-shadow",
    "DSH_IGREP_SHADOW_ROOT",
  );
  if (
    pathsOverlap(canonicalRoot, privateRoot) ||
    pathsOverlap(privateRoot, canonicalRoot) ||
    pathsOverlap(canonicalRoot, shadowRoot) ||
    pathsOverlap(shadowRoot, canonicalRoot) ||
    pathsOverlap(privateRoot, shadowRoot) ||
    pathsOverlap(shadowRoot, privateRoot)
  ) {
    throw new Error(
      "DSH igrep workspace roots must be pairwise disjoint",
    );
  }
  return {
    host: loopbackHost(env.CHAT_AGENT_HOST),
    port: tcpPort(env.CHAT_AGENT_PORT),
    // INVARIANT: Chat and sidecar authenticate one bridge with one shared secret.
    authToken: required(env, "DSH_AGENT_TOKEN"),
    canonicalRoot,
    shadowRoot,
    privateRoot,
    igrepCommand: env.DSH_IGREP_COMMAND?.trim() || "igrep",
    igrepPluginUrl: required(env, "DSH_IGREP_PLUGIN_URL"),
    igrepLlm: {
      url: httpUrl(env, "IGREP_LLM_URL"),
      model: required(env, "IGREP_LLM_MODEL"),
      apiKey: required(env, "IGREP_LLM_API_KEY"),
    },
    bootstrapStatePath: absolutePath(
      required(env, "DSH_BOOTSTRAP_STATE_PATH"),
      "DSH_BOOTSTRAP_STATE_PATH",
    ),
    providerApiKey: required(env, "DSH_PROVIDER_API_KEY"),
    readyProvider,
    readyModel: required(env, "DSH_READY_MODEL"),
    readyBaseUrl: required(env, "DSH_READY_BASE_URL"),
    ...(providerOnly?.length ? { openRouterProviderOnly: providerOnly } : {}),
    maxSteps: positiveInteger(env.DSH_MAX_STEPS, 8, "DSH_MAX_STEPS"),
    maxConcurrentAgents: {
      normal: positiveInteger(env.DSH_MAX_NORMAL_AGENTS, 4, "DSH_MAX_NORMAL_AGENTS"),
      private: positiveInteger(env.DSH_MAX_PRIVATE_AGENTS, 4, "DSH_MAX_PRIVATE_AGENTS"),
    },
  };
}
