import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = new URL(
  "./migrations/20260828200000_retire_darkbeast_flux2_klein_9b/migration.sql",
  import.meta.url,
);

describe("Dark Beast FLUX.2 Klein 9B retirement migration", () => {
  it("archives every known profile identity without deleting history", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(sql).toContain('UPDATE "generation_model_profiles"');
    expect(sql).toContain('"enabled" = false');
    expect(sql).toContain('"rolloutPercent" = 0');
    expect(sql).toContain('"status" = \'archived\'');
    expect(sql).toContain('"pipelineModel" = \'darkbeast-flux2-klein-9b-bfs\'');
    expect(sql).toContain(
      '"workflowKey" = \'darkbeast-flux2-klein-9b-multi-reference\'',
    );
    expect(sql).toContain(
      "Dark Beast FLUX.2 Klein 9B profile remains executable",
    );
    expect(sql).not.toContain("DELETE FROM");
  });
});
