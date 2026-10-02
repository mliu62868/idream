import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { expect, it } from "vitest";
import { env } from "@/server/lib/env";

it("rehearses additive attribution evidence without rewriting old observations and freezes new evidence", async () => {
  const schema = `affiliate_migration_${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: env.DATABASE_URL }); await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE affiliate_clicks(id TEXT PRIMARY KEY,"affiliateUserId" TEXT NOT NULL,code TEXT NOT NULL,"visitorKey" TEXT NOT NULL,"landingPath" TEXT NOT NULL,"convertedAt" TIMESTAMP(3),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT now());
      INSERT INTO affiliate_clicks VALUES('old','partner','code','visitor','/',TIMESTAMP '2026-09-01 12:00:00',TIMESTAMP '2026-09-01 11:00:00');`);
    await client.query(await readFile(new URL("../../../../prisma/migrations/20261001030000_affiliate_attribution_evidence/migration.sql", import.meta.url), "utf8"));
    expect((await client.query(`SELECT "convertedAt"::text,"convertedUserId","attributionVersion","attributionWindowDays","termsVersion" FROM affiliate_clicks WHERE id='old'`)).rows[0]).toEqual({ convertedAt: "2026-09-01 12:00:00", convertedUserId: null, attributionVersion: null, attributionWindowDays: null, termsVersion: null });
    await client.query(`INSERT INTO affiliate_clicks(id,"affiliateUserId",code,"visitorKey","landingPath","attributionVersion","attributionWindowDays","termsVersion") VALUES('new','partner','code','new-visitor','/','affiliate-signup-v1',30,'published-terms')`);
    await expect(client.query(`UPDATE affiliate_clicks SET "attributionWindowDays"=365 WHERE id='new'`)).rejects.toThrow(/immutable/);
    await client.query(`UPDATE affiliate_clicks SET "convertedAt"=now(),"convertedUserId"='signup-user' WHERE id='new'`);
    await expect(client.query(`UPDATE affiliate_clicks SET "convertedUserId"='another-user' WHERE id='new'`)).rejects.toThrow(/immutable/);
    await expect(client.query(`UPDATE affiliate_clicks SET "convertedUserId"='invented-old-user' WHERE id='old'`)).rejects.toThrow(/immutable/);
    await expect(client.query(`INSERT INTO affiliate_clicks(id,"affiliateUserId",code,"visitorKey","landingPath","attributionVersion","attributionWindowDays","termsVersion") VALUES('partial','partner','code','partial','/','affiliate-signup-v1',NULL,'terms')`)).rejects.toThrow(/check constraint/);
    await expect(client.query(`INSERT INTO affiliate_clicks(id,"affiliateUserId",code,"visitorKey","landingPath","convertedAt","convertedUserId") VALUES('duplicate','partner','code','duplicate','/',now(),'signup-user')`)).rejects.toThrow(/unique/);
  } finally { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await client.end(); }
});
