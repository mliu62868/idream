export interface NameMatchFilter {
  contains: string;
}

export function normalizeSearchQuery(query: string) {
  return query.trim().replace(/\s+/g, " ");
}

export function nameMatch(query: string): NameMatchFilter | undefined {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return undefined;

  // Postgres trigram indexes can be added in migrations while keeping this
  // Prisma filter portable.
  return { contains: normalized };
}

export function activeDbProvider() {
  return "postgresql";
}
