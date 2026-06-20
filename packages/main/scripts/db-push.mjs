import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const provider = process.env.DB_PROVIDER ?? "sqlite";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.capture
      ? ["pipe", "pipe", "pipe"]
      : options.input
        ? ["pipe", "inherit", "inherit"]
        : "inherit",
    input: options.input,
    encoding: "utf8",
    env: process.env,
  });

  if (result.status !== 0) {
    if (options.capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    process.exit(result.status ?? 1);
  }

  return result;
}

function sqlitePathFromUrl(databaseUrl) {
  if (!databaseUrl.startsWith("file:")) return undefined;

  const rawPath = databaseUrl.slice("file:".length);
  if (path.isAbsolute(rawPath)) return rawPath;

  return path.resolve(rawPath);
}

function schemaEnginePath() {
  // Resolve @prisma/engines via the module system so it works under both flat
  // (npm) and nested (pnpm) node_modules layouts — the package is a transitive
  // dep, not symlinked into this package's top-level node_modules under pnpm.
  const enginesDir = path.dirname(require.resolve("@prisma/engines/package.json"));
  const binary = readdirSync(enginesDir).find((entry) =>
    entry.startsWith("schema-engine-"),
  );

  if (!binary) {
    throw new Error("Could not find Prisma schema-engine binary");
  }

  return path.join(enginesDir, binary);
}

function ensureSqliteDatabaseFile() {
  const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";
  const filePath = sqlitePathFromUrl(databaseUrl);
  if (!filePath) return;
  if (existsSync(filePath) && statSync(filePath).size > 0) return;

  mkdirSync(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath)) unlinkSync(filePath);
  run(schemaEnginePath(), [
    "--datasource",
    JSON.stringify({ url: databaseUrl }),
    "cli",
    "create-database",
  ]);
}

run("node", ["scripts/db-provider.mjs"]);

if (provider !== "sqlite") {
  run("prisma", ["db", "push"]);
  process.exit(0);
}

ensureSqliteDatabaseFile();

const diff = run(
  "prisma",
  [
    "migrate",
    "diff",
    "--from-config-datasource",
    "--to-schema",
    "prisma/schema.prisma",
    "--script",
  ],
  { capture: true },
);

const sql = diff.stdout.trim();

if (!sql || sql.includes("-- This is an empty migration.")) {
  console.log("[db-push] SQLite schema already in sync");
} else {
  run("prisma", ["db", "execute", "--stdin"], { input: diff.stdout });
}

run("prisma", ["generate"]);
