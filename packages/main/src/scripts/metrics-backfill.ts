import { parseArgs } from "node:util";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { backfillCanonicalMetricFacts } from "@/server/modules/admin-v2/metrics/backfill";
import { reconcileCanonicalMetricFacts } from "@/server/modules/admin-v2/metrics/projector";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2), strict: true,
    options: {
      "batch-size": { type: "string", default: "500" }, "source-kind": { type: "string", default: "canonical_events" },
      source: { type: "string" }, cursor: { type: "string" }, "user-id-prefix": { type: "string" },
      "dry-run": { type: "boolean" }, help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write("Usage: metrics:backfill [--dry-run] [--source-kind canonical_events|main_authority] [--batch-size 1..1000] [--cursor CURSOR] [--user-id-prefix PREFIX] [--source LABEL]\n"
      + "Default: replay all canonical v2 outcomes, including Chat and generation, preserving original provenance.\n"
      + "--dry-run runs the authoritative projector inside rollback-only transactions; only its audit report is persisted.\n"
      + "Exit codes: 0 = batch completed/paused; 2 = blocked batch (inspect mismatches); 1 = execution/input error.\n");
    return;
  }
  const batchSize = Number(values["batch-size"]);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("--batch-size must be between 1 and 1000");
  }
  const sourceKind = values["source-kind"];
  if (sourceKind !== "canonical_events" && sourceKind !== "main_authority") throw new Error("--source-kind must be canonical_events or main_authority");
  const dryRun = values["dry-run"] ?? false;
  const report = await backfillCanonicalMetricFacts(prisma, {
    source: values.source ?? `manual:${sourceKind}`,
    sourceKind,
    dryRun,
    batchSize,
    cursor: values.cursor,
    userIdPrefix: values["user-id-prefix"],
  });
  if (report.status === "blocked") process.exitCode = 2;
  const reconciliation = dryRun ? null : await reconcileCanonicalMetricFacts(prisma);
  const database = new URL(env.DATABASE_URL);
  process.stdout.write(`${JSON.stringify({
    environment: env.APP_ENV,
    database: { host: database.hostname, port: database.port || "5432", name: database.pathname.slice(1) },
    report, reconciliation,
  }, null, 2)}\n`);
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
