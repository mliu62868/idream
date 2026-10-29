import { parseArgs } from "node:util";
import { officialCharacterSeeds } from "@/lib/official-cold-start-content";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { createBlobStore } from "@/server/providers/blob/factory";
import { materializeOfficialCoverSource } from "@/server/modules/ourdream/official-cover-source";

// Dry-run by default. This command only fills original official cover locators;
// it does not reseed accounts, change portraits, or publish a Character Release.
async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    apply: { type: "boolean", default: false },
    "character-id": { type: "string" },
  }, strict: true, allowPositionals: false });
  const characterId = values["character-id"];
  const cards = characterId ? officialCharacterSeeds.filter(card => card.id === characterId) : officialCharacterSeeds;
  if (!cards.length) throw new Error("--character-id must name a Character in the official cover manifest");
  const target = new URL(env.DATABASE_URL);
  const blob = createBlobStore();
  const results = [];
  for (const card of cards) {
    results.push(await materializeOfficialCoverSource({ db: prisma, blob, characterId: card.id, dryRun: !values.apply }));
  }
  process.stdout.write(`${JSON.stringify({ dryRun: !values.apply,
    target: { appEnv: env.APP_ENV, host: target.hostname, port: target.port, database: target.pathname.slice(1) },
    results }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof TypeError ? 2 : 1;
}).finally(() => prisma.$disconnect());
