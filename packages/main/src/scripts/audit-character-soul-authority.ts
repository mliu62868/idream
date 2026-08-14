import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { auditCharacterSoulAuthority } from "@/server/modules/admin-v2/characters/soul-authority-audit";

export async function runCharacterSoulAuthorityAuditCli() {
  const chatDatabaseUrl = process.env.CHAT_DATABASE_URL;
  if (!chatDatabaseUrl) {
    throw new Error("CHAT_DATABASE_URL is required for the Character Soul audit");
  }
  const chatPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: chatDatabaseUrl }),
  });
  try {
    const report = await auditCharacterSoulAuthority(prisma, chatPrisma);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
    return report;
  } finally {
    await chatPrisma.$disconnect();
  }
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
