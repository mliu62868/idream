import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { compileUserCharacterContent } from "@/server/modules/ourdream/character-soul";
import { getCharacterWorkspace } from "@/server/modules/admin-v2/characters/workspace";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { adminV2 as adminV2Api } from "@/server/test/admin-v2-http";
import { api, createCharacter, createMedia, createUser, purgeTestData } from "@/server/test/helpers";
import { POST as preparePublicationProject } from "@/app/api/v2/admin/characters/[id]/project/route";
import { GET as getCharacterWorkspaceRoute } from "@/app/api/v2/admin/characters/[id]/route";

const P = "zt-creview-";

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

type Caller = {
  userId?: string;
  role?: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
};

function buildRequest(method: string, path: string, opts: Caller) {
  const headers: Record<string, string> = {};
  if (opts.userId) headers["x-idream-user-id"] = opts.userId;
  if (opts.role) headers["x-idream-role"] = opts.role;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    headers["idempotency-key"] = opts.idempotencyKey ?? crypto.randomUUID();
  }
  return new Request(`http://test.local/${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function parse(res: Response) {
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = text ? (JSON.parse(text) as any) : null;
  return { status: res.status, ok: Boolean(json?.ok), data: json?.data, error: json?.error };
}

async function callList(opts: Caller, query = "") {
  const response = await adminV2Api("GET", `/api/v2/admin/content/review-queue${query}`, opts);
  return { status: response.status, ok: response.ok, data: response.data, error: response.error };
}

async function callReview(id: string, opts: Caller) {
  const response = await adminV2Api(
    "POST",
    `/api/v2/admin/content/review-queue/${id}/decision`,
    opts,
  );
  return { status: response.status, ok: response.ok, data: response.data, error: response.error };
}

async function callPublicationPrep(characterId: string, opts: Caller) {
  const request = buildRequest("POST", `api/v2/admin/characters/${characterId}/project`, opts);
  return parse(await preparePublicationProject(request, {
    params: Promise.resolve({ id: characterId }),
  }));
}

async function callCharacterWorkspace(characterId: string, opts: Caller) {
  const request = buildRequest("GET", `api/v2/admin/characters/${characterId}`, opts);
  return parse(await getCharacterWorkspaceRoute(request, {
    params: Promise.resolve({ id: characterId }),
  }));
}

async function seedSubmission(suffix: string, status = "pending", charStatus = "pending_review") {
  const submitterId = `${P}submitter-${suffix}`;
  const characterId = `${P}char-${suffix}`;
  await createUser({ id: submitterId });
  await createCharacter({
    id: characterId,
    creatorId: submitterId,
    name: `Pending ${suffix}`,
    visibility: "public",
    status: charStatus,
  });
  const submission = await prisma.characterSubmission.create({
    data: {
      id: `${P}sub-${suffix}`,
      characterId,
      submitterId,
      status,
    },
  });
  return { submission, characterId, submitterId };
}

async function seedPublishableSubmission(suffix: string) {
  const seeded = await seedSubmission(suffix);
  await prisma.user.update({
    where: { id: seeded.submitterId },
    data: { dataClass: "customer" },
  });
  await prisma.character.update({
    where: { id: seeded.characterId },
    data: { source: "user" },
  });
  const character = await prisma.character.findUniqueOrThrow({
    where: { id: seeded.characterId },
  });
  const imageAssetId = `${P}image-${suffix}`;
  await createMedia({
    id: imageAssetId,
    ownerId: seeded.submitterId,
    visibility: "private",
    safetyStatus: "passed",
  });
  await prisma.mediaAsset.update({
    where: { id: imageAssetId },
    data: { characterId: character.id },
  });
  const content = compileUserCharacterContent({
    name: character.name,
    age: character.age,
    gender: character.gender,
    relationship: character.relationship,
    description: character.description,
    style: character.style,
    appearance: character.appearance,
    advancedDetails: character.advancedDetails,
  });
  const contentVersionId = `${P}content-${suffix}`;
  await prisma.characterContentVersion.create({
    data: {
      id: contentVersionId,
      characterId: character.id,
      version: 1,
      contentHash: content.contentHash,
      personaSnapshot: toInputJson(content.personaSnapshot),
      openingSnapshot: toInputJson(content.openingSnapshot),
      appearanceSnapshot: toInputJson(content.appearanceSnapshot),
      sourceType: "user",
      sourceId: seeded.submission.id,
      createdById: seeded.submitterId,
    },
  });
  await prisma.character.update({
    where: { id: character.id },
    data: { imageAssetId, currentContentVersionId: contentVersionId },
  });
  return { ...seeded, imageAssetId, contentVersionId };
}

describe("character review queue (D)", () => {
  it("listReviewQueue returns only pending submissions with report counts", async () => {
    const moderator = `${P}mod-list`;
    await createUser({ id: moderator, role: "moderator" });

    const pending = await seedSubmission("list-pending");
    const done = await seedSubmission("list-done", "approved", "approved");
    // Two reports against the pending character → reportCount = 2.
    await prisma.contentReport.create({
      data: { id: `${P}rep-1`, targetType: "character", targetId: pending.characterId, category: "spam" },
    });
    await prisma.contentReport.create({
      data: { id: `${P}rep-2`, targetType: "character", targetId: pending.characterId, category: "abuse" },
    });

    const res = await callList({ userId: moderator, role: "moderator" });
    expect(res.status).toBe(200);
    const items = res.data.items as Array<{ submissionId: string; reportCount: number }>;
    const ids = items.map((item) => item.submissionId);
    expect(ids).toContain(pending.submission.id);
    expect(ids).not.toContain(done.submission.id);
    expect(items.find((item) => item.submissionId === pending.submission.id)?.reportCount).toBe(2);
  });

  it("executes search/report filters server-side with a query-bound stable cursor", async () => {
    const moderator = `${P}mod-cursor`;
    await createUser({ id: moderator, role: "moderator" });
    const first = await seedSubmission("cursor-alpha");
    const second = await seedSubmission("cursor-beta");
    await prisma.character.update({ where: { id: first.characterId }, data: { name: `${P}cursor-target alpha` } });
    await prisma.character.update({ where: { id: second.characterId }, data: { name: `${P}cursor-target beta` } });
    await prisma.contentReport.create({ data: { id: `${P}cursor-report`, targetType: "character", targetId: second.characterId, category: "spam" } });

    const firstPage = await callList({ userId: moderator, role: "moderator" }, `?search=${P}cursor-target&limit=1`);
    expect(firstPage.data.items).toHaveLength(1);
    expect(firstPage.data.pageInfo).toMatchObject({ hasNextPage: true, endCursor: expect.any(String) });
    const secondPage = await callList(
      { userId: moderator, role: "moderator" },
      `?search=${P}cursor-target&limit=1&cursor=${encodeURIComponent(firstPage.data.pageInfo.endCursor)}`,
    );
    expect(secondPage.data.items).toHaveLength(1);
    expect(secondPage.data.items[0].submissionId).not.toBe(firstPage.data.items[0].submissionId);

    const reported = await callList({ userId: moderator, role: "moderator" }, `?search=${P}cursor-target&reportFilter=reported&limit=25`);
    expect(reported.data.items.map((item: { submissionId: string }) => item.submissionId)).toEqual([second.submission.id]);
    const mismatch = await callList(
      { userId: moderator, role: "moderator" },
      `?search=${P}cursor-target&reportFilter=clean&limit=1&cursor=${encodeURIComponent(firstPage.data.pageInfo.endCursor)}`,
    );
    expect(mismatch.status).toBe(400);
  });

  it("approve sets character + submission status to approved and audits", async () => {
    const moderator = `${P}mod-approve`;
    await createUser({ id: moderator, role: "moderator" });
    const { submission, characterId } = await seedSubmission("approve");

    const res = await callReview(submission.id, {
      userId: moderator,
      role: "moderator",
      body: { decision: "approve", reviewReason: "looks good", reason: "meets guidelines", confirmation: submission.id },
    });
    expect(res.status).toBe(200);
    expect(res.data.submission.status).toBe("approved");
    expect(await prisma.character.findUnique({ where: { id: characterId } })).toMatchObject({
      status: "approved",
    });
    expect(await prisma.characterSubmission.findUnique({ where: { id: submission.id } })).toMatchObject({
      status: "approved",
      reviewerId: moderator,
    });
    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.submission.review", targetId: characterId },
    });
    expect(audit).not.toBeNull();
  });

  it("approve opens an inactive publication-prep workspace without publishing the character", async () => {
    const moderator = `${P}mod-publication-prep`;
    await createUser({ id: moderator, role: "moderator" });
    const seeded = await seedPublishableSubmission("publication-prep");

    const res = await callReview(seeded.submission.id, {
      userId: moderator,
      role: "moderator",
      body: {
        decision: "approve",
        reviewReason: "identity and content approved",
        reason: "prepare approved customer character for release",
        confirmation: seeded.submission.id,
      },
    });

    expect(res.status).toBe(200);
    expect(res.data.publication).toMatchObject({
      state: "publication_prep",
      deepLink: `/admin/characters/${seeded.characterId}?tab=assets`,
    });
    const workspace = await getCharacterWorkspace(seeded.characterId);
    expect(workspace.project).toMatchObject({
      characterId: seeded.characterId,
      phase: "producing",
    });
    expect(workspace.serving).toMatchObject({ state: "inactive" });
    expect(workspace.releases).toEqual([]);
    await expect(prisma.characterRevision.findFirst({
      where: {
        projectId: workspace.project.id,
        characterContentVersionId: seeded.contentVersionId,
      },
    })).resolves.not.toBeNull();
    await expect(prisma.mediaAsset.findUnique({ where: { id: seeded.imageAssetId } }))
      .resolves.toMatchObject({ visibility: "private" });

    const explore = await api("GET", "characters", {
      ageGate: true,
      query: { q: "Pending publication-prep" },
    });
    expect(explore.status).toBe(200);
    expect(explore.data.items).toEqual([]);
  });

  it("repairs an already-approved customer Character into the same publication-prep workspace", async () => {
    const admin = `${P}admin-publication-repair`;
    await createUser({ id: admin, role: "admin" });
    const seeded = await seedPublishableSubmission("publication-repair");
    await prisma.$transaction([
      prisma.character.update({
        where: { id: seeded.characterId },
        data: { status: "approved" },
      }),
      prisma.characterSubmission.update({
        where: { id: seeded.submission.id },
        data: { status: "approved", reviewerId: admin, reviewedAt: new Date() },
      }),
    ]);

    const missing = await callCharacterWorkspace(seeded.characterId, {
      userId: admin,
      role: "admin",
    });
    expect(missing.status).toBe(404);
    expect(missing.error).toMatchObject({
      code: "not_found",
      details: {
        reason: "customer_publication_prep_missing",
        characterId: seeded.characterId,
        submissionId: seeded.submission.id,
        recoveryOperation: "POST /api/v2/admin/characters/:id/project",
      },
    });

    const idempotencyKey = `${P}publication-repair-key`;
    const res = await callPublicationPrep(seeded.characterId, {
      userId: admin,
      role: "admin",
      idempotencyKey,
      body: {
        submissionId: seeded.submission.id,
        reason: "repair missing publication preparation authority",
        confirmation: `PREPARE PUBLICATION ${seeded.characterId}`,
      },
    });

    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      state: "publication_prep",
      servingState: "inactive",
      deepLink: `/admin/characters/${seeded.characterId}?tab=assets`,
      created: true,
      replayed: false,
    });
    const replay = await callPublicationPrep(seeded.characterId, {
      userId: admin,
      role: "admin",
      idempotencyKey,
      body: {
        submissionId: seeded.submission.id,
        reason: "repair missing publication preparation authority",
        confirmation: `PREPARE PUBLICATION ${seeded.characterId}`,
      },
    });
    expect(replay.data).toMatchObject({
      projectId: res.data.projectId,
      replayed: true,
    });
    await expect(getCharacterWorkspace(seeded.characterId)).resolves.toMatchObject({
      project: { phase: "producing" },
      serving: { state: "inactive" },
      releases: [],
    });
    const workspaceRoute = await callCharacterWorkspace(seeded.characterId, {
      userId: admin,
      role: "admin",
    });
    expect(workspaceRoute.status).toBe(200);
    expect(workspaceRoute.data).toMatchObject({
      project: { phase: "producing" },
      serving: { state: "inactive" },
      releases: [],
    });
    await expect(prisma.characterProject.count({
      where: { characterId: seeded.characterId },
    })).resolves.toBe(1);
    await expect(prisma.characterRevision.count({
      where: { projectId: res.data.projectId },
    })).resolves.toBe(1);
    await expect(prisma.adminAuditLog.count({
      where: {
        action: "character.publication_prepared",
        targetId: res.data.projectId,
      },
    })).resolves.toBe(1);
    await expect(prisma.mainOutboxEvent.count({
      where: {
        eventType: "admin.customer_character.publication_prepared.v1",
        aggregateId: res.data.projectId,
      },
    })).resolves.toBe(1);
  });

  it("rejects publication preparation when the approved submission belongs to another Character", async () => {
    const admin = `${P}admin-publication-mismatch`;
    await createUser({ id: admin, role: "admin" });
    const target = await seedPublishableSubmission("publication-mismatch-target");
    const other = await seedPublishableSubmission("publication-mismatch-other");
    await prisma.$transaction([
      prisma.character.update({ where: { id: target.characterId }, data: { status: "approved" } }),
      prisma.characterSubmission.update({
        where: { id: target.submission.id },
        data: { status: "approved", reviewerId: admin, reviewedAt: new Date() },
      }),
      prisma.character.update({ where: { id: other.characterId }, data: { status: "approved" } }),
      prisma.characterSubmission.update({
        where: { id: other.submission.id },
        data: { status: "approved", reviewerId: admin, reviewedAt: new Date() },
      }),
    ]);

    const res = await callPublicationPrep(target.characterId, {
      userId: admin,
      role: "admin",
      body: {
        submissionId: other.submission.id,
        reason: "must not cross Character review authority",
        confirmation: `PREPARE PUBLICATION ${target.characterId}`,
      },
    });

    expect(res.status).toBe(409);
    expect(res.error?.code).toBe("conflict");
    await expect(prisma.characterProject.count({
      where: { characterId: target.characterId },
    })).resolves.toBe(0);
  });

  it("reject sets character + submission status to rejected", async () => {
    const moderator = `${P}mod-reject`;
    await createUser({ id: moderator, role: "moderator" });
    const { submission, characterId } = await seedSubmission("reject");

    const res = await callReview(submission.id, {
      userId: moderator,
      role: "moderator",
      body: { decision: "reject", reason: "policy violation", confirmation: submission.id },
    });
    expect(res.status).toBe(200);
    expect(res.data.submission.status).toBe("rejected");
    expect(await prisma.character.findUnique({ where: { id: characterId } })).toMatchObject({
      status: "rejected",
    });
  });

  it("denies decisions without safety.review.write (403)", async () => {
    const support = `${P}support-deny`;
    await createUser({ id: support, role: "support" });
    const { submission } = await seedSubmission("deny");

    const res = await callReview(submission.id, {
      userId: support,
      role: "support",
      body: { decision: "approve", reason: "should be blocked", confirmation: submission.id },
    });
    expect(res.status).toBe(403);
    expect(res.error?.code).toBe("forbidden");
  });

  it("rejects bad confirmation (400)", async () => {
    const moderator = `${P}mod-confirm`;
    await createUser({ id: moderator, role: "moderator" });
    const { submission } = await seedSubmission("confirm");

    const res = await callReview(submission.id, {
      userId: moderator,
      role: "moderator",
      body: { decision: "approve", reason: "valid reason", confirmation: "REVIEW" },
    });
    expect(res.status).toBe(400);
    expect(res.error?.code).toBe("bad_request");
  });

  it("rejects re-reviewing a non-pending submission (409)", async () => {
    const moderator = `${P}mod-repeat`;
    await createUser({ id: moderator, role: "moderator" });
    const { submission } = await seedSubmission("repeat", "approved", "approved");

    const res = await callReview(submission.id, {
      userId: moderator,
      role: "moderator",
      body: { decision: "reject", reason: "already settled", confirmation: submission.id },
    });
    expect(res.status).toBe(409);
    expect(res.error?.code).toBe("conflict");
  });
});
