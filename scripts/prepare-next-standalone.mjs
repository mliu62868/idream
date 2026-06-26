#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = process.argv[2];

if (!packagePath) {
  throw new Error("Usage: node scripts/prepare-next-standalone.mjs <package-path>");
}

const packageDir = path.resolve(repoRoot, packagePath);
const packageName = path.basename(packageDir);
const standaloneDir = path.join(
  packageDir,
  ".next",
  "standalone",
  "packages",
  packageName,
);

if (!existsSync(path.join(standaloneDir, "server.js"))) {
  throw new Error(`Missing standalone server output for ${packagePath}`);
}

copyIfExists(
  path.join(packageDir, ".next", "static"),
  path.join(standaloneDir, ".next", "static"),
);
copyIfExists(path.join(packageDir, "public"), path.join(standaloneDir, "public"));

function copyIfExists(source, destination) {
  if (!existsSync(source)) return;
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}
