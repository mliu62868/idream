import { readFile } from "node:fs/promises";
import type { GenerationJob, GenerationModelProfile } from "@prisma/client";
import pg from "pg";
import { expect } from "vitest";

export async function historicalCutoverSql(url: URL) {
  // The test owns the transaction so successful publications can also roll back.
  return (await readFile(url, "utf8")).replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
}

export async function withHistoricalImageCatalog(run: (client: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    // Historical SQL must see its release-era catalogue, not today's seed.
    // Preserve real PostgreSQL column types, defaults, checks and indexes;
    // only these two tables are referenced by the cutovers exercised here.
    await client.query(`CREATE TEMP TABLE generation_model_profiles
      (LIKE public.generation_model_profiles INCLUDING ALL) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE generation_jobs
      (LIKE public.generation_jobs INCLUDING ALL) ON COMMIT DROP`);
    await client.query("SET LOCAL search_path = pg_temp, public");
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

type HistoricalProfile = Pick<GenerationModelProfile, "id" | "profileKey" | "label" | "pipelineModel" | "workflowKey">
  & Partial<GenerationModelProfile>;

export async function createHistoricalProfile(client: pg.Client, data: HistoricalProfile) {
  const fields = {
    mode: "image", runner: "comfyui", status: "active", allowedOrientations: ["4:5"],
    publishedAt: new Date("2026-09-01T00:00:00.000Z"), updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...data,
  };
  const keys = Object.keys(fields);
  const values = Object.values(fields).map((value) =>
    value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value);
  return (await client.query<GenerationModelProfile>(
    `INSERT INTO generation_model_profiles (${keys.map((key) => `"${key}"`).join(",")})
      VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")}) RETURNING *`, values,
  )).rows[0];
}

export async function createHistoricalJob(client: pg.Client, data: Pick<GenerationJob, "id"> & Partial<GenerationJob>) {
  const fields = {
    userId: "seed-dev-user", mode: "image", controls: {}, presetIds: [],
    updatedAt: new Date("2026-09-01T00:00:00.000Z"), ...data,
  };
  const keys = Object.keys(fields);
  const values = Object.values(fields).map((value) =>
    value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value);
  return (await client.query<GenerationJob>(
    `INSERT INTO generation_jobs (${keys.map((key) => `"${key}"`).join(",")})
      VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")}) RETURNING *`, values,
  )).rows[0];
}

export async function historicalProfiles(client: pg.Client) {
  return (await client.query<GenerationModelProfile>("SELECT * FROM generation_model_profiles ORDER BY id")).rows;
}

export async function expectHistoricalCutoverRejected(client: pg.Client, sql: string, message: string) {
  const before = await historicalProfiles(client);
  const jobs = (await client.query("SELECT * FROM generation_jobs ORDER BY id")).rows;
  await client.query("SAVEPOINT rejected_cutover");
  await expect(client.query(sql)).rejects.toThrow(message);
  await client.query("ROLLBACK TO SAVEPOINT rejected_cutover");
  expect(await historicalProfiles(client)).toEqual(before);
  expect((await client.query("SELECT * FROM generation_jobs ORDER BY id")).rows).toEqual(jobs);
}
