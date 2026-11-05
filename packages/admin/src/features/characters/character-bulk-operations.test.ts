import type { CharacterPortfolioItem, CharacterWorkspaceDetail } from "@idream/shared/admin";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Operation, createOrRecoverCharacterRun } = vi.hoisted(() => ({
  adminV2Operation: vi.fn(),
  createOrRecoverCharacterRun: vi.fn(),
}));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));
vi.mock("./creative-run-creation", () => ({ createOrRecoverCharacterRun }));

import {
  BULK_CONCURRENCY,
  bulkActionBlocker,
  bulkGenerationRequest,
  createBulkExecutor,
  planBulkTasks,
  runBulkTasks,
} from "./character-bulk-operations";

function item(
  id: string,
  overrides: {
    state?: string;
    code?: string;
    draftMissing?: string[];
    draftCompleted?: number;
    liveMissing?: string[];
  } = {},
) {
  return {
    characterId: id,
    name: `Name ${id}`,
    serving: { state: overrides.state ?? "live", version: 7 },
    journey: {
      primaryAction: { code: overrides.code ?? "continue_asset_pack" },
      assetPack: {
        draft: { completed: overrides.draftCompleted ?? 1, missingPurposes: overrides.draftMissing ?? ["character_hero", "character_chat"] },
        live: { completed: 3, missingPurposes: overrides.liveMissing ?? [] },
      },
    },
  } as unknown as CharacterPortfolioItem;
}

beforeEach(() => {
  adminV2Operation.mockReset();
  createOrRecoverCharacterRun.mockReset();
});

describe("bulk eligibility", () => {
  it("applies each action only where the single command would", () => {
    expect(bulkActionBlocker("pause", item("a"))).toBeNull();
    expect(bulkActionBlocker("pause", item("a", { state: "paused" }))).toContain("Only live");
    expect(bulkActionBlocker("resume", item("a", { state: "paused" }))).toBeNull();
    expect(bulkActionBlocker("resume", item("a"))).toContain("Only paused");
    expect(bulkActionBlocker("archive", item("a", { state: "inactive" }))).toBeNull();
    // 退役已发布角色不可撤销，不进批量。
    expect(bulkActionBlocker("archive", item("a"))).toContain("Only unpublished drafts");
    expect(bulkActionBlocker("add_tag", item("a", { state: "retired" }))).toBeNull();
  });

  it("explains why image generation does not apply", () => {
    expect(bulkActionBlocker("generate_missing", item("a", { code: "create_primary_portrait" }))).toBe("No visual identity yet.");
    expect(bulkActionBlocker("generate_missing", item("a", { code: "platform_route_unavailable" }))).toContain("Platform operations");
    expect(bulkActionBlocker("generate_missing", item("a", { code: "continue_image_run" }))).toContain("in progress");
    expect(bulkActionBlocker("generate_missing", item("a", { state: "retired" }))).toContain("retired");
    expect(bulkActionBlocker("generate_missing", item("a", { draftMissing: [], draftCompleted: 3 }))).toBe("No missing images.");
    // 线上齐、草稿空的健康角色没有缺图，不能白花钱。
    expect(bulkActionBlocker("generate_missing", item("a", { draftCompleted: 0, draftMissing: ["character_cover", "character_hero", "character_chat"] }))).toBe("No missing images.");
  });
});

describe("bulk planning", () => {
  it("skips what does not apply with a reason instead of refusing the batch", () => {
    const plan = planBulkTasks({ kind: "pause" }, [item("live"), item("paused", { state: "paused" })]);
    expect(plan.tasks.map((task) => task.characterId)).toEqual(["live"]);
    expect(plan.skipped).toEqual([{ characterId: "paused", name: "Name paused", reason: "Only live characters can be paused." }]);
  });

  it("creates one task per missing image and states the over-limit case", () => {
    const plan = planBulkTasks({ kind: "generate_missing" }, [item("a"), item("b", { draftMissing: ["character_chat"] })]);
    expect(plan.tasks.map((task) => task.id)).toEqual(["a:character_hero", "a:character_chat", "b:character_chat"]);
    expect(plan.overGenerationLimit).toBe(false);
    const many = Array.from({ length: 21 }, (_, index) => item(`c${index}`));
    expect(planBulkTasks({ kind: "generate_missing" }, many).overGenerationLimit).toBe(true);
    expect(planBulkTasks({ kind: "add_tag", tagId: "t", tagLabel: "T" }, many).overGenerationLimit).toBe(false);
  });
});

describe("bulk runner", () => {
  it("caps concurrency, and one failure does not stop the others", async () => {
    let running = 0;
    let peak = 0;
    const settled: string[] = [];
    const tasks = Array.from({ length: 10 }, (_, index) => ({ id: String(index) }));
    await runBulkTasks(tasks, async (task) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      settled.push(task.id);
    });
    expect(peak).toBe(BULK_CONCURRENCY);
    expect(settled).toHaveLength(10);
  });
});

const task = (id: string, attempts = 0, purpose: "character_hero" | null = null) => ({
  id, characterId: id, name: `Name ${id}`, purpose, state: "queued" as const, message: null, attempts,
});
const sleep = async () => undefined;

describe("bulk execution", () => {
  it("submits the existing serving command with an automatic reason and the CAS version", async () => {
    adminV2Operation.mockImplementation(async (id: string) =>
      id.startsWith("POST") ? { status: "accepted", commandId: "c1" } : { status: "succeeded" },
    );
    const run = createBulkExecutor({
      action: { kind: "pause" },
      actorId: "actor",
      itemByCharacter: new Map([["a", item("a")]]),
      sleep,
    });
    await expect(run(task("a"))).resolves.toBe("succeeded");
    expect(adminV2Operation).toHaveBeenCalledWith(
      "POST /api/v2/admin/characters/:id/commands/pause",
      {
        path: { id: "a" },
        body: {
          entityVersion: 7,
          reason: { code: "operator_pause", summary: "Pause serving" },
          confirmation: "a:pause",
        },
      },
    );
  });

  it("reports an accepted command that is still running, and a failed one as failed", async () => {
    adminV2Operation.mockImplementation(async (id: string) =>
      id.startsWith("POST") ? { status: "accepted", commandId: "c1" } : { status: "running" },
    );
    const items = new Map([["a", item("a")]]);
    const run = createBulkExecutor({ action: { kind: "pause" }, actorId: "actor", itemByCharacter: items, sleep });
    await expect(run(task("a"))).resolves.toBe("accepted");
    adminV2Operation.mockImplementation(async (id: string) =>
      id.startsWith("POST") ? { status: "accepted", commandId: "c1" } : { status: "failed" },
    );
    await expect(run(task("a"))).rejects.toThrow("Command failed.");
  });

  it("re-reads the version on retry so a stale list cannot wedge the item", async () => {
    adminV2Operation.mockImplementation(async (id: string) =>
      id === "GET /api/v2/admin/characters/:id"
        ? { serving: { version: 12 } }
        : id.startsWith("POST") ? { status: "accepted", commandId: "c1" } : { status: "succeeded" },
    );
    const run = createBulkExecutor({
      action: { kind: "resume" },
      actorId: "actor",
      itemByCharacter: new Map([["a", item("a", { state: "paused" })]]),
      sleep,
    });
    await run(task("a", 1));
    expect(adminV2Operation.mock.calls.find(([id]) => id.includes("commands/resume"))?.[1].body.entityVersion).toBe(12);
  });

  it("adds a tag to the full current set and skips the write when nothing changes", async () => {
    adminV2Operation.mockImplementation(async (id: string) =>
      id.startsWith("GET") ? { character: { tags: [{ id: "old" }] } } : {},
    );
    const run = createBulkExecutor({
      action: { kind: "add_tag", tagId: "new", tagLabel: "New" },
      actorId: "actor",
      itemByCharacter: new Map([["a", item("a")]]),
    });
    await run(task("a"));
    expect(adminV2Operation).toHaveBeenCalledWith("PUT /api/v2/admin/content/characters/:id/tags", {
      path: { id: "a" },
      body: { tagIds: ["old", "new"], confirmation: "a:tags" },
    });
    adminV2Operation.mockClear();
    const remove = createBulkExecutor({
      action: { kind: "remove_tag", tagId: "absent", tagLabel: "A" },
      actorId: "actor",
      itemByCharacter: new Map([["a", item("a")]]),
    });
    await remove(task("a"));
    expect(adminV2Operation.mock.calls.some(([id]) => id.startsWith("PUT"))).toBe(false);
  });

  it("creates images through the durable Run protocol, one scope per image", async () => {
    const detail = {
      character: { id: "a" },
      visual: {
        identityBootstrap: { allowed: false },
        readiness: { ready: true },
        routeQualifications: [{ result: "qualified", stale: false, generationProfileKey: "profile-1", generationProfileVersion: 1, workflowKey: "w", workflowVersion: 1 }],
        identityCalibration: { profiles: [{ profileKey: "profile-1", profileVersion: 1, workflowKey: "w", workflowVersion: 1, allowedOrientations: ["16:9"] }] },
      },
    };
    adminV2Operation.mockResolvedValue(detail);
    createOrRecoverCharacterRun.mockResolvedValue({ state: "committed", runId: "run-1" });
    const run = createBulkExecutor({
      action: { kind: "generate_missing" },
      actorId: "actor",
      itemByCharacter: new Map([["a", item("a")]]),
    });
    await expect(run(task("a", 0, "character_hero"))).resolves.toBe("accepted");
    const options = createOrRecoverCharacterRun.mock.calls[0][0];
    expect(options.scope).toBe("character-bulk-run:actor:a:character_hero");
    expect(options.request).toMatchObject({
      purpose: "character_hero",
      targetId: "a",
      profileId: "profile-1",
      count: 1,
      orientation: "16:9",
      referenceAssetIds: [],
      bootstrapIdentity: false,
    });
    createOrRecoverCharacterRun.mockResolvedValue({ state: "pending", receipt: {} });
    await expect(run(task("a", 1, "character_hero"))).rejects.toThrow("cannot create a duplicate");
  });

  it("refuses a Character whose route or identity is not ready", () => {
    const base = {
      character: { id: "a" },
      visual: { identityBootstrap: { allowed: false }, readiness: { ready: true }, routeQualifications: [] },
    } as unknown as CharacterWorkspaceDetail;
    expect(() => bulkGenerationRequest(base, "character_hero", "A")).toThrow("Platform operations");
    expect(() => bulkGenerationRequest({ ...base, visual: { ...base.visual, identityBootstrap: { allowed: true } } } as never, "character_hero", "A")).toThrow("visual identity");
    expect(() => bulkGenerationRequest({ ...base, visual: { ...base.visual, readiness: { ready: false } } } as never, "character_hero", "A")).toThrow("not ready");
  });
});
