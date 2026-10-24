import { createHash } from "node:crypto";
import { COMPANION_PI_VERSION, COMPANION_IGREP_VERSION } from "@idream/shared/chat/companion-runtime";
import { stableJson } from "../stable-json";
import { IGREP_MAINTENANCE_SAMPLING } from "./config";

export const COMPANION_CORE_PACKAGES = ["@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord"] as const;
export const COMPANION_COMPACTION_CONFIG = Object.freeze({ thresholdRatio: 0.85, headroomTokens: 512, retainRatio: 0.25, maxTokens: 1024 });
export const FORBIDDEN_COMPANION_EXECUTION_SERVICES = ["shell", "fs", "filesystem", "subagent", "goal"] as const;
export type CompanionCompositionMode = "normal" | "private";
export interface CompanionCompositionAuthority {
  maxSteps: number;
  igrepLlm: { url: string; model: string };
  igrepRoutes?: Readonly<Record<string, unknown>>;
}
export interface CompanionCompositionPlan {
  readonly mode: CompanionCompositionMode;
  readonly normalizedIgrepConfig: Readonly<Record<string, unknown>>;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly digest: string;
}
export function companionIgrepConfig(mode: CompanionCompositionMode, command: string, env: Readonly<Record<string, string | undefined>> = {}): Record<string, unknown> {
  return { command, memory: mode === "normal", searchMode: "fast", memorySearchMode: "fast", sessionRecallMode: "ultra",
    sessionRecallLimit: 8, sessionRecallTimeoutMs: 60000, automaticIngest: false, automaticMaintain: false,
    memoryRecord: false, sharedCaches: false,
    web: env.IGREP_WEB_SEARCH_PROVIDER ? { provider:env.IGREP_WEB_SEARCH_PROVIDER, url:env.IGREP_SEARXNG_URL || "", mode:"fast", maxResults:6, timeoutMs:30000, evidence:"unverified-provider-snippet" } : false,
    source: "Main committed Turn projection" };
}
/** Routes affect retrieval semantics; machine paths and credentials do not. */
export function companionIgrepRoutes(env: Readonly<Record<string, string | undefined>>): Record<string, unknown> {
  return Object.fromEntries([
    "IGREP_LLM_URL", "IGREP_LLM_MODEL", "IGREP_ASK_LLM_URL", "IGREP_ASK_LLM_MODEL",
    "IGREP_LLM_FINAL_SORT_URL", "IGREP_LLM_FINAL_SORT_MODEL", "IGREP_EMBEDDING_URL", "IGREP_EMBED_MODEL", "IGREP_EMBED_DIM",
    "IGREP_RERANK_URL", "IGREP_RERANK_MODEL", "IGREP_RERANK_API_FORMAT", "IGREP_NO_CACHE",
    "IGREP_WEB_SEARCH_PROVIDER", "IGREP_SEARXNG_URL", "IGREP_WEB_FAST_BUDGET_S", "IGREP_WEB_PROVIDER_TIMEOUT_S", "IGREP_WEB_LLM_TIMEOUT_S",
  ].map(name => [name, env[name] ?? ""]));
}
export function companionCompositionManifest(mode: CompanionCompositionMode, igrep: Record<string, unknown>, authority: CompanionCompositionAuthority) {
  if (!Number.isSafeInteger(authority.maxSteps) || authority.maxSteps <= 0) throw new Error("companion maxSteps must be a positive integer");
  const url = new URL(authority.igrepLlm.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("igrep maintenance URL must be credential-free HTTP(S)");
  return {
    schemaVersion: 3, piVersion: COMPANION_PI_VERSION, igrepVersion: COMPANION_IGREP_VERSION,
    corePackages: COMPANION_CORE_PACKAGES, storage: "memory", builtInTools: [],
    compaction: { backend: "pi-durable", ...COMPANION_COMPACTION_CONFIG },
    reasoning: { generation: true, compaction: false, structured: false, totalLimit: "profile" },
    execution: { version: 60, maxSteps: authority.maxSteps, toolExecution: "sequential", maxParallelToolCalls: 1,
      retry: false, backgroundCompaction: false, deadlineSource: "invocation.deadlineAt", commitBeforeProjection: true,
      recovery: "Main snapshot and immutable local proposal" },
    igrepMaintenance: { url: url.toString().replace(/\/$/u, ""), model: authority.igrepLlm.model.trim(), sampling: IGREP_MAINTENANCE_SAMPLING },
    ...(authority.igrepRoutes ? { igrepRoutes: digestSafeIgrepConfig(authority.igrepRoutes as Record<string, unknown>) } : {}),
    mode, igrep: digestSafeIgrepConfig(igrep),
  };
}
export function assertCompanionExecutionManifest(manifest: Readonly<Record<string, unknown>>): void {
  if (manifest.piVersion !== COMPANION_PI_VERSION || manifest.storage !== "memory"
    || stableJson(manifest.corePackages) !== stableJson(COMPANION_CORE_PACKAGES)
    || stableJson(manifest.builtInTools) !== "[]") throw new Error("companion execution manifest drifted");
}
export function companionCompositionDigest(mode: CompanionCompositionMode, config: Record<string, unknown>, authority: CompanionCompositionAuthority): string {
  return digestCompositionManifest(companionCompositionManifest(mode, config, authority));
}
export function createCompanionCompositionPlan(mode: CompanionCompositionMode, config: Record<string, unknown>, authority: CompanionCompositionAuthority): CompanionCompositionPlan {
  const normalizedIgrepConfig = immutableClone(config);
  const manifest = immutableClone(companionCompositionManifest(mode, config, authority));
  assertCompanionExecutionManifest(manifest);
  return Object.freeze({ mode, normalizedIgrepConfig, manifest, digest: digestCompositionManifest(manifest) });
}

function digestSafeIgrepConfig(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:command|.*path|.*secret|.*token|.*api[_-]?key|password)$/iu.test(key)) continue;
    output[key] = digestSafeValue(child);
  }
  return output;
}

function digestSafeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(digestSafeValue);
  if (value && typeof value === "object") {
    return digestSafeIgrepConfig(value as Record<string, unknown>);
  }
  return value;
}

function digestCompositionManifest(manifest: unknown): string {
  return createHash("sha256").update(stableJson(manifest)).digest("hex");
}

function immutableClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(immutableClone)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = immutableClone(child);
    }
    return Object.freeze(output) as T;
  }
  return value;
}
