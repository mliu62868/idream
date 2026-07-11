import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

function isFixtureEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  return normalized.endsWith(".test") || normalized.endsWith("@example.com");
}

export async function classifyCustomerMetricActor(db: Db, userId: string | null) {
  if (!userId) {
    return {
      dataClass: "operational" as const,
      actor: { type: "service", isInternal: true },
    };
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, status: true, deletedAt: true },
  });
  const fixture = user ? isFixtureEmail(user.email) : false;
  const isInternal = !user || user.role !== "user" || user.status !== "active" || user.deletedAt !== null;
  return {
    dataClass: fixture ? "fixture" as const : isInternal ? "internal" as const : "customer" as const,
    actor: {
      type: "user",
      userId,
      role: user?.role ?? "missing",
      isInternal: isInternal || fixture,
    },
  };
}

export async function classifyMetricSubject(
  db: Db,
  subject: { readonly userId: string | null; readonly anonymousId: string | null },
) {
  if (subject.userId) return classifyCustomerMetricActor(db, subject.userId);
  if (subject.anonymousId) {
    return {
      dataClass: "customer" as const,
      actor: {
        type: "anonymous",
        anonymousId: subject.anonymousId,
        isInternal: false,
      },
    };
  }
  return classifyCustomerMetricActor(db, null);
}
