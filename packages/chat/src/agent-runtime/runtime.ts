import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import {
  COMPANION_IGREP_PLUGIN_VERSION,
  type CompanionReadiness,
} from "@idream/shared/chat/companion-runtime";
import type { CompanionInvocation } from "./contracts.js";
import {
  bindIgrepLlmEnvironment,
  loadAgentRuntimeConfig,
} from "./config.js";
import {
  companionCompositionDigest,
  resolvedCompanionIgrepConfig,
} from "./composition.js";
import {
  CompanionEngine,
  probeCompanionBridges,
  type CompanionRuntimePort,
} from "./engine.js";
import {
  IgrepMemoryBuilder,
  igrepVersion,
  loadIgrepPlugin,
} from "./igrep.js";
import { OpenAiCompatibleAdapter } from "./openai-adapter.js";
import {
  createReadinessProbe,
  probeWorkspaceRebuild,
  readinessProfile,
} from "./readiness.js";
import type {
  CompanionWorkspaceRebuildPromotion,
  CompanionWorkspaceRebuildSource,
} from "./rebuild-source.js";
import {
  AttemptWorkspaceStore,
  type WorkspacePurgeRequest,
} from "./workspace.js";

interface AgentRuntime {
  engine: CompanionEngine;
  fullReadiness(force?: boolean): Promise<CompanionReadiness>;
  checkHealth(): Promise<AgentRuntimeHealth>;
  latestHealth(): Promise<AgentRuntimeHealth>;
}

interface AgentRuntimeHealth {
    igrepVersion: string;
    pluginVersion: string;
    profileDigests: { normal: string; private: string };
}

let runtime: AgentRuntime | undefined;

function createRuntime(): AgentRuntime {
  const config = loadAgentRuntimeConfig();
  bindIgrepLlmEnvironment(config.igrepLlm);
  const instance = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const plugin = Promise.resolve().then(() => loadIgrepPlugin(config.igrepPluginUrl));
  const workspaces = new AttemptWorkspaceStore({
    canonicalRoot: config.canonicalRoot,
    privateRoot: config.privateRoot,
  });
  const engine = new CompanionEngine({
    instance,
    workspaces,
    plugin: async () => (await plugin).module,
    adapter: (profile, requiredToolName, requestPolicy) => new OpenAiCompatibleAdapter({
      profile,
      apiKey: config.modelProfile.apiKey,
      openRouterProviderOnly: config.openRouterProviderOnly,
      ...requestPolicy,
      ...(requiredToolName ? { requiredToolName } : {}),
    }),
    igrepCommand: config.igrepCommand,
    igrepLlm: config.igrepLlm,
    memoryBuilder: new IgrepMemoryBuilder(config.igrepCommand),
    maxSteps: config.maxSteps,
    maxConcurrentAgents: config.maxConcurrentAgents,
  });
  let lastHealth: AgentRuntimeHealth | undefined;
  let healthInFlight: Promise<AgentRuntimeHealth> | undefined;
  const computeHealth = async (): Promise<AgentRuntimeHealth> => {
    await Promise.all([
      mkdir(config.canonicalRoot, { recursive: true, mode: 0o700 }),
      mkdir(config.privateRoot, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      chmod(config.canonicalRoot, 0o700),
      chmod(config.privateRoot, 0o700),
    ]);
    const loaded = await plugin;
    if (loaded.version !== COMPANION_IGREP_PLUGIN_VERSION) {
      throw new Error(`igrep plugin version drifted to ${loaded.version}`);
    }
    const normal = resolvedCompanionIgrepConfig(
      loaded.module,
      "normal",
      config.igrepCommand,
    );
    const privateProfile = resolvedCompanionIgrepConfig(
      loaded.module,
      "private",
      config.igrepCommand,
    );
    const profileDigests = {
      normal: companionCompositionDigest("normal", normal, {
        maxSteps: config.maxSteps,
        igrepLlm: config.igrepLlm,
      }),
      private: companionCompositionDigest("private", privateProfile, {
        maxSteps: config.maxSteps,
        igrepLlm: config.igrepLlm,
      }),
    };
    const [resolvedIgrepVersion] = await Promise.all([
      igrepVersion(config.igrepCommand),
      new OpenAiCompatibleAdapter({
        profile: readinessProfile(config.modelProfile),
        apiKey: config.modelProfile.apiKey,
        openRouterProviderOnly: config.openRouterProviderOnly,
      }).resolveModel(config.modelProfile.provider, config.modelProfile.model),
    ]);
    return {
      igrepVersion: resolvedIgrepVersion,
      pluginVersion: loaded.version,
      profileDigests,
    };
  };
  const checkHealth = (): Promise<AgentRuntimeHealth> => {
    healthInFlight ??= computeHealth().then((health) => {
      lastHealth = health;
      return health;
    }).finally(() => {
      healthInFlight = undefined;
    });
    return healthInFlight;
  };
  return {
    engine,
    checkHealth,
    latestHealth: () => lastHealth ? Promise.resolve(lastHealth) : checkHealth(),
    fullReadiness: createReadinessProbe({
      config,
      instance,
      plugin: () => plugin,
      bridgeProbe: probeCompanionBridges,
      workspaceRebuildProbe: () => probeWorkspaceRebuild(engine),
    }),
  };
}

function current(): AgentRuntime {
  runtime ??= createRuntime();
  return runtime;
}

export async function warmAgentRuntime(): Promise<void> {
  await current().checkHealth();
}

export async function certifyAgentRuntime(): Promise<CompanionReadiness> {
  return current().fullReadiness(true);
}

export async function agentRuntimeProfileDigest(
  mode: "normal" | "private",
): Promise<string> {
  return (await current().latestHealth()).profileDigests[mode];
}

export async function agentRuntimeVersions(): Promise<{
  igrepVersion: string;
  pluginVersion: string;
}> {
  const health = await current().latestHealth();
  return {
    igrepVersion: health.igrepVersion,
    pluginVersion: health.pluginVersion,
  };
}

export async function runCompanion(
  invocation: CompanionInvocation,
  port: CompanionRuntimePort,
  signal?: AbortSignal,
): Promise<void> {
  await warmAgentRuntime();
  return current().engine.run(invocation, port, signal);
}

export async function purgeCompanionWorkspace(
  request: WorkspacePurgeRequest,
): Promise<{ purged: number }> {
  return { purged: await current().engine.purge(request) };
}

export async function prepareCompanionWorkspaceRebuild(
  request: CompanionWorkspaceRebuildSource,
  signal?: AbortSignal,
): Promise<{ rebuildId: string; sessions: number; messages: number }> {
  return current().engine.prepareRebuild(request, signal);
}

export async function promoteCompanionWorkspaceRebuild(
  request: CompanionWorkspaceRebuildPromotion,
  signal?: AbortSignal,
): Promise<{ sessions: number; messages: number }> {
  return current().engine.promoteRebuild(request, signal);
}

export async function shutdownAgentRuntime(): Promise<void> {
  if (!runtime) return;
  await runtime.engine.shutdown();
}
