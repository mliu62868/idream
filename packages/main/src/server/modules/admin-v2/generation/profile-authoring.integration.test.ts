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
  const legacyKeys = [5, 8].map((count) => `${key}-legacy-${count}`);
  const rollbackKey = `${key}-capacity-rollback`;
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
    await prisma.generationModelProfile.deleteMany({ where: { profileKey: { in: [key, ...legacyKeys, rollbackKey] } } });
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

  it.each([5, 8])("rejects %i-output authoring without changing a valid draft", async (maxCount) => {
    vi.stubEnv("ADMIN_MODEL_DIAGNOSTICS_ENABLED", "true");
    const profileKey = `${key}-legacy-${maxCount}`;
    const id = `${profileKey}-draft`;
    const created = await adminV2("POST", "/api/v2/admin/generation/model-profiles", {
      ...admin, body: { profileKey, label: "Unsupported capacity", pipelineModel: "test-model", allowedOrientations: ["1:1"], maxCount },
    });
    expect(created.status).toBe(400);
    expect(await prisma.generationModelProfile.count({ where: { profileKey } })).toBe(0);
    await prisma.generationModelProfile.create({ data: {
      id, profileKey, label: "Legacy image profile", pipelineModel: "test-model", allowedOrientations: ["1:1"], mode: "image", status: "draft", maxCount: 4,
    } });
    const edited = await adminV2("PATCH", `/api/v2/admin/generation/model-profiles/${id}`, { ...admin, body: { maxCount } });
    expect(edited.status).toBe(400);
    expect((await prisma.generationModelProfile.findUniqueOrThrow({ where: { id } })).maxCount).toBe(4);
  });

  it.each([5, 8])("does not certify or publish a legacy %i-output image profile", async (maxCount) => {
    const profileKey = `${key}-legacy-${maxCount}`;
    const id = `${profileKey}-publish`;
    await prisma.generationModelProfile.create({ data: {
      id, profileKey, label: "Legacy delivery capacity", pipelineModel: "test-model", allowedOrientations: ["1:1"], mode: "image", status: "draft", enabled: false, version: 2, maxCount,
    } });
    const checked = await adminV2("POST", `/api/v2/admin/generation/model-profiles/${id}/commands/dry-run`, {
      ...admin, body: { reason: "Check legacy delivery capacity", confirmation: id },
    });
    expect(checked.status, JSON.stringify(checked.error)).toBe(200);
    expect(checked.data.dryRun.status).toBe("fail");
    expect(checked.data.dryRun.samples.every((sample: { issues: string[] }) => sample.issues.includes("unsupported maxCount for image delivery"))).toBe(true);
    const published = await adminV2("POST", `/api/v2/admin/generation/model-profiles/${id}/commands/publish`, {
      ...admin, body: { reason: "Reject legacy delivery promise", confirmation: id },
    });
    expect(published.status).toBe(400);
    expect(published.error?.details).toMatchObject({ maxCount, supportedMaxCount: 4 });
    expect(await prisma.generationModelProfile.findUniqueOrThrow({ where: { id }, select: { status: true, enabled: true } })).toEqual({ status: "draft", enabled: false });
  });

  it("refuses to roll back to an undeliverable historical profile without archiving the active version", async () => {
    const archivedId = `${rollbackKey}-old`, currentId = `${rollbackKey}-current`;
    await prisma.generationModelProfile.createMany({ data: [
      { id: archivedId, profileKey: rollbackKey, label: "Old capacity", pipelineModel: "test-model", allowedOrientations: ["1:1"], mode: "image", status: "archived", version: 1, maxCount: 8 },
      { id: currentId, profileKey: rollbackKey, label: "Current capacity", pipelineModel: "test-model", allowedOrientations: ["1:1"], mode: "image", status: "active", version: 2, maxCount: 4, enabled: true },
    ] });
    const rolledBack = await adminV2("POST", `/api/v2/admin/generation/model-profiles/${currentId}/commands/rollback`, {
      ...admin, body: { reason: "Do not restore an unsupported quantity", confirmation: currentId },
    });
    expect(rolledBack.status).toBe(400);
    expect(rolledBack.error?.details).toMatchObject({ maxCount: 8, supportedMaxCount: 4 });
    expect(await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: currentId }, select: { status: true, enabled: true } })).toEqual({ status: "active", enabled: true });
    expect((await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: archivedId } })).status).toBe("archived");
  });
});
