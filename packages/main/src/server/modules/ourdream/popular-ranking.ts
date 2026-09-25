import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";

// SPEC: EX-02 "Popular · Week / Month / All time".
//   week / month: chats started (recent_chats.createdAt) then likes given
//   (character_likes.createdAt) inside the last 7 / 30 days; the cumulative
//   stats (chatsCount, likesCount), newest, id break ties.
//   all: the cumulative keys alone.
// The last key is unique, so the order is total and the offset cursor stays
// stable between pages.
// INTENT: windowed counts come from the event rows rather than a rolling
// counter — the catalog is small enough to rank in memory (same as For You);
// materialize a per-day rollup only once the public catalog reaches thousands.
// INVARIANT: the window counts sessions, while stats.chatsCount counts
// replies — so "all" is a different quantity, not the window stretched to ∞.

export const POPULAR_PERIODS = ["week", "month", "all"] as const;
export type PopularPeriod = (typeof POPULAR_PERIODS)[number];
export const DEFAULT_POPULAR_PERIOD: PopularPeriod = "month";

const PERIOD_DAYS = { week: 7, month: 30 } as const;

export function popularPeriod(value: string | null): PopularPeriod {
  return POPULAR_PERIODS.includes(value as PopularPeriod) ? (value as PopularPeriod) : DEFAULT_POPULAR_PERIOD;
}

export const cumulativePopularOrderBy: Prisma.CharacterOrderByWithRelationInput[] = [
  { stats: { chatsCount: "desc" } },
  { stats: { likesCount: "desc" } },
  { createdAt: "desc" },
  { id: "asc" },
];

export type PopularCandidate = {
  readonly id: string;
  readonly createdAt: Date;
  readonly chatsCount: number;
  readonly likesCount: number;
  readonly recentChats: number;
  readonly recentLikes: number;
};

export function rankPopular<T extends PopularCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((left, right) =>
    right.recentChats - left.recentChats ||
    right.recentLikes - left.recentLikes ||
    right.chatsCount - left.chatsCount ||
    right.likesCount - left.likesCount ||
    right.createdAt.getTime() - left.createdAt.getTime() ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

// Ids of one windowed Popular page; the caller hydrates them in this order.
export async function windowedPopularPageIds(
  where: Prisma.CharacterWhereInput,
  period: Exclude<PopularPeriod, "all">,
  offset: number,
  take: number,
) {
  const since = new Date(Date.now() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000);
  const [candidates, chats, likes] = await Promise.all([
    prisma.character.findMany({
      where,
      select: { id: true, createdAt: true, stats: { select: { chatsCount: true, likesCount: true } } },
    }),
    prisma.recentChat.groupBy({ by: ["characterId"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.characterLike.groupBy({ by: ["characterId"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const chatsById = new Map(chats.map((row) => [row.characterId, row._count._all]));
  const likesById = new Map(likes.map((row) => [row.characterId, row._count._all]));
  return rankPopular(candidates.map((candidate) => ({
    id: candidate.id,
    createdAt: candidate.createdAt,
    chatsCount: candidate.stats?.chatsCount ?? 0,
    likesCount: candidate.stats?.likesCount ?? 0,
    recentChats: chatsById.get(candidate.id) ?? 0,
    recentLikes: likesById.get(candidate.id) ?? 0,
  }))).slice(offset, offset + take).map((candidate) => candidate.id);
}
