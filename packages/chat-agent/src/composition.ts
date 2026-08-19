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

export const COMPANION_CORE_PACKAGES = [
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-agent-loop",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-tool-call-timeout-policy",
  "@deepseek-ai/dsh-tools",
] as const;

const SYSTEM_PROMPT_OPTIONS = Object.freeze({
  includeHarnessIdentity: false,
  includeRuntimeContext: true,
  persona: "",
});
const AGENT_LOOP_OPTIONS = Object.freeze({ agents: [] as never[], maxParallelToolCalls: 1 });

export type CompanionCompositionMode = "normal" | "private";

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

/** The engine and readiness share this exact composition seam. */
export async function applyCompanionComposition(
  ctx: Context,
  input: {
    plugin: IgrepPluginModule;
    mode: CompanionCompositionMode;
    igrepCommand: string;
  },
): Promise<void> {
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, SYSTEM_PROMPT_OPTIONS);
  await ctx.plugin(ToolRuntime, {});
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(
    input.plugin as never,
    companionIgrepConfig(input.mode, input.igrepCommand) as never,
  );
  await ctx.plugin(ToolTimeoutPolicy);
  await ctx.plugin(AgentLoop, AGENT_LOOP_OPTIONS);
}

/**
 * Digest the composition that actually executes turns, not the installer-only
 * DSH profile (whose official manager also materializes dsh-base).
 */
export function companionCompositionDigest(
  mode: CompanionCompositionMode,
  normalizedIgrepConfig: Record<string, unknown>,
): string {
  const manifest = {
    schemaVersion: 1,
    cordisVersion: "4.0.1",
    dshVersion: COMPANION_DSH_VERSION,
    pluginVersion: COMPANION_IGREP_PLUGIN_VERSION,
    pluginOrder: [
      "llm",
      "session",
      "system-prompt",
      "tools",
      "agent-registry",
      "igrep",
      "tool-call-timeout-policy",
      "agent-loop",
    ],
    systemPrompt: SYSTEM_PROMPT_OPTIONS,
    toolRuntime: {},
    agentLoop: AGENT_LOOP_OPTIONS,
    mode,
    igrep: normalizedIgrepConfig,
  };
  return createHash("sha256").update(stableJson(manifest)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      if (child !== undefined) output[key] = stableValue(child);
    }
    return output;
  }
  throw new Error(`companion composition contains unsupported ${typeof value}`);
}
