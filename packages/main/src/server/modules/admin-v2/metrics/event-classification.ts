import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

type UserDataClass = "customer" | "internal" | "fixture" | "audit";

function isFixtureEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const domain = normalized.split("@").at(-1) ?? "";
  return domain === "test.local" || domain.endsWith(".test") || domain === "example.com";
}

function normalizeDataClass(dataClass: string): UserDataClass {
  if (
    dataClass === "customer" ||
    dataClass === "internal" ||
    dataClass === "fixture" ||
    dataClass === "audit"
  ) {
    return dataClass;
  }
  return "internal";
}

export function classifyExistingCustomerMetricActor(user: {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly deletedAt: Date | null;
  readonly dataClass: string;
}) {
  const fixture = isFixtureEmail(user.email);
  const storedDataClass = normalizeDataClass(user.dataClass);
  const isInactiveOrPrivileged =
    user.role !== "user" || user.status !== "active" || user.deletedAt !== null;
  const dataClass = fixture
    ? "fixture" as const
    : storedDataClass !== "customer"
      ? storedDataClass
      : isInactiveOrPrivileged
        ? "internal" as const
        : "customer" as const;
  return {
    dataClass,
    actor: {
      type: "user",
      userId: user.id,
      role: user.role,
      isInternal: dataClass !== "customer",
    },
  };
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
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      deletedAt: true,
      dataClass: true,
    },
  });
  if (user) return classifyExistingCustomerMetricActor(user);
  return {
    dataClass: "internal" as const,
    actor: {
      type: "user",
      userId,
      role: "missing",
      isInternal: true,
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
