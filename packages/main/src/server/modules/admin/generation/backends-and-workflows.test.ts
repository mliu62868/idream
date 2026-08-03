import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { handle } from "@/server/lib/http";
import { createUser, purgeTestData } from "@/server/test/helpers";
import {
  getGenerationWorkflow,
  listGenerationBackends,
  listGenerationWorkflows,
} from "./backends-and-workflows";

// SPEC: 只读 admin API 单测 —— generation/backends 与 generation/workflows[/:workflowKey]。
// 直接驱动 handler（dispatchAdmin 路由接缝已在 service.ts 挂好；本文件像本目录其它 handler
// 单测一样不经过路由字符串解析）。覆盖：workflows 摘要不含 apiPrompt、detail 含 apiPrompt、
// 未知 workflowKey 404、backends 恰好两条（comfyui + drawthings）且 health 字段存在
// （comfyui 用不可达端口驱动 ok:false 分支的确定性，而不是依赖本机是否真的跑着
// ComfyUI）、非 admin actor 403。
// INVARIANTS: dev-auth 头（x-idream-*）仅在 APP_ENV=test 生效；前缀 P 隔离测试数据；
// COMFYUI_API_URL/DRAWTHINGS_CLI 覆盖必须在 finally 里还原，避免污染其它用例。

const P = "zt-gencat-";

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

type Role = "admin" | "moderator" | "support" | "ops" | "analyst" | "user";

type Caller = { userId?: string; role?: Role };

function buildRequest(method: string, path: string, opts: Caller) {
  const headers: Record<string, string> = {};
  if (opts.userId) headers["x-idream-user-id"] = opts.userId;
  if (opts.role) headers["x-idream-role"] = opts.role;
  return new Request(`http://test.local/${path}`, { method, headers });
}

async function parse(res: Response) {
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = text ? (JSON.parse(text) as any) : null;
  return { status: res.status, ok: Boolean(json?.ok), data: json?.data, error: json?.error };
}

async function setupActor(role: Role, suffix: string) {
  const id = `${P}${role}-${suffix}`;
  await createUser({ id, role });
  return id;
}

async function callWorkflows(opts: Caller) {
  const request = buildRequest("GET", "admin/generation/workflows", opts);
  return parse(await handle(() => listGenerationWorkflows(request))(request));
}

async function callWorkflowDetail(workflowKey: string, opts: Caller) {
  const request = buildRequest("GET", `admin/generation/workflows/${workflowKey}`, opts);
  return parse(await handle(() => getGenerationWorkflow(request, workflowKey))(request));
}

async function callBackends(opts: Caller) {
  const request = buildRequest("GET", "admin/generation/backends", opts);
  return parse(await handle(() => listGenerationBackends(request))(request));
}

describe("generation catalog (admin, read-only)", () => {
  it("lists workflow descriptor summaries without apiPrompt", async () => {
    const admin = await setupActor("admin", "list");
    const res = await callWorkflows({ userId: admin, role: "admin" });
    expect(res.status).toBe(200);

    const items = res.data.items as Array<Record<string, unknown>>;
    const keys = items.map((item) => item.workflowKey);
    expect(keys).toContain("redcraft-krea2-redmix3-txt2img");
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

  it("returns the full descriptor (incl. apiPrompt) for a known workflowKey", async () => {
    const admin = await setupActor("admin", "detail");
    const res = await callWorkflowDetail("qwen-image-edit-img2img", {
      userId: admin,
      role: "admin",
    });
    expect(res.status).toBe(200);
    expect(res.data.workflow.workflowKey).toBe("qwen-image-edit-img2img");
    expect(res.data.workflow.backendKind).toBe("comfyui");
    expect(res.data.workflow.apiPrompt).toBeTruthy();
    expect(Object.keys(res.data.workflow.apiPrompt).length).toBeGreaterThan(0);
  });

  it("keeps enabled local image profiles bound to matching workflow descriptors", async () => {
    const admin = await setupActor("admin", "profile-workflows");
    const res = await callWorkflows({ userId: admin, role: "admin" });
    expect(res.status).toBe(200);

    const workflows = new Map(
      (res.data.items as Array<Record<string, unknown>>).map((item) => [
        item.workflowKey,
        item.backendKind,
      ]),
    );
    const profiles = await prisma.generationModelProfile.findMany({
      where: {
        mode: "image",
        enabled: true,
        status: "active",
        runner: "comfyui",
      },
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
    const admin = await setupActor("admin", "404");
    const res = await callWorkflowDetail("does-not-exist", { userId: admin, role: "admin" });
    expect(res.status).toBe(404);
    expect(res.error.code).toBe("not_found");
  });

  it("lists comfyui + drawthings backends, each with a health object", async () => {
    const admin = await setupActor("admin", "backends");
    const originalComfyUrl = process.env.COMFYUI_API_URL;
    const originalDrawThingsCli = process.env.DRAWTHINGS_CLI;
    // Point at an unreachable port so comfyui health is deterministically ok:false,
    // instead of depending on whether a real ComfyUI happens to be running locally.
    process.env.COMFYUI_API_URL = "http://127.0.0.1:59999";
    process.env.DRAWTHINGS_CLI = "/usr/bin/true";
    try {
      const res = await callBackends({ userId: admin, role: "admin" });
      expect(res.status).toBe(200);

      const items = res.data.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);

      const comfyui = items.find((item) => item.id === "comfyui") as Record<string, unknown>;
      const drawthings = items.find((item) => item.id === "drawthings") as Record<string, unknown>;
      expect(comfyui).toBeTruthy();
      expect(drawthings).toBeTruthy();
      // gen has no sd.cpp backend left, so the catalog must not advertise one.
      expect(items.map((item) => item.id)).not.toContain("sdcpp");

      const comfyuiHealth = comfyui.health as Record<string, unknown>;
      expect(comfyuiHealth.ok).toBe(false);
      expect(typeof comfyuiHealth.detail).toBe("string");

      expect(drawthings.cliPath).toBe("/usr/bin/true");
      expect(drawthings.health).toEqual({ ok: true });
    } finally {
      if (originalComfyUrl === undefined) delete process.env.COMFYUI_API_URL;
      else process.env.COMFYUI_API_URL = originalComfyUrl;
      if (originalDrawThingsCli === undefined) delete process.env.DRAWTHINGS_CLI;
      else process.env.DRAWTHINGS_CLI = originalDrawThingsCli;
    }
  });

  it("denies actors without generation.config.read (403)", async () => {
    const user = await setupActor("user", "denied");

    const workflows = await callWorkflows({ userId: user, role: "user" });
    expect(workflows.status).toBe(403);
    expect(workflows.error.code).toBe("forbidden");

    const detail = await callWorkflowDetail("qwen-image-edit-img2img", {
      userId: user,
      role: "user",
    });
    expect(detail.status).toBe(403);
    expect(detail.error.code).toBe("forbidden");

    const backends = await callBackends({ userId: user, role: "user" });
    expect(backends.status).toBe(403);
    expect(backends.error.code).toBe("forbidden");
  });
});
