import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { canonicalSha256 } from "../shared/canonical-json";
import { characterWorkspaceTabLink } from "./character-deep-link";

const appearanceDirectionKeys = ["identityAnchor", "stableTraits", "style", "referenceDirection"] as const;

function appearanceDirection(snapshot: unknown) {
  const record = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
  return appearanceDirectionKeys.map((key) => record[key] ?? null);
}

/**
 * INVARIANT: once a Character has an active visual identity, its look is that identity
 * (portrait + sealed description). The appearance direction written at creation becomes
 * read-only, so text and portrait cannot drift apart; a new look is a new identity
 * version from Visual identity.
 * INTENT: product decision 2026-10-07. Both authoring entrances (Soul save, Project
 * PATCH) call this before writing; unchanged direction bytes always pass.
 */
export async function assertAppearanceDirectionUnlocked(
  tx: Prisma.TransactionClient,
  input: { characterId: string; before: unknown; after: unknown },
) {
  if (canonicalSha256(appearanceDirection(input.before)) === canonicalSha256(appearanceDirection(input.after))) return;
  const identity = await tx.characterVisualProfile.findFirst({
    where: { characterId: input.characterId, status: "active" },
    select: { id: true, version: true },
  });
  if (!identity) return;
  throw Errors.conflict(
    "The look is locked to the current visual identity. Change the look from Visual identity instead of editing the appearance text.",
    {
      blocker: "visual_identity_locked",
      visualProfileId: identity.id,
      visualProfileVersion: identity.version,
      deepLink: characterWorkspaceTabLink(input.characterId, "visual"),
    },
  );
}
