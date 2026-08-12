import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  path.join(
    process.cwd(),
    "prisma/migrations/20260811143000_runtime_schema_reconciliation/migration.sql",
  ),
  "utf8",
);

describe("runtime schema reconciliation migration", () => {
  it("moves every retired runtime value into current Prisma authority", () => {
    expect(migration).toContain("SET runner = 'comfyui'");
    expect(migration).toContain("WHERE runner = 'sd_cpp'");
    expect(migration).toContain("ALTER COLUMN runner SET DEFAULT 'comfyui'");
    expect(migration).toContain(
      "SET \"validationState\" = 'late_after_cancelled'",
    );
    expect(migration).toContain(
      "WHERE \"validationState\" = 'late_after_cancel'",
    );
  });

  it("drops only the obsolete visual-profile shadow authority", () => {
    expect(migration).toContain(
      'ALTER TABLE public.character_visual_profiles\n  DROP COLUMN IF EXISTS "referenceAssetIds"',
    );
    expect(migration).not.toContain("CASCADE");
    expect(migration).not.toContain("generation_jobs");
    expect(migration).toContain("shadow column remains");
  });

  it("fails closed until every non-empty profile shadow is covered by one active Reference Set", () => {
    const shapeGate = migration.indexOf(
      "referenceAssetIds must be a JSON array of non-empty media asset ids",
    );
    const parityGate = migration.indexOf(
      "referenceAssetIds shadow parity failed",
    );
    const dropColumn = migration.indexOf(
      'DROP COLUMN IF EXISTS "referenceAssetIds"',
    );

    expect(shapeGate).toBeGreaterThan(-1);
    expect(parityGate).toBeGreaterThan(shapeGate);
    expect(dropColumn).toBeGreaterThan(parityGate);
    expect(migration).toContain("jsonb_typeof");
    expect(migration).toContain("jsonb_array_elements_text");
    expect(migration).toContain(
      'active_revisions."visualProfileId" = profiles.id',
    );
    expect(migration).toContain('revisions."visualProfileId" = profiles.id');
    expect(migration).toContain('revisions."status" = \'active\'');
    expect(migration).toContain(
      "public.character_visual_reference_snapshots",
    );
    expect(migration).toContain("active_reference_set_count <> 1");
    expect(migration).toContain(
      "LOCK TABLE public.character_visual_profiles IN ACCESS EXCLUSIVE MODE",
    );
    expect(migration).toContain("IN SHARE MODE");
    expect(migration).toContain("USING ERRCODE = '23514'");
  });

  it("fails the transaction if any retired state survives", () => {
    expect(migration.startsWith("BEGIN;")).toBe(true);
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(migration).toContain("retired generation runner sd_cpp remains");
    expect(migration).toContain(
      "retired artifact state late_after_cancel remains",
    );
  });
});
