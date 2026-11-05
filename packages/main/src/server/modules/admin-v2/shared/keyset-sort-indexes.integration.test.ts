import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

// SPEC: the unfiltered keyset pages of these Admin lists are served by an index on their sort.
const INDEXES = [
  ["admin_audit_logs", "admin_audit_logs_createdAt_id_idx", '("createdAt", id)'],
  ["dreamcoin_ledger", "dreamcoin_ledger_createdAt_id_idx", '("createdAt", id)'],
  ["generation_jobs", "generation_jobs_createdAt_id_idx", '("createdAt", id)'],
  ["generation_jobs", "generation_jobs_updatedAt_id_idx", '("updatedAt", id)'],
] as const;

describe("Admin keyset sort indexes", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(INDEXES)("%s has %s", async (table, name, columns) => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = ${table} AND indexname = ${name}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain(columns);
  });

  it("ships each index in the migration that production applies", () => {
    const migration = readFileSync(
      new URL("../../../../../prisma/migrations/20261105010000_admin_keyset_sort_indexes/migration.sql", import.meta.url),
      "utf8",
    );
    for (const [table, name] of INDEXES) {
      expect(migration).toContain(`CREATE INDEX "${name}" ON "${table}"`);
    }
  });
});
