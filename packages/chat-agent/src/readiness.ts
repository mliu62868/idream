import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import {
  COMPANION_DSH_COMMIT,
  COMPANION_DSH_VERSION,
  COMPANION_IGREP_PLUGIN_VERSION,
  COMPANION_IGREP_VERSION,
  companionReadinessSchema,
  type CompanionReadiness,
  type PreparedTurnProfile,
} from "@idream/shared/chat/companion-runtime";
import type { SidecarConfig } from "./config";
import {
  NORMAL_IGREP_CONFIG,
  PRIVATE_IGREP_CONFIG,
  igrepVersion,
  type LoadedIgrepPlugin,
} from "./igrep";
import { OpenAiCompatibleAdapter } from "./openai-adapter";

const require = createRequire(import.meta.url);
const CORE_PACKAGES = [
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-agent-loop",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-tool-call-timeout-policy",
  "@deepseek-ai/dsh-tools",
] as const;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

async function packageVersion(name: string): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(require.resolve(`${name}/package.json`), "utf8"),
  ) as { version?: string };
  if (!packageJson.version) throw new Error(`${name} package version is missing`);
  return packageJson.version;
}

function readinessProfile(config: SidecarConfig): PreparedTurnProfile {
  return {
    tier: "readiness",
    adapter: "openai-compatible-v1",
    provider: config.readyProvider,
    baseUrl: config.readyBaseUrl,
    model: config.readyModel,
    supportsTools: true,
    maxOutputTokens: 1,
    timeout: { firstTokenMs: 1_000, idleMs: 1_000, completionMs: 1_000 },
    sampling: {
      temperature: 0,
      topP: 1,
      repetitionPenalty: 1,
      structuredTemperature: 0,
    },
  };
}

export interface ReadinessOptions {
  config: SidecarConfig;
  plugin(): Promise<LoadedIgrepPlugin>;
  resolveIgrepVersion?: (command: string) => Promise<string>;
}

export function createReadinessProbe(options: ReadinessOptions): () => Promise<CompanionReadiness> {
  return async () => {
    const cordis = await packageVersion("@deepseek-ai/cordis");
    if (cordis !== "4.0.1") throw new Error(`Cordis version drifted to ${cordis}`);
    const versions = await Promise.all(CORE_PACKAGES.map(packageVersion));
    const drift = CORE_PACKAGES.filter((_name, index) => versions[index] !== COMPANION_DSH_VERSION);
    if (drift.length > 0) throw new Error(`DSH core version drift: ${drift.join(", ")}`);
    const plugin = await options.plugin();
    if (plugin.version !== COMPANION_IGREP_PLUGIN_VERSION) {
      throw new Error(`igrep plugin version drifted to ${plugin.version}`);
    }
    const resolvedIgrepVersion = await (options.resolveIgrepVersion ?? igrepVersion)(options.config.igrepCommand);
    if (resolvedIgrepVersion !== COMPANION_IGREP_VERSION) {
      throw new Error(`igrep version drifted to ${resolvedIgrepVersion}`);
    }
    const normal = plugin.module.resolveConfig?.({
      command: options.config.igrepCommand,
      ...NORMAL_IGREP_CONFIG,
    }) ?? { command: options.config.igrepCommand, ...NORMAL_IGREP_CONFIG };
    const privateProfile = plugin.module.resolveConfig?.({
      command: options.config.igrepCommand,
      ...PRIVATE_IGREP_CONFIG,
    }) ?? { command: options.config.igrepCommand, ...PRIVATE_IGREP_CONFIG };
    if (normal.ingest !== true || normal.wake !== false || normal.memory !== true || normal.search !== true) {
      throw new Error("normal igrep profile did not normalize to the pinned capability set");
    }
    if (privateProfile.ingest !== false || privateProfile.wake !== false
      || privateProfile.memory !== false || privateProfile.search !== false) {
      throw new Error("private igrep profile did not normalize to the pinned capability set");
    }
    const profile = readinessProfile(options.config);
    const adapter = new OpenAiCompatibleAdapter({
      profile,
      apiKey: options.config.providerApiKey,
      openRouterProviderOnly: options.config.openRouterProviderOnly,
    });
    await adapter.resolveModel(profile.provider, profile.model);

    return companionReadinessSchema.parse({
      protocolVersion: 1,
      service: "dsh-companion",
      ready: true,
      checkedAt: new Date().toISOString(),
      dshVersion: COMPANION_DSH_VERSION,
      dshCommit: COMPANION_DSH_COMMIT,
      igrepVersion: COMPANION_IGREP_VERSION,
      pluginVersion: COMPANION_IGREP_PLUGIN_VERSION,
      provider: { name: profile.provider, model: profile.model, resolved: true },
      profiles: {
        normal: {
          name: "normal",
          loaded: true,
          normalizedConfigDigest: digest(normal),
          capabilities: { memoryRead: true, memoryWrite: true, tools: true, commit: true },
        },
        private: {
          name: "private",
          loaded: true,
          normalizedConfigDigest: digest(privateProfile),
          capabilities: { memoryRead: false, memoryWrite: false, tools: true, commit: true },
        },
      },
      bridges: { toolReachable: true, commitReachable: true },
    });
  };
}
