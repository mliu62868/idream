import { createHash } from "node:crypto";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { AgentLoop } from "@deepseek-ai/dsh-agent-loop";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import * as ToolTimeoutPolicy from "@deepseek-ai/dsh-tool-call-timeout-policy";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
  COMPANION_DSH_VERSION,
  COMPANION_IGREP_PLUGIN_VERSION,
} from "@idream/shared/chat/companion-runtime";
import type { Context } from "@deepseek-ai/cordis";
import {
  NORMAL_IGREP_CONFIG,
  PRIVATE_IGREP_CONFIG,
  type IgrepPluginModule,
} from "./igrep";
import { stableJson } from "../stable-json";
import { IGREP_MAINTENANCE_SAMPLING } from "./config";

export const COMPANION_CORE_PACKAGES = [
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-agent-loop",
  "@deepseek-ai/dsh-attachment",
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/dsh-code-runtime",
  "@deepseek-ai/dsh-invariants",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-scope",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-session-persistence",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-timeout",
  "@deepseek-ai/dsh-tool-call-timeout-policy",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-typert-protocol",
  "@deepseek-ai/dsh-user-approval",
] as const;

const SYSTEM_PROMPT_OPTIONS = Object.freeze({
  includeHarnessIdentity: false,
  includeRuntimeContext: true,
  persona: "",
});
const AGENT_LOOP_OPTIONS = Object.freeze({ agents: [] as never[], maxParallelToolCalls: 1 });

const IDREAM_COMPOSITION_IDENTITY = Object.freeze({
  adapter: Object.freeze({ name: "openai-compatible", contractVersion: 1 }),
  bridges: Object.freeze({
    preparedTurn: 1,
    tool: 1,
    event: 1,
    commit: 1,
  }),
});
const EXECUTION_POLICY_VERSION = 9;
const EFFECTFUL_TOOL_CONCURRENCY = 1;
export const FORBIDDEN_COMPANION_EXECUTION_SERVICES = [
  "shell",
  "fs",
  "filesystem",
  "subagent",
  "goal",
  "scheduler",
] as const;

export type CompanionCompositionMode = "normal" | "private";

export interface CompanionCompositionAuthority {
  maxSteps: number;
  igrepLlm: {
    url: string;
    model: string;
  };
}

export interface CompanionCompositionPlan {
  readonly mode: CompanionCompositionMode;
  readonly normalizedIgrepConfig: Readonly<Record<string, unknown>>;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly digest: string;
}

interface CompanionCompositionInput {
  plugin: IgrepPluginModule;
  plan: CompanionCompositionPlan;
}

// INVARIANT: this table is both the executable registration path and Gate C's
// manifest source, so evidence cannot stay green after runtime composition drifts.
const COMPANION_EXECUTION_PLUGINS = [
  { name: "llm", install: async (ctx: Context) => { await ctx.plugin(LlmRuntime); } },
  { name: "session", install: async (ctx: Context) => { await ctx.plugin(SessionStore); } },
  {
    name: "system-prompt",
    install: async (ctx: Context) => { await ctx.plugin(SystemPrompt, SYSTEM_PROMPT_OPTIONS); },
  },
  { name: "tools", install: async (ctx: Context) => { await ctx.plugin(ToolRuntime, {}); } },
  { name: "agent-registry", install: async (ctx: Context) => { await ctx.plugin(AgentRegistry); } },
  {
    name: "igrep",
    install: async (ctx: Context, input: CompanionCompositionInput) => {
      await ctx.plugin(input.plugin as never, input.plan.normalizedIgrepConfig as never);
    },
  },
  {
    name: "tool-call-timeout-policy",
    install: async (ctx: Context) => { await ctx.plugin(ToolTimeoutPolicy); },
  },
  {
    name: "agent-loop",
    install: async (ctx: Context) => { await ctx.plugin(AgentLoop, AGENT_LOOP_OPTIONS); },
  },
] as const;

export const COMPANION_EXECUTION_PLUGIN_ORDER = Object.freeze(
  COMPANION_EXECUTION_PLUGINS.map((entry) => entry.name),
);

export function companionIgrepConfig(
  mode: CompanionCompositionMode,
  command: string,
): Record<string, unknown> {
  return {
    command,
    ...(mode === "normal" ? NORMAL_IGREP_CONFIG : PRIVATE_IGREP_CONFIG),
  };
}

export function resolvedCompanionIgrepConfig(
  plugin: IgrepPluginModule,
  mode: CompanionCompositionMode,
  command: string,
): Record<string, unknown> {
  const raw = companionIgrepConfig(mode, command);
  return plugin.resolveConfig?.(raw) ?? raw;
}

/** Execute only the registrations whose names are hashed into Gate C evidence. */
export async function applyCompanionComposition(
  ctx: Context,
  input: CompanionCompositionInput,
): Promise<void> {
  assertCompanionExecutionManifest(input.plan.manifest);
  for (const registration of COMPANION_EXECUTION_PLUGINS) {
    await registration.install(ctx, input);
  }
}

/** Reject a digest whose declared services differ from the executable table. */
export function assertCompanionExecutionManifest(
  manifest: Readonly<Record<string, unknown>>,
): void {
  const pluginOrder = manifest.pluginOrder;
  if (
    !Array.isArray(pluginOrder) ||
    pluginOrder.length !== COMPANION_EXECUTION_PLUGIN_ORDER.length ||
    pluginOrder.some((entry, index) => entry !== COMPANION_EXECUTION_PLUGIN_ORDER[index])
  ) {
    throw new Error("companion execution plugin order drifted");
  }
  const forbidden = pluginOrder.find((entry) =>
    FORBIDDEN_COMPANION_EXECUTION_SERVICES.includes(entry as never)
  );
  if (forbidden) {
    throw new Error(`forbidden companion execution service loaded: ${String(forbidden)}`);
  }
}

/**
 * Digest the composition that actually executes turns, not the installer-only
 * DSH profile (whose official manager also materializes dsh-base).
 */
export function companionCompositionDigest(
  mode: CompanionCompositionMode,
  normalizedIgrepConfig: Record<string, unknown>,
  authority: CompanionCompositionAuthority,
): string {
  return digestCompositionManifest(
    companionCompositionManifest(mode, normalizedIgrepConfig, authority),
  );
}

/** Pure authority plan: no Context, workspace, adapter or provider is initialized here. */
export function createCompanionCompositionPlan(
  mode: CompanionCompositionMode,
  normalizedIgrepConfig: Record<string, unknown>,
  authority: CompanionCompositionAuthority,
): CompanionCompositionPlan {
  const immutableIgrepConfig = immutableClone(normalizedIgrepConfig);
  const manifest = immutableClone(
    companionCompositionManifest(mode, immutableIgrepConfig, authority),
  ) as Readonly<Record<string, unknown>>;
  assertCompanionExecutionManifest(manifest);
  return Object.freeze({
    mode,
    normalizedIgrepConfig: immutableIgrepConfig,
    manifest,
    digest: digestCompositionManifest(manifest),
  });
}

export function companionCompositionManifest(
  mode: CompanionCompositionMode,
  normalizedIgrepConfig: Record<string, unknown>,
  authority: CompanionCompositionAuthority,
) {
  if (!Number.isSafeInteger(authority.maxSteps) || authority.maxSteps <= 0) {
    throw new Error("companion maxSteps must be a positive integer");
  }
  const maintenanceUrl = new URL(authority.igrepLlm.url);
  if (maintenanceUrl.protocol !== "http:" && maintenanceUrl.protocol !== "https:") {
    throw new Error("igrep maintenance LLM URL must use HTTP(S)");
  }
  if (maintenanceUrl.username || maintenanceUrl.password || maintenanceUrl.search || maintenanceUrl.hash) {
    throw new Error("igrep maintenance LLM URL must not contain credentials, query or fragment");
  }
  return {
    schemaVersion: 2,
    cordisVersion: "4.0.1",
    dshVersion: COMPANION_DSH_VERSION,
    pluginVersion: COMPANION_IGREP_PLUGIN_VERSION,
    pluginOrder: COMPANION_EXECUTION_PLUGIN_ORDER,
    systemPrompt: SYSTEM_PROMPT_OPTIONS,
    toolRuntime: {},
    agentLoop: AGENT_LOOP_OPTIONS,
    idream: {
      ...IDREAM_COMPOSITION_IDENTITY,
      executionPolicy: {
        version: EXECUTION_POLICY_VERSION,
        maxSteps: authority.maxSteps,
        maxParallelToolCalls: AGENT_LOOP_OPTIONS.maxParallelToolCalls,
        effectfulToolConcurrency: EFFECTFUL_TOOL_CONCURRENCY,
        deadlineSource: "invocation.deadlineAt",
        commitBeforeProjection: true,
      },
      igrepMaintenance: {
        url: maintenanceUrl.toString().replace(/\/$/u, ""),
        model: authority.igrepLlm.model.trim(),
        sampling: IGREP_MAINTENANCE_SAMPLING,
      },
    },
    mode,
    igrep: digestSafeIgrepConfig(normalizedIgrepConfig),
  };
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
