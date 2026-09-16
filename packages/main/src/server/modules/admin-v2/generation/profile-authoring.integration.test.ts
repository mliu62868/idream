import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";

describe("generation profile authoring and recovery authority", () => {
  const key = `profile-authoring-${randomUUID()}`;
  const actorId = `${key}-admin`;
  const admin = { userId: actorId, role: "admin" };
  const oldId = `${key}-old`;
  const activeId = `${key}-active`;
  beforeAll(async () => {
    await prisma.user.create({ data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active", dataClass: "internal" } });
    await prisma.generationModelProfile.createMany({ data: [
      { id: oldId, profileKey: key, label: key, pipelineModel: "test-model", allowedOrientations: ["1:1"], mode: "image", status: "archived", version: 1 },
      { id: activeId, profileKey: key, label: key, pipelineModel: "test-model", allowedOrientations: ["1:1"], mode: "image", status: "active", version: 2, enabled: true },
    ] });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { actorId } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId } });
    await prisma.generationModelProfile.deleteMany({ where: { profileKey: key } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("projects the real rollback target even when archived versions are excluded from the page", async () => {
    vi.stubEnv("ADMIN_MODEL_DIAGNOSTICS_ENABLED", "false");
    const result = await adminV2("GET", `/api/v2/admin/generation/model-profiles?search=${key}&status=active&limit=1`, admin);
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    expect(result.data.authoringEnabled).toBe(false);
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]).toMatchObject({ id: activeId, rollbackTarget: { id: oldId, version: 1 } });
    expect(result.data.items.some((item: { id: string }) => item.id === oldId)).toBe(false);
  });

  it("creates a disabled draft, edits it in place, and invalidates evidence for the previous configuration", async () => {
    vi.stubEnv("ADMIN_MODEL_DIAGNOSTICS_ENABLED", "true");
    const created = await adminV2("POST", "/api/v2/admin/generation/model-profiles", { ...admin, body: { profileKey: key, label: "Replacement", pipelineModel: "test-model", allowedOrientations: ["1:1"] } });
    expect(created.status, JSON.stringify(created.error)).toBe(200);
    expect(created.data.profile).toMatchObject({ profileKey: key, version: 3, status: "draft", enabled: false });
    const draftId = created.data.profile.id;
    const previousEvidence = { configurationPassRate: 1, consistencySampleCount: 20, consistencyRate: 1 };
    await prisma.generationModelProfile.update({ where: { id: draftId }, data: { dryRunSummary: previousEvidence } });
    const updated = await adminV2("PATCH", `/api/v2/admin/generation/model-profiles/${draftId}`, { ...admin, body: { steps: 42 } });
    expect(updated.status, JSON.stringify(updated.error)).toBe(200);
    expect(updated.data.profile).toMatchObject({ id: draftId, status: "draft", steps: 42, dryRunSummary: {} });
    expect(await prisma.generationModelProfile.findUnique({ where: { id: activeId }, select: { status: true, enabled: true } })).toEqual({ status: "active", enabled: true });
    const published = await adminV2("POST", `/api/v2/admin/generation/model-profiles/${draftId}/commands/publish`, { ...admin, body: { reason: "Must verify changed configuration", confirmation: draftId } });
    expect(published.status).toBe(400);
    expect((await prisma.generationModelProfile.findUnique({ where: { id: draftId } }))?.status).toBe("draft");
  });

  it("keeps emergency disable available while authoring is disabled", async () => {
    vi.stubEnv("ADMIN_MODEL_DIAGNOSTICS_ENABLED", "false");
    const blocked = await adminV2("POST", "/api/v2/admin/generation/model-profiles", { ...admin, body: { profileKey: key, label: "Blocked draft", pipelineModel: "test-model", allowedOrientations: ["1:1"] } });
    expect(blocked.status).toBe(404);
    const disabled = await adminV2("PATCH", `/api/v2/admin/generation/model-profiles/${activeId}`, { ...admin, body: { enabled: false, reason: "Emergency disable regression", confirmation: activeId } });
    expect(disabled.status, JSON.stringify(disabled.error)).toBe(200);
    expect(disabled.data.profile.enabled).toBe(false);
  });
});
