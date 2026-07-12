import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const sourceUrl = new URL(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/idream");
const runId = Date.now();
const freshDatabaseName = `idream_admin_rehearsal_fresh_${runId}`;
const upgradeDatabaseName = `idream_admin_rehearsal_upgrade_${runId}`;
const baselineMigration = "20260711000000_baseline";
const migrationsDirectory = path.join(process.cwd(), "prisma", "migrations");
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";

function databaseUrl(databaseName) {
  const url = new URL(sourceUrl);
  url.pathname = `/${databaseName}`;
  url.search = "";
  return url;
}

function runPrisma(databaseName, args) {
  const result = spawnSync("bunx", ["prisma", "migrate", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl(databaseName).toString(),
      DB_PROVIDER: "postgresql",
    },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function deploy(databaseName) {
  return runPrisma(databaseName, ["deploy"]);
}

function isNoopDeploy(output) {
  return output.includes("No pending migrations") || output.includes("already in sync");
}

async function createDatabase(admin, databaseName) {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
}

async function dropDatabase(admin, databaseName) {
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1",
    [databaseName],
  ).catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
}

async function inspectExpandedSchema(databaseName) {
  const db = new pg.Client({ connectionString: databaseUrl(databaseName).toString() });
  await db.connect();
  try {
    const tables = await db.query(
      `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])
       ORDER BY tablename`,
      [[
        "character_serving",
        "character_qa_runs",
        "control_plane_commands",
        "generation_transport_executions",
        "incident_postmortems",
        "metric_definition_snapshots",
      ]],
    );
    const triggers = await db.query(
      `SELECT tgname
       FROM pg_trigger
       WHERE NOT tgisinternal AND tgname = ANY($1::text[])
       ORDER BY tgname`,
      [[
        "analytics_events_immutable",
        "character_release_snapshot_immutable",
        "character_qa_runs_immutable_update",
        "generation_attempt_terminal_event_required",
        "generation_transport_execution_lifecycle",
        "incident_postmortems_immutable",
      ]],
    );
    const generationColumns = await db.query(
      `SELECT column_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'generation_jobs'
         AND column_name = ANY($1::text[])
       ORDER BY column_name`,
      [["deliveredOutputCount", "finishedAt", "version"]],
    );
    const servingConstraints = await db.query(
      `SELECT conname, condeferrable, convalidated
       FROM pg_constraint
       WHERE conname LIKE 'character_serving_%_fkey'
       ORDER BY conname`,
    );
    const unvalidated = servingConstraints.rows.filter((row) => !row.convalidated);
    for (const constraint of unvalidated) {
      await db.query(`ALTER TABLE character_serving VALIDATE CONSTRAINT "${constraint.conname}"`);
    }
    const validatedServingConstraints = await db.query(
      `SELECT conname, condeferrable, convalidated
       FROM pg_constraint
       WHERE conname LIKE 'character_serving_%_fkey'
       ORDER BY conname`,
    );
    const migrationHistory = await db.query(
      `SELECT migration_name, finished_at, rolled_back_at
       FROM _prisma_migrations
       ORDER BY migration_name`,
    );
    const expectedMigrations = (await readdir(migrationsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const qaRunId = `migration-rehearsal-qa-${runId}`;
    await db.query(
      `INSERT INTO character_qa_runs
        (id, "characterId", "projectId", "characterContentVersionId", "projectVersion", "ownerId", status, checks, "evidenceHash")
       VALUES ($1, 'character', 'project', 'content', 1, 'owner', 'passed', '[]'::jsonb, $2)`,
      [qaRunId, `migration-rehearsal-qa-hash-${runId}-${databaseName}`],
    );
    let qaImmutableUpdateRejected = false;
    try {
      await db.query(`UPDATE character_qa_runs SET status = 'failed' WHERE id = $1`, [qaRunId]);
    } catch (error) {
      qaImmutableUpdateRejected = String(error).includes("character_qa_runs are immutable");
    }
    await db.query(`DELETE FROM character_qa_runs WHERE id = $1`, [qaRunId]);
    return {
      tables: tables.rows,
      triggers: triggers.rows,
      generationColumns: generationColumns.rows,
      servingConstraints: servingConstraints.rows,
      validatedServingConstraints: validatedServingConstraints.rows,
      migrationHistory: migrationHistory.rows,
      checks: {
        migrationHistoryComplete:
          migrationHistory.rowCount === expectedMigrations.length
          && migrationHistory.rows.every(
            (row, index) => row.migration_name === expectedMigrations[index]
              && row.finished_at !== null
              && row.rolled_back_at === null,
          ),
        expandedTablesPresent: tables.rowCount === 6,
        databaseGuardsPresent: triggers.rowCount === 6,
        qaImmutableUpdateRejected,
        servingConstraintsPresent:
          servingConstraints.rowCount === 3
          && servingConstraints.rows.every((row) => row.condeferrable === true),
        servingConstraintsValidateAfterBackfill:
          validatedServingConstraints.rowCount === 3
          && validatedServingConstraints.rows.every((row) => row.convalidated === true),
        previousAppWriteShapeCompatible: generationColumns.rows.every(
          (column) => column.is_nullable === "YES" || column.column_default !== null,
        ),
      },
    };
  } finally {
    await db.end();
  }
}

async function applyBaselineSnapshot(databaseName) {
  const baselineSql = await readFile(
    path.join(migrationsDirectory, baselineMigration, "migration.sql"),
    "utf8",
  );
  const db = new pg.Client({ connectionString: databaseUrl(databaseName).toString() });
  await db.connect();
  try {
    await db.query(baselineSql);
  } finally {
    await db.end();
  }
  runPrisma(databaseName, ["resolve", "--applied", baselineMigration]);
}

async function exercisePreviousAppWriteShape(databaseName) {
  const db = new pg.Client({ connectionString: databaseUrl(databaseName).toString() });
  await db.connect();
  try {
    const userId = `rehearsal-user-${runId}`;
    const jobId = `rehearsal-job-${runId}`;
    await db.query(
      `INSERT INTO users (id, email, "emailVerified", role, status, "updatedAt")
       VALUES ($1, $2, false, 'user', 'active', NOW())`,
      [userId, `${userId}@example.test`],
    );
    await db.query(
      `INSERT INTO generation_jobs
         (id, "userId", mode, controls, "presetIds", status, "updatedAt")
       VALUES ($1, $2, 'image', '{}'::jsonb, '[]'::jsonb, 'queued', NOW())`,
      [jobId, userId],
    );
    await db.query(
      `UPDATE generation_jobs
       SET status = 'failed', "errorCode" = 'legacy_app_rehearsal', "updatedAt" = NOW()
       WHERE id = $1`,
      [jobId],
    );
    const result = await db.query(
      `SELECT status, "deliveredOutputCount", version
       FROM generation_jobs
       WHERE id = $1`,
      [jobId],
    );
    return result.rows[0] ?? null;
  } finally {
    await db.end();
  }
}

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  await createDatabase(admin, freshDatabaseName);
  await createDatabase(admin, upgradeDatabaseName);

  const freshFirstDeploy = deploy(freshDatabaseName);
  const freshSecondDeploy = deploy(freshDatabaseName);
  const freshSchema = await inspectExpandedSchema(freshDatabaseName);

  await applyBaselineSnapshot(upgradeDatabaseName);
  const upgradeFirstDeploy = deploy(upgradeDatabaseName);
  const upgradeSecondDeploy = deploy(upgradeDatabaseName);
  const upgradeSchema = await inspectExpandedSchema(upgradeDatabaseName);

  // This is the application rollback leg: an older binary writes only the
  // baseline column set after the additive schema has landed.
  const previousAppRow = await exercisePreviousAppWriteShape(upgradeDatabaseName);
  // Re-deploying the current application/migrations proves the forward-fix leg
  // remains a no-op and preserves the old binary's durable write.
  const forwardFixDeploy = deploy(upgradeDatabaseName);
  const db = new pg.Client({ connectionString: databaseUrl(upgradeDatabaseName).toString() });
  await db.connect();
  const preservedPreviousAppRow = await db.query(
    `SELECT status, "deliveredOutputCount", version
     FROM generation_jobs
     WHERE id = $1`,
    [`rehearsal-job-${runId}`],
  );
  await db.end();

  const checks = {
    freshDeployAppliedEveryMigration:
      !freshFirstDeploy.includes("failed") && freshSchema.checks.expandedTablesPresent,
    freshRedeployIsIdempotent: isNoopDeploy(freshSecondDeploy),
    currentSnapshotBaselineResolved: !upgradeFirstDeploy.includes(baselineMigration),
    currentSnapshotForwardDeployApplied:
      !upgradeFirstDeploy.includes("failed") && upgradeSchema.checks.expandedTablesPresent,
    currentSnapshotRedeployIsIdempotent: isNoopDeploy(upgradeSecondDeploy),
    applicationRollbackWriteCompatible:
      previousAppRow?.status === "failed"
      && previousAppRow.deliveredOutputCount === 0
      && previousAppRow.version === 1,
    forwardFixRedeployIsIdempotent: isNoopDeploy(forwardFixDeploy),
    forwardFixPreservesRollbackWrite:
      preservedPreviousAppRow.rows[0]?.status === "failed"
      && preservedPreviousAppRow.rows[0]?.deliveredOutputCount === 0
      && preservedPreviousAppRow.rows[0]?.version === 1,
    freshSchemaGuardsPass: Object.values(freshSchema.checks).every(Boolean),
    upgradedSchemaGuardsPass: Object.values(upgradeSchema.checks).every(Boolean),
  };
  const report = {
    status: Object.values(checks).every(Boolean) ? "pass" : "fail",
    scenarios: {
      fresh: {
        databaseName: freshDatabaseName,
        schema: freshSchema,
      },
      currentSnapshotUpgrade: {
        databaseName: upgradeDatabaseName,
        baselineMigration,
        previousAppRow,
        preservedPreviousAppRow: preservedPreviousAppRow.rows[0] ?? null,
        schema: upgradeSchema,
      },
    },
    checks,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== "pass") process.exitCode = 1;
} finally {
  await dropDatabase(admin, freshDatabaseName);
  await dropDatabase(admin, upgradeDatabaseName);
  await admin.end();
}
