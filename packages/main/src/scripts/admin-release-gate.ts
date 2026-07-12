import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateAdminReleaseGate } from "@idream/shared/admin/release-gate";

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

  const trustRegistryPath = process.env.ADMIN_RELEASE_TRUST_REGISTRY_PATH;
  const trustRegistry = trustRegistryPath
    ? await readFile(resolve(trustRegistryPath), "utf8")
        .then((value) => JSON.parse(value) as unknown)
        .catch(() => undefined)
    : undefined;
  const report = evaluateAdminReleaseGate(input, {
    trustRegistry,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 2;
}

void main();
