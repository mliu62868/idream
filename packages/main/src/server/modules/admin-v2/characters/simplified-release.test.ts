import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(path: string) {
  return readFileSync(`${root}/${path}`, "utf8");
}

describe("simplified Character publishing", () => {
  it("exposes one create-and-validate operation before the durable publish command", () => {
    const route = source(
      "src/app/api/v2/admin/characters/[id]/releases/route.ts",
    );
    const lifecycle = source(
      "src/server/modules/admin-v2/characters/release-lifecycle.ts",
    );

    expect(route).toMatch(
      /actorWithPermission\(\s*request,\s*"character\.release\.publish"/,
    );
    expect(route).toContain("createCharacterRelease");
    expect(lifecycle).toContain("validateCharacterReleaseSnapshot");
    expect(lifecycle).toContain('status: "approved"');

    for (const retiredWorkflow of [
      "qaRunId",
      "reviewCharacterRelease",
      "validateCharacterRelease(",
      "transitionCharacterProject",
    ]) {
      expect(`${route}\n${lifecycle}`).not.toContain(retiredWorkflow);
    }
  });

  it("removes project phase, scheduled serving, and per-character QA storage", () => {
    const schema = source("prisma/schema.prisma");
    const migration = source(
      "prisma/migrations/20260828120000_simplify_character_release/migration.sql",
    );
    const rehearsal = source("scripts/admin-migration-rehearsal.mjs");

    expect(schema).not.toContain("model CharacterQaRun");
    expect(schema).not.toContain("scheduledReleaseId");
    expect(migration).toContain('DROP COLUMN IF EXISTS "phase"');
    expect(migration).toContain('DROP TABLE IF EXISTS "character_qa_runs"');
    expect(migration).toContain('DROP COLUMN IF EXISTS "scheduledReleaseId"');
    expect(
      migration.indexOf('DROP TABLE IF EXISTS "character_qa_runs"'),
    ).toBeLessThan(
      migration.indexOf(
        'DROP FUNCTION IF EXISTS "reject_character_qa_run_update"',
      ),
    );
    expect(rehearsal).not.toContain("character_qa_runs");
    expect(rehearsal).not.toContain("character_qa_runs_immutable_update");
    expect(rehearsal).not.toContain('"ownerId", phase, audience');
    expect(rehearsal).toContain("servingConstraints.rowCount === 2");
  });
});
