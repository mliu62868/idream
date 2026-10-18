import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import {
  COMPANION_PI_VERSION,
  COMPANION_IGREP_VERSION,
  type CompanionReadiness,
} from "@idream/shared/chat/companion-runtime";
import type { CompanionInvocation } from "./contracts.js";
import {
  loadAgentRuntimeConfig,
} from "./config.js";
import {
  companionCompositionDigest,
  companionIgrepConfig,
  companionIgrepRoutes,
} from "./composition.js";
import {
  CompanionEngine,
  probeCompanionBridges,
  type CompanionRuntimePort,
} from "./engine.js";
import {
  IgrepMemoryBuilder,
  igrepVersion,
} from "./igrep.js";
import { OpenAiCompatibleAdapter } from "./openai-adapter.js";
import { llmProfileClaimVerifier } from "./profile-evidence.js";
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
    piVersion: string;
    profileDigests: { normal: string; private: string };
}

let runtime: AgentRuntime | undefined;

function createRuntime(): AgentRuntime {
  const config = loadAgentRuntimeConfig();
  const instance = {
    id: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const cli = { command: config.igrepCommand, env: config.igrepEnvironment };
  const igrepRoutes = companionIgrepRoutes(config.igrepEnvironment);
  const workspaces = new AttemptWorkspaceStore({
    canonicalRoot: config.canonicalRoot,
    privateRoot: config.privateRoot,
  });
  const engine = new CompanionEngine({
    instance,
    workspaces,
    adapter: (profile, requestPolicy) => new OpenAiCompatibleAdapter({
      profile,
      apiKey: config.modelProfile.apiKey,
      openRouterProviderOnly: config.openRouterProviderOnly,
      ...requestPolicy,
    }),
    igrep: cli,
    igrepRoutes,
    igrepLlm: config.igrepLlm,
    memoryBuilder: new IgrepMemoryBuilder(
      cli,
      undefined,
      undefined,
      llmProfileClaimVerifier(config.igrepLlm),
    ),
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
    const normal = companionIgrepConfig("normal", config.igrepCommand, config.igrepEnvironment);
    const privateProfile = companionIgrepConfig("private", config.igrepCommand, config.igrepEnvironment);
    const profileDigests = {
      normal: companionCompositionDigest("normal", normal, {
        maxSteps: config.maxSteps,
        igrepLlm: config.igrepLlm,
        igrepRoutes,
      }),
      private: companionCompositionDigest("private", privateProfile, {
        maxSteps: config.maxSteps,
        igrepLlm: config.igrepLlm,
        igrepRoutes,
      }),
    };
    const [resolvedIgrepVersion] = await Promise.all([
      igrepVersion(cli),
      new OpenAiCompatibleAdapter({
        profile: readinessProfile(config.modelProfile),
        apiKey: config.modelProfile.apiKey,
        openRouterProviderOnly: config.openRouterProviderOnly,
      }).resolveModel(config.modelProfile.provider, config.modelProfile.model),
    ]);
    if (resolvedIgrepVersion !== COMPANION_IGREP_VERSION) throw new Error("igrep runtime version drifted");
    return {
      igrepVersion: resolvedIgrepVersion,
      piVersion: COMPANION_PI_VERSION,
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
  piVersion: string;
}> {
  const health = await current().latestHealth();
  return {
    igrepVersion: health.igrepVersion,
    piVersion: health.piVersion,
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
