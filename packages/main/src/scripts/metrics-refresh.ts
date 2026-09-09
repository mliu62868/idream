import { parseArgs } from "node:util";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { materializeMetricSnapshots, readMetricDashboard } from "@/server/modules/admin-v2/metrics/query";
import { summarizeMetricRefresh } from "@/server/modules/admin-v2/metrics/refresh";

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { check: { type: "boolean" }, "as-of": { type: "string" }, help: { type: "boolean" } },
    strict: true,
  });
  if (values.help) {
    process.stdout.write("Usage: metrics:refresh [--check] [--as-of ISO_TIMESTAMP]\n"
      + "Default: materialize current facts and quality evidence. --check: read only.\n"
      + "Exit codes: 0 = official metrics decision-ready; 2 = report available but blocked; 1 = execution error.\n");
    return;
  }
  const asOf = values["as-of"] ? new Date(values["as-of"]) : new Date();
  if (!Number.isFinite(asOf.getTime()) || (values["as-of"] && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(values["as-of"]))) {
    throw new Error("--as-of must be an ISO timestamp with an explicit timezone");
  }
  if (asOf.getTime() > Date.now()) throw new Error("--as-of must not be in the future");
  const dashboard = values.check
    ? await readMetricDashboard(prisma, asOf)
    : await materializeMetricSnapshots(prisma, asOf);
  const report = summarizeMetricRefresh(dashboard);
  const database = new URL(env.DATABASE_URL);
  process.stdout.write(`${JSON.stringify({
    mode: values.check ? "check" : "refresh",
    environment: env.APP_ENV,
    database: { host: database.hostname, port: database.port || "5432", name: database.pathname.slice(1) },
    ...report,
  }, null, 2)}\n`);
  if (!report.decisionReady) process.exitCode = 2;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
