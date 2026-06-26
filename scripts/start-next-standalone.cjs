#!/usr/bin/env node
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const packagePath = process.argv[2];

if (!packagePath) {
  throw new Error("Usage: node scripts/start-next-standalone.cjs <package-path>");
}

const packageDir = path.resolve(repoRoot, packagePath);
const packageName = path.basename(packageDir);
const serverPath = path.join(
  packageDir,
  ".next",
  "standalone",
  "packages",
  packageName,
  "server.js",
);

loadEnv(path.join(packageDir, ".env"));

if (!existsSync(serverPath)) {
  throw new Error(`Missing standalone server output for ${packagePath}`);
}

require(serverPath);

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
