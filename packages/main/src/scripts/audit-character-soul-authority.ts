import { pathToFileURL } from "node:url";
import { prisma } from "@/server/lib/db";
import { auditCharacterSoulAuthority } from "@/server/modules/admin-v2/characters/soul-authority-audit";

export async function runCharacterSoulAuthorityAuditCli() {
  const report = await auditCharacterSoulAuthority(prisma);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCharacterSoulAuthorityAuditCli()
    .then(() => prisma.$disconnect())
    .catch(async (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      await prisma.$disconnect();
      process.exitCode = 1;
    });
}
