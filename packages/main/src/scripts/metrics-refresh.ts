import { prisma } from "@/server/lib/db";
import { materializeMetricSnapshots } from "@/server/modules/admin-v2/metrics/query";

async function main() {
  const dashboard = await materializeMetricSnapshots(prisma);
  process.stdout.write(`${JSON.stringify({
    asOf: dashboard.asOf,
    quality: dashboard.quality,
    snapshots: dashboard.cards.length,
  }, null, 2)}\n`);
  if (dashboard.quality.qualityState !== "certified") process.exitCode = 2;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
