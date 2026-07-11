import { prisma } from "@/server/lib/db";
import { backfillCanonicalMetricFacts } from "@/server/modules/admin-v2/metrics/backfill";
import { reconcileCanonicalMetricFacts } from "@/server/modules/admin-v2/metrics/projector";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const batchSize = Number.parseInt(argument("batch-size") ?? "500", 10);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("--batch-size must be between 1 and 1000");
  }
  const sourceKind = argument("source-kind") === "canonical_events" ? "canonical_events" : "main_authority";
  const dryRun = process.argv.includes("--dry-run");
  const report = await backfillCanonicalMetricFacts(prisma, {
    source: argument("source") ?? `manual:${sourceKind}`,
    sourceKind,
    dryRun,
    batchSize,
    cursor: argument("cursor"),
    userIdPrefix: argument("user-id-prefix"),
  });
  const reconciliation = dryRun ? null : await reconcileCanonicalMetricFacts(prisma);
  process.stdout.write(`${JSON.stringify({ report, reconciliation }, null, 2)}\n`);
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
