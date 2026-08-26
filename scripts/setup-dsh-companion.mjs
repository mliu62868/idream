#!/usr/bin/env node
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DSH_VERSION = "0.1.0-rc.7";
export const IGREP_VERSION = "0.1.132";
export const IGREP_PLUGIN_VERSION = "0.1.0";
export const PROFILE_NAMES = Object.freeze({
  normal: "idream-companion-memory",
  private: "idream-companion-private",
});

const PLUGIN_PACKAGE = "@igrep/dsh-plugin";
const PLUGIN_PEERS = Object.freeze([
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-tools",
]);
const STATE_FILENAME = "idream-companion-bootstrap.json";
const STATE_SCHEMA_VERSION = 1;
const COMMAND_TIMEOUT_MS = 120_000;
// INVARIANT: mirrors NORMAL_IGREP_CONFIG / PRIVATE_IGREP_CONFIG in
// packages/chat-agent/src/igrep.ts; readiness greps every entry out of the
// installed profile dump, so the two tables must stay identical.
const PROFILE_CAPABILITIES = Object.freeze({
  normal: Object.freeze({
    search: false,
    webProvider: false,
    webTool: false,
    memory: true,
    ingest: true,
    wake: true,
    memorySearchMode: "fast",
    timeoutMs: 10000,
  }),
  private: Object.freeze({
    search: false,
    webProvider: false,
    webTool: false,
    memory: false,
    ingest: false,
    wake: false,
  }),
});

export class BootstrapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
  }
}

export function parseCliArgs(argv) {
  const parsed = { check: false, json: false };
  const seen = new Set();
  for (const argument of argv) {
    if (argument !== "--check" && argument !== "--json") {
      throw new BootstrapError("INVALID_ARGUMENT", "unknown argument");
    }
    if (seen.has(argument)) {
      throw new BootstrapError("INVALID_ARGUMENT", `duplicate argument: ${argument}`);
    }
    seen.add(argument);
    if (argument === "--check") parsed.check = true;
    if (argument === "--json") parsed.json = true;
  }
  return parsed;
}

export function isSupportedNodeVersion(version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return (major === 22 && minor >= 19) || major >= 24;
}

export function runDshCompanionBootstrap(options, injected = {}) {
  const dependencies = resolveDependencies(injected);
  const dshHome = path.resolve(
    dependencies.env.DSH_HOME ?? path.join(dependencies.homedir(), ".dsh"),
  );
  assertNodeVersion(dependencies.nodeVersion);

  const igrepExecutable = discoverIgrepExecutable(dependencies);
  const pythonVersion = readIgrepPythonVersion(
    igrepExecutable,
    dependencies,
  );
  const igrepVersion = readIgrepVersion(dependencies);
  const dshVersion = readDshVersion(dependencies, dshHome);

  const discoveries = Object.entries(PROFILE_NAMES).map(
    ([memoryMode, profileName]) => ({
      memoryMode,
      profileName,
      ...discoverPlugin(profileName, dependencies, dshHome),
    }),
  );

  let profiles;
  if (options.check) {
    profiles = checkProfiles(discoveries, dependencies, dshHome);
  } else {
    profiles = setupProfiles(discoveries, dependencies, dshHome);
    writeBootstrapState(profiles, dependencies, dshHome);
  }

  return {
    ok: true,
    mode: options.check ? "check" : "setup",
    dshHome,
    statePath: path.join(dshHome, STATE_FILENAME),
    versions: {
      node: stripVersionPrefix(dependencies.nodeVersion),
      python: pythonVersion,
      dsh: dshVersion,
      igrep: igrepVersion,
      plugin: IGREP_PLUGIN_VERSION,
    },
    profiles,
  };
}

export function executeCli(argv = process.argv.slice(2), injected = {}) {
  const stdout = injected.stdout ?? process.stdout;
  const stderr = injected.stderr ?? process.stderr;
  const setExitCode = injected.setExitCode ?? ((code) => {
    process.exitCode = code;
  });
  const wantsJson = argv.includes("--json");
  try {
    const options = parseCliArgs(argv);
    const report = runDshCompanionBootstrap(options, injected);
    stdout.write(
      options.json
        ? `${JSON.stringify(report)}\n`
        : formatHumanReport(report),
    );
    return report;
  } catch (error) {
    const failure = publicFailure(error);
    const output = wantsJson
      ? `${JSON.stringify({ ok: false, error: failure })}\n`
      : `dsh companion bootstrap failed [${failure.code}]: ${failure.message}\n`;
    stderr.write(output);
    setExitCode(1);
    return { ok: false, error: failure };
  }
}

function resolveDependencies(injected) {
  return {
    env: injected.env ?? process.env,
    fs: injected.fs ?? nodeFs,
    homedir: injected.homedir ?? os.homedir,
    nodeVersion: injected.nodeVersion ?? process.versions.node,
    spawnSync: injected.spawnSync ?? nodeSpawnSync,
  };
}

function assertNodeVersion(version) {
  if (!isSupportedNodeVersion(version)) {
    throw new BootstrapError(
      "NODE_VERSION_MISMATCH",
      `Node ${stripVersionPrefix(version)} is unsupported; expected ^22.19 or >=24`,
    );
  }
}

function discoverIgrepExecutable(dependencies) {
  const output = runCommand(
    dependencies,
    "igrep executable discovery",
    "which",
    ["igrep"],
    dependencies.env,
  ).trim();
  const executable = output.split(/\r?\n/, 1)[0];
  if (!executable || !path.isAbsolute(executable)) {
    throw new BootstrapError(
      "IGREP_EXECUTABLE_INVALID",
      "igrep executable discovery did not return an absolute path",
    );
  }
  return executable;
}

function readIgrepPythonVersion(igrepExecutable, dependencies) {
  let firstLine;
  try {
    firstLine = String(
      dependencies.fs.readFileSync(igrepExecutable, "utf8"),
    ).split(/\r?\n/, 1)[0];
  } catch {
    throw new BootstrapError(
      "IGREP_SHEBANG_INVALID",
      "cannot read the igrep executable shebang",
    );
  }
  const pythonExecutable = resolveShebangExecutable(firstLine, dependencies);
  const output = runCommand(
    dependencies,
    "igrep Python version",
    pythonExecutable,
    ["--version"],
    dependencies.env,
  ).trim();
  const match = /^Python\s+(\d+\.\d+\.\d+)(?:\s|$)/.exec(output);
  if (!match || !isSupportedPythonVersion(match[1])) {
    throw new BootstrapError(
      "PYTHON_VERSION_MISMATCH",
      "igrep requires Python >=3.14,<3.15",
    );
  }
  return match[1];
}

function resolveShebangExecutable(firstLine, dependencies) {
  if (!firstLine?.startsWith("#!")) {
    throw new BootstrapError(
      "IGREP_SHEBANG_INVALID",
      "igrep executable has no Python shebang",
    );
  }
  const shebang = firstLine.slice(2).trim();
  if (path.isAbsolute(shebang) && !shebang.includes(" ")) return shebang;
  const envMatch = /^\/usr\/bin\/env\s+([A-Za-z0-9._-]+)$/.exec(shebang);
  if (!envMatch) {
    throw new BootstrapError(
      "IGREP_SHEBANG_INVALID",
      "igrep executable uses an unsupported shebang",
    );
  }
  const resolved = runCommand(
    dependencies,
    "igrep Python executable discovery",
    "which",
    [envMatch[1]],
    dependencies.env,
  ).trim();
  if (!resolved || !path.isAbsolute(resolved)) {
    throw new BootstrapError(
      "IGREP_SHEBANG_INVALID",
      "igrep Python executable discovery failed",
    );
  }
  return resolved;
}

function isSupportedPythonVersion(version) {
  const parsed = parseVersion(version);
  return Boolean(parsed && parsed[0] === 3 && parsed[1] === 14);
}

function readIgrepVersion(dependencies) {
  const output = runCommand(
    dependencies,
    "igrep version",
    "igrep",
    ["--version"],
    dependencies.env,
  ).trim();
  const match = /^igrep\s+(\S+)(?:\s|$)/.exec(output);
  if (match?.[1] !== IGREP_VERSION) {
    throw new BootstrapError(
      "IGREP_VERSION_MISMATCH",
      `igrep version mismatch; expected ${IGREP_VERSION}`,
    );
  }
  return match[1];
}

function readDshVersion(dependencies, dshHome) {
  const output = runCommand(
    dependencies,
    "dsh version",
    "npm",
    dshNpmArgs("dsh", "-V"),
    dshEnvironment(dependencies.env, dshHome),
  ).trim();
  const version = output.split(/\s+/).at(-1);
  if (version !== DSH_VERSION) {
    throw new BootstrapError(
      "DSH_VERSION_MISMATCH",
      `DSH version mismatch; expected ${DSH_VERSION}`,
    );
  }
  return version;
}

function discoverPlugin(profileName, dependencies, dshHome) {
  const output = runCommand(
    dependencies,
    `igrep dry-run for ${profileName}`,
    "igrep",
    [
      "setup",
      "deepseek-harness",
      "--profile",
      profileName,
      "--dry-run",
      "--json",
    ],
    dshEnvironment(dependencies.env, dshHome),
  );
  const plan = parseJsonObject(output, "IGREP_SETUP_PLAN_INVALID");
  const expectedPrefix = [
    "dsh",
    "plugin",
    "--profile",
    profileName,
    "add",
  ];
  if (
    plan.package !== PLUGIN_PACKAGE ||
    plan.profile !== profileName ||
    plan.dryRun !== true ||
    !Array.isArray(plan.command) ||
    expectedPrefix.some((value, index) => plan.command[index] !== value) ||
    plan.command.length !== expectedPrefix.length + 1
  ) {
    throw new BootstrapError(
      "IGREP_SETUP_PLAN_INVALID",
      `igrep returned an unexpected plugin plan for ${profileName}`,
    );
  }
  const fileSpec = plan.command.at(-1);
  const pluginPath = typeof fileSpec === "string" && fileSpec.startsWith("file:")
    ? fileSpec.slice("file:".length)
    : "";
  if (!path.isAbsolute(pluginPath)) {
    throw new BootstrapError(
      "PLUGIN_PATH_INVALID",
      `igrep did not resolve an absolute plugin path for ${profileName}`,
    );
  }
  validatePluginPackage(
    path.join(pluginPath, "package.json"),
    dependencies.fs,
  );
  return { pluginPath };
}

function setupProfiles(discoveries, dependencies, dshHome) {
  return discoveries.map((discovery) => {
    runCommand(
      dependencies,
      `igrep setup for ${discovery.profileName}`,
      "npm",
      dshNpmArgs(
        "igrep",
        "setup",
        "deepseek-harness",
        "--profile",
        discovery.profileName,
        "--json",
      ),
      dshEnvironment(dependencies.env, dshHome),
    );
    writeOwnedMinimalProfileManifest(
      discovery,
      dependencies.fs,
      dshHome,
    );
    writeOwnedProfilePatch(
      discovery.memoryMode,
      discovery.profileName,
      dependencies.fs,
      dshHome,
    );
    runCommand(
      dependencies,
      `dsh plugin install for ${discovery.profileName}`,
      "npm",
      dshNpmArgs(
        "dsh",
        "plugin",
        "--profile",
        discovery.profileName,
        "install",
      ),
      dshEnvironment(dependencies.env, dshHome),
    );
    const configDigest = dumpProfileConfigDigest(
      discovery,
      dependencies,
      dshHome,
    );
    // Loading the profile is what makes DSH materialize/repair the plugin's
    // peer graph in a clean DSH_HOME. Validate that graph only after the dump.
    const validated = validateProfile(discovery, dependencies.fs, dshHome);
    return {
      memoryMode: discovery.memoryMode,
      name: discovery.profileName,
      pluginPath: discovery.pluginPath,
      installedPluginPath: validated.installedPluginPath,
      configDigest,
      profileInputDigest: computeProfileInputDigest(
        discovery,
        validated,
        dependencies.fs,
        dshHome,
      ),
    };
  });
}

function checkProfiles(discoveries, dependencies, dshHome) {
  const validatedProfiles = discoveries.map((discovery) => {
    const validated = validateProfile(discovery, dependencies.fs, dshHome);
    return {
      discovery,
      validated,
      configDigest: dumpProfileConfigDigest(
        discovery,
        dependencies,
        dshHome,
      ),
      profileInputDigest: computeProfileInputDigest(
        discovery,
        validated,
        dependencies.fs,
        dshHome,
      ),
    };
  });
  const state = readBootstrapState(dependencies.fs, dshHome);
  return validatedProfiles.map(({
    discovery,
    validated,
    configDigest,
    profileInputDigest,
  }) => {
    const expected = state.profiles[discovery.memoryMode];
    if (
      expected.name !== discovery.profileName ||
      expected.pluginPath !== discovery.pluginPath
    ) {
      throw new BootstrapError(
        "PLUGIN_PATH_MISMATCH",
        `persisted plugin identity differs for ${discovery.profileName}`,
      );
    }
    if (expected.profileInputDigest !== profileInputDigest) {
      throw new BootstrapError(
        "PROFILE_DIGEST_MISMATCH",
        `profile inputs changed after setup for ${discovery.profileName}`,
      );
    }
    if (expected.configDigest !== configDigest) {
      throw new BootstrapError(
        "PROFILE_CONFIG_DIGEST_MISMATCH",
        `effective DSH config changed after setup for ${discovery.profileName}`,
      );
    }
    return {
      memoryMode: discovery.memoryMode,
      name: discovery.profileName,
      pluginPath: discovery.pluginPath,
      installedPluginPath: validated.installedPluginPath,
      configDigest,
      profileInputDigest,
    };
  });
}

function validateProfile(discovery, fs, dshHome) {
  const profileDir = path.join(dshHome, "profiles", discovery.profileName);
  const manifestPath = path.join(profileDir, "package.json");
  const manifest = readJsonFile(fs, manifestPath, "PROFILE_MANIFEST_INVALID");
  const expectedSpec = `file:${discovery.pluginPath}`;
  if (manifest.dependencies?.[PLUGIN_PACKAGE] !== expectedSpec) {
    throw new BootstrapError(
      "PLUGIN_PATH_MISMATCH",
      `${discovery.profileName} does not point at the igrep-owned plugin package`,
    );
  }
  if (JSON.stringify(manifest.dsh?.profile?.bundles) !== JSON.stringify([PLUGIN_PACKAGE])) {
    throw new BootstrapError(
      "PROFILE_BUNDLE_MISMATCH",
      `${discovery.profileName} must load only ${PLUGIN_PACKAGE}`,
    );
  }
  for (const peerPackage of PLUGIN_PEERS) {
    if (manifest.dependencies?.[peerPackage] !== DSH_VERSION) {
      throw new BootstrapError(
        "PLUGIN_PEER_VERSION_MISMATCH",
        `${discovery.profileName} must pin ${peerPackage} to ${DSH_VERSION}`,
      );
    }
  }
  const profilePatchPath = path.join(profileDir, "cordis.patch.yml");
  const expectedPatch = renderOwnedProfilePatch(discovery.memoryMode);
  if (
    !fs.existsSync(profilePatchPath) ||
    String(fs.readFileSync(profilePatchPath, "utf8")) !== expectedPatch
  ) {
    throw new BootstrapError(
      "PROFILE_PATCH_MISMATCH",
      `${discovery.profileName} does not carry the owned companion capability patch`,
    );
  }
  const installedPluginPath = path.join(
    profileDir,
    "node_modules",
    ...PLUGIN_PACKAGE.split("/"),
  );
  const installedManifestPath = path.join(installedPluginPath, "package.json");
  validatePluginPackage(installedManifestPath, fs);
  const installedManifest = readJsonFile(
    fs,
    installedManifestPath,
    "PLUGIN_MANIFEST_INVALID",
  );
  const patch = installedManifest.dsh.bundle.patch;
  const installedPatchPath = path.join(installedPluginPath, patch);
  if (!fs.existsSync(installedPatchPath)) {
    throw new BootstrapError(
      "PLUGIN_BUNDLE_MISSING",
      `${PLUGIN_PACKAGE} bundle patch is missing from ${discovery.profileName}`,
    );
  }
  const peerManifestPaths = PLUGIN_PEERS.map((peerPackage) => {
    const peerManifestPath = path.join(
      dshHome,
      "profiles",
      "node_modules",
      ...peerPackage.split("/"),
      "package.json",
    );
    const peerManifest = readJsonFile(
      fs,
      peerManifestPath,
      "PLUGIN_PEER_MISSING",
    );
    if (peerManifest.name !== peerPackage || peerManifest.version !== DSH_VERSION) {
      throw new BootstrapError(
        "PLUGIN_PEER_VERSION_MISMATCH",
        `${peerPackage} must resolve to the pinned DSH version`,
      );
    }
    return [peerPackage, peerManifestPath];
  });
  return {
    profileDir,
    profilePatchPath,
    installedPluginPath,
    installedPatchPath,
    peerManifestPaths,
  };
}

function writeOwnedMinimalProfileManifest(discovery, fs, dshHome) {
  const manifestPath = path.join(
    dshHome,
    "profiles",
    discovery.profileName,
    "package.json",
  );
  const manifest = readJsonFile(fs, manifestPath, "PROFILE_MANIFEST_INVALID");
  manifest.dependencies = {
    ...(manifest.dependencies ?? {}),
    ...Object.fromEntries(PLUGIN_PEERS.map((peerPackage) => [peerPackage, DSH_VERSION])),
  };
  manifest.dsh = {
    ...(manifest.dsh ?? {}),
    profile: {
      ...(manifest.dsh?.profile ?? {}),
      bundles: [PLUGIN_PACKAGE],
    },
  };
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function writeOwnedProfilePatch(memoryMode, profileName, fs, dshHome) {
  const profilePatchPath = path.join(
    dshHome,
    "profiles",
    profileName,
    "cordis.patch.yml",
  );
  fs.writeFileSync(
    profilePatchPath,
    renderOwnedProfilePatch(memoryMode),
    { encoding: "utf8", mode: 0o600 },
  );
}

function renderOwnedProfilePatch(memoryMode) {
  const capabilities = PROFILE_CAPABILITIES[memoryMode];
  return [
    "# SPEC: iDream owns this dedicated profile overlay; bootstrap rewrites it exactly.",
    "- id: igrep",
    "  config:",
    ...Object.entries(capabilities).map(
      ([name, enabled]) => `    ${name}: ${enabled}`,
    ),
    "",
  ].join("\n");
}

function dumpProfileConfigDigest(discovery, dependencies, dshHome) {
  const configDump = runCommand(
    dependencies,
    `dsh config dump for ${discovery.profileName}`,
    "npm",
    dshNpmArgs(
      "dsh",
      "--profile",
      discovery.profileName,
      "--dump-config",
    ),
    dshEnvironment(dependencies.env, dshHome),
  );
  if (!configDump.trim()) {
    throw new BootstrapError(
      "DSH_CONFIG_DUMP_EMPTY",
      `DSH returned an empty config dump for ${discovery.profileName}`,
    );
  }
  const entryIds = [...configDump.matchAll(/^\s*-\s+id:\s+([^\s#]+)\s*$/gm)]
    .map((match) => match[1]);
  const unexpectedEntries = entryIds.filter((id) => id !== "igrep");
  if (!entryIds.includes("igrep") || unexpectedEntries.length > 0) {
    throw new BootstrapError(
      "PROFILE_FORBIDDEN_PLUGIN",
      `${discovery.profileName} dump must contain only the igrep entry`,
    );
  }
  for (const [capability, enabled] of Object.entries(
    PROFILE_CAPABILITIES[discovery.memoryMode],
  )) {
    const line = new RegExp(`^\\s*${capability}:\\s*${enabled}\\s*$`, "m");
    if (!line.test(configDump)) {
      throw new BootstrapError(
        "PROFILE_CAPABILITY_MISMATCH",
        `${discovery.profileName} dump lacks the required ${capability} capability`,
      );
    }
  }
  return sha256(normalizeConfigDump(configDump));
}

function validatePluginPackage(manifestPath, fs) {
  const manifest = readJsonFile(fs, manifestPath, "PLUGIN_MANIFEST_INVALID");
  if (manifest.name !== PLUGIN_PACKAGE) {
    throw new BootstrapError(
      "PLUGIN_PACKAGE_MISMATCH",
      `igrep plugin manifest is not ${PLUGIN_PACKAGE}`,
    );
  }
  if (manifest.version !== IGREP_PLUGIN_VERSION) {
    throw new BootstrapError(
      "PLUGIN_VERSION_MISMATCH",
      `${PLUGIN_PACKAGE} version mismatch; expected ${IGREP_PLUGIN_VERSION}`,
    );
  }
  if (
    typeof manifest.dsh?.bundle?.patch !== "string" ||
    !manifest.dsh.bundle.patch
  ) {
    throw new BootstrapError(
      "PLUGIN_BUNDLE_MISSING",
      `${PLUGIN_PACKAGE} does not declare a DSH bundle patch`,
    );
  }
  for (const peerPackage of PLUGIN_PEERS) {
    if (manifest.peerDependencies?.[peerPackage] !== `^${DSH_VERSION}`) {
      throw new BootstrapError(
        "PLUGIN_PEER_RANGE_MISMATCH",
        `${PLUGIN_PACKAGE} must declare the pinned ${peerPackage} peer range`,
      );
    }
  }
}

function computeProfileInputDigest(discovery, validated, fs, dshHome) {
  const sourceManifest = readJsonFile(
    fs,
    path.join(discovery.pluginPath, "package.json"),
    "PLUGIN_MANIFEST_INVALID",
  );
  const sourcePatchPath = path.join(
    discovery.pluginPath,
    sourceManifest.dsh.bundle.patch,
  );
  const inputs = [
    ["home-patch", path.join(dshHome, "cordis.patch.yml"), false],
    ["profile-manifest", path.join(validated.profileDir, "package.json"), true],
    ["profile-lock", path.join(validated.profileDir, "pnpm-lock.yaml"), true],
    ["profile-patch", validated.profilePatchPath, true],
    ["plugin-source-manifest", path.join(discovery.pluginPath, "package.json"), true],
    ["plugin-source-patch", sourcePatchPath, true],
    ["plugin-installed-manifest", path.join(validated.installedPluginPath, "package.json"), true],
    ["plugin-installed-patch", validated.installedPatchPath, true],
    ...validated.peerManifestPaths.map(([peerPackage, peerManifestPath]) => [
      `peer:${peerPackage}`,
      peerManifestPath,
      true,
    ]),
  ];
  const hash = createHash("sha256");
  for (const [label, file, required] of inputs) {
    hash.update(`${label}\0`);
    if (!fs.existsSync(file)) {
      if (required) {
        throw new BootstrapError(
          "PROFILE_INPUT_MISSING",
          `required profile input is missing: ${label}`,
        );
      }
      hash.update("missing\0");
      continue;
    }
    hash.update(String(fs.readFileSync(file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function writeBootstrapState(profiles, dependencies, dshHome) {
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    pins: {
      dsh: DSH_VERSION,
      igrep: IGREP_VERSION,
      plugin: IGREP_PLUGIN_VERSION,
    },
    profiles: Object.fromEntries(
      profiles.map((profile) => [
        profile.memoryMode,
        {
          name: profile.name,
          pluginPath: profile.pluginPath,
          configDigest: profile.configDigest,
          profileInputDigest: profile.profileInputDigest,
        },
      ]),
    ),
  };
  dependencies.fs.mkdirSync(dshHome, { recursive: true, mode: 0o700 });
  dependencies.fs.writeFileSync(
    path.join(dshHome, STATE_FILENAME),
    `${JSON.stringify(state, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function readBootstrapState(fs, dshHome) {
  const statePath = path.join(dshHome, STATE_FILENAME);
  if (!fs.existsSync(statePath)) {
    throw new BootstrapError(
      "BOOTSTRAP_STATE_MISSING",
      "companion profiles have not completed a verified setup",
    );
  }
  const state = readJsonFile(fs, statePath, "BOOTSTRAP_STATE_INVALID");
  assertExactKeys(
    state,
    ["schemaVersion", "pins", "profiles"],
    "BOOTSTRAP_STATE_INVALID",
  );
  if (
    state.schemaVersion !== STATE_SCHEMA_VERSION ||
    state.pins?.dsh !== DSH_VERSION ||
    state.pins?.igrep !== IGREP_VERSION ||
    state.pins?.plugin !== IGREP_PLUGIN_VERSION
  ) {
    throw new BootstrapError(
      "BOOTSTRAP_STATE_INVALID",
      "companion bootstrap state does not match the pinned runtime versions",
    );
  }
  for (const memoryMode of Object.keys(PROFILE_NAMES)) {
    const profile = state.profiles?.[memoryMode];
    assertExactKeys(
      profile,
      ["name", "pluginPath", "configDigest", "profileInputDigest"],
      "BOOTSTRAP_STATE_INVALID",
    );
    if (
      !isSha256(profile.configDigest) ||
      !isSha256(profile.profileInputDigest)
    ) {
      throw new BootstrapError(
        "BOOTSTRAP_STATE_INVALID",
        `stored profile digests are invalid for ${memoryMode}`,
      );
    }
  }
  assertExactKeys(
    state.profiles,
    Object.keys(PROFILE_NAMES),
    "BOOTSTRAP_STATE_INVALID",
  );
  return state;
}

function assertExactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BootstrapError(code, "companion bootstrap state has an invalid shape");
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new BootstrapError(code, "companion bootstrap state has unexpected fields");
  }
}

function readJsonFile(fs, file, code) {
  try {
    return JSON.parse(String(fs.readFileSync(file, "utf8")));
  } catch {
    throw new BootstrapError(code, `cannot read required JSON metadata at ${file}`);
  }
}

function parseJsonObject(output, code) {
  try {
    const parsed = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new BootstrapError(code, "command returned invalid machine output");
  }
}

function runCommand(dependencies, label, command, args, env) {
  const result = dependencies.spawnSync(command, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result?.error) {
    throw new BootstrapError(
      "COMMAND_FAILED",
      `${label} could not start (${result.error.code ?? "spawn_error"})`,
    );
  }
  if (result?.status !== 0) {
    throw new BootstrapError(
      "COMMAND_FAILED",
      `${label} failed with exit code ${result?.status ?? "unknown"}`,
    );
  }
  return String(result.stdout ?? "");
}

function dshNpmArgs(...command) {
  return [
    "exec",
    "--yes",
    `--package=@deepseek-ai/dsh@${DSH_VERSION}`,
    "--",
    ...command,
  ];
}

function dshEnvironment(environment, dshHome) {
  return {
    ...environment,
    DSH_HOME: dshHome,
  };
}

function normalizeConfigDump(value) {
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
    .concat("\n");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value));
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : null;
}

function stripVersionPrefix(value) {
  return String(value).replace(/^v/, "");
}

function formatHumanReport(report) {
  return [
    `DSH companion ${report.mode} passed`,
    `DSH_HOME: ${report.dshHome}`,
    `versions: Node ${report.versions.node}, Python ${report.versions.python}, DSH ${report.versions.dsh}, igrep ${report.versions.igrep}, plugin ${report.versions.plugin}`,
    ...report.profiles.map(
      (profile) =>
        `${profile.memoryMode}: ${profile.name} config=${profile.configDigest} inputs=${profile.profileInputDigest}`,
    ),
    "",
  ].join("\n");
}

function publicFailure(error) {
  if (error instanceof BootstrapError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "UNEXPECTED_FAILURE",
    message: "unexpected bootstrap failure",
  };
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  executeCli();
}
