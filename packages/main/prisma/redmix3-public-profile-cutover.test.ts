import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = new URL(
  "./migrations/20260811133000_redmix3_public_profile_cutover/migration.sql",
  import.meta.url,
);

describe("RedMix3 public profile cutover migration", () => {
  it("publishes Premium v2 without rewriting the immutable legacy execution pin", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const archiveStart = sql.indexOf('UPDATE "generation_model_profiles" AS legacy');
    const postconditionStart = sql.indexOf(
      "-- INVARIANT: leave either a genuinely fresh database",
    );
    const archiveStatement = sql.slice(archiveStart, postconditionStart);
    const archiveSetClause = archiveStatement.slice(
      archiveStatement.indexOf("SET"),
      archiveStatement.indexOf("WHERE"),
    );

    expect(archiveStart).toBeGreaterThan(0);
    expect(postconditionStart).toBeGreaterThan(archiveStart);
    expect(sql).toContain("'seed-profile-image-premium-v2'");
    expect(sql).toContain("'profile_image_premium_v1'");
    expect(sql).toContain('version_two_count = 1');
    expect(sql).toContain("'Premium RedMix3 cutover postcondition failed'");
    expect(archiveStatement).toContain('"status" = \'archived\'');
    expect(archiveStatement).toContain('legacy."version" = 1');
    expect(archiveSetClause).not.toMatch(
      /"(?:version|runner|pipelineModel|workflowKey|sourceModelPath|convertedModelPath|modelFormat|runnerConfig)"\s*=/,
    );
  });

  it("accepts both seed and Admin-published RedMix3 model-path authority", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("->> 'modelPath'");
    expect(sql).toContain("->> 'diffusionModelPath'");
    expect(sql).toContain("#>> '{capabilities,textToImage}' = 'true'");
    expect(sql).toContain(
      "LIKE '%/redcraft-krea2-redmix3-txt2img.json'",
    );
  });
});
