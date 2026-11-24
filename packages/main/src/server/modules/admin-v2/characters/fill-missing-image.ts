import {
  assignCharacterImageCandidates,
  type CharacterImageSourceAsset,
  type CreativeRunFillSkip,
} from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import { isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import {
  operationalCharacterWhere,
  operationalContentProductionBatchWhere,
  operationalMediaAssetWhere,
} from "@/server/modules/metric-data-scope";
import { deriveCreativeItemExecutionState } from "../creative/run-state";
import { ACTIVE_CONTROL_PLANE_COMMAND_STATUSES } from "../shared/control-plane-command";
import { characterCommandCoordinationKey } from "./command-coordination";
import { characterDraftAssetPurposes, draftAssetRouteEntries, type CharacterDraftAssetPurpose } from "./draft-asset-route-authority";
import { lockCharacterMediaAssetAuthorities } from "./generation-authority-lock";
import { resolveSelectableCharacterImage } from "./image-qualification";
import { listCharacterImageSources } from "./image-sources";
import {
  availablePurposes,
  characterImagePackProgress,
  projectCurrentDraftAssetPack,
  releaseAssetPack,
  workingCharacterImagePack,
} from "./production-journey";

type FillDecision = { readonly projectId: string; readonly skip: CreativeRunFillSkip };

// INVARIANT: The caller holds Character generation authority. The slot, assigned
// images and in-flight Run must all be read again before reserving generation.
export async function checkMissingCharacterImage(
  tx: Prisma.TransactionClient,
  characterId: string,
  purpose: string,
): Promise<FillDecision | null> {
  const character = await tx.character.findFirst({
    where: operationalCharacterWhere({ id: characterId, deletedAt: null, status: { notIn: ["archived", "removed"] } }),
    select: { id: true },
  });
  if (!character) throw Errors.notFound("Active Character not found");
  const project = await tx.characterProject.findFirst({
    where: { characterId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  if (!project) throw Errors.notFound("Character Project not found");
  const serving = await tx.characterServing.findUnique({ where: { characterId } });
  if (serving?.state === "retired") throw Errors.conflict("Character is archived or retired");
  const release = serving?.currentReleaseId
    ? await tx.characterRelease.findUnique({ where: { id: serving.currentReleaseId } })
    : null;
  const draftPack = projectCurrentDraftAssetPack(project, null);
  const livePack = releaseAssetPack(release);
  const packAssetIds = [...new Set([...Object.values(draftPack), ...Object.values(livePack)])];
  const packAssets = packAssetIds.length === 0 ? [] : await tx.mediaAsset.findMany({
    where: operationalMediaAssetWhere({
      id: { in: packAssetIds }, type: "image", deletedAt: null, safetyStatus: "passed",
    }),
    select: { id: true, characterId: true, metadata: true },
  });
  const legacyAssetIds = packAssets.filter((asset) => asset.characterId === null).map((asset) => asset.id);
  const owners = legacyAssetIds.length === 0 ? [] : await tx.character.findMany({
    where: { imageAssetId: { in: legacyAssetIds } },
    select: { id: true, imageAssetId: true },
  });
  const availableAssetIds = new Set(packAssets.flatMap((asset) => {
    if (!isMediaAssetOperationalForAuthority(asset.metadata)) return [];
    const legacyOwners = asset.characterId === null ? owners.filter((owner) => owner.imageAssetId === asset.id) : [];
    return asset.characterId === characterId || (legacyOwners.length === 1 && legacyOwners[0].id === characterId)
      ? [asset.id]
      : [];
  }));
  const draft = { ...characterImagePackProgress(availablePurposes(draftPack, availableAssetIds)), pack: draftPack };
  const live = { ...characterImagePackProgress(availablePurposes(livePack, availableAssetIds)), pack: livePack };
  const workingPack = workingCharacterImagePack(serving?.state ?? "inactive", draft, live);
  const missing = workingPack.missingPurposes;
  const requested = characterDraftAssetPurposes.find((slot) => slot === purpose);
  if (!requested) throw Errors.badRequest("A valid Character placement is required");
  if (!missing.includes(requested)) return { projectId: project.id, skip: { reason: "slot_filled" } };

  const inFlight = await unresolvedImageRuns(tx, characterId, missing);
  const runId = inFlight.get(requested);
  if (runId) return { projectId: project.id, skip: { reason: "run_pending", runId } };

  const selectedIds = new Set([
    ...Object.values(workingPack.pack),
    ...Object.values(draftAssetRouteEntries(project.draftAssetPack)).map((entry) => entry.assetId),
  ]);
  const unfilled = missing.filter((slot) => !inFlight.has(slot));
  const candidates: CharacterImageSourceAsset[] = [];
  let cursor: string | undefined;
  do {
    const page = await listCharacterImageSources({ characterId, purpose: "character_library", cursor }, tx);
    candidates.push(...page.items.filter((asset) => asset.qualification?.selectablePurposes.length && !selectedIds.has(asset.id)));
    const assignments = assignCharacterImageCandidates(unfilled, selectedIds, candidates);
    const match = assignments.find((entry) => entry.purpose === requested);
    if (assignments.length === unfilled.length || !page.nextCursor) {
      if (match) {
        // Library archive locks only the asset. Recheck the chosen image on
        // that same key, while the Character lock keeps its placement stable.
        await lockCharacterMediaAssetAuthorities(tx, [match.asset.id]);
        await resolveSelectableCharacterImage(tx, { characterId, assetId: match.asset.id, purpose: requested });
        return { projectId: project.id, skip: { reason: "candidate_available", assetId: match.asset.id } };
      }
      break;
    }
    cursor = page.nextCursor;
  } while (cursor);

  const command = await tx.controlPlaneCommand.findFirst({
    where: {
      coordinationKey: characterCommandCoordinationKey(characterId),
      status: { in: [...ACTIVE_CONTROL_PLANE_COMMAND_STATUSES] },
    },
    select: { id: true },
  });
  if (command) throw Errors.conflict("Another Character command is in progress", { commandId: command.id });
  return null;
}

async function unresolvedImageRuns(
  tx: Prisma.TransactionClient,
  characterId: string,
  purposes: readonly CharacterDraftAssetPurpose[],
) {
  const runs = await tx.contentProductionBatch.findMany({
    where: operationalContentProductionBatchWhere({
      targetType: "character", targetId: characterId, purpose: { in: [...purposes] },
      lifecycleState: { not: "archived" }, items: { some: { mediaAssetId: null } },
    }),
    select: {
      id: true,
      purpose: true,
      lifecycleState: true,
      items: {
        where: { mediaAssetId: null },
        select: { status: true, jobId: true, job: { select: { status: true, errorCode: true } } },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const jobIds = runs.flatMap((run) => run.items.flatMap((item) => item.jobId ? [item.jobId] : []));
  const attempts = jobIds.length === 0 ? [] : await tx.generationAttempt.findMany({
    where: { requestId: { in: jobIds } },
    distinct: ["requestId"],
    orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
    select: { requestId: true, status: true },
  });
  const statusByJobId = new Map(attempts.map((attempt) => [attempt.requestId, attempt.status]));
  const inFlight = new Map<string, string>();
  for (const run of runs) {
    if (inFlight.has(run.purpose)) continue;
    if (run.items.some((item) => {
      if (item.status === "rejected" || item.job?.status === "cancelled" || item.job?.status === "refunded") return false;
      const state = deriveCreativeItemExecutionState({
        itemStatus: item.status,
        jobStatus: item.job?.status ?? null,
        jobErrorCode: item.job?.errorCode,
        attemptStatus: item.jobId ? statusByJobId.get(item.jobId) ?? null : null,
        transportStatus: null,
        hasAsset: false,
      });
      return state === "unknown" || (run.lifecycleState === "active" && state !== "failed");
    })) inFlight.set(run.purpose, run.id);
  }
  return inFlight;
}
