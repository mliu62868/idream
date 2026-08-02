import { assessGenerationDispatchCutoverReadiness } from "@/server/ai/generation-dispatch-cutover";
import { prisma } from "@/server/lib/db";

async function main() {
  try {
    const report = await assessGenerationDispatchCutoverReadiness(prisma);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
