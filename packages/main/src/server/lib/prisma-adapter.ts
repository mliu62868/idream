import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaClient } from "@prisma/client";
import { env } from "./env";

type PrismaClientOptions = NonNullable<ConstructorParameters<typeof PrismaClient>[0]>;

export function createPrismaClientOptions(): PrismaClientOptions {
  process.env.DATABASE_URL ??= env.DATABASE_URL;

  // SPEC: the test suite shares ONE Postgres instance (single `max_connections`)
  // with whatever local dev/PM2 stack is running. An uncapped pg pool (default
  // max 10) per process plus the dev-stack pools and setup/seed spikes can cross
  // the server ceiling and yield flaky "too many clients" failures. Cap the pool
  // in test so the suite coexists deterministically. Prod/dev keep the driver
  // default; override with DATABASE_POOL_MAX when a different ceiling is needed.
  const poolMax = resolvePoolMax();

  return {
    adapter: new PrismaPg({
      connectionString: env.DATABASE_URL,
      ...(poolMax ? { max: poolMax } : {}),
    }),
  };
}

function resolvePoolMax(): number | undefined {
  const override = process.env.DATABASE_POOL_MAX;
  if (override) {
    const parsed = Number.parseInt(override, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return env.APP_ENV === "test" ? 5 : undefined;
}
