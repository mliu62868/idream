#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const {
  assertSelfContainedSymlinks,
  fingerprintDirectory,
  pathIsInside,
} = require("./next-standalone-integrity.cjs");

export function publishNextStandaloneRelease(packagePath) {
  if (!packagePath) {
    throw new Error(
      "Usage: node scripts/prepare-next-standalone.mjs <package-path>",
    );
  }

  const packageDir = path.resolve(repoRoot, packagePath);
  const tracingRoot = path.resolve(packageDir, "..", "..");
  const packageName = path.basename(packageDir);
  const nextDir = path.join(packageDir, ".next");
  const standaloneSource = path.join(nextDir, "standalone");
  const standalonePackageSource = path.join(
    standaloneSource,
    "packages",
    packageName,
  );
  const buildIdPath = path.join(nextDir, "BUILD_ID");
  const staticSource = path.join(nextDir, "static");
  const serverSource = path.join(standalonePackageSource, "server.js");

  requireFile(serverSource, `Missing standalone server output for ${packagePath}`);
  requireFile(buildIdPath, `Missing Next BUILD_ID for ${packagePath}`);
  requireDirectory(
    staticSource,
    `Missing Next static assets for ${packagePath}`,
  );
  if (!directoryContainsFile(staticSource)) {
    throw new Error(`Next static assets are empty for ${packagePath}`);
  }

  const buildId = readFileSync(buildIdPath, "utf8").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(buildId)) {
    throw new Error(`Unsafe Next BUILD_ID for ${packagePath}: ${buildId}`);
  }
  const deploymentId = readDeploymentId(nextDir) ?? buildId;
  if (!/^[A-Za-z0-9._-]+$/.test(deploymentId)) {
    throw new Error(
      `Unsafe Next deployment ID for ${packagePath}: ${deploymentId}`,
    );
  }
  const releaseId = deploymentId;
  const runtimeRoot = path.join(packageDir, ".next-runtime");
  const releasesRoot = path.join(runtimeRoot, "releases");
  const releaseDir = path.join(releasesRoot, releaseId);
  const stagingDir = path.join(
    runtimeRoot,
    `.staging-${releaseId}-${process.pid}-${randomUUID()}`,
  );
  const stagedPackage = path.join(stagingDir, "packages", packageName);

  mkdirSync(releasesRoot, { recursive: true });
  try {
    cpSync(standaloneSource, stagingDir, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    replaceDirectory(
      staticSource,
      path.join(stagedPackage, ".next", "static"),
    );
    copyIfExists(
      path.join(packageDir, "public"),
      path.join(stagedPackage, "public"),
    );
    mkdirSync(path.join(stagedPackage, ".next"), { recursive: true });
    copyFileSync(buildIdPath, path.join(stagedPackage, ".next", "BUILD_ID"));
    copyFileIfExists(
      path.join(nextDir, "required-server-files.json"),
      path.join(stagedPackage, ".next", "required-server-files.json"),
    );

    normalizeStandaloneSymlinks(stagingDir, tracingRoot);
    assertSelfContainedSymlinks(stagingDir);
    validateRelease(stagingDir, packageName, buildId);
    const sourceFingerprint = fingerprintDirectory(stagingDir);
    const metadata = {
      schemaVersion: 1,
      packageName,
      releaseId,
      buildId,
      deploymentId,
      sourceFingerprint,
      createdAt: new Date().toISOString(),
    };

    if (existsSync(releaseDir)) {
      const existing = readReleaseMetadata(releaseDir);
      rmSync(stagingDir, { recursive: true, force: true });
      assertSelfContainedSymlinks(releaseDir);
      validateRelease(releaseDir, packageName, buildId);
      const existingFingerprint = fingerprintDirectory(releaseDir);
      if (existingFingerprint !== existing.sourceFingerprint) {
        throw new Error(
          `Immutable Next release ${releaseDir} failed its source fingerprint`,
        );
      }
      if (
        existing.sourceFingerprint !== sourceFingerprint ||
        existing.deploymentId !== deploymentId
      ) {
        throw new Error(
          `Immutable Next release ${releaseDir} already exists with different content`,
        );
      }
    } else {
      writeFileSync(
        path.join(stagingDir, "release.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
      renameSync(stagingDir, releaseDir);
    }

    switchCurrentRelease(runtimeRoot, releaseId);
    const result = {
      packagePath,
      releaseId,
      buildId,
      deploymentId,
      releaseDir,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function readDeploymentId(nextDir) {
  const requiredServerFiles = path.join(
    nextDir,
    "required-server-files.json",
  );
  if (!existsSync(requiredServerFiles)) {
    return process.env.NEXT_DEPLOYMENT_ID?.trim() || null;
  }
  const parsed = JSON.parse(readFileSync(requiredServerFiles, "utf8"));
  const configured = parsed?.config?.deploymentId;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return process.env.NEXT_DEPLOYMENT_ID?.trim() || null;
}

function validateRelease(releaseDir, packageName, buildId) {
  const packageDir = path.join(releaseDir, "packages", packageName);
  requireFile(
    path.join(packageDir, "server.js"),
    `Published release is missing server.js for ${packageName}`,
  );
  const publishedBuildId = readFileSync(
    path.join(packageDir, ".next", "BUILD_ID"),
    "utf8",
  ).trim();
  if (publishedBuildId !== buildId) {
    throw new Error(
      `Published BUILD_ID mismatch for ${packageName}: ${publishedBuildId}`,
    );
  }
  const staticDir = path.join(packageDir, ".next", "static");
  requireDirectory(
    staticDir,
    `Published release is missing static assets for ${packageName}`,
  );
  if (!directoryContainsFile(staticDir)) {
    throw new Error(`Published static assets are empty for ${packageName}`);
  }
}

function switchCurrentRelease(runtimeRoot, releaseId) {
  const current = path.join(runtimeRoot, "current");
  if (existsSync(current) && !lstatSync(current).isSymbolicLink()) {
    throw new Error(`${current} must be a symbolic link`);
  }
  const temporaryLink = path.join(
    runtimeRoot,
    `.current-${process.pid}-${randomUUID()}`,
  );
  symlinkSync(path.join("releases", releaseId), temporaryLink);
  try {
    renameSync(temporaryLink, current);
  } finally {
    rmSync(temporaryLink, { force: true });
  }
}

function normalizeStandaloneSymlinks(stagingRoot, tracingRoot) {
  const canonicalTracingRoot = realpathSync(tracingRoot);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const link = findRepairableSymlink(stagingRoot);
    if (!link) return;
    const relative = path.relative(stagingRoot, link.absolute);
    const originalLink = path.join(tracingRoot, relative);
    let originalStat;
    try {
      originalStat = lstatSync(originalLink);
    } catch {
      throw new Error(
        `Standalone trace omitted the target for symbolic link ${relative}`,
      );
    }
    if (!originalStat.isSymbolicLink()) {
      throw new Error(
        `Standalone symbolic link ${relative} has no matching trace-root link`,
      );
    }
    let originalTarget;
    try {
      originalTarget = realpathSync(originalLink);
    } catch {
      throw new Error(
        `Trace-root symbolic link is dangling: ${relative}`,
      );
    }
    if (!pathIsInside(canonicalTracingRoot, originalTarget)) {
      throw new Error(
        `Trace-root symbolic link resolves outside the deployment root: ${relative}`,
      );
    }
    const originalTargetRelative = path.relative(
      canonicalTracingRoot,
      originalTarget,
    );
    const stagedTarget = path.join(stagingRoot, originalTargetRelative);
    if (!existsSync(stagedTarget)) {
      const mayMaterializeBunHoist =
        relative.startsWith(
          path.join("node_modules", ".bun", "node_modules") + path.sep,
        ) &&
        originalTargetRelative.startsWith(
          path.join("node_modules", ".bun") + path.sep,
        );
      if (!mayMaterializeBunHoist) {
        throw new Error(
          `Standalone trace omitted ${originalTargetRelative}, required by ${relative}`,
        );
      }
      mkdirSync(path.dirname(stagedTarget), { recursive: true });
      cpSync(originalTarget, stagedTarget, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    }
    rmSync(link.absolute, { force: true });
    symlinkSync(
      path.relative(path.dirname(link.absolute), stagedTarget) || ".",
      link.absolute,
    );
  }
  throw new Error("Standalone symbolic link normalization did not converge");
}

function findRepairableSymlink(root) {
  const canonicalRoot = realpathSync(root);
  const visit = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const absolute = path.join(directory, entry);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        const nested = visit(absolute);
        if (nested) return nested;
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      const target = readlinkSync(absolute);
      const lexicalTarget = path.resolve(path.dirname(absolute), target);
      let canonicalTarget = null;
      try {
        canonicalTarget = realpathSync(absolute);
      } catch {
        // A missing traced dependency is repaired from the trace root below.
      }
      if (
        path.isAbsolute(target) ||
        !pathIsInside(root, lexicalTarget) ||
        canonicalTarget === null ||
        !pathIsInside(canonicalRoot, canonicalTarget)
      ) {
        return { absolute };
      }
    }
    return null;
  };
  return visit(root);
}

function directoryContainsFile(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && directoryContainsFile(target)) return true;
  }
  return false;
}

function replaceDirectory(source, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

function copyIfExists(source, destination) {
  if (!existsSync(source)) return;
  replaceDirectory(source, destination);
}

function copyFileIfExists(source, destination) {
  if (!existsSync(source)) return;
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
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

function readReleaseMetadata(releaseDir) {
  const metadataPath = path.join(releaseDir, "release.json");
  requireFile(
    metadataPath,
    `Immutable Next release metadata is missing at ${metadataPath}`,
  );
  return JSON.parse(readFileSync(metadataPath, "utf8"));
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  publishNextStandaloneRelease(process.argv[2]);
}
