import { prisma } from "@/server/lib/db";
import { backfillGenerationAttemptEvents } from "@/server/ai/generation-attempt-event-backfill";

function valueAfter(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const mode = process.argv.includes("--apply") ? "apply" as const : "dry-run" as const;
  const cursor = valueAfter("--cursor");
  const rawBatchSize = valueAfter("--batch-size");
  const batchSize = rawBatchSize ? Number.parseInt(rawBatchSize, 10) : undefined;
  if (batchSize !== undefined && (!Number.isFinite(batchSize) || batchSize < 1)) {
    throw new Error("--batch-size must be a positive integer");
  }
  const report = await backfillGenerationAttemptEvents(prisma, { mode, cursor, batchSize });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.mismatch > 0) process.exitCode = 2;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
