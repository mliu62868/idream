import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateSignedAdminReleaseGate } from "@/server/admin/admin-release-evidence-signing";

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

  const publicKeyPath = process.env.ADMIN_RELEASE_EVIDENCE_PUBLIC_KEY_PATH;
  const expectedKeyId = process.env.ADMIN_RELEASE_EVIDENCE_KEY_ID;
  const publicKeyPem = publicKeyPath
    ? await readFile(resolve(publicKeyPath)).catch(() => undefined)
    : undefined;
  const report = evaluateSignedAdminReleaseGate(input, {
    publicKeyPem,
    expectedKeyId,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 2;
}

void main();
