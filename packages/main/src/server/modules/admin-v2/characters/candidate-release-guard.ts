import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { characterWorkspaceTabLink } from "./character-deep-link";

/**
 * INVARIANT: while a candidate Release (status approved) exists, draft content and
 * image placements are frozen. The candidate pins its revision and image set; an edit
 * made beside it would never ship with it, and Publish would silently ship the older one.
 * The operator publishes or discards the candidate first (Release tab).
 */
export async function assertNoCandidateRelease(
  tx: Prisma.TransactionClient,
  input: { projectId: string; characterId: string; message: string },
) {
  const candidate = await tx.characterRelease.findFirst({
    where: { projectId: input.projectId, status: "approved" },
    select: { id: true, status: true },
  });
  if (!candidate) return;
  throw Errors.conflict(input.message, {
    // Admin keys its "publish or discard the candidate" copy on this blocker.
    blocker: "candidate_release_pending",
    releaseId: candidate.id,
    status: candidate.status,
    deepLink: characterWorkspaceTabLink(input.characterId, "release"),
  });
}
