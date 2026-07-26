// SPEC: 一次性回填 —— 用新的 characterVisualProfileSnapshotHash 重算所有已密封
//       CharacterVisualProfile 的 immutableHash。
//
// WHY: 参考图（anchorAssetIds/referenceAssetIds）已从 profile 密封 hash 中移除，
//      改由 referenceSetSnapshotHash 独立覆盖。算法变了，DB 里的旧 hash 全部对不上，
//      qa.ts / release-lifecycle.ts 的「sealed hash has drifted」守卫会拦住 QA 与发布。
//      必须在部署带新算法的 main 之后立刻跑一次（dev 与 prod 各一次）。
//
// SAFE: 幂等 —— 已经是新 hash 的行会被跳过。只写 immutableHash 一列，不碰其它字段。
//       只处理 immutableHash 非空的行（未密封的草稿本来就没有 hash，不该凭空补）。
//
// RUN: cd packages/main && npx tsx src/server/reseal-visual-profile-hashes.ts [--apply]
//      不带 --apply 时只报告将要改动的行数，不写库。
import { prisma } from "@/server/lib/db";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";

async function main() {
  const apply = process.argv.includes("--apply");
  const profiles = await prisma.characterVisualProfile.findMany({
    where: { immutableHash: { not: null } },
    select: {
      id: true, characterId: true, version: true, status: true, style: true,
      identityPrompt: true, negativeIdentityPrompt: true, immutableHash: true,
      faceTraits: true, hairTraits: true, bodyTraits: true,
      signatureTraits: true, styleTraits: true,
    },
  });

  const stale = profiles.filter(
    (profile) => profile.immutableHash !== characterVisualProfileSnapshotHash(profile),
  );

  process.stdout.write(`sealed profiles: ${profiles.length}, stale: ${stale.length}, already current: ${profiles.length - stale.length}\n`);
  for (const profile of stale) {
    process.stdout.write(`  ${profile.characterId} v${profile.version} (${profile.status}) ${profile.id}\n`);
  }

  if (!apply) {
    process.stdout.write(stale.length > 0 ? "\ndry run — rerun with --apply to write\n" : "\nnothing to do\n");
    return;
  }
  for (const profile of stale) {
    await prisma.characterVisualProfile.update({
      where: { id: profile.id },
      data: { immutableHash: characterVisualProfileSnapshotHash(profile) },
    });
  }
  process.stdout.write(`\nresealed ${stale.length} profile(s)\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
