import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  permissions: new Set<string>(),
}));

vi.mock("@/server/modules/admin-v2/shared/admin-bff", () => ({
  verifyAdminBffRequest: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/server/lib/auth", () => ({
  getAuthCtx: vi.fn(async () => ({ userId: "actor-1", role: "ops" })),
  requireUser: vi.fn(() => ({ id: "actor-1", role: "ops" })),
}));

vi.mock("@/server/admin/effective-permissions", () => ({
  effectivePermissions: vi.fn(async () => new Set(mocks.permissions)),
  effectiveCharacterIdsForPermission: vi.fn(async () => null),
}));

import { actorWithPermission } from "./authority";

describe("actorWithPermission manifest binding", () => {
  beforeEach(() => {
    mocks.permissions.clear();
    vi.unstubAllEnvs();
  });

  it("enforces every all-of permission declared for the exact route method", async () => {
    mocks.permissions.add("ops.incident.manage");
    const request = new Request(
      "http://localhost/api/v2/admin/creative/runs/run-1/commands/attach-incident",
      { method: "POST" },
    );

    await expect(actorWithPermission(request, "ops.incident.manage")).rejects.toMatchObject({
      code: "forbidden",
      details: { permission: "creative.run.write" },
    });

    mocks.permissions.add("creative.run.write");
    await expect(actorWithPermission(request, "ops.incident.manage")).resolves.toEqual({
      id: "actor-1",
      role: "ops",
    });
  });

  it("rejects a handler permission that the operation did not declare", async () => {
    mocks.permissions.add("dashboard.read");
    const request = new Request("http://localhost/api/v2/admin/cases/case-1");

    await expect(actorWithPermission(request, "dashboard.read")).rejects.toMatchObject({
      code: "internal",
      details: {
        operation: "GET /api/v2/admin/cases/:id",
        permission: "dashboard.read",
      },
    });
  });

  it("returns a permission-denied 403 contract for an unauthorized API deep link", async () => {
    await expect(actorWithPermission(
      new Request("http://localhost/api/v2/admin/cases/case-1"),
      "case.read",
    )).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
      details: { permission: "case.read" },
    });
  });

  it("allows only the permission selected by a declared resource resolver", async () => {
    mocks.permissions.add("creative.run.read");
    const request = new Request(
      "http://localhost/api/v2/admin/collaboration/creative_run/run-1/activity",
    );

    await expect(actorWithPermission(request, "creative.run.read")).resolves.toMatchObject({
      id: "actor-1",
    });
    await expect(actorWithPermission(request, "creative.run.write")).rejects.toMatchObject({
      code: "internal",
    });
  });

  it("fails closed on an unregistered production Admin v2 operation", async () => {
    vi.stubEnv("APP_ENV", "production");
    mocks.permissions.add("dashboard.read");

    await expect(actorWithPermission(
      new Request("http://localhost/api/v2/admin/unregistered"),
      "dashboard.read",
    )).rejects.toMatchObject({
      code: "internal",
      details: { method: "GET", pathname: "/api/v2/admin/unregistered" },
    });
  });
});
