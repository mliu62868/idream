import path from "node:path";
import { executeRecoveryRehearsal } from "@/server/readiness/recovery-rehearsal-executor";
import { loadRecoveryServiceEnvironment } from "@/server/readiness/recovery-service-environment";
import {
  parseRecoveryRehearsalCliArgs,
  resolveRecoveryRehearsalPlan,
} from "@/server/readiness/recovery-rehearsal-producer";
import { loadExpectedMigrationAuthority } from "@/server/readiness/migration-authority";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");

function help() {
  return [
    "Usage:",
    "  bun run recovery:rehearse -- [options]",
    "",
    "Dry-run (default):",
    "  --bundle-parent <path>       Parent of the immutable flat bundle",
    "  --bundle-name <name>         Safe idream-recovery-* name",
    "  --launch-env-file <path>     Main/launch production dotenv",
    "  --chat-env-file <path>       Chat production dotenv",
    "  --gen-env-file <path>        Gen production dotenv",
    "  RECOVERY_DATABASE_URL        Explicit superuser actor on exact Main DB",
    "",
    "Apply additionally requires:",
    "  --apply",
    "  --confirmation \"CREATE RECOVERY REHEARSAL <bundleName>\"",
    "  APP_ENV=production IDREAM_QUIESCED=1",
    "",
    "Apply establishes and verifies the Generation queue pause/drain boundary,",
    "then refuses non-terminal PM2/HTTP runtime, active database clients,",
    "non-exact migrations, in-flight durable mutations, split Main/Chat/Gen",
    "authorities, symlinks (stable backlog is preserved), unversioned remote",
    "objects, missing independent recovery Blob authority, and restore drift.",
    "",
  ].join("\n");
}

async function main() {
  const options = parseRecoveryRehearsalCliArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help());
    return;
  }
  const expectedMigrations = await loadExpectedMigrationAuthority();
  const environment = loadRecoveryServiceEnvironment({
    workspaceRoot,
    launchEnvFile: options.launchEnvFile,
    chatEnvFile: options.chatEnvFile,
    genEnvFile: options.genEnvFile,
    processEnv: process.env,
  });
  const plan = resolveRecoveryRehearsalPlan({
    options,
    env: environment,
    expectedMigrationCount: expectedMigrations.length,
    latestMigration: expectedMigrations.at(-1)?.migrationName ?? null,
    workspaceRoot,
    chatWorkingDirectory: path.join(workspaceRoot, "packages/chat"),
  });

  if (!options.apply) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    if (!plan.safeToApply) process.exitCode = 1;
    return;
  }
  if (!plan.safeToApply) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }

  const result = await executeRecoveryRehearsal({
    plan,
    env: environment as NodeJS.ProcessEnv,
    expectedMigrations,
    workspaceRoot,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
