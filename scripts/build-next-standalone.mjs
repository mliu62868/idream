#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishNextStandaloneRelease } from "./prepare-next-standalone.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = process.argv[2];

if (!packagePath) {
  throw new Error(
    "Usage: node scripts/build-next-standalone.mjs <package-path>",
  );
}

const packageDir = path.resolve(repoRoot, packagePath);
const requireFromPackage = createRequire(path.join(packageDir, "package.json"));
const nextBin = requireFromPackage.resolve("next/dist/bin/next");
const deploymentId =
  process.env.NEXT_DEPLOYMENT_ID?.trim() ||
  `idream-${randomUUID()}`;
process.env.NEXT_DEPLOYMENT_ID = deploymentId;

const build = spawnSync(process.execPath, [nextBin, "build"], {
  cwd: packageDir,
  env: {
    ...process.env,
    NEXT_DEPLOYMENT_ID: deploymentId,
  },
  stdio: "inherit",
});

if (build.error) throw build.error;
if (build.signal) {
  throw new Error(`Next build terminated by ${build.signal}`);
}
if (build.status !== 0) {
  process.exitCode = build.status ?? 1;
} else {
  publishNextStandaloneRelease(packagePath);
}
