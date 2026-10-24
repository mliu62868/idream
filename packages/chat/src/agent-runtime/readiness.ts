import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import {
  COMPANION_PI_VERSION,
  COMPANION_IGREP_VERSION,
  COMPANION_RUNTIME_PROTOCOL_VERSION,
  companionReadinessSchema,
  type CompanionReadiness,
  type CompanionWorkspaceRebuild,
  type CompanionWorkspaceRebuildFence,
  type CompanionWorkspaceRebuildPromotion,
} from "@idream/shared/chat/companion-runtime";
import type { CompanionInvocation, PreparedTurnProfile } from "./contracts";
import type { AgentRuntimeConfig } from "./config";
import { COMPANION_PRODUCT_PROMPT_VERSION, type ChatModelProfile } from "@idream/shared";
import { igrepVersion, probeIgrepLifecycle, type IgrepLifecycleProbeEvidence, type IgrepCommand } from "./igrep";
import { probeCompanionBridges } from "./engine";
import { OpenAiCompatibleAdapter } from "./openai-adapter";
import { llmProfileClaimVerifier } from "./profile-evidence";
import { probeCompanionRetrieval } from "./retrieval-probe";
import { COMPANION_CORE_PACKAGES, companionCompositionDigest, companionIgrepConfig, companionIgrepRoutes } from "./composition";

async function packageVersion(name: string): Promise<string> {
  // pi-ai does not export package.json. Resolve its public entry, then read the
  // owning package manifest rather than relying on a private module export.
  let directory = dirname(fileURLToPath(import.meta.resolve(name)));
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string; version?: string };
      if (manifest.name === name && manifest.version) return manifest.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`${name} package version is missing`);
    directory = parent;
  }
}

export function readinessProfile(model: ChatModelProfile): PreparedTurnProfile {
  return {
    tier: "readiness", adapter: "openai-compatible-v1", provider: model.provider,
    baseUrl: model.baseUrl, model: model.model, supportsTools: true, maxOutputTokens: 1,
    timeout: { firstTokenMs: 30_000, idleMs: 30_000 },
    sampling: { temperature: 0, topP: 1, repetitionPenalty: 1 },
  };
}

/** Qualify the public storage/entry/context surface without issuing a model call. */
export async function probePiKernel(): Promise<CompanionReadiness["kernel"]> {
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(new MemoryStorage(), {
    models: createModels(), registry: createRegistry(),
    settings: { retry: { enabled: false }, stream: { maxRetries: 0 }, compaction: { enabled: false }, toolExecution: "sequential" },
  }, context);
  try {
    const conversation = await harness.root(context);
    await conversation.commit(tx => tx.appendEntry(conversation.id, {
      kind: "idream.readiness", model: [{ role: "user", content: "Controlled public API qualification.", timestamp: 1 }],
    }), context);
    const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
    const view = await conversation.context(context);
    if (!entries.items.some(entry => entry.kind === "idream.readiness")
      || view.entries.length !== view.contributions.length
      || !view.contributions.flat().some(message => message.role === "user" && message.content === "Controlled public API qualification.")) {
      throw new Error("Pi public storage, entry or context contract failed");
    }
    return { storage: "memory", publicApi: true };
  } finally {
    await harness.close(context);
  }
}

export async function warmProvider(config: AgentRuntimeConfig, profile: PreparedTurnProfile): Promise<void> {
  const adapter = new OpenAiCompatibleAdapter({ profile, apiKey: config.modelProfile.apiKey, openRouterProviderOnly: config.openRouterProviderOnly });
  await adapter.resolveModel(profile.provider, profile.model);
  let completed = false;
  for await (const event of adapter.stream([
    { role: "system", content: "", timestamp: 1, toolsAdded: [{ name: "idream_readiness_probe", description: "Readiness-only tool schema; never executes a product effect.", parameters: { type: "object", properties: {}, additionalProperties: false } }] },
    { role: "user", content: "Reply with OK.", timestamp: 1 },
  ], { maxTokens: 1, purpose: "warmup" })) {
    if (event.type === "error") {
      const failure = adapter.getError(event.error);
      throw new Error(`provider warmup failed: ${failure?.code ?? event.reason}`);
    }
    if (event.type === "done") {
      // Pi's numeric usage fields include defaults. Only the transport receipt
      // proves that the upstream supplied complete counters for this request.
      const usage = adapter.getUsage(event.message);
      adapter.getAttribution(event.message);
      if (event.reason !== "stop" && event.reason !== "length") throw new Error("provider warmup did not reach a committable terminal");
      if (!usage) throw new Error("provider warmup usage is unknown");
      completed = true;
    }
  }
  if (!completed) throw new Error("provider warmup did not reach a committable terminal");
}

function bridgeInvocation(
  profile: PreparedTurnProfile,
  expectedProfileDigest: string,
): CompanionInvocation {
  return {
    invocationId: "readiness-bridge-invocation",
    attemptId: "readiness-bridge-attempt",
    sessionId: "readiness-bridge-session",
    userId: "readiness-user",
    characterId: "readiness-character",
    memoryMode: "private",
    expectedProfileDigest,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    preparedTurn: {
      version: 6,
      model: profile.model,
      characterName: "Readiness",
      messages: [{
        id: "readiness-current-user",
        sourceKind: "current_user",
        role: "user",
        content: "readiness",
      }],
      tools: [],
      profile,
      budget: { maxInputTokens: 16, usedInputTokens: 1, dropped: [] },
      trace: {
        productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION,
        systemPromptDigest: "0".repeat(64),
        characterContentVersionId: "readiness-content",
        characterReleaseId: null,
        soulFingerprint: "0".repeat(64),
        compilerVersion: "readiness",
        sceneVersion: 0,
        contextRevision: "0",
      },
    },
  };
}

export interface ReadinessOptions {
  config: AgentRuntimeConfig;
  instance: CompanionReadiness["instance"];
  resolvePackageVersion?: (name: string) => Promise<string>;
  resolveIgrepVersion?: (cli: IgrepCommand) => Promise<string>;
  kernelProbe?: typeof probePiKernel;
  providerWarmup?: (config: AgentRuntimeConfig, profile: PreparedTurnProfile) => Promise<void>;
  memoryLifecycleProbe?: (cli: IgrepCommand) => Promise<IgrepLifecycleProbeEvidence>;
  bridgeProbe?: (invocation: CompanionInvocation) => Promise<void>;
  retrievalProbe?: typeof probeCompanionRetrieval;
  workspaceRebuildProbe(): Promise<void>;
}

export async function probeWorkspaceRebuild(
  port: {
    prepareRebuild(
      request: CompanionWorkspaceRebuild & { fence: CompanionWorkspaceRebuildFence },
    ): Promise<{ rebuildId: string }>;
    promoteRebuild(request: CompanionWorkspaceRebuildPromotion): Promise<unknown>;
    purge(request: {
      scope: "relationship";
      userId: string;
      characterId: string;
    }): Promise<unknown>;
  },
  nonce: () => string = randomUUID,
): Promise<void> {
  const identity = {
    userId: `readiness-${nonce()}`,
    characterId: "readiness-rebuild",
  };
  const fence = {
    mutationId: `readiness:${identity.userId}`,
    claimToken: "00000000-0000-4000-8000-000000000001",
    authorityVersion: "1",
  };
  try {
    const prepared = await port.prepareRebuild({
      scope: "relationship",
      ...identity,
      mode: "rebuild",
      messages: [],
      fence,
    });
    await port.promoteRebuild({
      scope: "relationship",
      ...identity,
      rebuildId: prepared.rebuildId,
      fence,
    });
    // Nonempty Main history exercises the installed CLI's private-file format;
    // an empty rebuild alone cannot certify a dependency's ingest contract.
    const populatedFence = { ...fence, mutationId: `${fence.mutationId}:populated`, authorityVersion: "2" };
    const timestamp = new Date().toISOString();
    const populated = await port.prepareRebuild({
      scope: "relationship",
      ...identity,
      mode: "rebuild",
      messages: [
        { id: "readiness-user", sessionId: identity.userId, role: "user", content: "This is a controlled memory source verification.\n明天再见。Literal symbols: ␊ ␡", createdAt: timestamp },
        { id: "readiness-assistant", sessionId: identity.userId, role: "assistant", content: "The source verification has been acknowledged.\n\nThe original paragraphs remain intact.", createdAt: timestamp },
      ],
      fence: populatedFence,
    });
    await port.promoteRebuild({ scope: "relationship", ...identity, rebuildId: populated.rebuildId, fence: populatedFence });
  } finally {
    await port.purge({ scope: "relationship", ...identity });
  }
}

// Provider and CLI failures are content-free but otherwise indistinguishable.
// Identify the qualification phase without adding transcript or command output.
async function runtimeProof<T>(phase: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    throw new Error(`companion ${phase} proof failed: ${error instanceof Error ? error.message : "unknown failure"}`, { cause: error });
  }
}

export function createReadinessProbe(options: ReadinessOptions): (force?: boolean) => Promise<CompanionReadiness> {
  let cached: CompanionReadiness | undefined;
  let inFlight: Promise<CompanionReadiness> | undefined;
  return (force = false) => {
    if (inFlight) return inFlight;
    if (!force && cached) return Promise.resolve(cached);
    const current = (async () => {
      const versions = await Promise.all(COMPANION_CORE_PACKAGES.map(options.resolvePackageVersion ?? packageVersion));
      const drift = COMPANION_CORE_PACKAGES.filter((_name, index) => versions[index] !== COMPANION_PI_VERSION);
      if (drift.length) throw new Error(`Pi core version drift: ${drift.join(", ")}`);
      const cli = { command: options.config.igrepCommand, env: options.config.igrepEnvironment };
      const resolvedIgrepVersion = await (options.resolveIgrepVersion ?? igrepVersion)(cli);
      if (resolvedIgrepVersion !== COMPANION_IGREP_VERSION) throw new Error("igrepVersion must match the qualified release");
      const kernel = await runtimeProof("kernel", options.kernelProbe ?? probePiKernel);
      const normal = companionIgrepConfig("normal", cli.command, cli.env);
      const privateProfile = companionIgrepConfig("private", cli.command, cli.env);
      const authority = { maxSteps: options.config.maxSteps, igrepLlm: options.config.igrepLlm, igrepRoutes: companionIgrepRoutes(options.config.igrepEnvironment) };
      const normalDigest = companionCompositionDigest("normal", normal, authority);
      const privateDigest = companionCompositionDigest("private", privateProfile, authority);
      const profile = readinessProfile(options.config.modelProfile);
      await runtimeProof("provider", () => (options.providerWarmup ?? warmProvider)(options.config, profile));
      const verification = await runtimeProof("memory", () => options.memoryLifecycleProbe
        ? options.memoryLifecycleProbe(cli)
        : probeIgrepLifecycle(cli, { verifyClaim: llmProfileClaimVerifier(options.config.igrepLlm) }));
      await runtimeProof("bridge", () => (options.bridgeProbe ?? probeCompanionBridges)(bridgeInvocation(profile, privateDigest)));
      // This independently executes compaction, exact by-id recall, semantic
      // archive search, local retrieval and usage aggregation in production composition.
      await runtimeProof("retrieval", () => (options.retrievalProbe ?? probeCompanionRetrieval)(options.config, profile));
      await runtimeProof("workspace-rebuild", options.workspaceRebuildProbe);
      return companionReadinessSchema.parse({
        protocolVersion: COMPANION_RUNTIME_PROTOCOL_VERSION, service: "chat-runtime", ready: true,
        checkedAt: new Date().toISOString(), productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION,
        piVersion: COMPANION_PI_VERSION, igrepVersion: resolvedIgrepVersion, kernel, instance: options.instance,
        provider: { name: profile.provider, baseUrl: profile.baseUrl, model: profile.model, resolved: true },
        profiles: {
          normal: { name: "normal", loaded: true, executionCompositionDigest: normalDigest, capabilities: { memoryRead: true, memoryWrite: true, tools: true, commit: true } },
          private: { name: "private", loaded: true, executionCompositionDigest: privateDigest, capabilities: { memoryRead: false, memoryWrite: false, tools: true, commit: true } },
        },
        bridges: { toolReachable: true, commitReachable: true, workspaceRebuildReachable: true }, verification,
      });
    })();
    inFlight = current.then((readiness) => {
      cached = readiness;
      return readiness;
    }, (error) => {
      // A failed full rewarm invalidates the earlier success; the next probe retries.
      cached = undefined;
      throw error;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
