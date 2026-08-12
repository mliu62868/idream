import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GEN_QUEUES } from "@idream/shared/contracts";
import {
  acknowledgeLegacyFailedGenerationSourceResidue,
  failedSourceResidueExpectationSchema,
  inspectLegacyFailedGenerationSourceRepair,
} from "@/server/ai/generation-failed-source-repair";
import { prisma } from "@/server/lib/db";

const VALUE_FLAGS = new Set([
  "--actor-id",
  "--queue",
  "--bull-job-id",
  "--plan-file",
  "--reason",
  "--request-id",
  "--idempotency-key",
  "--confirmation",
]);

type ParsedArgs = {
  readonly apply: boolean;
  readonly values: ReadonlyMap<string, string>;
};

function usage() {
  return [
    "Dry-run (default):",
    "  --actor-id <id> --queue ai.video.generate --bull-job-id <id>",
    "Apply acknowledgement (never mutates Redis/Bull):",
    "  --apply --actor-id <id> --plan-file <dry-run.json> --reason <text>",
    "  --request-id <id> --idempotency-key <key> --confirmation <typed text>",
  ].join("\n");
}

export function parseFailedSourceResidueCliArgs(
  args: readonly string[],
): ParsedArgs {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--apply") {
      if (apply) throw new Error("Duplicate argument: --apply");
      apply = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    values.set(flag, value);
    index += 1;
  }
  const actorId = values.get("--actor-id");
  if (!actorId) throw new Error(`Missing --actor-id\n${usage()}`);
  if (apply) {
    for (const flag of [
      "--plan-file",
      "--reason",
      "--request-id",
      "--idempotency-key",
      "--confirmation",
    ]) {
      if (!values.has(flag)) throw new Error(`Missing ${flag}\n${usage()}`);
    }
    if (values.has("--queue") || values.has("--bull-job-id")) {
      throw new Error(
        "Apply identity comes only from --plan-file; do not also pass --queue/--bull-job-id",
      );
    }
  } else {
    if (
      values.get("--queue") !== GEN_QUEUES.videoGenerate ||
      !values.has("--bull-job-id")
    ) {
      throw new Error(`Dry-run requires exact --queue and --bull-job-id\n${usage()}`);
    }
    for (const flag of [
      "--plan-file",
      "--reason",
      "--request-id",
      "--idempotency-key",
      "--confirmation",
    ]) {
      if (values.has(flag)) {
        throw new Error(`${flag} is only valid with --apply`);
      }
    }
  }
  return { apply, values };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function runFailedSourceResidueCli(
  args = process.argv.slice(2),
) {
  const parsed = parseFailedSourceResidueCliArgs(args);
  const actorId = parsed.values.get("--actor-id")!;
  if (!parsed.apply) {
    const report = await inspectLegacyFailedGenerationSourceRepair(prisma, {
      actorId,
      queue: GEN_QUEUES.videoGenerate,
      bullJobId: parsed.values.get("--bull-job-id")!,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.eligible ? 0 : 1;
    return report;
  }

  const planPath = path.resolve(parsed.values.get("--plan-file")!);
  const document = JSON.parse(await readFile(planPath, "utf8")) as unknown;
  const plan = record(document);
  const expectation = failedSourceResidueExpectationSchema.parse(
    plan.expectation ?? document,
  );
  const result = await acknowledgeLegacyFailedGenerationSourceResidue(prisma, {
    actorId,
    reason: parsed.values.get("--reason")!,
    requestId: parsed.values.get("--request-id")!,
    idempotencyKey: parsed.values.get("--idempotency-key")!,
    confirmation: parsed.values.get("--confirmation")!,
    expectation,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFailedSourceResidueCli()
    .then(() => prisma.$disconnect())
    .catch(async (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      await prisma.$disconnect();
      process.exitCode = 1;
    });
}
