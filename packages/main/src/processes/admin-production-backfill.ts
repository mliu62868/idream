import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import {
  PRODUCTION_BACKFILL_DOMAINS,
  runProductionBackfillBatch,
  type ProductionBackfillDomain,
  type ProductionBackfillMode,
} from "@/server/modules/admin-v2/backfill/production-runner";

type CliOptions = {
  runId?: string;
  domain?: ProductionBackfillDomain;
  mode?: ProductionBackfillMode;
  batchSize?: number;
  initialCursor?: string;
  stopAtId?: string;
  actorId?: string;
  actorRole?: string;
  continuous: boolean;
};

export function parseProductionBackfillArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { continuous: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") options.mode = "apply";
    else if (arg === "--dry-run") options.mode = "dry_run";
    else if (arg === "--continuous") options.continuous = true;
    else if (arg === "--run-id") options.runId = args[++index];
    else if (arg === "--domain") {
      const domain = args[++index];
      if (!PRODUCTION_BACKFILL_DOMAINS.includes(domain as ProductionBackfillDomain)) {
        throw new Error(`--domain must be one of ${PRODUCTION_BACKFILL_DOMAINS.join(", ")}`);
      }
      options.domain = domain as ProductionBackfillDomain;
    } else if (arg === "--batch-size") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 1_000) {
        throw new Error("--batch-size must be an integer between 1 and 1000");
      }
      options.batchSize = value;
    } else if (arg === "--cursor") options.initialCursor = args[++index];
    else if (arg === "--stop-at") options.stopAtId = args[++index];
    else if (arg === "--actor-id") options.actorId = args[++index];
    else if (arg === "--actor-role") options.actorRole = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.runId && (options.domain || options.mode || options.batchSize || options.initialCursor || options.stopAtId || options.actorId || options.actorRole)) {
    throw new Error("--run-id resumes persisted options; do not submit new backfill options");
  }
  if (!options.runId && (!options.domain || !options.actorId)) {
    throw new Error("New runs require --domain and --actor-id");
  }
  return options;
}

export async function runProductionBackfillCli(
  args = process.argv.slice(2),
  dependencies: {
    readonly db?: PrismaClient;
    readonly write?: (text: string) => void;
  } = {},
) {
  const db = dependencies.db ?? prisma;
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  const cli = parseProductionBackfillArgs(args);
  let result = await runProductionBackfillBatch(db, cli.runId
    ? { runId: cli.runId }
    : {
        domain: cli.domain,
        mode: cli.mode ?? "dry_run",
        batchSize: cli.batchSize,
        initialCursor: cli.initialCursor,
        stopAtId: cli.stopAtId,
        actor: { id: cli.actorId!, role: cli.actorRole ?? "admin" },
      });
  while (cli.continuous && result.status === "paused") {
    result = await runProductionBackfillBatch(db, { runId: result.runId });
  }
  const exitCode = result.summary.mismatch > 0 ? 2 : 0;
  write(`${JSON.stringify({ ...result, exitCode }, null, 2)}\n`);
  return { result, exitCode };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runProductionBackfillCli()
    .then(async ({ exitCode }) => {
      process.exitCode = exitCode;
      await prisma.$disconnect();
    })
    .catch(async (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
      await prisma.$disconnect();
    });
}
