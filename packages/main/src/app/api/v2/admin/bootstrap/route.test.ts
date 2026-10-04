import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adminBootstrapResponseSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { GET } from "./route";

const adminId = `admin-bootstrap-${randomUUID()}`;
const userId = `admin-bootstrap-user-${randomUUID()}`;

beforeAll(async () => {
  await prisma.user.createMany({
    data: [
      { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
      { id: userId, email: `${userId}@example.test`, role: "user", status: "active" },
    ],
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [adminId, userId] } } });
  await prisma.$disconnect();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/v2/admin/bootstrap", () => {
  it("returns authoritative actor, effective permissions, and provenance", async () => {
    const response = await GET(new Request("http://localhost/api/v2/admin/bootstrap", {
      headers: { "x-idream-user-id": adminId, "x-idream-role": "admin" },
    }));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { data: unknown };
    const { bootstrap } = adminBootstrapResponseSchema.parse(envelope.data);
    expect(bootstrap.actor).toEqual({ id: adminId, role: "admin" });
    expect(bootstrap.canReadDashboard).toBe(true);
    expect(bootstrap.canCreateCharacters).toBe(true);
    expect(bootstrap.permissions).toContain("dashboard.read");
    expect(bootstrap.shellSignals.productTimezone).toBeTruthy();
  });

  it("fails closed for an actor without dashboard permission", async () => {
    const response = await GET(new Request("http://localhost/api/v2/admin/bootstrap", {
      headers: { "x-idream-user-id": userId, "x-idream-role": "user" },
    }));
    const envelope = await response.json() as { data: unknown };
    const { bootstrap } = adminBootstrapResponseSchema.parse(envelope.data);
    expect(bootstrap.actor).toEqual({ id: userId, role: "user" });
    expect(bootstrap.canReadDashboard).toBe(false);
    expect(bootstrap.canCreateCharacters).toBe(false);
    expect(bootstrap.permissions).not.toContain("dashboard.read");
  });

  it("does not offer creation to a producer limited to assigned Characters", async () => {
    const grant = await prisma.adminUserGrantBundle.create({ data: {
      userId, bundleKey: "character_producer", scope: { characterIds: ["assigned-character"] },
      createdById: adminId, reason: "Scope the producer to assigned work",
    } });
    try {
      const response = await GET(new Request("http://localhost/api/v2/admin/bootstrap", {
        headers: { "x-idream-user-id": userId, "x-idream-role": "user" },
      }));
      expect(response.status).toBe(200);
      const envelope = await response.json() as { data: unknown };
      const { bootstrap } = adminBootstrapResponseSchema.parse(envelope.data);
      expect(bootstrap.permissions).toContain("character.project.write");
      expect(bootstrap.canCreateCharacters).toBe(false);
    } finally {
      await prisma.adminUserGrantBundle.delete({ where: { id: grant.id } });
    }
  });

  it("rejects an unsigned bootstrap request when the production BFF secret is configured", async () => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("ADMIN_BFF_SIGNING_SECRET", "bootstrap-test-secret");

    const response = await GET(new Request("http://localhost/api/v2/admin/bootstrap", {
      headers: { "x-idream-user-id": adminId, "x-idream-role": "admin" },
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unauthorized" },
    });
  });
});
