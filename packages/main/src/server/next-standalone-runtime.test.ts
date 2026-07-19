import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  configureRuntimeEnvironment,
  resolveStandaloneRuntime,
} = require("../../../../scripts/start-next-standalone.cjs") as {
  configureRuntimeEnvironment: (
    runtime: {
      repoRoot: string;
      releaseId: string;
      deploymentId: string;
    },
    env: NodeJS.ProcessEnv,
  ) => void;
  resolveStandaloneRuntime: (
    repoRoot: string,
    packagePath: string,
  ) => {
    releaseDir: string;
    releaseId: string;
    deploymentId: string;
    serverPath: string;
  };
};

const prepareScript = fileURLToPath(
  new URL("../../../../scripts/prepare-next-standalone.mjs", import.meta.url),
);
const workspaceRoot = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const temporaryRoots: string[] = [];

function createFixture(input: {
  packageDir: string;
  buildId: string;
  deploymentId: string;
  bundle: string;
}) {
  const packageName = path.basename(input.packageDir);
  const standaloneRoot = path.join(input.packageDir, ".next", "standalone");
  const standalonePackage = path.join(
    standaloneRoot,
    "packages",
    packageName,
  );
  mkdirSync(path.join(standalonePackage, ".next"), { recursive: true });
  mkdirSync(path.join(input.packageDir, ".next", "static", "chunks"), {
    recursive: true,
  });
  mkdirSync(path.join(input.packageDir, "public"), { recursive: true });
  writeFileSync(path.join(standalonePackage, "server.js"), "module.exports = {};\n");
  writeFileSync(
    path.join(standalonePackage, ".next", "BUILD_ID"),
    `${input.buildId}\n`,
  );
  writeFileSync(
    path.join(input.packageDir, ".next", "BUILD_ID"),
    `${input.buildId}\n`,
  );
  writeFileSync(
    path.join(input.packageDir, ".next", "required-server-files.json"),
    JSON.stringify({ config: { deploymentId: input.deploymentId } }),
  );
  writeFileSync(
    path.join(input.packageDir, ".next", "static", "chunks", "app.js"),
    input.bundle,
  );
  writeFileSync(
    path.join(input.packageDir, "public", "portrait.txt"),
    `portrait-${input.buildId}`,
  );
  writeFileSync(path.join(standaloneRoot, "shared.js"), "shared\n");
  symlinkSync(
    "../../shared.js",
    path.join(standalonePackage, "shared-link.js"),
  );
}

function publish(packageDir: string) {
  return spawnSync(process.execPath, [prepareScript, packageDir], {
    encoding: "utf8",
  });
}

function addTracingRootNodeModulesAlias(packageDir: string) {
  const tracingRoot = path.resolve(packageDir, "..", "..");
  const tracedNodeModules = path.join(tracingRoot, "node_modules");
  const standaloneNodeModules = path.join(
    packageDir,
    ".next",
    "standalone",
    "node_modules",
  );
  mkdirSync(tracedNodeModules, { recursive: true });
  mkdirSync(standaloneNodeModules, { recursive: true });
  writeFileSync(path.join(tracedNodeModules, "trace-marker.txt"), "traced\n");
  symlinkSync(
    tracedNodeModules,
    path.join(tracedNodeModules, "node_modules"),
  );
  symlinkSync(
    tracedNodeModules,
    path.join(standaloneNodeModules, "node_modules"),
  );
}

function addDanglingBunHoist(packageDir: string) {
  const tracingRoot = path.resolve(packageDir, "..", "..");
  const tracedBun = path.join(tracingRoot, "node_modules", ".bun");
  const tracedPackage = path.join(
    tracedBun,
    "semver@7.8.1",
    "node_modules",
    "semver",
  );
  const tracedHoists = path.join(tracedBun, "node_modules");
  const standaloneHoists = path.join(
    packageDir,
    ".next",
    "standalone",
    "node_modules",
    ".bun",
    "node_modules",
  );
  mkdirSync(tracedPackage, { recursive: true });
  mkdirSync(tracedHoists, { recursive: true });
  mkdirSync(standaloneHoists, { recursive: true });
  writeFileSync(
    path.join(tracedPackage, "package.json"),
    JSON.stringify({ name: "semver", version: "7.8.1" }),
  );
  const target = "../semver@7.8.1/node_modules/semver";
  symlinkSync(target, path.join(tracedHoists, "semver"));
  symlinkSync(target, path.join(standaloneHoists, "semver"));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("immutable Next standalone runtime releases", () => {
  it("keeps immutable runtime releases outside the ESLint source scope", () => {
    for (const packageName of ["main", "admin"]) {
      const config = readFileSync(
        path.join(workspaceRoot, "packages", packageName, "eslint.config.mjs"),
        "utf8",
      );
      expect(config).toContain('".next-runtime/**"');
    }
  });

  it("never lets Turbo cache away the release publication side effect", () => {
    const turbo = JSON.parse(
      readFileSync(path.join(workspaceRoot, "turbo.json"), "utf8"),
    ) as {
      tasks?: Record<string, { cache?: boolean }>;
    };
    expect(turbo.tasks?.["@idream/main#build"]?.cache).toBe(false);
    expect(turbo.tasks?.["@idream/admin#build"]?.cache).toBe(false);
  });

  it("keeps ISR disk writes disabled for both immutable web releases", () => {
    for (const packageName of ["main", "admin"]) {
      const source = readFileSync(
        path.join(workspaceRoot, "packages", packageName, "next.config.ts"),
        "utf8",
      );
      expect(source).toMatch(/isrFlushToDisk:\s*false/);
    }
  });

  it("keeps the previous release intact while atomically switching current", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "idream-next-runtime-"));
    temporaryRoots.push(repoRoot);
    const packageDir = path.join(repoRoot, "packages", "admin");
    createFixture({
      packageDir,
      buildId: "build-a",
      deploymentId: "deploy-a",
      bundle: "bundle-a",
    });

    const first = publish(packageDir);
    expect(first.status, first.stderr).toBe(0);
    const firstRelease = realpathSync(
      path.join(packageDir, ".next-runtime", "current"),
    );
    expect(path.basename(firstRelease)).toBe("deploy-a");
    expect(readFileSync(
      path.join(
        firstRelease,
        "packages",
        "admin",
        ".next",
        "static",
        "chunks",
        "app.js",
      ),
      "utf8",
    )).toBe("bundle-a");
    expect(readFileSync(
      path.join(firstRelease, "packages", "admin", "public", "portrait.txt"),
      "utf8",
    )).toBe("portrait-build-a");
    expect(readlinkSync(
      path.join(firstRelease, "packages", "admin", "shared-link.js"),
    )).toBe("../../shared.js");

    rmSync(path.join(packageDir, ".next"), { recursive: true });
    createFixture({
      packageDir,
      buildId: "build-b",
      deploymentId: "deploy-b",
      bundle: "bundle-b",
    });
    const second = publish(packageDir);
    expect(second.status, second.stderr).toBe(0);
    const secondRelease = realpathSync(
      path.join(packageDir, ".next-runtime", "current"),
    );

    expect(path.basename(secondRelease)).toBe("deploy-b");
    expect(secondRelease).not.toBe(firstRelease);
    expect(readFileSync(
      path.join(
        firstRelease,
        "packages",
        "admin",
        ".next",
        "static",
        "chunks",
        "app.js",
      ),
      "utf8",
    )).toBe("bundle-a");
    expect(readFileSync(
      path.join(
        secondRelease,
        "packages",
        "admin",
        ".next",
        "static",
        "chunks",
        "app.js",
      ),
      "utf8",
    )).toBe("bundle-b");
  });

  it("rewrites tracing-root absolute links into the immutable release", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "idream-next-runtime-"));
    temporaryRoots.push(repoRoot);
    const packageDir = path.join(repoRoot, "packages", "admin");
    createFixture({
      packageDir,
      buildId: "build-contained-link",
      deploymentId: "deploy-contained-link",
      bundle: "bundle",
    });
    addTracingRootNodeModulesAlias(packageDir);

    const result = publish(packageDir);
    expect(result.status, result.stderr).toBe(0);
    const release = realpathSync(
      path.join(packageDir, ".next-runtime", "current"),
    );
    const alias = path.join(release, "node_modules", "node_modules");
    expect(readlinkSync(alias)).toBe(".");
    expect(realpathSync(alias)).toBe(
      realpathSync(path.join(release, "node_modules")),
    );
  });

  it("materializes an exact missing Bun hoist target inside the release", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "idream-next-runtime-"));
    temporaryRoots.push(repoRoot);
    const packageDir = path.join(repoRoot, "packages", "main");
    createFixture({
      packageDir,
      buildId: "build-bun-hoist",
      deploymentId: "deploy-bun-hoist",
      bundle: "bundle",
    });
    addDanglingBunHoist(packageDir);

    const result = publish(packageDir);
    expect(result.status, result.stderr).toBe(0);
    const release = realpathSync(
      path.join(packageDir, ".next-runtime", "current"),
    );
    const hoist = path.join(
      release,
      "node_modules",
      ".bun",
      "node_modules",
      "semver",
    );
    expect(readlinkSync(hoist)).toBe(
      "../semver@7.8.1/node_modules/semver",
    );
    expect(JSON.parse(readFileSync(
      path.join(realpathSync(hoist), "package.json"),
      "utf8",
    ))).toMatchObject({ name: "semver", version: "7.8.1" });
  });

  it.each(["absolute", "relative"] as const)(
    "rejects an unexpected %s link without publishing current",
    (linkKind) => {
      const repoRoot = mkdtempSync(
        path.join(tmpdir(), "idream-next-runtime-"),
      );
      const externalRoot = mkdtempSync(
        path.join(tmpdir(), "idream-next-external-"),
      );
      temporaryRoots.push(repoRoot, externalRoot);
      const packageDir = path.join(repoRoot, "packages", "admin");
      createFixture({
        packageDir,
        buildId: `build-${linkKind}-escape`,
        deploymentId: `deploy-${linkKind}-escape`,
        bundle: "bundle",
      });
      const tracingRoot = path.resolve(packageDir, "..", "..");
      const standaloneRoot = path.join(
        packageDir,
        ".next",
        "standalone",
      );
      const externalTarget = path.join(externalRoot, "outside.js");
      writeFileSync(externalTarget, "outside\n");
      symlinkSync(
        linkKind === "absolute"
          ? externalTarget
          : path.relative(tracingRoot, externalTarget),
        path.join(tracingRoot, "escape-link"),
      );
      symlinkSync(
        linkKind === "absolute"
          ? externalTarget
          : path.relative(standaloneRoot, externalTarget),
        path.join(standaloneRoot, "escape-link"),
      );

      const result = publish(packageDir);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("outside the deployment root");
      expect(existsSync(
        path.join(packageDir, ".next-runtime", "current"),
      )).toBe(false);
    },
  );

  it("refuses to overwrite a release with the same deployment id", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "idream-next-runtime-"));
    temporaryRoots.push(repoRoot);
    const packageDir = path.join(repoRoot, "packages", "main");
    createFixture({
      packageDir,
      buildId: "same-build",
      deploymentId: "deploy-a",
      bundle: "first",
    });
    expect(publish(packageDir).status).toBe(0);

    rmSync(path.join(packageDir, ".next"), { recursive: true });
    createFixture({
      packageDir,
      buildId: "same-build",
      deploymentId: "deploy-a",
      bundle: "different",
    });
    const collision = publish(packageDir);

    expect(collision.status).not.toBe(0);
    expect(collision.stderr).toContain("already exists");
  });

  it("starts only from current and pins runtime paths before Next changes cwd", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "idream-next-runtime-"));
    temporaryRoots.push(repoRoot);
    const packageDir = path.join(repoRoot, "packages", "main");
    createFixture({
      packageDir,
      buildId: "build-current",
      deploymentId: "deploy-current",
      bundle: "bundle",
    });
    expect(publish(packageDir).status).toBe(0);

    const runtime = resolveStandaloneRuntime(repoRoot, packageDir);
    expect(runtime.serverPath).toBe(
      path.join(
        runtime.releaseDir,
        "packages",
        "main",
        "server.js",
      ),
    );
    expect(runtime.deploymentId).toBe("deploy-current");

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      BLOB_ROOT: "data/blob",
    };
    configureRuntimeEnvironment({ repoRoot, ...runtime }, env);
    expect(env.BLOB_ROOT).toBe(path.join(repoRoot, "data", "blob"));
    expect(env.IDREAM_REPO_ROOT).toBe(repoRoot);
    expect(env.IDREAM_NEXT_RELEASE_ID).toBe("deploy-current");
    expect(env.NEXT_DEPLOYMENT_ID).toBe("deploy-current");

    rmSync(path.join(packageDir, ".next-runtime", "current"));
    expect(() =>
      resolveStandaloneRuntime(repoRoot, packageDir)
    ).toThrow("Missing immutable standalone release");
  });

  it("keeps runtime cache writes inside the immutable fingerprint boundary", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "idream-next-runtime-"));
    temporaryRoots.push(repoRoot);
    const packageDir = path.join(repoRoot, "packages", "main");
    createFixture({
      packageDir,
      buildId: "build-runtime-cache",
      deploymentId: "deploy-runtime-cache",
      bundle: "bundle",
    });
    expect(publish(packageDir).status).toBe(0);
    const release = realpathSync(
      path.join(packageDir, ".next-runtime", "current"),
    );
    const fetchCache = path.join(
      release,
      "packages",
      "main",
      ".next",
      "cache",
      "fetch-cache",
    );
    mkdirSync(fetchCache, { recursive: true });
    writeFileSync(path.join(fetchCache, "runtime-entry"), "runtime data");

    expect(() =>
      resolveStandaloneRuntime(repoRoot, packageDir)
    ).toThrow("source fingerprint mismatch");
    const republish = publish(packageDir);
    expect(republish.status).not.toBe(0);
    expect(republish.stderr).toContain("failed its source fingerprint");
  });

  it("rejects a release whose link closure was tampered after publication", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "idream-next-runtime-"));
    const externalRoot = mkdtempSync(
      path.join(tmpdir(), "idream-next-external-"),
    );
    temporaryRoots.push(repoRoot, externalRoot);
    const packageDir = path.join(repoRoot, "packages", "main");
    createFixture({
      packageDir,
      buildId: "build-link-tamper",
      deploymentId: "deploy-link-tamper",
      bundle: "bundle",
    });
    expect(publish(packageDir).status).toBe(0);
    const release = realpathSync(
      path.join(packageDir, ".next-runtime", "current"),
    );
    symlinkSync(externalRoot, path.join(release, "tampered-link"));

    expect(() =>
      resolveStandaloneRuntime(repoRoot, packageDir)
    ).toThrow("absolute symbolic link");
  });

  it("rejects modified release bytes at startup and on same-id reuse", () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), "idream-next-runtime-"));
    temporaryRoots.push(repoRoot);
    const packageDir = path.join(repoRoot, "packages", "admin");
    createFixture({
      packageDir,
      buildId: "build-byte-tamper",
      deploymentId: "deploy-byte-tamper",
      bundle: "original",
    });
    expect(publish(packageDir).status).toBe(0);
    const release = realpathSync(
      path.join(packageDir, ".next-runtime", "current"),
    );
    writeFileSync(
      path.join(
        release,
        "packages",
        "admin",
        ".next",
        "static",
        "chunks",
        "app.js",
      ),
      "tampered",
    );

    expect(() =>
      resolveStandaloneRuntime(repoRoot, packageDir)
    ).toThrow("source fingerprint mismatch");
    const republish = publish(packageDir);
    expect(republish.status).not.toBe(0);
    expect(republish.stderr).toContain("failed its source fingerprint");
  });
});
