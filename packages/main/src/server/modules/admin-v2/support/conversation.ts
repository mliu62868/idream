import type { Prisma, PrismaClient, SupportRequest } from "@prisma/client";
import { supportConversationSchema, supportMessageBodySchema } from "@idream/shared/contracts";
import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { ensureSupportCaseForRequest } from "../cases/service";

type Db = PrismaClient | Prisma.TransactionClient;
const publicMessageSnapshot = z.object({
  schemaVersion: z.literal(1),
  visibility: z.literal("customer"),
  supportRequestId: z.string(),
  authorId: z.string(),
  author: z.enum(["customer", "support"]),
  body: supportMessageBodySchema,
}).strict();

export async function supportConversation(db: Db, request: SupportRequest) {
  const intakes = await db.caseEvidence.findMany({
    where: { sourceType: "support_request", sourceId: request.id },
    select: { caseId: true },
  });
  const evidence = intakes.length > 0 ? await db.caseEvidence.findMany({
    where: { caseId: { in: intakes.map((item) => item.caseId) }, sourceType: "support_message" },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  }) : [];
  // SPEC: Only explicitly customer-visible messages of this exact ticket are
  // public. Existing evidence and resolution notes were written for operators.
  const messages = evidence.flatMap((item) => {
    const parsed = publicMessageSnapshot.safeParse(item.snapshot);
    if (!parsed.success || parsed.data.supportRequestId !== request.id) return [];
    return [{ id: item.id, author: parsed.data.author, body: parsed.data.body, createdAt: item.occurredAt.toISOString() }];
  });
  return supportConversationSchema.parse({
    ticketId: request.ticketId, subject: request.subject, description: request.description,
    status: request.status, createdAt: request.createdAt.toISOString(), updatedAt: request.updatedAt.toISOString(),
    canReply: ["received", "open", "waiting_on_user"].includes(request.status), messages,
  });
}

export async function appendSupportMessage(
  tx: Prisma.TransactionClient,
  request: SupportRequest,
  input: { messageId: string; body: string; author: "customer" | "support"; authorId: string; actorRole: string },
) {
  const adminCase = await ensureSupportCaseForRequest(tx, request);
  if (!adminCase || adminCase.targetType !== "user" || adminCase.targetId !== request.userId) {
    throw Errors.conflict("Support case does not match this request");
  }
  const sourceId = `${input.author}:${input.authorId}:${input.messageId}`;
  const key = { caseId: adminCase.id, sourceType: "support_message", sourceId };
  const snapshot = { schemaVersion: 1, visibility: "customer", supportRequestId: request.id,
    authorId: input.authorId, author: input.author, body: input.body };
  const intakes = await tx.caseEvidence.findMany({
    where: { sourceType: "support_request", sourceId: request.id }, select: { caseId: true },
  });
  // An accepted reply keeps its idempotency scope when this ticket recurs.
  const existing = await tx.caseEvidence.findFirst({
    where: { caseId: { in: intakes.map((item) => item.caseId) }, sourceType: "support_message", sourceId },
  });
  if (existing) {
    const parsed = publicMessageSnapshot.safeParse(existing.snapshot);
    if (!parsed.success || parsed.data.supportRequestId !== request.id || parsed.data.authorId !== input.authorId || parsed.data.body !== input.body) {
      throw Errors.conflict("Message ID is already bound to another reply");
    }
    return { caseId: adminCase.id, replayed: true };
  }
  if (input.author === "customer" && !["received", "open", "waiting_on_user"].includes(request.status)) {
    throw Errors.conflict("This request is resolved. Submit a new support request for further help.");
  }
  const now = new Date();
  await tx.caseEvidence.create({ data: { ...key, snapshot, occurredAt: now } });
  const changed = await tx.adminCase.updateMany({
    where: { id: adminCase.id, version: adminCase.version },
    data: { version: { increment: 1 }, updatedAt: now },
  });
  if (changed.count !== 1) throw Errors.conflict("Support case changed before the reply was saved");
  await tx.adminAuditLog.create({ data: {
    actorId: input.authorId, actorRole: input.actorRole,
    action: "case.support_message.added", targetType: "admin_case", targetId: adminCase.id,
    reason: "Customer-visible support reply", requestId: sourceId,
    after: { sourceType: "support_message", sourceId, supportRequestId: request.id },
  } });
  return { caseId: adminCase.id, replayed: false };
}
