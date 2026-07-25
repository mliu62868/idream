import { prisma } from "@/server/lib/db";
import {
  EDITORIAL_VISUAL_IDENTITY_REPAIR_VERSION,
  repairLegacyEditorialVisualIdentity,
} from "@/server/modules/admin-v2/characters/image-readiness-repair";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function main() {
  const requestedCharacterId = argument("character-id");
  const dryRun = process.argv.includes("--dry-run");
  const profiles = await prisma.characterVisualProfile.findMany({
    where: {
      status: "active",
      ...(requestedCharacterId
        ? { characterId: requestedCharacterId }
        : {}),
    },
    orderBy: [{ characterId: "asc" }, { version: "desc" }],
    select: {
      id: true,
      characterId: true,
      version: true,
      adapterRefs: true,
      faceTraits: true,
      identityPrompt: true,
    },
  });
  const targets = profiles.filter((profile) => {
    const adapterRefs = record(profile.adapterRefs);
    const faceTraits = record(profile.faceTraits);
    return (
      adapterRefs.authority === "editorial_live_portrait" &&
      !(
        faceTraits.canonicalPortraitAuthority === true &&
        record(adapterRefs.identityPromptRepair).version ===
          EDITORIAL_VISUAL_IDENTITY_REPAIR_VERSION
      )
    );
  });
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({
      dryRun: true,
      targets: targets.map((profile) => ({
        characterId: profile.characterId,
        visualProfileId: profile.id,
        version: profile.version,
        identityPrompt: profile.identityPrompt,
      })),
    }, null, 2)}\n`);
    return;
  }
  const results = [];
  for (const target of targets) {
    results.push(await prisma.$transaction((tx) =>
      repairLegacyEditorialVisualIdentity({
        characterId: target.characterId,
        actorId: "system:editorial-visual-identity-repair",
        requestId: `editorial-visual-identity-repair:${target.id}`,
        tx,
      })
    ));
  }
  process.stdout.write(`${JSON.stringify({
    dryRun: false,
    repaired: results.length,
    results,
  }, null, 2)}\n`);
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
