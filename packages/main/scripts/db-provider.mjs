// Load packages/main/.env so a standalone invocation (e.g. via `db:generate`
// in the build pipeline) sees the same DB_PROVIDER as the Next.js runtime.
// Without this, node defaults DB_PROVIDER→sqlite while env.ts (dotenv) picks
// postgresql, generating a client that mismatches the runtime adapter.
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";

const provider = process.env.DB_PROVIDER ?? "sqlite";

if (!["sqlite", "postgresql"].includes(provider)) {
  throw new Error(`Invalid DB_PROVIDER: ${provider}`);
}

const file = "prisma/schema.prisma";
const source = readFileSync(file, "utf8");
const next = source.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"(sqlite|postgresql)"/s,
  `$1"${provider}"`,
);

if (next === source) {
  console.log(`[db-provider] datasource.provider already ${provider}`);
} else {
  writeFileSync(file, next);
  console.log(`[db-provider] datasource.provider = ${provider}`);
}
