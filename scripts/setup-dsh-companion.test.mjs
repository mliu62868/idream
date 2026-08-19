import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DSH_VERSION,
  IGREP_PLUGIN_VERSION,
  IGREP_VERSION,
  PROFILE_NAMES,
  executeCli,
  isSupportedNodeVersion,
  parseCliArgs,
  runDshCompanionBootstrap,
} from "./setup-dsh-companion.mjs";

const DSH_HOME = "/virtual/dsh-home";
const PLUGIN_SOURCE =
  "/virtual/igrep/lib/python3.14/site-packages/igrep/data/deepseek-harness/igrep-dsh";

test("accepts only the pinned Node engine range", () => {
  assert.equal(isSupportedNodeVersion("v22.18.9"), false);
  assert.equal(isSupportedNodeVersion("22.19.0"), true);
  assert.equal(isSupportedNodeVersion("v22.22.3"), true);
  assert.equal(isSupportedNodeVersion("23.9.0"), false);
  assert.equal(isSupportedNodeVersion("24.0.0"), true);
  assert.equal(isSupportedNodeVersion("25.1.0"), true);
  assert.equal(isSupportedNodeVersion("latest"), false);
});

test("parses only the setup/check and machine-output switches", () => {
  assert.deepEqual(parseCliArgs([]), { check: false, json: false });
  assert.deepEqual(parseCliArgs(["--check", "--json"]), {
    check: true,
    json: true,
  });
  assert.throws(() => parseCliArgs(["--repair"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["--check", "--check"]), /duplicate argument/);
});

test("root scripts expose setup/check without installing DSH into the workspace", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    manifest.scripts["dsh-companion:setup"],
    "node scripts/setup-dsh-companion.mjs",
  );
  assert.equal(
    manifest.scripts["dsh-companion:check"],
    "node scripts/setup-dsh-companion.mjs --check",
  );
  assert.equal(manifest.dependencies?.["@deepseek-ai/dsh"], undefined);
  assert.equal(manifest.devDependencies?.["@deepseek-ai/dsh"], undefined);
});

test("setup materializes both official profiles, dumps with the same DSH_HOME, and persists only digests", () => {
  const fixture = createFixture({ materialized: false });
  const report = runDshCompanionBootstrap(
    { check: false },
    fixture.dependencies,
  );

  assert.equal(report.ok, true);
  assert.equal(report.mode, "setup");
  assert.deepEqual(report.versions, {
    node: "22.22.3",
    python: "3.14.3",
    dsh: DSH_VERSION,
    igrep: IGREP_VERSION,
    plugin: IGREP_PLUGIN_VERSION,
  });
  assert.deepEqual(
    report.profiles.map((profile) => [profile.memoryMode, profile.name]),
    [
      ["normal", PROFILE_NAMES.normal],
      ["private", PROFILE_NAMES.private],
    ],
  );
  for (const profile of report.profiles) {
    assert.match(profile.configDigest, /^[a-f0-9]{64}$/);
    assert.match(profile.profileInputDigest, /^[a-f0-9]{64}$/);
    assert.equal(profile.pluginPath, PLUGIN_SOURCE);
  }
  assert.notEqual(report.profiles[0].configDigest, report.profiles[1].configDigest);

  const setupCalls = fixture.calls.filter((call) =>
    call.args.includes("deepseek-harness") && !call.args.includes("--dry-run")
  );
  assert.deepEqual(
    setupCalls.map((call) => call.args.slice(-4)),
    [
      ["--profile", PROFILE_NAMES.normal, "--json"],
      ["--profile", PROFILE_NAMES.private, "--json"],
    ].map((tail) => ["deepseek-harness", ...tail]),
  );
  const dumps = fixture.calls.filter((call) => call.args.includes("--dump-config"));
  assert.deepEqual(
    dumps.map((call) => call.options.env.DSH_HOME),
    [DSH_HOME, DSH_HOME],
  );
  assert.ok(
    dumps.every((call) =>
      call.args.includes(`--package=@deepseek-ai/dsh@${DSH_VERSION}`)
    ),
  );

  const state = fixture.fs.readJson(path.join(DSH_HOME, "idream-companion-bootstrap.json"));
  assert.equal(state.schemaVersion, 1);
  assert.equal(JSON.stringify(state).includes("super-secret-token"), false);
  assert.equal(JSON.stringify(report).includes("super-secret-token"), false);
  const normalPatch = fixture.fs.readFileSync(path.join(
    DSH_HOME,
    "profiles",
    PROFILE_NAMES.normal,
    "cordis.patch.yml",
  ));
  const privatePatch = fixture.fs.readFileSync(path.join(
    DSH_HOME,
    "profiles",
    PROFILE_NAMES.private,
    "cordis.patch.yml",
  ));
  assert.match(normalPatch, /memory: true/);
  assert.match(normalPatch, /ingest: true/);
  assert.match(normalPatch, /wake: true/);
  assert.match(privatePatch, /search: false/);
  assert.match(privatePatch, /webProvider: false/);
  assert.match(privatePatch, /webTool: false/);
  assert.match(privatePatch, /memory: false/);
  assert.match(privatePatch, /ingest: false/);
  assert.match(privatePatch, /wake: false/);
});

test("--check is read-only and verifies the persisted dump/input digests", () => {
  const fixture = createFixture({ materialized: false });
  runDshCompanionBootstrap({ check: false }, fixture.dependencies);
  fixture.fs.resetMutations();
  fixture.calls.length = 0;

  const report = runDshCompanionBootstrap(
    { check: true },
    fixture.dependencies,
  );

  assert.equal(report.mode, "check");
  assert.deepEqual(fixture.fs.mutations, []);
  assert.equal(
    fixture.calls.some((call) =>
      call.args.includes("deepseek-harness") && !call.args.includes("--dry-run")
    ),
    false,
  );
  assert.equal(
    fixture.calls.filter((call) => call.args.includes("--dump-config")).length,
    2,
  );
  assert.ok(
    fixture.calls
      .filter((call) => call.args.includes("--dump-config"))
      .every((call) => call.options.env.DSH_HOME === DSH_HOME),
  );
});

test("--check fails closed when profile inputs drift after setup", () => {
  const fixture = createFixture({ materialized: false });
  runDshCompanionBootstrap({ check: false }, fixture.dependencies);
  const patchPath = path.join(
    DSH_HOME,
    "profiles",
    PROFILE_NAMES.normal,
    "cordis.patch.yml",
  );
  fixture.fs.seed(patchPath, "- id: unexpected-drift\n");
  fixture.fs.resetMutations();

  assert.throws(
    () => runDshCompanionBootstrap({ check: true }, fixture.dependencies),
    (error) => error?.code === "PROFILE_PATCH_MISMATCH",
  );
  assert.deepEqual(fixture.fs.mutations, []);
});

test("--check recomputes and rejects a changed effective DSH dump", () => {
  const fixture = createFixture({ materialized: false });
  runDshCompanionBootstrap({ check: false }, fixture.dependencies);
  fixture.control.dumpDrift = true;
  fixture.fs.resetMutations();

  assert.throws(
    () => runDshCompanionBootstrap({ check: true }, fixture.dependencies),
    (error) => error?.code === "PROFILE_CONFIG_DIGEST_MISMATCH",
  );
  assert.deepEqual(fixture.fs.mutations, []);
});

test("--json emits one secret-free machine document and failure sets a non-zero exit", () => {
  const successFixture = createFixture({ materialized: false });
  let successOutput = "";
  const success = executeCli(["--json"], {
    ...successFixture.dependencies,
    stdout: { write: (value) => { successOutput += value; } },
    stderr: { write: () => {} },
    setExitCode: () => assert.fail("successful setup must not set an exit code"),
  });
  assert.equal(success.ok, true);
  assert.equal(JSON.parse(successOutput).ok, true);
  assert.equal(successOutput.includes("super-secret-token"), false);

  const failureFixture = createFixture({ failLabel: "dsh version" });
  let failureOutput = "";
  let exitCode = 0;
  const failure = executeCli(["--check", "--json"], {
    ...failureFixture.dependencies,
    stdout: { write: () => {} },
    stderr: { write: (value) => { failureOutput += value; } },
    setExitCode: (value) => { exitCode = value; },
  });
  assert.equal(failure.ok, false);
  assert.equal(exitCode, 1);
  assert.equal(JSON.parse(failureOutput).error.code, "COMMAND_FAILED");
  assert.equal(failureOutput.includes("super-secret-token"), false);
});

test("fails closed on runtime, igrep, Python, command, and plugin identity mismatches", async (t) => {
  await t.test("Node", () => {
    const fixture = createFixture({ nodeVersion: "23.1.0" });
    assert.throws(
      () => runDshCompanionBootstrap({ check: false }, fixture.dependencies),
      (error) => error?.code === "NODE_VERSION_MISMATCH",
    );
  });
  await t.test("igrep", () => {
    const fixture = createFixture({ igrepVersion: "0.1.133" });
    assert.throws(
      () => runDshCompanionBootstrap({ check: false }, fixture.dependencies),
      (error) => error?.code === "IGREP_VERSION_MISMATCH",
    );
  });
  await t.test("Python", () => {
    const fixture = createFixture({ pythonVersion: "3.13.9" });
    assert.throws(
      () => runDshCompanionBootstrap({ check: false }, fixture.dependencies),
      (error) => error?.code === "PYTHON_VERSION_MISMATCH",
    );
  });
  await t.test("DSH", () => {
    const fixture = createFixture({ dshVersion: "0.1.0" });
    assert.throws(
      () => runDshCompanionBootstrap({ check: false }, fixture.dependencies),
      (error) => error?.code === "DSH_VERSION_MISMATCH",
    );
  });
  await t.test("spawn exit", () => {
    const fixture = createFixture({ failLabel: "dsh version" });
    assert.throws(
      () => runDshCompanionBootstrap({ check: false }, fixture.dependencies),
      (error) =>
        error?.code === "COMMAND_FAILED" &&
        !error.message.includes("super-secret-token"),
    );
  });
  await t.test("plugin source version", () => {
    const fixture = createFixture({ pluginVersion: "0.1.1" });
    assert.throws(
      () => runDshCompanionBootstrap({ check: false }, fixture.dependencies),
      (error) => error?.code === "PLUGIN_VERSION_MISMATCH",
    );
  });
  await t.test("plugin peer version", () => {
    const fixture = createFixture({
      materialized: false,
      peerVersion: "0.1.0",
    });
    assert.throws(
      () => runDshCompanionBootstrap({ check: false }, fixture.dependencies),
      (error) => error?.code === "PLUGIN_PEER_VERSION_MISMATCH",
    );
  });
  await t.test("profile plugin path", () => {
    const fixture = createFixture({ profilePluginPath: "/wrong/plugin" });
    assert.throws(
      () => runDshCompanionBootstrap({ check: true }, fixture.dependencies),
      (error) => error?.code === "PLUGIN_PATH_MISMATCH",
    );
  });
});

function createFixture(options = {}) {
  const fs = createMemoryFs();
  const calls = [];
  const control = { dumpDrift: false };
  const igrepExecutable = "/virtual/bin/igrep";
  const pythonExecutable = "/virtual/python3.14";
  fs.seed(igrepExecutable, `#!${pythonExecutable}\n`);
  seedPluginSource(fs, options.pluginVersion ?? IGREP_PLUGIN_VERSION);
  if (options.materialized !== false) {
    for (const profile of Object.values(PROFILE_NAMES)) {
      materializeProfile(fs, profile, options.profilePluginPath ?? PLUGIN_SOURCE);
    }
  }

  const spawnSync = (command, args, spawnOptions) => {
    calls.push({ command, args: [...args], options: spawnOptions });
    const label = identifyCall(command, args);
    if (options.failLabel === label) {
      return {
        status: 71,
        stdout: "",
        stderr: "failed with super-secret-token",
      };
    }
    if (label === "which igrep") return success(`${igrepExecutable}\n`);
    if (label === "python version") {
      return success(`Python ${options.pythonVersion ?? "3.14.3"}\n`);
    }
    if (label === "igrep version") {
      return success(`igrep ${options.igrepVersion ?? IGREP_VERSION}\n`);
    }
    if (label === "dsh version") {
      return success(`${options.dshVersion ?? DSH_VERSION}\n`);
    }
    if (label === "igrep dry-run") {
      const profile = readArg(args, "--profile");
      return success(JSON.stringify({
        pluginId: "igrep-dsh",
        package: "@igrep/dsh-plugin",
        profile,
        command: [
          "dsh",
          "plugin",
          "--profile",
          profile,
          "add",
          `file:${PLUGIN_SOURCE}`,
        ],
        action: "installed",
        dryRun: true,
      }));
    }
    if (label === "igrep setup") {
      const profile = readArg(args, "--profile");
      materializeProfile(
        fs,
        profile,
        PLUGIN_SOURCE,
        options.peerVersion ?? DSH_VERSION,
      );
      return success(JSON.stringify({
        package: "@igrep/dsh-plugin",
        profile,
        action: "installed",
      }));
    }
    if (label === "dsh dump") {
      const profile = readArg(args, "--profile");
      const capabilities = profile === PROFILE_NAMES.private
        ? {
            search: false,
            webProvider: false,
            webTool: false,
            memory: false,
            ingest: false,
            wake: false,
          }
        : {
            search: true,
            webProvider: true,
            webTool: false,
            memory: true,
            ingest: true,
            wake: true,
          };
      return success([
        `# profile ${profile}`,
        "- id: igrep-dsh",
        "  config:",
        ...Object.entries(capabilities).map(
          ([name, enabled]) => `    ${name}: ${enabled}`,
        ),
        "    apiKey: super-secret-token",
        ...(control.dumpDrift ? ["    drift: true"] : []),
        "",
      ].join("\n"));
    }
    throw new Error(`unexpected spawn: ${command} ${args.join(" ")}`);
  };

  return {
    calls,
    control,
    fs,
    dependencies: {
      fs,
      spawnSync,
      env: {
        DSH_HOME,
        DEEPSEEK_API_KEY: "super-secret-token",
      },
      homedir: () => "/must-not-be-used",
      nodeVersion: options.nodeVersion ?? "22.22.3",
    },
  };
}

function identifyCall(command, args) {
  if (command === "which" && args[0] === "igrep") return "which igrep";
  if (command === "/virtual/python3.14") return "python version";
  if (command === "igrep" && args[0] === "--version") return "igrep version";
  if (command === "npm" && args.includes("-V")) return "dsh version";
  if (command === "igrep" && args.includes("--dry-run")) return "igrep dry-run";
  if (command === "npm" && args.includes("deepseek-harness")) return "igrep setup";
  if (command === "npm" && args.includes("--dump-config")) return "dsh dump";
  return "unknown";
}

function success(stdout) {
  return { status: 0, stdout, stderr: "" };
}

function readArg(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function seedPluginSource(fs, version) {
  fs.seed(
    path.join(PLUGIN_SOURCE, "package.json"),
    JSON.stringify({
      name: "@igrep/dsh-plugin",
      version,
      dsh: { bundle: { patch: "cordis.patch.yml" } },
      peerDependencies: {
        "@deepseek-ai/dsh-llm": `^${DSH_VERSION}`,
        "@deepseek-ai/dsh-tools": `^${DSH_VERSION}`,
      },
    }),
  );
  fs.seed(path.join(PLUGIN_SOURCE, "cordis.patch.yml"), "- id: igrep-dsh\n");
}

function materializeProfile(fs, profile, pluginPath, peerVersion = DSH_VERSION) {
  const profileDir = path.join(DSH_HOME, "profiles", profile);
  const dependency = `file:${pluginPath}`;
  fs.seed(
    path.join(profileDir, "package.json"),
    JSON.stringify({
      name: `dsh-profile-${profile}`,
      dependencies: { "@igrep/dsh-plugin": dependency },
      dsh: { profile: { bundles: ["@igrep/dsh-plugin"] } },
    }),
  );
  fs.seed(path.join(profileDir, "pnpm-lock.yaml"), `plugin: ${dependency}\n`);
  fs.seed(path.join(profileDir, "cordis.patch.yml"), "[]\n");
  const installed = path.join(
    profileDir,
    "node_modules",
    "@igrep",
    "dsh-plugin",
  );
  fs.seed(
    path.join(installed, "package.json"),
    fs.readFileSync(path.join(PLUGIN_SOURCE, "package.json"), "utf8"),
  );
  fs.seed(
    path.join(installed, "cordis.patch.yml"),
    fs.readFileSync(path.join(PLUGIN_SOURCE, "cordis.patch.yml"), "utf8"),
  );
  for (const peerPackage of [
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-tools",
  ]) {
    fs.seed(
      path.join(DSH_HOME, "profiles", "node_modules", ...peerPackage.split("/"), "package.json"),
      JSON.stringify({ name: peerPackage, version: peerVersion }),
    );
  }
}

function createMemoryFs() {
  const files = new Map();
  const mutations = [];
  return {
    mutations,
    seed(file, content) {
      files.set(path.normalize(file), String(content));
    },
    resetMutations() {
      mutations.length = 0;
    },
    existsSync(file) {
      return files.has(path.normalize(file));
    },
    readFileSync(file) {
      const normalized = path.normalize(file);
      if (!files.has(normalized)) {
        const error = new Error(`ENOENT: ${normalized}`);
        error.code = "ENOENT";
        throw error;
      }
      return files.get(normalized);
    },
    writeFileSync(file, content) {
      const normalized = path.normalize(file);
      mutations.push(["writeFileSync", normalized]);
      files.set(normalized, String(content));
    },
    mkdirSync(file) {
      mutations.push(["mkdirSync", path.normalize(file)]);
    },
    readJson(file) {
      return JSON.parse(this.readFileSync(file, "utf8"));
    },
  };
}
