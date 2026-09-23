import { prisma } from "@/server/lib/db";
import { communityFollowedCreatorIds } from "./discovery";

// SPEC: EX-02 "For You" — a taste profile built from the viewer's own actions.
//   score = Σ tag weights + style weight + followed-creator bonus
//   liked Character: each of its tags / its style +2; chatted Character: +1.
//   A Character by a creator the viewer follows: +3.
// Ordering: not-yet-chatted first (discovery, not re-surfacing), then score,
// then the Popular keys (chats, likes, newest, id). The last key is unique, so
// the order is total and the offset cursor stays stable between pages.
// INTENT: no signal (anonymous or a brand-new account) returns null and the
// caller serves Popular — there is nothing personal to rank by, and saying
// "For You" over an empty profile would be a pretence either way.

const LIKE_WEIGHT = 2;
const CHAT_WEIGHT = 1;
const FOLLOWED_CREATOR_BONUS = 3;

export type ForYouProfile = {
  readonly tagWeights: ReadonlyMap<string, number>;
  readonly styleWeights: ReadonlyMap<string, number>;
  readonly followedCreatorIds: ReadonlySet<string>;
  readonly chattedCharacterIds: ReadonlySet<string>;
};

export type ForYouCandidate = {
  readonly id: string;
  readonly style: string;
  readonly creatorId: string | null;
  readonly createdAt: Date;
  readonly tagSlugs: readonly string[];
  readonly chatsCount: number;
  readonly likesCount: number;
};

export async function loadForYouProfile(userId: string): Promise<ForYouProfile | null> {
  const signalCharacter = { select: { style: true, tags: { select: { tag: { select: { slug: true } } } } } } as const;
  const [likes, chats, followedCreatorIds] = await Promise.all([
    prisma.characterLike.findMany({ where: { userId }, select: { character: signalCharacter } }),
    prisma.recentChat.findMany({
      where: { userId },
      distinct: ["characterId"],
      select: { characterId: true, character: signalCharacter },
    }),
    communityFollowedCreatorIds(userId),
  ]);
  if (likes.length === 0 && chats.length === 0 && followedCreatorIds.length === 0) return null;
  const tagWeights = new Map<string, number>();
  const styleWeights = new Map<string, number>();
  const add = (map: Map<string, number>, key: string, weight: number) =>
    map.set(key, (map.get(key) ?? 0) + weight);
  for (const [rows, weight] of [[likes, LIKE_WEIGHT], [chats, CHAT_WEIGHT]] as const) {
    for (const { character } of rows) {
      add(styleWeights, character.style, weight);
      for (const { tag } of character.tags) add(tagWeights, tag.slug, weight);
    }
  }
  return {
    tagWeights,
    styleWeights,
    followedCreatorIds: new Set(followedCreatorIds),
    chattedCharacterIds: new Set(chats.map((chat) => chat.characterId)),
  };
}

export function forYouScore(candidate: ForYouCandidate, profile: ForYouProfile) {
  return candidate.tagSlugs.reduce((sum, slug) => sum + (profile.tagWeights.get(slug) ?? 0), 0) +
    (profile.styleWeights.get(candidate.style) ?? 0) +
    (candidate.creatorId && profile.followedCreatorIds.has(candidate.creatorId) ? FOLLOWED_CREATOR_BONUS : 0);
}

export function rankForYou<T extends ForYouCandidate>(candidates: readonly T[], profile: ForYouProfile): T[] {
  const scored = candidates.map((candidate) => ({
    candidate,
    chatted: profile.chattedCharacterIds.has(candidate.id) ? 1 : 0,
    score: forYouScore(candidate, profile),
  }));
  scored.sort((left, right) =>
    left.chatted - right.chatted ||
    right.score - left.score ||
    right.candidate.chatsCount - left.candidate.chatsCount ||
    right.candidate.likesCount - left.candidate.likesCount ||
    right.candidate.createdAt.getTime() - left.candidate.createdAt.getTime() ||
    (left.candidate.id < right.candidate.id ? -1 : left.candidate.id > right.candidate.id ? 1 : 0));
  return scored.map(({ candidate }) => candidate);
}
