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
  igrepLlm: IgrepLlmConfig;
  igrepEnvironment: IgrepEnvironment;
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

// Profile extraction/reconciliation emits a strict operation protocol. Creative
// sampling caused invalid empty-profile operations even after igrep's repairs.
// These settings are independent of the companion's conversational sampling.
export const IGREP_MAINTENANCE_SAMPLING = Object.freeze({
  temperature: 0,
  top_p: 1,
  presence_penalty: 0,
});

export type IgrepEnvironment = Record<string, string | undefined>;
export type IgrepEndpoint = IgrepLlmConfig;
export const IGREP_WEB_PROVIDERS = ["searxng", "tavily", "serper", "exa"] as const;
export type IgrepWebProvider = typeof IGREP_WEB_PROVIDERS[number];
export interface IgrepWebConfig { provider: IgrepWebProvider; url?: string; apiKey: string }
export interface IgrepChildConfig {
  llm: IgrepEndpoint | null;
  embedding: (IgrepEndpoint & { dimensions: number }) | null;
  rerank: (IgrepEndpoint & { format: "omlx" | "tei" }) | null;
  web?: IgrepWebConfig | null;
}

const sampling = JSON.stringify(IGREP_MAINTENANCE_SAMPLING);

/** Route isolation, not a claim that igrep stops reading ~/.igreprc/.env. */
export function createIgrepEnvironment(config: IgrepChildConfig, ambient: Readonly<Record<string, string | undefined>>): IgrepEnvironment {
  if (config.embedding && (!Number.isSafeInteger(config.embedding.dimensions) || config.embedding.dimensions <= 0)) throw new Error("invalid igrep embedding dimensions");
  if (config.rerank && config.rerank.format !== "omlx" && config.rerank.format !== "tei") throw new Error("invalid igrep rerank format");
  const env: IgrepEnvironment = {};
  // Keep only process-launch necessities; never inherit application/provider credentials.
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL"]) {
    if (ambient[name] !== undefined) env[name] = ambient[name];
  }
  const pin = (prefix: string, endpoint: IgrepEndpoint | null) => {
    if (endpoint) {
      const url = new URL(endpoint.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !endpoint.model.trim()) {
        throw new Error("invalid igrep service endpoint");
      }
    }
    env[`IGREP_${prefix}_URL`] = endpoint?.url ?? "";
    env[`IGREP_${prefix}_MODEL`] = endpoint?.model ?? "";
    env[`IGREP_${prefix}_API_KEY`] = endpoint?.apiKey ?? "";
  };
  // Maintain uses ASK; Ultra's local selector has a third independent route.
  for (const prefix of ["LLM", "ASK_LLM", "LLM_FINAL_SORT"]) {
    pin(prefix, config.llm);
    env[`IGREP_${prefix}_EXTRA_BODY`] = sampling;
  }
  pin("EMBEDDING", config.embedding);
  delete env.IGREP_EMBEDDING_MODEL;
  env.IGREP_EMBED_MODEL = config.embedding?.model ?? "";
  env.IGREP_EMBED_DIM = String(config.embedding?.dimensions ?? 1024);
  pin("RERANK", config.rerank);
  env.IGREP_RERANK_API_FORMAT = config.rerank?.format ?? "omlx";
  // Empty is an explicit highest-priority value, not an omitted variable.
  for (const name of [
    "API_KEY", "QMD_MODEL_NAME", "FINAL_RERANK_MODEL", "RERANK_INSTRUCTION", "RERANK_TASK",
    "EMBED_QUERY_PREFIX", "EMBED_DOC_PREFIX", "SYSTEM_PROMPT_EXTRA", "LLM_GATEWAY_DIALECTS",
    "SPARSE_URL", "SPARSE_MODEL", "SPARSE_API_KEY", "SPARSE_TOKENIZER_PATH",
    "OCR_URL", "OCR_MODEL", "OCR_API_KEY", "DECISION_URL", "DECISION_MODEL", "DECISION_API_KEY",
    "VLM_URL", "VLM_MODEL", "VLM_API_KEY", "VLM_EMOJI_MODEL", "ISEARCH_DEFAULT_SOURCE",
    "WEB_SEARCH_PROVIDER", "WEB_SEARCH_URL", "WEB_SEARCH_API_KEY", "SEARXNG_URL", "SEARXNG_API_KEY", "SEARXNG_ENGINES",
    "TAVILY_API_KEY", "SERPER_API_KEY", "EXA_API_KEY", "CACHE_REDIS_DIR", "CACHE_BACKEND_SOURCE",
  ]) env[`IGREP_${name}`] = "";
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "REDIS_URL", "TAVILY_API_KEY", "SERPER_API_KEY", "EXA_API_KEY"]) env[name] = "";
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[name] = "";
  env.NO_PROXY = env.no_proxy = "*";
  Object.assign(env, {
    IGREP_LLM_API_FORMAT: "chat", IGREP_LLM_CONTEXT_WINDOW_TOKENS: "0", IGREP_ASK_LLM_CONTEXT_WINDOW_TOKENS: "0",
    IGREP_NO_CACHE: "1", IGREP_RERANK_CACHE: "0", IGREP_FAST_SPARSE_EXPANSION: "0",
    IGREP_MEM_DECISION_JUDGE: "0", IGREP_IMAGE_AUGMENTATION_MODE: "off",
  });
  if (config.web) {
    const {provider, url, apiKey} = config.web;
    if (!IGREP_WEB_PROVIDERS.includes(provider) || /[\x00-\x20\x7f]/u.test(apiKey)) throw new Error("invalid igrep web configuration");
    if (provider === "searxng") {
      env.IGREP_SEARXNG_URL = httpUrl({PI_IGREP_WEB_URL:url}, "PI_IGREP_WEB_URL");
      env.IGREP_SEARXNG_API_KEY = apiKey;
    } else {
      if (url || !apiKey) throw new Error("igrep cloud web providers require a key and use their fixed endpoint");
      env[`IGREP_${provider.toUpperCase()}_API_KEY`] = apiKey;
    }
    env.IGREP_WEB_SEARCH_PROVIDER = provider;
  }
  // Fast web is one bounded provider round. Do not inherit private overrides.
  env.IGREP_WEB_FAST_BUDGET_S = "12";
  env.IGREP_WEB_PROVIDER_TIMEOUT_S = "10";
  env.IGREP_WEB_LLM_TIMEOUT_S = "10";
  return env;
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function httpUrl(env: Readonly<Record<string, string | undefined>>, name: string): string {
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
  const providerOnly = env.PI_OPENROUTER_PROVIDER_ONLY
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
    throw new Error("PI_OPENROUTER_PROVIDER_ONLY is required for OpenRouter");
  }
  const canonicalRoot = absolutePath(
    env.PI_IGREP_CANONICAL_ROOT ?? "data/companion-memory",
    "PI_IGREP_CANONICAL_ROOT",
  );
  const privateRoot = absolutePath(
    env.PI_IGREP_PRIVATE_ROOT ?? "data/companion-private",
    "PI_IGREP_PRIVATE_ROOT",
  );
  if (
    pathsOverlap(canonicalRoot, privateRoot) ||
    pathsOverlap(privateRoot, canonicalRoot)
  ) {
    throw new Error(
      "Pi igrep workspace roots must be pairwise disjoint",
    );
  }
  const igrepLlm = {
    url: httpUrl(env, "IGREP_LLM_URL"),
    model: required(env, "IGREP_LLM_MODEL"),
    apiKey: required(env, "IGREP_LLM_API_KEY"),
  };
  const optionalEndpoint = (prefix: string, modelName = `IGREP_${prefix}_MODEL`): IgrepLlmConfig | null => {
    const names = [`IGREP_${prefix}_URL`, modelName, `IGREP_${prefix}_API_KEY`];
    if (!names.some(name => env[name]?.trim())) return null;
    return { url: httpUrl(env, names[0]!), model: required(env, modelName), apiKey: required(env, names[2]!) };
  };
  const embedding = optionalEndpoint("EMBEDDING", "IGREP_EMBED_MODEL");
  const rerank = optionalEndpoint("RERANK");
  const rerankFormat = env.IGREP_RERANK_API_FORMAT?.trim() || "omlx";
  if (rerank && rerankFormat !== "omlx" && rerankFormat !== "tei") throw new Error("IGREP_RERANK_API_FORMAT must be omlx or tei");
  const webProvider = env.PI_IGREP_WEB_PROVIDER?.trim();
  const webUrl = env.PI_IGREP_WEB_URL?.trim();
  const webKey = env.PI_IGREP_WEB_API_KEY?.trim() ?? "";
  if (!webProvider && (webUrl || webKey)) throw new Error("PI_IGREP_WEB_PROVIDER is required when web URL or key is configured");
  if (webProvider && !IGREP_WEB_PROVIDERS.includes(webProvider as IgrepWebProvider)) throw new Error("PI_IGREP_WEB_PROVIDER must be searxng, tavily, serper or exa");
  const web: IgrepWebConfig | null = webProvider ? {
    provider: webProvider as IgrepWebProvider,
    ...(webProvider === "searxng" ? {url:httpUrl(env,"PI_IGREP_WEB_URL")} : webUrl ? {url:webUrl} : {}),
    apiKey: webProvider === "searxng" ? webKey : required(env,"PI_IGREP_WEB_API_KEY"),
  } : null;
  const igrepEnvironment = createIgrepEnvironment({
    llm: igrepLlm,
    web,
    embedding: embedding ? { ...embedding, dimensions: positiveInteger(env.IGREP_EMBED_DIM, 1024, "IGREP_EMBED_DIM") } : null,
    rerank: rerank ? { ...rerank, format: rerankFormat as "omlx" | "tei" } : null,
  }, env);
  return {
    canonicalRoot,
    privateRoot,
    igrepCommand: env.PI_IGREP_COMMAND?.trim() || "igrep",
    igrepLlm,
    igrepEnvironment,
    modelProfile,
    ...(openRouter && providerOnly?.length ? { openRouterProviderOnly: providerOnly } : {}),
    maxSteps: positiveInteger(env.PI_MAX_STEPS, 8, "PI_MAX_STEPS"),
    maxConcurrentAgents: {
      normal: positiveInteger(env.PI_MAX_NORMAL_AGENTS, 4, "PI_MAX_NORMAL_AGENTS"),
      private: positiveInteger(env.PI_MAX_PRIVATE_AGENTS, 4, "PI_MAX_PRIVATE_AGENTS"),
    },
  };
}
