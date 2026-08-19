import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import {
  COMPANION_DSH_COMMIT,
  COMPANION_DSH_VERSION,
  COMPANION_IGREP_PLUGIN_VERSION,
  COMPANION_IGREP_VERSION,
  companionReadinessSchema,
  releasedKnowledgeDigest,
  type CompanionReadiness,
  type PreparedTurnProfile,
  type CompanionInvocation,
  type CompanionWorkspaceRebuild,
} from "@idream/shared/chat/companion-runtime";
import type { SidecarConfig } from "./config";
import {
  NORMAL_IGREP_CONFIG,
  PRIVATE_IGREP_CONFIG,
  igrepVersion,
  probeIgrepLifecycle,
  type IgrepLifecycleProbeEvidence,
  type LoadedIgrepPlugin,
} from "./igrep";
import { probeCompanionBridges } from "./engine";
import { OpenAiCompatibleAdapter } from "./openai-adapter";
import {
  COMPANION_CORE_PACKAGES,
  companionCompositionDigest,
  resolvedCompanionIgrepConfig,
} from "./composition";

const require = createRequire(import.meta.url);
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
    timeout: { firstTokenMs: 30_000, idleMs: 30_000, completionMs: 60_000 },
    sampling: {
      temperature: 0,
      topP: 1,
      repetitionPenalty: 1,
      structuredTemperature: 0,
    },
  };
}

interface BootstrapProfile {
  name: string;
  pluginPath: string;
  configDigest: string;
  profileInputDigest: string;
}

interface BootstrapState {
  schemaVersion: 1;
  pins: { dsh: string; igrep: string; plugin: string };
  profiles: { normal: BootstrapProfile; private: BootstrapProfile };
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort().join(",");
  const wanted = [...expected].sort().join(",");
  if (actual !== wanted) throw new Error(`${label} contains unexpected fields`);
}

async function bootstrapState(path: string): Promise<BootstrapState> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  exactKeys(parsed, ["schemaVersion", "pins", "profiles"], "bootstrap state");
  const pins = parsed.pins as Record<string, unknown>;
  const profiles = parsed.profiles as Record<string, unknown>;
  if (!pins || !profiles || parsed.schemaVersion !== 1) throw new Error("bootstrap state shape is invalid");
  exactKeys(pins, ["dsh", "igrep", "plugin"], "bootstrap pins");
  exactKeys(profiles, ["normal", "private"], "bootstrap profiles");
  if (pins.dsh !== COMPANION_DSH_VERSION || pins.igrep !== COMPANION_IGREP_VERSION
    || pins.plugin !== COMPANION_IGREP_PLUGIN_VERSION) {
    throw new Error("bootstrap state version pins drifted");
  }
  for (const [mode, expectedName] of [
    ["normal", "idream-companion-memory"],
    ["private", "idream-companion-private"],
  ] as const) {
    const profile = profiles[mode] as Record<string, unknown>;
    if (!profile) throw new Error(`bootstrap ${mode} profile is missing`);
    exactKeys(profile, ["name", "pluginPath", "configDigest", "profileInputDigest"], `${mode} profile`);
    if (profile.name !== expectedName
      || typeof profile.pluginPath !== "string" || !profile.pluginPath
      || typeof profile.configDigest !== "string" || !/^[a-f0-9]{64}$/.test(profile.configDigest)
      || typeof profile.profileInputDigest !== "string" || !/^[a-f0-9]{64}$/.test(profile.profileInputDigest)) {
      throw new Error(`bootstrap ${mode} profile identity is invalid`);
    }
  }
  return parsed as unknown as BootstrapState;
}

async function textCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > 4_194_304) child.kill("SIGKILL");
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveResult, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveResult({ code, signal }));
    },
  ).finally(() => clearTimeout(timeout));
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.code ?? result.signal}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
    );
  }
  return Buffer.concat(stdout).toString("utf8");
}

function normalizedDump(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
    .concat("\n");
}

async function verifyBootstrapRuntime(input: {
  statePath: string;
  state: BootstrapState;
  plugin: LoadedIgrepPlugin;
}): Promise<void> {
  const dshHome = dirname(resolve(input.statePath));
  const expectedModule = resolve(
    dshHome,
    "profiles",
    input.state.profiles.normal.name,
    "node_modules",
    "@igrep",
    "dsh-plugin",
    "index.mjs",
  );
  if (resolve(fileURLToPath(input.plugin.moduleUrl)) !== expectedModule) {
    throw new Error("loaded igrep plugin is not the bootstrap-installed normal profile module");
  }
  const profiles = [
    ["normal", input.state.profiles.normal, NORMAL_IGREP_CONFIG],
    ["private", input.state.profiles.private, PRIVATE_IGREP_CONFIG],
  ] as const;
  await Promise.all(profiles.map(async ([mode, profile, capabilities]) => {
    const dump = await textCommand(
      "npm",
      [
        "exec",
        "--yes",
        `--package=@deepseek-ai/dsh@${COMPANION_DSH_VERSION}`,
        "--",
        "dsh",
        "--profile",
        profile.name,
        "--dump-config",
      ],
      { ...process.env, DSH_HOME: dshHome },
    );
    for (const [name, enabled] of Object.entries(capabilities)) {
      if (!new RegExp(`^\\s*${name}:\\s*${enabled}\\s*$`, "m").test(dump)) {
        throw new Error(`bootstrap ${mode} dump lacks ${name}:${enabled}`);
      }
    }
    const entryIds = [...dump.matchAll(/^\s*-\s+id:\s+([^\s#]+)\s*$/gm)]
      .map((match) => match[1]);
    if (!entryIds.includes("igrep") || entryIds.some((id) => id !== "igrep")) {
      throw new Error(`bootstrap ${mode} dump contains a non-companion plugin entry`);
    }
    const actual = createHash("sha256").update(normalizedDump(dump)).digest("hex");
    if (actual !== profile.configDigest) {
      throw new Error(`bootstrap ${mode} dump digest drifted`);
    }
  }));
}

async function warmProvider(config: SidecarConfig, profile: PreparedTurnProfile): Promise<void> {
  const adapter = new OpenAiCompatibleAdapter({
    profile,
    apiKey: config.providerApiKey,
    openRouterProviderOnly: config.openRouterProviderOnly,
  });
  await adapter.resolveModel(profile.provider, profile.model);
  let finish: Extract<StreamChunk, { type: "finish" }> | undefined;
  for await (const chunk of adapter.stream({
    provider: profile.provider,
    model: profile.model,
    messages: [{
      id: "readiness-provider-user" as never,
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "Reply with OK." }],
    }],
    maxTokens: 1,
    tools: [{
      name: "idream_readiness_probe",
      description: "Readiness-only tool schema; never executes a product effect.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }],
  })) {
    if (chunk.type === "finish") finish = chunk;
  }
  if (!finish || (finish.reason.kind !== "stop" && finish.reason.kind !== "max-tokens")) {
    throw new Error("provider warmup did not reach a committable terminal");
  }
}

function bridgeInvocation(profile: PreparedTurnProfile): CompanionInvocation {
  const knowledgeAuthority = {
    characterId: "readiness-character",
    characterContentVersionId: "readiness-content",
    characterReleaseId: null,
    files: [] as [],
  };
  const releasedKnowledge = {
    ...knowledgeAuthority,
    digest: releasedKnowledgeDigest(knowledgeAuthority),
  };
  return {
    invocationId: "readiness-bridge-invocation",
    attemptId: "readiness-bridge-attempt",
    sessionId: "readiness-bridge-session",
    userId: "readiness-user",
    characterId: "readiness-character",
    memoryMode: "private",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    preparedTurn: {
      version: 2,
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
      releasedKnowledge,
      trace: {
        characterContentVersionId: "readiness-content",
        characterReleaseId: null,
        soulFingerprint: "0".repeat(64),
        compilerVersion: "readiness",
        sceneVersion: 0,
        relationshipVersion: 0,
        fileContextRevision: "0",
        releasedKnowledgeDigest: releasedKnowledge.digest,
      },
    },
  };
}

export interface ReadinessOptions {
  config: SidecarConfig;
  instance: CompanionReadiness["instance"];
  plugin(): Promise<LoadedIgrepPlugin>;
  resolveIgrepVersion?: (command: string) => Promise<string>;
  readBootstrapState?: (path: string) => Promise<BootstrapState>;
  bootstrapRuntimeProof?: (input: {
    statePath: string;
    state: BootstrapState;
    plugin: LoadedIgrepPlugin;
  }) => Promise<void>;
  providerWarmup?: (config: SidecarConfig, profile: PreparedTurnProfile) => Promise<void>;
  memoryLifecycleProbe?: (command: string) => Promise<IgrepLifecycleProbeEvidence>;
  bridgeProbe?: (invocation: CompanionInvocation) => Promise<void>;
  workspaceRebuildProbe(): Promise<void>;
}

export async function probeWorkspaceRebuild(
  port: {
    rebuild(request: CompanionWorkspaceRebuild): Promise<unknown>;
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
    characterId: "readiness-empty-rebuild",
  };
  try {
    await port.rebuild({
      scope: "relationship",
      ...identity,
      messages: [],
    });
  } finally {
    await port.purge({ scope: "relationship", ...identity });
  }
}

export function createReadinessProbe(
  options: ReadinessOptions,
): (force?: boolean) => Promise<CompanionReadiness> {
  let cached: CompanionReadiness | undefined;
  let inFlight: Promise<CompanionReadiness> | undefined;
  return (force = false) => {
    if (inFlight) return inFlight;
    // Ordinary readiness is a cheap read of the latest deep proof. Only the
    // explicit full path may spend provider/igrep/DSH dump budgets or replace it.
    if (!force && cached) {
      return Promise.resolve(cached);
    }
    const current = (async () => {
    const cordis = await packageVersion("@deepseek-ai/cordis");
    if (cordis !== "4.0.1") throw new Error(`Cordis version drifted to ${cordis}`);
    const versions = await Promise.all(COMPANION_CORE_PACKAGES.map(packageVersion));
    const drift = COMPANION_CORE_PACKAGES.filter((_name, index) => versions[index] !== COMPANION_DSH_VERSION);
    if (drift.length > 0) throw new Error(`DSH core version drift: ${drift.join(", ")}`);
    const plugin = await options.plugin();
    if (plugin.version !== COMPANION_IGREP_PLUGIN_VERSION) {
      throw new Error(`igrep plugin version drifted to ${plugin.version}`);
    }
    const resolvedIgrepVersion = await (options.resolveIgrepVersion ?? igrepVersion)(options.config.igrepCommand);
    if (resolvedIgrepVersion !== COMPANION_IGREP_VERSION) {
      throw new Error(`igrep version drifted to ${resolvedIgrepVersion}`);
    }
    const normal = resolvedCompanionIgrepConfig(
      plugin.module,
      "normal",
      options.config.igrepCommand,
    );
    const privateProfile = resolvedCompanionIgrepConfig(
      plugin.module,
      "private",
      options.config.igrepCommand,
    );
    if (normal.ingest !== true || normal.wake !== true || normal.memory !== true || normal.search !== true
      || normal.webProvider !== false || normal.webTool !== false) {
      throw new Error("normal igrep profile did not normalize to the pinned capability set");
    }
    if (privateProfile.ingest !== false || privateProfile.wake !== false
      || privateProfile.memory !== false || privateProfile.search !== false) {
      throw new Error("private igrep profile did not normalize to the pinned capability set");
    }
    const profile = readinessProfile(options.config);
    const state = await (options.readBootstrapState ?? bootstrapState)(options.config.bootstrapStatePath);
    await (options.bootstrapRuntimeProof ?? verifyBootstrapRuntime)({
      statePath: options.config.bootstrapStatePath,
      state,
      plugin,
    });
    await (options.providerWarmup ?? warmProvider)(options.config, profile);
    const verification = await (options.memoryLifecycleProbe ?? probeIgrepLifecycle)(
      options.config.igrepCommand,
    );
    await (options.bridgeProbe ?? probeCompanionBridges)(bridgeInvocation(profile));
    await options.workspaceRebuildProbe();

    return companionReadinessSchema.parse({
      protocolVersion: 1,
      service: "dsh-companion",
      ready: true,
      checkedAt: new Date().toISOString(),
      dshVersion: COMPANION_DSH_VERSION,
      dshCommit: COMPANION_DSH_COMMIT,
      igrepVersion: COMPANION_IGREP_VERSION,
      pluginVersion: COMPANION_IGREP_PLUGIN_VERSION,
      instance: options.instance,
      provider: {
        name: profile.provider,
        baseUrl: profile.baseUrl,
        model: profile.model,
        resolved: true,
      },
      profiles: {
        normal: {
          name: "normal",
          loaded: true,
          normalizedConfigDigest: companionCompositionDigest("normal", normal),
          capabilities: { memoryRead: true, memoryWrite: true, tools: true, commit: true },
        },
        private: {
          name: "private",
          loaded: true,
          normalizedConfigDigest: companionCompositionDigest("private", privateProfile),
          capabilities: { memoryRead: false, memoryWrite: false, tools: true, commit: true },
        },
      },
      bridges: {
        toolReachable: true,
        commitReachable: true,
        workspaceRebuildReachable: true,
      },
      verification,
    });
    })();
    inFlight = current.then((readiness) => {
      cached = readiness;
      return readiness;
    }, (error) => {
      // A transient startup failure must be retryable, and a stale success may
      // never be returned after an explicit full rewarm has failed.
      cached = undefined;
      throw error;
    }).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
