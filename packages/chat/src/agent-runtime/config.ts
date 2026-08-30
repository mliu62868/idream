import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  isOpenRouterBaseUrl,
  resolveChatModelProfile,
  type ChatModelProfile,
} from "@idream/shared";

export interface AgentRuntimeConfig {
  canonicalRoot: string;
  privateRoot: string;
  igrepCommand: string;
  igrepPluginUrl: string;
  igrepLlm: IgrepLlmConfig;
  bootstrapStatePath: string;
  modelProfile: ChatModelProfile;
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
 * INVARIANT: every official igrep plugin or CLI child inherits Chat's
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
  if (url.username || url.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  if (url.search) {
    throw new Error(`${name} must not contain a query`);
  }
  if (url.hash) {
    throw new Error(`${name} must not contain a fragment`);
  }
  return url.toString().replace(/\/$/u, "");
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
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

export function loadAgentRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntimeConfig {
  const providerOnly = env.DSH_OPENROUTER_PROVIDER_ONLY
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const modelProfile = resolveChatModelProfile(env);
  if (modelProfile.adapter !== "openai-compatible-v1") {
    throw new Error("CHAT_MODEL_PROVIDER must select the OpenAI-compatible runtime");
  }
  if (!modelProfile.apiKey.trim()) throw new Error("CHAT_MODEL_API_KEY is required");
  const openRouter = isOpenRouterBaseUrl(modelProfile.baseUrl);
  if (openRouter && !providerOnly?.length) {
    throw new Error("DSH_OPENROUTER_PROVIDER_ONLY is required for OpenRouter");
  }
  const canonicalRoot = absolutePath(
    env.DSH_IGREP_CANONICAL_ROOT ?? "data/companion-memory",
    "DSH_IGREP_CANONICAL_ROOT",
  );
  const privateRoot = absolutePath(
    env.DSH_IGREP_PRIVATE_ROOT ?? "data/companion-private",
    "DSH_IGREP_PRIVATE_ROOT",
  );
  if (
    pathsOverlap(canonicalRoot, privateRoot) ||
    pathsOverlap(privateRoot, canonicalRoot)
  ) {
    throw new Error(
      "DSH igrep workspace roots must be pairwise disjoint",
    );
  }
  return {
    canonicalRoot,
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
    modelProfile,
    ...(openRouter && providerOnly?.length ? { openRouterProviderOnly: providerOnly } : {}),
    maxSteps: positiveInteger(env.DSH_MAX_STEPS, 8, "DSH_MAX_STEPS"),
    maxConcurrentAgents: {
      normal: positiveInteger(env.DSH_MAX_NORMAL_AGENTS, 4, "DSH_MAX_NORMAL_AGENTS"),
      private: positiveInteger(env.DSH_MAX_PRIVATE_AGENTS, 4, "DSH_MAX_PRIVATE_AGENTS"),
    },
  };
}
