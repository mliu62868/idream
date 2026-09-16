import { readFileSync } from "node:fs";
import path from "node:path";
import { parseCharacterReleaseAssetManifest } from "@idream/shared/admin";
import { describe, expect, it } from "vitest";

// SPEC: the PostgreSQL copy of the v2 Release placement manifest contract and the
//       shared Zod contract must accept and reject the same manifests.
// INTENT: they diverged once already — on 2026-09-05 daily adoption dropped the
//         per-image review gate in the shared contract while
//         `assert_character_release_asset_manifest_v2` kept demanding
//         `reviewDecisionId` and full lineage. Admin then reported every release
//         check green and the publish command failed inside the executor with
//         `release_executor_transaction_failed`. The test DB is built with
//         `prisma db push`, which installs no trigger functions, so no
//         integration test can catch that divergence.
const migration = readFileSync(
  path.join(
    process.cwd(),
    "prisma/migrations/20260913120000_release_manifest_optional_review_lineage/migration.sql",
  ),
  "utf8",
);

function placement(
  slotKey: "character_avatar" | "character_hero" | "character_chat",
) {
  return {
    slotKey,
    assetId: `${slotKey}-asset`,
    slotVersion: 1,
    runId: `${slotKey}-run`,
    itemId: `${slotKey}-item`,
    generationJobId: `${slotKey}-job`,
  };
}

function manifest(placements: Record<string, unknown>[]) {
  return { schemaVersion: 2, placements };
}

describe("Release placement manifest database parity", () => {
  it("requires only the placement identity, like the shared contract", () => {
    expect(migration).toContain(
      "placement ?& ARRAY['slotKey', 'assetId', 'slotVersion']::TEXT[]",
    );
    expect(
      parseCharacterReleaseAssetManifest(
        manifest([
          { slotKey: "character_avatar", assetId: "a", slotVersion: 1 },
          { slotKey: "character_hero", assetId: "b", slotVersion: 1 },
          { slotKey: "character_chat", assetId: "c", slotVersion: 1 },
        ]),
      ),
    ).not.toBeNull();
  });

  it("accepts a directly adopted generation with no manual review decision", () => {
    expect(migration).toContain("placement ? 'reviewDecisionId'");
    expect(
      parseCharacterReleaseAssetManifest(
        manifest([
          placement("character_avatar"),
          placement("character_hero"),
          placement("character_chat"),
        ]),
      ),
    ).not.toBeNull();
  });

  it("keeps generation lineage all-or-nothing on both sides", () => {
    expect(migration).toContain("lineage_present NOT IN (0, 3)");
    const partial: Record<string, unknown> = { ...placement("character_chat") };
    delete partial.itemId;
    expect(
      parseCharacterReleaseAssetManifest(
        manifest([
          placement("character_avatar"),
          placement("character_hero"),
          partial,
        ]),
      ),
    ).toBeNull();
  });

  it("keeps three distinct slots and three distinct assets mandatory", () => {
    expect(migration).toContain(
      "IF distinct_slot_count <> 3 OR distinct_asset_count <> 3 THEN",
    );
    expect(
      parseCharacterReleaseAssetManifest(
        manifest([
          placement("character_avatar"),
          placement("character_hero"),
          { ...placement("character_chat"), assetId: "character_avatar-asset" },
        ]),
      ),
    ).toBeNull();
  });

  it("keeps the placement key set closed", () => {
    expect(migration).toContain("'bootstrapIdentity'\n        ]::TEXT[]");
    expect(
      parseCharacterReleaseAssetManifest(
        manifest([
          { ...placement("character_avatar"), unexpected: "x" },
          placement("character_hero"),
          placement("character_chat"),
        ]),
      ),
    ).toBeNull();
  });
});
