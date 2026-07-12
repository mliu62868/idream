import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateAdminReleaseGate } from "@idream/shared/admin";

async function main() {
  const evidencePath = process.argv[2] ?? process.env.ADMIN_RELEASE_EVIDENCE_PATH;
  if (!evidencePath) {
    process.stderr.write("Usage: bun run admin:readiness:release-gate -- <production-evidence.json>\n");
    process.exitCode = 1;
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(await readFile(resolve(evidencePath), "utf8")) as unknown;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const report = evaluateAdminReleaseGate(input);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 2;
}

void main();
