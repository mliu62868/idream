import {
  pauseAndDrainGenerationCutoverQueues,
  resumeGenerationCutoverQueues,
} from "@/server/ai/generation-cutover-queue-control";
import { prisma } from "@/server/lib/db";

async function main() {
  const action = process.argv[2];
  if (action === "pause-and-drain") {
    const report = await pauseAndDrainGenerationCutoverQueues();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (action === "resume") {
    const queues = await resumeGenerationCutoverQueues();
    process.stdout.write(`${JSON.stringify({ ok: true, queues }, null, 2)}\n`);
    return;
  }
  throw new Error(
    "Expected generation cutover queue action: pause-and-drain | resume",
  );
}

void main()
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
