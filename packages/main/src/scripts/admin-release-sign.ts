import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { signAdminReleaseEvidence } from "@/server/admin/release-gate";

async function main() {
  const evidencePath = process.argv[2];
  const privateKeyPath = process.env.ADMIN_RELEASE_EVIDENCE_PRIVATE_KEY_PATH;
  const keyId = process.env.ADMIN_RELEASE_EVIDENCE_KEY_ID;
  if (!evidencePath || !privateKeyPath || !keyId) {
    process.stderr.write(
      "Usage: ADMIN_RELEASE_EVIDENCE_PRIVATE_KEY_PATH=<path> ADMIN_RELEASE_EVIDENCE_KEY_ID=<id> bun run admin:readiness:sign -- <unsigned-evidence.json>\n",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const [input, privateKeyPem] = await Promise.all([
      readFile(resolve(evidencePath), "utf8").then((value) => JSON.parse(value) as unknown),
      readFile(resolve(privateKeyPath)),
    ]);
    const manifest = signAdminReleaseEvidence(input, { privateKeyPem, keyId });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

void main();
