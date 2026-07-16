import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prisma } from "@/server/lib/db";
import {
  runPublicCatalogProbe,
  type PublicCatalogProbeOptions,
} from "@/server/public-catalog-probe";

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptions(): PublicCatalogProbeOptions {
  return {
    report: readArg("report") ?? process.env.PUBLIC_CATALOG_PROBE_REPORT ?? null,
    maxDuplicateImageRatio: readNumberArg("max-duplicate-image-ratio", 0.4),
    maxPublicMetric: readNumberArg("max-public-metric", 10_000_000),
    maxIssues: Math.max(1, Math.floor(readNumberArg("max-issues", 100))),
  };
}

function readNumberArg(name: string, fallback: number) {
  const value = readArg(name) ?? process.env[toEnvName(name)];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toEnvName(name: string) {
  return `PUBLIC_CATALOG_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

async function main() {
  const options = readOptions();
  const report = await runPublicCatalogProbe(prisma, options);

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
