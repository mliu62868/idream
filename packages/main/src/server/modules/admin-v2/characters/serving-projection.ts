import type { Prisma } from "@prisma/client";
import { CHARACTER_SERVING_STATES } from "../shared/state-transition-authority";
import { toInputJson } from "../shared/prisma-json";
import { releaseRecord } from "./release-snapshot-values";
import { Errors } from "@/server/lib/errors";

type ServingState = (typeof CHARACTER_SERVING_STATES)[number];

/**
 * SPEC: Serving controls availability; visibility preserves the operator's
 * catalog choice. First publication promotes private to public. Republishing,
 * pausing, resuming and retiring must not erase an existing unlisted choice.
 * INVARIANT: Non-live Characters are archived, so retained public visibility
 * cannot make a paused or retired Character available to customers.
 */
export function servingCharacterProjection(input: {
  readonly state: ServingState;
  readonly visibility: string;
  readonly avatarAssetId?: string | null;
}) {
  return input.state === "live"
    ? {
        status: "approved",
        visibility: input.visibility === "unlisted" ? "unlisted" : "public",
        ...(input.avatarAssetId !== undefined
          ? { imageAssetId: input.avatarAssetId }
          : {}),
      }
    : {
        status: "archived",
        visibility: input.visibility,
      };
}

/**
 * 把一次 Serving 状态变更投影到 Character 行。发布链里所有改变客户可见性的写入都必须经过这里。
 */
export async function projectServingToCharacter(
  tx: Prisma.TransactionClient,
  input: {
    readonly characterId: string;
    readonly state: ServingState;
    readonly avatarAssetId?: string | null;
    readonly content?: Prisma.CharacterUncheckedUpdateInput;
  },
) {
  // The same row lock serializes catalog choices and chat-tool settings with
  // Release projection, including resume which has no new content payload.
  const [character] = await tx.$queryRaw<Array<{ visibility: string; advancedDetails: Prisma.JsonValue }>>`
    SELECT "visibility", "advancedDetails" FROM "characters"
    WHERE "id" = ${input.characterId} FOR UPDATE
  `;
  if (!character) throw Errors.notFound("Character not found");
  let advancedDetails = input.content?.advancedDetails;
  if (advancedDetails !== undefined) {
    // SPEC: Release owns Soul/opening projections; operator switches survive
    // publish and rollback. Lock the row before merging so concurrent tool
    // settings cannot restore stale released content or be silently reset.
    advancedDetails = toInputJson({
      ...releaseRecord(character.advancedDetails),
      ...releaseRecord(advancedDetails),
    });
  }
  await tx.character.update({
    where: { id: input.characterId },
    data: {
      ...input.content,
      ...(advancedDetails !== undefined ? { advancedDetails } : {}),
      ...servingCharacterProjection({
        state: input.state,
        visibility: character.visibility,
        avatarAssetId: input.avatarAssetId,
      }),
    },
  });
}
