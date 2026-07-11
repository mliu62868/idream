import { customer360Schema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { ok } from "@/server/lib/http";
import { actorWithPermission } from "@/server/modules/admin/service";
import { caseDto } from "./query";

const ACTIVE_CASE_STATUSES = ["new", "triaged", "in_progress", "waiting", "reopened"];

export async function getCustomer360(request: Request, customerId: string) {
  const actor = await actorWithPermission(request, "customer.read");
  const customer = await prisma.user.findUnique({ where: { id: customerId } });
  if (!customer || customer.role !== "user") throw Errors.notFound("Customer not found");

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  const [subscription, ledger, recentChats, generations, adminCases, failedGenerationCount30d] = await Promise.all([
    prisma.subscription.findFirst({
      where: { userId: customerId },
      include: { plan: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
    prisma.dreamcoinLedger.findMany({
      where: { userId: customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    }),
    prisma.recentChat.findMany({
      where: { userId: customerId, status: "active" },
      include: { character: { select: { name: true } } },
      orderBy: [{ lastMessageAt: "desc" }, { sessionId: "desc" }],
      take: 20,
    }),
    prisma.generationJob.findMany({
      where: { userId: customerId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    }),
    prisma.adminCase.findMany({
      where: {
        targetType: "user",
        targetId: customerId,
        ...(actor.role === "support" ? { type: { in: ["support_request", "billing_dispute"] } } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
    }),
    prisma.generationJob.count({
      where: { userId: customerId, status: { in: ["failed", "blocked"] }, createdAt: { gte: since30d } },
    }),
  ]);
  const caseIds = adminCases.map((item) => item.id);
  const activity = await prisma.adminAuditLog.findMany({
    where: {
      OR: [
        { targetType: "user", targetId: customerId },
        ...(caseIds.length > 0 ? [{ targetType: "admin_case", targetId: { in: caseIds } }] : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  const cases = await Promise.all(adminCases.map(caseDto));
  const lastActiveAt = recentChats.find((item) => item.lastMessageAt)?.lastMessageAt ?? null;
  const model = customer360Schema.parse({
    customer: {
      id: customer.id,
      email: customer.email,
      displayName: customer.displayName ?? customer.name,
      status: customer.status,
      createdAt: customer.createdAt.toISOString(),
    },
    overview: {
      balanceDreamcoins: ledger[0]?.balanceAfter ?? 0,
      activeCaseCount: adminCases.filter((item) => ACTIVE_CASE_STATUSES.includes(item.status)).length,
      failedGenerationCount30d,
      lastActiveAt: lastActiveAt?.toISOString() ?? null,
    },
    subscription: subscription
      ? {
          id: subscription.id,
          status: subscription.status,
          currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          plan: {
            id: subscription.plan.id,
            name: subscription.plan.name,
            billingPeriod: subscription.plan.billingPeriod,
          },
        }
      : null,
    relationships: recentChats.map((item) => ({
      characterId: item.characterId,
      characterName: item.character.name,
      sessionId: item.sessionId,
      lastMessageAt: item.lastMessageAt?.toISOString() ?? null,
    })),
    generations: generations.map((item) => ({
      id: item.id,
      mode: item.mode,
      status: item.status,
      costDreamcoins: item.costDreamcoins,
      createdAt: item.createdAt.toISOString(),
    })),
    ledger: ledger.map((item) => ({
      id: item.id,
      delta: item.delta,
      balanceAfter: item.balanceAfter,
      reason: item.reason,
      sourceId: item.sourceId,
      createdAt: item.createdAt.toISOString(),
    })),
    cases,
    activity: activity.map((item) => ({
      id: item.id,
      action: item.action,
      targetType: item.targetType,
      targetId: item.targetId,
      createdAt: item.createdAt.toISOString(),
    })),
    asOf: new Date().toISOString(),
  });
  return ok(model, { headers: { "Cache-Control": "no-store" } });
}
