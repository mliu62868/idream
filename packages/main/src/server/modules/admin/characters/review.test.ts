import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { handle } from "@/server/lib/http";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { listReviewQueue, reviewSubmission } from "./review";

const P = "zt-creview-";

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

type Caller = { userId?: string; role?: string; body?: Record<string, unknown> };

function buildRequest(method: string, path: string, opts: Caller) {
  const headers: Record<string, string> = {};
  if (opts.userId) headers["x-idream-user-id"] = opts.userId;
  if (opts.role) headers["x-idream-role"] = opts.role;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
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
  const request = buildRequest("GET", `admin/content/review-queue${query}`, opts);
  return parse(await handle(() => listReviewQueue(request))(request));
}

async function callReview(id: string, opts: Caller) {
  const request = buildRequest("POST", `admin/content/review-queue/${id}/decision`, opts);
  return parse(await handle(() => reviewSubmission(request, id))(request));
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

  it("approve sets character + submission status to approved and audits", async () => {
    const moderator = `${P}mod-approve`;
    await createUser({ id: moderator, role: "moderator" });
    const { submission, characterId } = await seedSubmission("approve");

    const res = await callReview(submission.id, {
      userId: moderator,
      role: "moderator",
      body: { decision: "approve", reviewReason: "looks good", reason: "meets guidelines", confirmation: "REVIEW" },
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

  it("reject sets character + submission status to rejected", async () => {
    const moderator = `${P}mod-reject`;
    await createUser({ id: moderator, role: "moderator" });
    const { submission, characterId } = await seedSubmission("reject");

    const res = await callReview(submission.id, {
      userId: moderator,
      role: "moderator",
      body: { decision: "reject", reason: "policy violation", confirmation: "REVIEW" },
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
      body: { decision: "approve", reason: "should be blocked", confirmation: "REVIEW" },
    });
    expect(res.status).toBe(403);
    expect(res.error.code).toBe("forbidden");
  });

  it("rejects bad confirmation (400)", async () => {
    const moderator = `${P}mod-confirm`;
    await createUser({ id: moderator, role: "moderator" });
    const { submission } = await seedSubmission("confirm");

    const res = await callReview(submission.id, {
      userId: moderator,
      role: "moderator",
      body: { decision: "approve", reason: "valid reason", confirmation: "nope" },
    });
    expect(res.status).toBe(400);
    expect(res.error.code).toBe("bad_request");
  });

  it("rejects re-reviewing a non-pending submission (400)", async () => {
    const moderator = `${P}mod-repeat`;
    await createUser({ id: moderator, role: "moderator" });
    const { submission } = await seedSubmission("repeat", "approved", "approved");

    const res = await callReview(submission.id, {
      userId: moderator,
      role: "moderator",
      body: { decision: "reject", reason: "already settled", confirmation: "REVIEW" },
    });
    expect(res.status).toBe(400);
    expect(res.error.code).toBe("bad_request");
  });
});
