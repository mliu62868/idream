#!/usr/bin/env node
const {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
} = require("node:fs");
const path = require("node:path");
const {
  assertSelfContainedSymlinks,
  fingerprintDirectory,
} = require("./next-standalone-integrity.cjs");

const repoRoot = path.resolve(__dirname, "..");

function start(packagePath) {
  if (!packagePath) {
    throw new Error(
      "Usage: node scripts/start-next-standalone.cjs <package-path>",
    );
  }

  const packageDir = path.resolve(repoRoot, packagePath);
  loadEnv(path.join(packageDir, ".env"));
  const runtime = resolveStandaloneRuntime(repoRoot, packagePath);
  configureRuntimeEnvironment({ repoRoot, ...runtime }, process.env);
  require(runtime.serverPath);
}

function resolveStandaloneRuntime(root, packagePath) {
  const packageDir = path.resolve(root, packagePath);
  const packageName = path.basename(packageDir);
  const runtimeRoot = path.join(packageDir, ".next-runtime");
  const releasesRoot = path.join(runtimeRoot, "releases");
  const current = path.join(runtimeRoot, "current");

  if (!existsSync(current) || !lstatSync(current).isSymbolicLink()) {
    throw new Error(
      `Missing immutable standalone release for ${packagePath}; run the package build before starting`,
    );
  }
  const releaseDir = realpathSync(current);
  const canonicalReleasesRoot = realpathSync(releasesRoot);
  const releaseRelative = path.relative(canonicalReleasesRoot, releaseDir);
  if (
    !releaseRelative ||
    releaseRelative.startsWith("..") ||
    path.isAbsolute(releaseRelative)
  ) {
    throw new Error(
      `Current standalone release resolves outside ${canonicalReleasesRoot}`,
    );
  }
  assertSelfContainedSymlinks(releaseDir);

  const metadataPath = path.join(releaseDir, "release.json");
  requireFile(metadataPath, "Immutable standalone release metadata is missing");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (
    metadata.packageName !== packageName ||
    typeof metadata.buildId !== "string" ||
    !metadata.buildId ||
    typeof metadata.sourceFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.sourceFingerprint)
  ) {
    throw new Error(`Invalid standalone release metadata at ${metadataPath}`);
  }
  const sourceFingerprint = fingerprintDirectory(releaseDir);
  if (sourceFingerprint !== metadata.sourceFingerprint) {
    throw new Error(
      `Immutable standalone release source fingerprint mismatch at ${releaseDir}`,
    );
  }
  const deploymentId =
    typeof metadata.deploymentId === "string" && metadata.deploymentId
      ? metadata.deploymentId
      : metadata.buildId;
  const releaseId =
    typeof metadata.releaseId === "string" && metadata.releaseId
      ? metadata.releaseId
      : path.basename(releaseDir);
  if (releaseId !== path.basename(releaseDir)) {
    throw new Error(
      `Immutable standalone release ID mismatch: ${releaseId}`,
    );
  }
  if (deploymentId !== releaseId) {
    throw new Error(
      `Immutable standalone deployment ID mismatch: ${deploymentId}`,
    );
  }
  const standalonePackage = path.join(
    releaseDir,
    "packages",
    packageName,
  );
  const serverPath = path.join(standalonePackage, "server.js");
  const buildIdPath = path.join(standalonePackage, ".next", "BUILD_ID");
  const staticDir = path.join(standalonePackage, ".next", "static");
  requireFile(serverPath, "Immutable standalone release is missing server.js");
  requireFile(buildIdPath, "Immutable standalone release is missing BUILD_ID");
  requireDirectory(
    staticDir,
    "Immutable standalone release is missing static assets",
  );
  if (!directoryContainsFile(staticDir)) {
    throw new Error("Immutable standalone release has no static assets");
  }
  const publishedBuildId = readFileSync(buildIdPath, "utf8").trim();
  if (publishedBuildId !== metadata.buildId) {
    throw new Error(
      `Immutable standalone BUILD_ID mismatch: ${publishedBuildId}`,
    );
  }

  return {
    releaseDir,
    releaseId,
    deploymentId,
    serverPath,
  };
}

function configureRuntimeEnvironment(runtime, env) {
  env.IDREAM_REPO_ROOT = runtime.repoRoot;
  env.IDREAM_NEXT_RELEASE_ID = runtime.releaseId;
  if (
    env.NEXT_DEPLOYMENT_ID &&
    env.NEXT_DEPLOYMENT_ID !== runtime.deploymentId
  ) {
    throw new Error(
      `NEXT_DEPLOYMENT_ID ${env.NEXT_DEPLOYMENT_ID} does not match immutable release ${runtime.deploymentId}`,
    );
  }
  env.NEXT_DEPLOYMENT_ID = runtime.deploymentId;
  env.ADMIN_MODEL_LIBRARY_DIR ??= path.join(
    runtime.repoRoot,
    "data",
    "model-imports",
  );
  env.BLOB_ROOT = env.BLOB_ROOT?.trim()
    ? path.isAbsolute(env.BLOB_ROOT)
      ? path.resolve(env.BLOB_ROOT)
      : path.resolve(runtime.repoRoot, env.BLOB_ROOT)
    : path.join(runtime.repoRoot, "data", "blob");
}

function loadEnv(envPath) {
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!match) continue;

    const [, key, rawValue = ""] = match;
    if (process.env[key] !== undefined) continue;

    process.env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  const quote = trimmed[0];
  if (
    (quote === "\"" || quote === "'") &&
    trimmed.length >= 2 &&
    trimmed[trimmed.length - 1] === quote
  ) {
    const unquoted = trimmed.slice(1, -1);
    return quote === "\""
      ? unquoted.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
      : unquoted;
  }

  return trimmed.replace(/\s+#.*$/, "");
}

function directoryContainsFile(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && directoryContainsFile(target)) return true;
  }
  return false;
}

function requireFile(filePath, message) {
  if (!existsSync(filePath) || !lstatSync(filePath).isFile()) {
    throw new Error(message);
  }
}

function requireDirectory(directory, message) {
  if (!existsSync(directory) || !lstatSync(directory).isDirectory()) {
    throw new Error(message);
  }
}

if (require.main === module) {
  start(process.argv[2]);
}

module.exports = {
  configureRuntimeEnvironment,
  loadEnv,
  parseEnvValue,
  resolveStandaloneRuntime,
  start,
};
