import { prisma } from "@/server/lib/db";
import { runCharacterReleaseBackfillBatch } from "@/server/modules/admin-v2/characters/backfill";

interface CliOptions {
  runId?: string;
  dryRun?: boolean;
  batchSize?: number;
  initialCursor?: string;
  stopAtId?: string;
  continuous: boolean;
}

function parseArgs(args: readonly string[]): CliOptions {
  const result: CliOptions = { continuous: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") result.dryRun = false;
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--continuous") result.continuous = true;
    else if (arg === "--run-id") result.runId = args[++index];
    else if (arg === "--batch-size") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 1_000) {
        throw new Error("--batch-size must be an integer between 1 and 1000");
      }
      result.batchSize = value;
    }
    else if (arg === "--cursor") result.initialCursor = args[++index];
    else if (arg === "--stop-at") result.stopAtId = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (result.runId && (result.dryRun !== undefined || result.batchSize || result.initialCursor || result.stopAtId)) {
    throw new Error("--run-id resumes persisted options; do not submit new mode/cursor/batch options");
  }
  return result;
}

export async function runCharacterBackfillCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  let result = await runCharacterReleaseBackfillBatch(prisma, options);
  while (options.continuous && result.status === "paused") {
    result = await runCharacterReleaseBackfillBatch(prisma, { runId: result.runId });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCharacterBackfillCli()
    .then(() => prisma.$disconnect())
    .catch(async (error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      await prisma.$disconnect();
      process.exitCode = 1;
    });
}
