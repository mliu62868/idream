import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { executeRecoveryRehearsal } from "@/server/readiness/recovery-rehearsal-executor";
import {
  parseRecoveryRehearsalCliArgs,
  resolveRecoveryRehearsalPlan,
  type RecoveryEnvironment,
} from "@/server/readiness/recovery-rehearsal-producer";
import { loadExpectedMigrationAuthority } from "@/server/readiness/migration-authority";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");

function readEnvFile(filePath: string | null, fallback: string) {
  const resolved = path.resolve(workspaceRoot, filePath ?? fallback);
  if (!existsSync(resolved)) {
    if (filePath) throw new Error(`Environment file does not exist: ${resolved}`);
    return {};
  }
  return parseDotenv(readFileSync(resolved));
}

function mergedServiceEnvironment(input: {
  launchEnvFile: string | null;
  chatEnvFile: string | null;
  genEnvFile: string | null;
  processEnv: NodeJS.ProcessEnv;
}): RecoveryEnvironment {
  const main = {
    ...readEnvFile(null, "packages/main/.env"),
    ...input.processEnv,
    ...(input.launchEnvFile
      ? readEnvFile(input.launchEnvFile, "packages/main/.env")
      : {}),
  };
  const chat = {
    ...readEnvFile(null, "packages/chat/.env"),
    ...input.processEnv,
    ...(input.chatEnvFile
      ? readEnvFile(input.chatEnvFile, "packages/chat/.env")
      : {}),
  };
  const gen = {
    ...readEnvFile(null, "packages/gen/.env"),
    ...input.processEnv,
    ...(input.genEnvFile
      ? readEnvFile(input.genEnvFile, "packages/gen/.env")
      : {}),
  };
  return {
    ...main,
    CHAT_DATABASE_URL: chat.CHAT_DATABASE_URL,
    CHAT_PROJECTOR_DATABASE_URL: chat.CHAT_PROJECTOR_DATABASE_URL,
    CHAT_FS_ROOT: chat.CHAT_FS_ROOT,
    GEN_BLOB_PROVIDER: gen.GEN_BLOB_PROVIDER ?? gen.BLOB_PROVIDER,
    IDREAM_GEN_BLOB_ENDPOINT: gen.BLOB_ENDPOINT,
    IDREAM_GEN_BLOB_BUCKET: gen.BLOB_BUCKET,
    IDREAM_GEN_BLOB_ROOT: gen.BLOB_ROOT,
  };
}

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
    "",
    "Apply additionally requires:",
    "  --apply",
    "  --confirmation \"CREATE RECOVERY REHEARSAL <bundleName>\"",
    "  APP_ENV=production IDREAM_QUIESCED=1",
    "",
    "Apply refuses live PM2/HTTP runtime, active database clients, non-exact",
    "migrations, pending durable work, split Main/Chat/Gen authorities, symlinks,",
    "unversioned remote objects, and any source/isolated-restore byte drift.",
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
  const environment = mergedServiceEnvironment({
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
