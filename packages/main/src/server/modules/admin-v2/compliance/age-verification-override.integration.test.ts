import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as overrideRoute } from "@/app/api/v2/admin/compliance/age-verifications/[id]/override/route";
import { prisma } from "@/server/lib/db";

const auditFault = vi.hoisted(() => ({ active: false }));
vi.mock("@/server/modules/admin/shared/legacy-primitives", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/modules/admin/shared/legacy-primitives")>();
  const failing = <Args extends unknown[], Result>(write: (...args: Args) => Result) => (...args: Args) => {
    if (auditFault.active) throw new Error("injected audit failure");
    return write(...args);
  };
  return {
    ...actual,
    adminAuditData: failing(actual.adminAuditData),
    writeAudit: failing(actual.writeAudit),
  };
});

describe("age verification override authority", () => {
  const suffix = randomUUID();
  const adminId = `age-override-admin-${suffix}`;
  const subjectId = `age-override-subject-${suffix}`;

  async function seedVerification(status = "pending") {
    return prisma.ageVerification.create({
      data: { id: `age-override-${randomUUID()}`, userId: subjectId, provider: "mock", status, metadata: {} },
    });
  }

  function override(id: string, status = "verified") {
    return overrideRoute(
      new Request(`http://localhost/api/v2/admin/compliance/age-verifications/${id}/override`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": adminId,
          "x-idream-role": "admin",
          "idempotency-key": randomUUID(),
        },
        body: JSON.stringify({ status, reason: "Reviewed the disputed document", confirmation: id }),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
        { id: subjectId, email: `${subjectId}@example.test`, role: "user", status: "active" },
      ],
    });
  });

  afterEach(() => {
    auditFault.active = false;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { actorId: adminId } });
    await prisma.ageVerification.deleteMany({ where: { userId: subjectId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, subjectId] } } });
    await prisma.$disconnect();
  });

  it("commits the override and its audit together", async () => {
    const verification = await seedVerification();

    const response = await override(verification.id);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { ageVerification: { id: verification.id, status: "verified" } },
    });
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "compliance.age_override", targetId: verification.id },
    });
    expect(audit).toMatchObject({ before: { status: "pending" }, after: { status: "verified" } });
  });

  it("leaves the 18+ gate untouched when its audit cannot be written", async () => {
    const verification = await seedVerification();
    auditFault.active = true;

    const response = await override(verification.id);

    expect(response.status).toBe(500);
    expect(await prisma.ageVerification.findUniqueOrThrow({ where: { id: verification.id } }))
      .toMatchObject({ status: "pending", verifiedAt: null });
  });

  it("answers an override that lost a race with 409 instead of last-writer-wins", async () => {
    const verification = await seedVerification();
    // Every read in this transaction sees the state before a concurrent override committed.
    const transaction = prisma.$transaction.bind(prisma) as (run: (tx: unknown) => unknown) => Promise<unknown>;
    vi.spyOn(prisma, "$transaction").mockImplementationOnce(((run: (tx: unknown) => unknown) => transaction(async (tx) => {
      const client = tx as typeof prisma;
      await prisma.ageVerification.update({ where: { id: verification.id }, data: { status: "failed" } });
      return run(new Proxy(client, {
        get(target, property, receiver) {
          if (property !== "ageVerification") return Reflect.get(target, property, receiver);
          return {
            findUnique: async () => verification,
            updateMany: client.ageVerification.updateMany.bind(client.ageVerification),
            findUniqueOrThrow: client.ageVerification.findUniqueOrThrow.bind(client.ageVerification),
          };
        },
      }));
    })) as never);

    const response = await override(verification.id);

    expect(response.status).toBe(409);
    expect(await prisma.ageVerification.findUniqueOrThrow({ where: { id: verification.id } }))
      .toMatchObject({ status: "failed" });
    await expect(prisma.adminAuditLog.count({ where: { targetId: verification.id } })).resolves.toBe(0);
  });
});
