import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 } from "@/server/test/admin-v2-http";

// SPEC: read-only generation diagnostics over the real v2 route seam — the workflow descriptor
//       catalogue, the backend probe, and per-profile health.
// INVARIANTS: the workflow list never carries apiPrompt; the detail route does. COMFYUI_API_URL
//             / DRAWTHINGS_CLI overrides are restored in `finally` so no other case inherits them.
describe("generation diagnostics (v2, read-only)", () => {
  const suffix = randomUUID();
  const adminId = `gen-diag-admin-${suffix}`;
  const deniedId = `gen-diag-denied-${suffix}`;
  const profileId = `gen-diag-profile-${suffix}`;

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
        { id: deniedId, email: `${deniedId}@example.test`, role: "user", status: "active" },
      ],
    });
    await prisma.generationModelProfile.create({
      data: {
        id: profileId,
        profileKey: `gen-diag-key-${suffix}`,
        label: "Diagnostics fixture",
        mode: "image",
        pipelineModel: "mock-image",
        allowedOrientations: ["1:1"],
        status: "draft",
      },
    });
  });

  afterAll(async () => {
    await prisma.generationModelProfile.deleteMany({ where: { id: profileId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, deniedId] } } });
    await prisma.$disconnect();
  });

  const admin = { userId: adminId, role: "admin" };

  it("lists workflow descriptor summaries without apiPrompt", async () => {
    const result = await adminV2("GET", "/api/v2/admin/generation/workflows", admin);
    expect(result.status, JSON.stringify(result.error)).toBe(200);

    const items = result.data.items as Array<Record<string, unknown>>;
    const keys = items.map((item) => item.workflowKey);
    expect(keys).toContain("redcraft-krea2-redmix3-txt2img");
    expect(keys).toContain("qwen-image-edit-img2img");
    expect(keys).toContain("qwen-image-edit-multi-identity");
    expect(keys).toContain("pornmaster-zimage-drawthings-txt2img");
    for (const item of items) {
      expect(item).not.toHaveProperty("apiPrompt");
      expect(Object.keys(item).sort()).toEqual(
        ["backendKind", "capabilities", "inputs", "modelId", "version", "workflowKey"].sort(),
      );
    }
  });

  it("returns the full descriptor including apiPrompt for a known workflowKey", async () => {
    const result = await adminV2(
      "GET",
      "/api/v2/admin/generation/workflows/qwen-image-edit-img2img",
      admin,
    );
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    expect(result.data.workflow.workflowKey).toBe("qwen-image-edit-img2img");
    expect(result.data.workflow.backendKind).toBe("comfyui");
    expect(Object.keys(result.data.workflow.apiPrompt).length).toBeGreaterThan(0);
  });

  it("keeps enabled local image profiles bound to matching workflow descriptors", async () => {
    const result = await adminV2("GET", "/api/v2/admin/generation/workflows", admin);
    const workflows = new Map(
      (result.data.items as Array<Record<string, unknown>>).map((item) => [
        item.workflowKey,
        item.backendKind,
      ]),
    );
    const profiles = await prisma.generationModelProfile.findMany({
      where: { mode: "image", enabled: true, status: "active", runner: "comfyui" },
      select: { profileKey: true, runner: true, workflowKey: true },
    });

    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles).toEqual(expect.arrayContaining([
      {
        profileKey: "character-image-multi-identity",
        runner: "comfyui",
        workflowKey: "qwen-image-edit-multi-identity",
      },
    ]));
    for (const profile of profiles) {
      expect(profile.workflowKey, `${profile.profileKey} is missing workflowKey`).toBeTruthy();
      expect(workflows.get(profile.workflowKey ?? ""), profile.profileKey).toBe("comfyui");
    }
  });

  it("404s for an unknown workflowKey", async () => {
    const result = await adminV2(
      "GET",
      "/api/v2/admin/generation/workflows/does-not-exist",
      admin,
    );
    expect(result.status).toBe(404);
    expect(result.error?.code).toBe("not_found");
  });

  it("lists comfyui + drawthings backends, each with a health object", async () => {
    const originalComfyUrl = process.env.COMFYUI_API_URL;
    const originalDrawThingsCli = process.env.DRAWTHINGS_CLI;
    // An unreachable port makes the comfyui probe deterministically ok:false instead of
    // depending on whether a real ComfyUI happens to be running on this machine.
    process.env.COMFYUI_API_URL = "http://127.0.0.1:59999";
    process.env.DRAWTHINGS_CLI = "/usr/bin/true";
    try {
      const result = await adminV2("GET", "/api/v2/admin/generation/backends", admin);
      expect(result.status, JSON.stringify(result.error)).toBe(200);

      type BackendItem = {
        id: string;
        cliPath?: string | null;
        health: { ok: boolean; detail?: string };
      };
      const items = result.data.items as BackendItem[];
      expect(items).toHaveLength(2);
      // gen has no sd.cpp backend left, so the catalogue must not advertise one.
      expect(items.map((item) => item.id)).not.toContain("sdcpp");

      const comfyui = items.find((item) => item.id === "comfyui")!;
      const drawthings = items.find((item) => item.id === "drawthings")!;
      expect(comfyui.health.ok).toBe(false);
      expect(typeof comfyui.health.detail).toBe("string");
      expect(drawthings.cliPath).toBe("/usr/bin/true");
      expect(drawthings.health).toEqual({ ok: true });
    } finally {
      if (originalComfyUrl === undefined) delete process.env.COMFYUI_API_URL;
      else process.env.COMFYUI_API_URL = originalComfyUrl;
      if (originalDrawThingsCli === undefined) delete process.env.DRAWTHINGS_CLI;
      else process.env.DRAWTHINGS_CLI = originalDrawThingsCli;
    }
  });

  it("reports unavailable profile health rates when nothing has finished", async () => {
    const result = await adminV2(
      "GET",
      `/api/v2/admin/generation/model-profiles/${profileId}/health`,
      admin,
    );
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    expect(result.data.dataScope).toEqual({
      kind: "operational",
      includedDataClasses: ["customer", "internal", "operational"],
      excludedDataClasses: ["fixture", "audit"],
    });
    expect(result.data.metrics).toMatchObject({
      total: 0,
      successRate: null,
      blockedRate: null,
      refundRate: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
      latencySamples: 0,
    });
  });

  it("404s health for an unknown profile", async () => {
    const result = await adminV2(
      "GET",
      "/api/v2/admin/generation/model-profiles/missing-profile/health",
      admin,
    );
    expect(result.status).toBe(404);
  });

  it("denies actors without generation.config.read", async () => {
    const denied = { userId: deniedId, role: "user" };
    for (const path of [
      "/api/v2/admin/generation/workflows",
      "/api/v2/admin/generation/workflows/qwen-image-edit-img2img",
      "/api/v2/admin/generation/backends",
      `/api/v2/admin/generation/model-profiles/${profileId}/health`,
    ]) {
      const result = await adminV2("GET", path, denied);
      expect(result.status, path).toBe(403);
      expect(result.error?.code, path).toBe("forbidden");
    }
  });
});
