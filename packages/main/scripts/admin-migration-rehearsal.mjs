import { spawnSync } from "node:child_process";
import pg from "pg";

const sourceUrl = new URL(process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/idream");
const databaseName = `idream_admin_rehearsal_${Date.now()}`;
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
adminUrl.search = "";
const rehearsalUrl = new URL(sourceUrl);
rehearsalUrl.pathname = `/${databaseName}`;
rehearsalUrl.search = "";

function runDeploy() {
  const result = spawnSync("bunx", ["prisma", "migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: rehearsalUrl.toString(), DB_PROVIDER: "postgresql" },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const firstDeploy = runDeploy();
  const secondDeploy = runDeploy();
  const db = new pg.Client({ connectionString: rehearsalUrl.toString() });
  await db.connect();
  try {
    const tables = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename`, [["character_serving", "control_plane_commands", "generation_transport_executions", "incident_postmortems", "metric_definition_snapshots"]]);
    const triggers = await db.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[]) ORDER BY tgname`, [["analytics_events_immutable", "character_release_snapshot_immutable", "generation_attempt_terminal_event_required", "generation_transport_execution_lifecycle", "incident_postmortems_immutable"]]);
    const generationColumns = await db.query(`SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'generation_jobs' AND column_name = ANY($1::text[]) ORDER BY column_name`, [["deliveredOutputCount", "finishedAt", "version"]]);
    const servingConstraints = await db.query(`SELECT conname, condeferrable, convalidated FROM pg_constraint WHERE conname LIKE 'character_serving_%_fkey' ORDER BY conname`);
    const servingConstraintValidation = await db.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conname LIKE 'character_serving_%_fkey'
        AND NOT convalidated
      ORDER BY conname
    `);
    for (const constraint of servingConstraintValidation.rows) {
      await db.query(`ALTER TABLE character_serving VALIDATE CONSTRAINT "${constraint.conname}"`);
    }
    const validatedServingConstraints = await db.query(`SELECT conname, condeferrable, convalidated FROM pg_constraint WHERE conname LIKE 'character_serving_%_fkey' ORDER BY conname`);
    const rollbackCompatible = generationColumns.rows.every((column) => column.is_nullable === "YES" || column.column_default !== null);
    const checks = {
      freshDeployAppliedEveryMigration: !firstDeploy.includes("failed") && tables.rowCount === 5,
      redeployIsIdempotent: secondDeploy.includes("No pending migrations") || secondDeploy.includes("already in sync"),
      databaseGuardsPresent: triggers.rowCount === 5,
      servingConstraintsPresent: servingConstraints.rowCount === 3 && servingConstraints.rows.every((row) => row.condeferrable === true),
      servingConstraintsValidateAfterBackfill: validatedServingConstraints.rowCount === 3 && validatedServingConstraints.rows.every((row) => row.convalidated === true),
      previousAppWriteShapeCompatible: rollbackCompatible,
    };
    const report = {
      status: Object.values(checks).every(Boolean) ? "pass" : "fail",
      databaseName,
      tables: tables.rows,
      triggers: triggers.rows,
      generationColumns: generationColumns.rows,
      servingConstraints: servingConstraints.rows,
      validatedServingConstraints: validatedServingConstraints.rows,
      checks,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "pass") process.exitCode = 1;
  } finally {
    await db.end();
  }
} finally {
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [databaseName]).catch(() => undefined);
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
  await admin.end();
}
