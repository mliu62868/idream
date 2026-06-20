import { env } from "../env";

export interface NameMatchFilter {
  contains: string;
}

export function normalizeSearchQuery(query: string) {
  return query.trim().replace(/\s+/g, " ");
}

export function nameMatch(query: string): NameMatchFilter | undefined {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return undefined;

  // SQLite has no Prisma mode: "insensitive"; Postgres can use trigram indexes
  // added in migrations while keeping the schema filter portable.
  return { contains: normalized };
}

export function activeDbProvider() {
  return env.DB_PROVIDER;
}
