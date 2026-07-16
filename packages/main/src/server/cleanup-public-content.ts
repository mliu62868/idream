import path from "node:path";
import { pathToFileURL } from "node:url";
import { prisma } from "@/server/lib/db";
import {
  applyPublicContentCleanup,
  planPublicContentCleanup,
} from "@/server/public-content-cleanup";

async function main() {
  const apply = process.argv.includes("--apply");
  const plan = await planPublicContentCleanup(prisma);
  const result = apply
    ? await applyPublicContentCleanup(prisma, plan)
    : {
        charactersUpdated: 0,
        collectionsUpdated: 0,
        feedbackItemsUpdated: 0,
      };

  process.stdout.write(`${JSON.stringify({ mode: apply ? "apply" : "dry_run", plan, result }, null, 2)}\n`);
}

const entryPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (entryPath === import.meta.url) {
  main()
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
