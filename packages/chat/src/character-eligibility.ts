export interface CharacterEligibility {
  creatorId: string | null;
  visibility: string;
  status: string;
  deletedAt: Date | null;
}

const CREATOR_CHAT_STATUSES = new Set([
  "draft",
  "pending_review",
  "approved",
]);

/**
 * Character lifecycle is authoritative for every caller, including the
 * creator. Creators may preview active drafts, but cannot bypass removal or
 * archival.
 */
export function characterAvailableToUser(
  character: CharacterEligibility,
  userId: string,
): boolean {
  if (character.deletedAt) return false;
  const creator = character.creatorId === userId;
  if (creator) return CREATOR_CHAT_STATUSES.has(character.status);
  return character.visibility === "public" &&
    character.status === "approved";
}
