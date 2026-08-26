export interface NameMatchFilter {
  contains: string;
  mode: "insensitive";
}

export function normalizeSearchQuery(query: string) {
  return query.trim().replace(/\s+/g, " ");
}

export function nameMatch(query: string): NameMatchFilter | undefined {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return undefined;

  // SPEC: 搜索按用户输入的大小写无关匹配 —— Prisma 的 contains 在 Postgres 上默认
  // 走大小写敏感的 LIKE，"alexa" 匹配不到 "Alexa Reeves"。
  // Postgres trigram indexes can be added in migrations while keeping this
  // Prisma filter portable.
  return { contains: normalized, mode: "insensitive" };
}

export function activeDbProvider() {
  return "postgresql";
}
