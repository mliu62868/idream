import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { createUser, expectError, purgeTestData } from "@/server/test/helpers";
import { adminV2 } from "@/server/test/admin-v2-http";
import { setCharacterVisibility } from "../content/merchandising";
import { evaluateEditorialReleaseAuthorityInTransaction } from "../../ourdream/public-release-authority";
import { characterReleaseSnapshotHash } from "./release-snapshot";
import { projectServingToCharacter } from "./serving-projection";
import { transitionCharacterServing } from "./transition";
import type { AdminActor } from "../shared/authority";
import { collectReleaseMonitorFacts } from "./release-monitor";
import { directCharacterAudienceWhere, publicCharacterAudienceWhere } from "../../ourdream/public-content-audience";
import { updateCharacterForUser } from "../../ourdream/character-update";
import { reviewSubmission } from "../content/review";
import { ensureCustomerCharacterPublicationPrep } from "./publication-prep";

const P = "zt-serving-visibility-";
const actorId = `${P}admin`;
const request = new Request("http://localhost/api/v2/admin/content/characters/visibility");
const actor = { id: actorId, role: "admin" } satisfies AdminActor;

beforeAll(async () => { await purgeTestData(P); await createUser({ id: actorId, role: "admin", dataClass: "internal" }); });
afterAll(async () => { await purgeTestData(P); await prisma.$disconnect(); });

// A rollback keeps append-only qualification evidence intact without leaving
// public fixtures behind. Flush deferred guards before rollback to verify them.
async function fixture(visibility: string, run: (tx: Prisma.TransactionClient, id: string, servingId: string, releaseId: string) => Promise<void>, source = "official") {
  const rolledBack = new Error("completed visibility fixture");
  try { await prisma.$transaction(async (tx) => {
    const id = `${P}${randomUUID()}`;
    const assetId = `${id}-image`;
    await tx.character.create({ data: { id, creatorId: actorId, source, name: "Visibility fixture", age: 28,
      description: "Independent publication and discovery", visibility, status: "approved", appearance: {}, advancedDetails: {} } });
    await tx.mediaAsset.create({ data: { id: assetId, ownerId: actorId, characterId: id, type: "image", url: `/user-content/${assetId}.webp`,
      storageKey: `${assetId}.webp`, visibility: "public_pack", safetyStatus: "passed",
      metadata: { seedSource: P, synthetic: false, platformAsset: { status: "approved" } } } });
    await tx.character.update({ where: { id }, data: { imageAssetId: assetId } });
    const project = await tx.characterProject.create({ data: { characterId: id } });
    const content = await tx.characterContentVersion.create({ data: { characterId: id, version: 1, contentHash: id,
      personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "test" } });
    await tx.character.update({ where: { id }, data: { currentContentVersionId: content.id } });
    const revision = await tx.characterRevision.create({ data: { projectId: project.id, revision: 1, characterContentVersionId: content.id, projectSnapshot: {} } });
    const snapshot = { projectId: project.id, revisionId: revision.id, characterContentVersionId: content.id,
      visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null,
      generationProvenance: { schemaVersion: "character-release-editorial-import-v1", recordId: id, dataset: P, sourceAssetId: assetId },
      releasePlacementManifest: { schemaVersion: 1, kind: "editorial_import", placements: [{ slotKey: "character_avatar", assetId, slotVersion: 1 }] } };
    const release = await tx.characterRelease.create({ data: { ...snapshot, snapshotHash: characterReleaseSnapshotHash(snapshot), readiness: "ready", legacy: true, status: "published", publishedAt: new Date() } });
    await tx.publicCatalogQualification.create({ data: { releaseId: release.id, releaseSnapshotHash: release.snapshotHash, kind: "editorial_import",
      evidence: { schemaVersion: "public-catalog-qualification-v1", policyVersion: "public-catalog-editorial-import-v1", characterId: id, sourceAssetId: assetId,
        checks: { exactSeedRecord: true, nonSynthetic: true, safetyPassed: true, publicPack: true, imageAvailable: true } } } });
    const serving = await tx.characterServing.create({ data: { characterId: id, currentReleaseId: release.id, state: "live" } });
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    await run(tx, id, serving.id, release.id);
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
    throw rolledBack;
  }, { timeout: 10_000 }); } catch (error) { if (error !== rolledBack) throw error; }
}

describe("Character serving and catalog visibility", () => {
  it("makes the initial private publication public", async () => {
    await fixture("private", async (tx, characterId) => {
      await projectServingToCharacter(tx, { characterId, state: "live" });
      expect(await tx.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ visibility: "public", status: "approved" });
    });
  });

  it("keeps unlisted across republish and rollback content projection", async () => {
    await fixture("unlisted", async (tx, characterId) => {
      for (const firstMessage of ["New release", "Historical rollback"]) {
        await projectServingToCharacter(tx, { characterId, state: "live", content: { advancedDetails: { firstMessage } } });
        expect(await tx.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ visibility: "unlisted", status: "approved", advancedDetails: { firstMessage } });
      }
    });
  });

  it.each(["public", "unlisted"])("preserves %s intent through pause, valid resume, and retirement", async (visibility) => {
    await fixture(visibility, async (tx, characterId, servingId, releaseId) => {
      await transitionCharacterServing(tx, { servingId, to: "paused" });
      await projectServingToCharacter(tx, { characterId, state: "paused" });
      expect(await tx.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ visibility, status: "archived" });
      const pausedAuthority = await evaluateEditorialReleaseAuthorityInTransaction(tx, { releaseId, projectionState: "paused" });
      expect(pausedAuthority.failures).toEqual([]);
      await transitionCharacterServing(tx, { servingId, to: "live" });
      await projectServingToCharacter(tx, { characterId, state: "live" });
      expect(await tx.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ visibility, status: "approved" });
      await transitionCharacterServing(tx, { servingId, to: "retired" });
      await projectServingToCharacter(tx, { characterId, state: "retired" });
      expect(await tx.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ visibility, status: "archived" });
    });
  });

  it("allows a versioned official public/unlisted change with atomic audit and outbox", async () => {
    await fixture("public", async (tx, id, servingId) => {
      for (const [entityVersion, visibility] of [[1, "unlisted"], [2, "public"]] as const) {
        const result = await setCharacterVisibility({ tx, request, actor, requestId: `${id}-${entityVersion}`, id,
          body: { visibility, entityVersion, reason: "Update Explore listing", confirmation: `${id}:visibility:${visibility}` } });
        expect(result.character.visibility).toBe(visibility);
        expect(await tx.characterServing.findUniqueOrThrow({ where: { id: servingId } })).toMatchObject({ version: entityVersion + 1, state: "live" });
      }
      expect(await tx.adminAuditLog.count({ where: { targetId: id, action: "content.visibility.write" } })).toBe(2);
      expect(await tx.mainOutboxEvent.count({ where: { aggregateId: id, eventType: "admin.content.visibility_changed.v2" } })).toBe(2);
    });
  });

  it("rejects stale official versions, direct private transitions, and hidden draft publication", async () => {
    await fixture("unlisted", async (tx, id) => {
      await expect(setCharacterVisibility({ tx, request, actor, requestId: id, id,
        body: { visibility: "public", reason: "Missing Serving version", confirmation: `${id}:visibility:public` } })).rejects.toMatchObject({ status: 409 });
      await expect(setCharacterVisibility({ tx, request, actor, requestId: id, id,
        body: { visibility: "public", entityVersion: 99, reason: "Stale visibility form", confirmation: `${id}:visibility:public` } })).rejects.toMatchObject({ status: 409 });
      await expect(setCharacterVisibility({ tx, request, actor, requestId: id, id,
        body: { visibility: "private", entityVersion: 1, reason: "Cannot bypass serving pause", confirmation: `${id}:visibility:private` } })).rejects.toMatchObject({ status: 409 });
      await tx.character.update({ where: { id }, data: { visibility: "private" } });
      await expect(setCharacterVisibility({ tx, request, actor, requestId: id, id,
        body: { visibility: "public", entityVersion: 1, reason: "Cannot publish using discovery", confirmation: `${id}:visibility:public` } })).rejects.toMatchObject({ status: 409 });
      expect(await tx.adminAuditLog.count({ where: { targetId: id } })).toBe(0);
    });
  });

  it("cannot show an unlisted Character whose current qualification was revoked", async () => {
    await fixture("unlisted", async (tx, id, _servingId, releaseId) => {
      await tx.publicCatalogQualification.update({ where: { releaseId }, data: { revokedAt: new Date() } });
      await expect(setCharacterVisibility({ tx, request, actor, requestId: id, id,
        body: { visibility: "public", entityVersion: 1, reason: "Cannot bypass qualification", confirmation: `${id}:visibility:public` } })).rejects.toMatchObject({ status: 409 });
      expect(await tx.character.findUniqueOrThrow({ where: { id } })).toMatchObject({ visibility: "unlisted" });
      expect(await tx.adminAuditLog.count({ where: { targetId: id } })).toBe(0);
    });
  });

  it("does not report an intentional unlisted projection as a failed release monitor", async () => {
    await fixture("unlisted", async (tx, _id, _servingId, releaseId) => {
      const monitored = await collectReleaseMonitorFacts(tx, { releaseId, window: "24h", now: new Date() });
      expect(monitored.observed).toMatchObject({ operationalChecks: { servingPointerLive: true, servingProjectionLive: true } });
    });
  });

  it("allows qualified unlisted direct access while excluding discovery, private, paused and retired Characters", async () => {
    await fixture("unlisted", async (tx, id, servingId) => {
      const direct = () => tx.character.findFirst({ where: { AND: [{ id }, directCharacterAudienceWhere] } });
      expect(await direct()).toMatchObject({ id });
      expect(await tx.character.findFirst({ where: { AND: [{ id }, publicCharacterAudienceWhere] } })).toBeNull();
      await tx.character.update({ where: { id }, data: { visibility: "private" } });
      expect(await direct()).toBeNull();
      expect(await tx.character.findFirst({ where: { id, OR: [directCharacterAudienceWhere, { creatorId: actorId }] } })).toMatchObject({ id });
      await tx.character.update({ where: { id }, data: { visibility: "unlisted" } });
      for (const state of ["paused", "retired"] as const) {
        await transitionCharacterServing(tx, { servingId, to: state });
        await projectServingToCharacter(tx, { characterId: id, state });
        expect(await direct()).toBeNull();
      }
    });
  });

  it("requires content takedown permission before accepting the visibility command", async () => {
    const userId = `${P}user`;
    await createUser({ id: userId });
    const result = await adminV2("POST", `/api/v2/admin/content/characters/${P}missing/visibility`, {
      userId, role: "user", body: { visibility: "unlisted", entityVersion: 1, reason: "No operator authority", confirmation: `${P}missing:visibility:unlisted` },
    });
    expectError(result, 403, "forbidden");
  });

  it.each(["public", "unlisted"] as const)("prepares an existing paused customer Release for %s sharing without replacing its authority", async (visibility) => {
    await fixture("public", async (tx, characterId, servingId, releaseId) => {
      const releaseBefore = await tx.characterRelease.findUniqueOrThrow({ where: { id: releaseId } });
      let projectBefore = await tx.characterProject.findUniqueOrThrow({ where: { id: releaseBefore.projectId } });
      const characterBefore = await tx.character.findUniqueOrThrow({ where: { id: characterId } });
      let draftContentVersionId = characterBefore.currentContentVersionId;
      let draftRevisionId = releaseBefore.revisionId;
      expect(characterBefore).toMatchObject({ source: "user", status: "approved", currentContentVersionId: releaseBefore.characterContentVersionId });
      // Bind only the transaction boundary to this rollback fixture. Every
      // owner mutation and review below still executes real PostgreSQL queries.
      function inFixture<T>(run: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> { return run(tx); }
      const transaction = vi.spyOn(prisma, "$transaction").mockImplementation(inFixture);
      try {
        await updateCharacterForUser({ userId: actorId, characterId, patch: { visibility: "private" } });
        expect(await tx.characterServing.findUniqueOrThrow({ where: { id: servingId } })).toMatchObject({
          state: "paused", version: 2, currentReleaseId: releaseId,
        });
        if (visibility === "unlisted") {
          const draftContent = await tx.characterContentVersion.create({ data: {
            characterId, version: 2, contentHash: `${characterId}-draft`,
            personaSnapshot: {}, openingSnapshot: { firstMessage: "A new opening" }, appearanceSnapshot: {}, sourceType: "user",
          } });
          draftContentVersionId = draftContent.id;
          await tx.character.update({ where: { id: characterId }, data: { currentContentVersionId: draftContentVersionId } });
          const revision = await tx.characterRevision.create({ data: {
            projectId: projectBefore.id, revision: 2, characterContentVersionId: draftContentVersionId, projectSnapshot: { draft: true },
          } });
          draftRevisionId = revision.id;
          projectBefore = await tx.characterProject.update({ where: { id: projectBefore.id }, data: {
            draftImageAssetId: characterBefore.imageAssetId, draftAssetPack: { character_cover: { assetId: characterBefore.imageAssetId } },
          } });
        }
        await updateCharacterForUser({ userId: actorId, characterId, patch: { visibility } });
        const pending = await tx.characterSubmission.findFirstOrThrow({ where: { characterId, status: "pending" } });
        const reviewed = await reviewSubmission({ tx, actor, requestId: randomUUID(), id: pending.id,
          body: { decision: "approve", reason: "Review sharing after owner withdrawal", confirmation: pending.id } });
        expect(reviewed.publication).toMatchObject({
          projectId: projectBefore.id, revisionId: draftRevisionId,
          servingState: "paused", created: false,
        });
        expect(await tx.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({
          visibility, status: "approved", currentContentVersionId: draftContentVersionId,
        });
        expect(await tx.characterServing.findUniqueOrThrow({ where: { id: servingId } })).toMatchObject({
          state: "paused", version: 2, currentReleaseId: releaseId,
        });
        expect(await tx.characterProject.findUniqueOrThrow({ where: { id: projectBefore.id } })).toEqual(projectBefore);
        expect(await tx.characterProject.count({ where: { characterId } })).toBe(1);
        expect(await tx.characterRelease.findUniqueOrThrow({ where: { id: releaseId } })).toEqual(releaseBefore);
        expect(await tx.characterRevision.count({ where: { projectId: projectBefore.id } })).toBe(visibility === "unlisted" ? 2 : 1);
      } finally { transaction.mockRestore(); }
    }, "user");
  });

  it.each(["live", "retired", "missing_pointer", "unpublished_pointer"])("rejects %s authority during customer publication recovery", async (condition) => {
    await fixture("unlisted", async (tx, characterId, servingId, releaseId) => {
      if (condition !== "live") await transitionCharacterServing(tx, { servingId, to: "paused" });
      if (condition === "retired") await transitionCharacterServing(tx, { servingId, to: "retired" });
      if (condition === "missing_pointer") await tx.characterServing.update({ where: { id: servingId }, data: { currentReleaseId: null } });
      if (condition === "unpublished_pointer") await tx.characterRelease.update({ where: { id: releaseId }, data: { status: "superseded" } });
      const submission = await tx.characterSubmission.create({ data: { characterId, submitterId: actorId, status: "approved" } });
      await expect(ensureCustomerCharacterPublicationPrep(tx, { characterId, submissionId: submission.id, actorId }))
        .rejects.toMatchObject({ status: 409 });
    }, "user");
  });

  it("keeps an already live customer Character available when only its listing changes", async () => {
    await fixture("public", async (tx, characterId, servingId, releaseId) => {
      function inFixture<T>(run: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> { return run(tx); }
      const transaction = vi.spyOn(prisma, "$transaction").mockImplementation(inFixture);
      try {
        for (const visibility of ["unlisted", "public"] as const) {
          await updateCharacterForUser({ userId: actorId, characterId, patch: { visibility } });
          expect(await tx.character.findUniqueOrThrow({ where: { id: characterId } })).toMatchObject({ visibility, status: "approved" });
          expect(await tx.characterServing.findUniqueOrThrow({ where: { id: servingId } })).toMatchObject({ state: "live", currentReleaseId: releaseId });
          expect(await tx.characterSubmission.count({ where: { characterId, status: "pending" } })).toBe(0);
        }
      } finally { transaction.mockRestore(); }
    }, "user");
  });
});
