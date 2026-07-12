import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runDependencyChaosHarness } from "@/server/readiness/dependency-chaos-process";
import { summarizeDependencyChaosReadiness } from "@/server/readiness/dependency-chaos";

function reportPath(): string | null {
  const index = process.argv.indexOf("--report");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (index >= 0 && (!value || value.startsWith("--"))) {
    throw new Error("--report requires a file path");
  }
  return value ? resolve(value) : null;
}

async function writeReport(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${contents}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function main() {
  const path = reportPath();
  const report = await runDependencyChaosHarness();
  const output = JSON.stringify({
    ...report,
    releaseGateCandidates: summarizeDependencyChaosReadiness(report),
    trustBoundary: "Store this complete report immutably and attach a trusted collector attestation before using it as schema-v5 release evidence.",
  }, null, 2);
  if (path) await writeReport(path, output);
  process.stdout.write(`${output}\n`);
  if (report.status !== "pass") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
