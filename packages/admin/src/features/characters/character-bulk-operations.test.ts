import type { CharacterPortfolioItem, CharacterWorkspaceDetail } from "@idream/shared/admin";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Operation, createOrRecoverMissingCharacterImage } = vi.hoisted(() => ({
  adminV2Operation: vi.fn(),
  createOrRecoverMissingCharacterImage: vi.fn(),
}));
vi.mock("@/lib/admin-v2-operation", () => ({ adminV2Operation }));

import { AdminV2RequestError } from "@/lib/admin-v2-api";
vi.mock("./creative-run-creation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./creative-run-creation")>()),
  createOrRecoverMissingCharacterImage,
}));

import {
  BULK_CONCURRENCY,
  bulkActionBlocker,
  bulkGenerationRequest,
  createBulkExecutor,
  planBulkTasks,
  runBulkTasks,
} from "./character-bulk-operations";
import { CharacterCommandFailedError } from "./release-command";

function item(
  id: string,
  overrides: {
    state?: string;
    currentReleaseId?: string | null;
    blocker?: CharacterPortfolioItem["journey"]["assetPack"]["generateMissingBlocker"];
    draftMissing?: string[];
    draftCompleted?: number;
    liveMissing?: string[];
  } = {},
) {
  return {
    characterId: id,
    name: `Name ${id}`,
    serving: { state: overrides.state ?? "live", version: 7, currentReleaseId: overrides.currentReleaseId ?? null },
    journey: {
      hasActiveCommand: overrides.blocker === "active_command",
      // An operational recommendation can send the user to Monitor while generation is blocked.
      primaryAction: { code: "inspect_no_traffic" },
      assetPack: {
        generateMissingBlocker: overrides.blocker ?? null,
        generateMissingPurposes: overrides.draftCompleted === 0 ? overrides.liveMissing ?? [] : overrides.draftMissing ?? ["character_hero", "character_chat"],
        draft: { completed: overrides.draftCompleted ?? 1, missingPurposes: overrides.draftMissing ?? ["character_hero", "character_chat"] },
        live: { completed: 3, missingPurposes: overrides.liveMissing ?? [] },
      },
    },
  } as unknown as CharacterPortfolioItem;
}

beforeEach(() => {
  adminV2Operation.mockReset();
  createOrRecoverMissingCharacterImage.mockReset();
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

  // SPEC: 恢复草稿只对归档草稿可用；已退役（保留 currentRelease）的角色给出明确的不可恢复原因。
  it("restores only archived drafts and says why a retired Character is skipped", () => {
    expect(bulkActionBlocker("restore", item("a", { state: "retired" }))).toBeNull();
    expect(bulkActionBlocker("restore", item("a", { state: "retired", currentReleaseId: "r1" }))).toBe("Retired permanently. Retired characters cannot be restored.");
    expect(bulkActionBlocker("restore", item("a", { state: "inactive" }))).toBe("Only archived drafts can be restored.");
    expect(bulkActionBlocker("restore", item("a", { state: "retired", blocker: "active_command" }))).toContain("in progress");
    const plan = planBulkTasks({ kind: "restore" }, [
      item("archived", { state: "retired" }),
      item("retired", { state: "retired", currentReleaseId: "r1" }),
    ]);
    expect(plan.tasks.map((task) => task.characterId)).toEqual(["archived"]);
    expect(plan.skipped).toEqual([{ characterId: "retired", name: "Name retired", reason: "Retired permanently. Retired characters cannot be restored." }]);
  });

  it("explains why image generation does not apply", () => {
    expect(bulkActionBlocker("generate_missing", item("a", { blocker: "visual_identity_missing" }))).toBe("No visual identity yet.");
    expect(bulkActionBlocker("generate_missing", item("a", { blocker: "generation_route_unqualified" }))).toContain("Platform operations");
    expect(bulkActionBlocker("generate_missing", item("a", { blocker: "image_run_in_progress" }))).toContain("in progress");
    expect(bulkActionBlocker("generate_missing", item("a", { state: "retired" }))).toBe("Archived draft. Restore it first.");
    expect(bulkActionBlocker("generate_missing", item("a", { state: "retired", currentReleaseId: "r1" }))).toContain("Retired permanently");
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

  it("restores an archived draft through the restore command with an automatic reason", async () => {
    adminV2Operation.mockImplementation(async (id: string) =>
      id.startsWith("POST") ? { status: "accepted", commandId: "c1" } : { status: "succeeded" },
    );
    const run = createBulkExecutor({
      action: { kind: "restore" },
      actorId: "actor",
      itemByCharacter: new Map([["a", item("a", { state: "retired" })]]),
      sleep,
    });
    await expect(run(task("a"))).resolves.toBe("succeeded");
    expect(adminV2Operation).toHaveBeenCalledWith("POST /api/v2/admin/characters/:id/commands/restore", {
      path: { id: "a" },
      body: { entityVersion: 7, reason: { code: "operator_restore", summary: "Restore draft" }, confirmation: "a:restore" },
    });
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
      body: { tagIds: ["old", "new"], expectedTagIds: ["old"], confirmation: "a:tags" },
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

  // SPEC: 读后被别人改过标签时服务端 409；重读一次重算，仍冲突就作为该行失败，绝不覆盖别人的写入。
  it("re-reads once after a tag conflict and fails the row if it still conflicts", async () => {
    const conflict = () => new AdminV2RequestError("Character tags changed since they were read", 409, "conflict", { blocker: "version_mismatch" });
    let reads = 0;
    let puts = 0;
    adminV2Operation.mockImplementation(async (id: string) => {
      if (id.startsWith("GET")) {
        reads += 1;
        return { character: { tags: reads === 1 ? [{ id: "old" }] : [{ id: "old" }, { id: "other" }] } };
      }
      puts += 1;
      if (puts === 1) throw conflict();
      return {};
    });
    const run = createBulkExecutor({
      action: { kind: "add_tag", tagId: "new", tagLabel: "New" },
      actorId: "actor",
      itemByCharacter: new Map([["a", item("a")]]),
    });
    await expect(run(task("a"))).resolves.toBe("succeeded");
    expect(adminV2Operation.mock.calls.filter(([id]) => id.startsWith("PUT")).map(([, options]) => options.body)).toEqual([
      { tagIds: ["old", "new"], expectedTagIds: ["old"], confirmation: "a:tags" },
      { tagIds: ["old", "other", "new"], expectedTagIds: ["old", "other"], confirmation: "a:tags" },
    ]);

    adminV2Operation.mockReset();
    adminV2Operation.mockImplementation(async (id: string) => {
      if (id.startsWith("GET")) return { character: { tags: [{ id: "old" }] } };
      throw conflict();
    });
    await expect(run(task("a"))).rejects.toThrow("Tags changed while this was running");
    expect(adminV2Operation.mock.calls.filter(([id]) => id.startsWith("PUT"))).toHaveLength(2);
  });

  it("creates images through the durable Run protocol, one scope per image", async () => {
    const detail = {
      character: { id: "a" },
      preview: { draft: { appearance: { referenceDirection: "Warm light in a quiet studio" } } },
      visual: {
        identityBootstrap: { allowed: false },
        readiness: { ready: true },
        routeQualifications: [{ result: "qualified", stale: false, generationProfileKey: "profile-1", generationProfileVersion: 1, workflowKey: "w", workflowVersion: 1 }],
        identityCalibration: { profiles: [{ profileKey: "profile-1", profileVersion: 1, workflowKey: "w", workflowVersion: 1, allowedOrientations: ["16:9"] }] },
      },
    };
    adminV2Operation.mockResolvedValue(detail);
    createOrRecoverMissingCharacterImage.mockResolvedValue({ result: { state: "committed", runId: "run-1" }, intent: null });
    const run = createBulkExecutor({
      action: { kind: "generate_missing" },
      actorId: "actor",
      itemByCharacter: new Map([["a", item("a")]]),
    });
    await expect(run(task("a", 0, "character_hero"))).resolves.toBe("accepted");
    const options = createOrRecoverMissingCharacterImage.mock.calls[0][0];
    expect(options.scope).toBe("character-bulk-run:actor:a:character_hero");
    expect(options.draft()).toMatchObject({
      purpose: "character_hero",
      brief: expect.stringContaining("Warm light in a quiet studio"),
      targetId: "a",
      profileId: "profile-1",
      count: 1,
      orientation: "16:9",
      referenceAssetIds: [],
      bootstrapIdentity: false,
    });
    createOrRecoverMissingCharacterImage.mockResolvedValue({ result: { state: "skipped", skip: { reason: "candidate_available", assetId: "existing" } }, intent: null });
    await expect(run(task("a", 0, "character_hero"))).resolves.toEqual({ state: "succeeded", message: "A selectable image already covers this placement." });
    createOrRecoverMissingCharacterImage.mockResolvedValue({ result: { state: "pending", receipt: {} }, intent: null });
    await expect(run(task("a", 1, "character_hero"))).rejects.toThrow("cannot create a duplicate");
  });

  it("refuses a Character whose route or identity is not ready", () => {
    const base = {
      character: { id: "a" },
      preview: { draft: { appearance: { referenceDirection: "Warm light in a quiet studio" } } },
      visual: { identityBootstrap: { allowed: false }, readiness: { ready: true }, routeQualifications: [] },
    } as unknown as CharacterWorkspaceDetail;
    expect(() => bulkGenerationRequest(base, "character_hero", "A")).toThrow("Platform operations");
    expect(() => bulkGenerationRequest({ ...base, visual: { ...base.visual, identityBootstrap: { allowed: true } } } as never, "character_hero", "A")).toThrow("visual identity");
    expect(() => bulkGenerationRequest({ ...base, visual: { ...base.visual, readiness: { ready: false } } } as never, "character_hero", "A")).toThrow("not ready");
  });

  it("publishes eligible characters in bulk by creating a release and submitting the publish command", async () => {
    const readyItem = {
      ...item("a", { state: "inactive" }),
      journey: {
        ...item("a", { state: "inactive" }).journey,
        stage: "publishing",
        blockers: [],
        release: { candidateReleaseId: null, pendingRevision: null },
      },
    } as unknown as CharacterPortfolioItem;
    expect(bulkActionBlocker("publish", readyItem)).toBeNull();
    expect(bulkActionBlocker("publish", item("a", { state: "retired" }))).toBe("Archived draft. Restore it first.");
    expect(bulkActionBlocker("publish", item("a", { state: "retired", currentReleaseId: "r1" }))).toContain("Retired permanently");

    adminV2Operation.mockImplementation(async (id: string) => {
      if (id === "GET /api/v2/admin/characters/:id") return { project: { version: 3 }, releases: [] };
      if (id === "POST /api/v2/admin/characters/:id/releases") return { id: "rel-1", version: 1 };
      if (id === "POST /api/v2/admin/characters/:id/releases/:releaseId/commands/publish") return { status: "accepted", commandId: "cmd-pub-1" };
      return { status: "succeeded" };
    });
    const run = createBulkExecutor({
      action: { kind: "publish" },
      actorId: "actor",
      itemByCharacter: new Map([["a", readyItem]]),
      sleep,
    });
    await expect(run(task("a"))).resolves.toBe("succeeded");
    expect(adminV2Operation).toHaveBeenCalledWith(
      "POST /api/v2/admin/characters/:id/releases/:releaseId/commands/publish",
      expect.objectContaining({
        path: { id: "a", releaseId: "rel-1" },
        body: { entityVersion: 1, confirmation: "a:rel-1:publish", reason: { code: "operator_publish", summary: "Publish current Character" } },
      }),
    );
  });

  // SPEC: 发布校验失败时服务端已撤回候选；该行失败并带回 blockers，运营打开角色即可直接改草稿。
  it("fails a bulk publish row with the release blockers when validation withdraws the candidate", async () => {
    const readyItem = {
      ...item("a", { state: "inactive" }),
      journey: { ...item("a", { state: "inactive" }).journey, stage: "publishing", blockers: [], release: { candidateReleaseId: null, pendingRevision: null } },
    } as unknown as CharacterPortfolioItem;
    adminV2Operation.mockImplementation(async (id: string) => {
      if (id === "GET /api/v2/admin/characters/:id") return { project: { version: 3 }, releases: [] };
      if (id === "POST /api/v2/admin/characters/:id/releases") return { id: "rel-1", version: 1 };
      if (id.endsWith("/commands/publish")) return { status: "accepted", commandId: "cmd-pub-1" };
      return { status: "failed", error: { code: "release_validation_failed", blockers: ["opening_complete"], validationRunId: "run-1", candidateWithdrawn: true } };
    });
    const run = createBulkExecutor({ action: { kind: "publish" }, actorId: "actor", itemByCharacter: new Map([["a", readyItem]]), sleep });
    const failure = await run(task("a")).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(CharacterCommandFailedError);
    expect((failure as CharacterCommandFailedError).message).toBe("Release checks failed. The candidate was withdrawn and the draft can be edited again.");
    expect((failure as CharacterCommandFailedError).failure).toMatchObject({ blockers: ["opening_complete"], candidateWithdrawn: true });
  });
});
