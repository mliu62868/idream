import { inspectMigrationAuthority } from "@/server/readiness/migration-authority";

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for migration authority check");
  }

  const authority = await inspectMigrationAuthority(databaseUrl);
  process.stdout.write(`${JSON.stringify(authority, null, 2)}\n`);
  if (!authority.schemaPostconditionsChecked || !authority.ok) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
