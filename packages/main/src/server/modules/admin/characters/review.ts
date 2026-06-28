// SPEC: 角色人审队列 —— 把 public 角色提交（CharacterSubmission status=pending）显式化为一个审核入口，
//        审核员 approve/reject 后同步角色 status 与提交记录，并写审计。
// INTENT: 复用既有 safety.review.read/write 权限，不新增权限、不改 schema；只新增列表 + 决策两个 handler。
// INVARIANTS: 只处理 status=pending 的提交（已审 → 400）；approve/reject 在单事务内同时落地 character + submission；
//             每次决策恰好一条审计（action=content.submission.review，targetId=characterId）。
// EXAMPLE: list → [{ submissionId, submittedAt, character, reportCount }]；
//          decision approve → character.status=approved 且 submission.status=approved。
import { z } from "zod";
import {
  actorWithPermission,
  clampInt,
  jsonBody,
  writeAudit,
} from "@/server/modules/admin/service";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";

const characterSelect = {
  id: true,
  name: true,
  gender: true,
  style: true,
  visibility: true,
  status: true,
  description: true,
  createdAt: true,
} as const;

const reviewDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reviewReason: z.string().trim().max(2_000).optional(),
  reason: z.string().trim().min(3).max(2_000),
  confirmation: z.string().trim().min(1).max(160),
});

export async function listReviewQueue(request: Request): Promise<Response> {
  await actorWithPermission(request, "safety.review.read");
  const url = new URL(request.url);
  const submissions = await prisma.characterSubmission.findMany({
    where: { status: "pending" },
    orderBy: { submittedAt: "asc" },
    take: clampInt(url.searchParams.get("limit"), 1, 100, 50),
    include: { character: { select: characterSelect } },
  });

  const items = await Promise.all(
    submissions.map(async (submission) => ({
      submissionId: submission.id,
      submittedAt: submission.submittedAt,
      character: submission.character,
      reportCount: await prisma.contentReport.count({
        where: { targetType: "character", targetId: submission.characterId },
      }),
    })),
  );

  return ok({ items });
}

export async function reviewSubmission(request: Request, id: string): Promise<Response> {
  const actor = await actorWithPermission(request, "safety.review.write");
  const body = reviewDecisionSchema.parse(await jsonBody(request));
  if (body.confirmation !== "REVIEW") {
    throw Errors.badRequest("Confirmation did not match review decision");
  }

  const submission = await prisma.characterSubmission.findUnique({
    where: { id },
    include: { character: { select: characterSelect } },
  });
  if (!submission) throw Errors.notFound("Character submission not found");
  if (submission.status !== "pending") {
    throw Errors.badRequest("Submission already reviewed");
  }

  const nextStatus = body.decision === "approve" ? "approved" : "rejected";
  const reviewedAt = new Date();

  const updated = await prisma.$transaction(async (tx) => {
    await tx.character.update({
      where: { id: submission.characterId },
      data: { status: nextStatus },
    });
    return tx.characterSubmission.update({
      where: { id: submission.id },
      data: {
        status: nextStatus,
        reviewerId: actor.id,
        reviewedAt,
        reviewReason: body.reviewReason,
      },
    });
  });

  await writeAudit(request, actor, {
    action: "content.submission.review",
    targetType: "character",
    targetId: submission.characterId,
    reason: body.reason,
    before: {
      characterStatus: submission.character.status,
      submissionStatus: submission.status,
    },
    after: {
      characterStatus: nextStatus,
      submissionStatus: nextStatus,
    },
  });

  return ok({ submission: updated });
}
