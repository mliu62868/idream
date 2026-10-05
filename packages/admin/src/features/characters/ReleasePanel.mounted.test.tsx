// @vitest-environment happy-dom

import type { AdminPermissionKey, CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { createCharacterCommandJournal } from "./character-command-journal";
import { characterWorkspaceDetail, withCharacterWorkspaceDetail } from "./character-workspace-fixture";
import { characterWorkspacePermissions } from "./character-workspace-permissions";
import { ReleasePanel } from "./ReleasePanel";
import * as transport from "@/lib/admin-v2-api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function readyCharacter() {
  const selection = (assetId: string) => ({
    assetId,
    runId: null,
    itemId: null,
    reviewDecisionId: `review-${assetId}`,
    generationJobId: null,
    bootstrapIdentity: false,
    generationRouteFingerprint: null,
    routeCurrent: true,
  });
  return characterWorkspaceDetail({
    releases: [],
    project: {
      draftAssetRouteAuthority: { releaseReady: true },
      draftAssetSelections: {
        character_cover: selection("cover"),
        character_hero: selection("hero"),
        character_chat: selection("chat"),
      },
    },
    preview: { draft: { assetPackReady: true, opening: { firstMessage: "You made it." } } },
  });
}

describe("Character release history empty state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(data: CharacterWorkspaceDetail, canPublish = true, journal = createCharacterCommandJournal({
    actorId: "release-operator", characterId: data.character.id, storage: null,
  })) {
    await act(async () => {
      root.render(
        <AdminI18nProvider locale="zh">
          <ReleasePanel
            data={data}
            journal={journal}
            permissions={characterWorkspacePermissions(
              new Set<AdminPermissionKey>(canPublish ? ["character.release.publish", "content.takedown.write"] : []),
              false,
            )}
            runCommittedMutation={async ({ commit }) => ({ result: await commit(), refreshed: true })}
            writesLocked={false}
          />
        </AdminI18nProvider>,
      );
    });
  }

  function publishButton() {
    return [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "发布角色");
  }

  it("locks the workspace before creating a release candidate and keeps it locked through command acceptance", async () => {
    const data = readyCharacter();
    const request = vi.spyOn(transport, "adminV2Request");
    const journal = createCharacterCommandJournal({ actorId: "release-operator", characterId: data.character.id, storage: null });
    let finishCandidate!: (value: unknown) => void;
    request.mockImplementation(async (path) => {
      expect(journal.getSnapshot().writesLocked).toBe(true);
      if (path.endsWith("/releases")) return new Promise((resolve) => { finishCandidate = resolve; });
      return { commandId: "publish-command" };
    });
    await render(data, true, journal);
    await act(async () => publishButton()!.click());
    expect(request).toHaveBeenCalledTimes(1);
    expect(journal.getSnapshot().notice?.kind).toBe("mutation_in_flight");
    expect(journal.getSnapshot().writesLocked).toBe(true);
    expect(journal.beginSubmission("another write")).toBe(false);
    await act(async () => finishCandidate({ id: "candidate-1", version: 3 }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain("/releases/candidate-1/commands/publish");
    expect(journal.getSnapshot().command?.commandId).toBe("publish-command");
    expect(journal.getSnapshot().writesLocked).toBe(true);
  });

  it("releases the submission lock when candidate creation is explicitly rejected", async () => {
    const data = readyCharacter();
    const journal = createCharacterCommandJournal({ actorId: "release-operator", characterId: data.character.id, storage: null });
    vi.spyOn(transport, "adminV2Request").mockRejectedValue(new transport.AdminV2RequestError("Character draft changed before publishing", 409, "conflict"));
    await render(data, true, journal);
    await act(async () => publishButton()!.click());
    expect(journal.getSnapshot().writesLocked).toBe(false);
    expect(journal.getSnapshot().command).toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it.each([true, false])("opens availability controls only for the current release's alert (current: %s)", async (isCurrent) => {
    const request = vi.spyOn(transport, "adminV2Request");
    const stamp = "2026-09-05T00:00:00.000Z";
    const release: CharacterWorkspaceDetail["releases"][number]["release"] = {
      id: "monitored-release", projectId: "project-fixture", revisionId: "revision-fixture", characterContentVersionId: "content-fixture",
      visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, generationProvenance: {}, releasePlacementManifest: {},
      snapshotHash: "snapshot", readiness: "ready", status: "published", legacy: false, publishedAt: stamp,
      supersedesId: null, rollbackOfReleaseId: null, version: 4, createdAt: stamp, updatedAt: stamp,
    };
    await render(characterWorkspaceDetail({
      serving: { state: "live", currentReleaseId: isCurrent ? release.id : "another-live-release", version: 5, updatedAt: stamp, characterId: "character-fixture" },
      releases: [
        { release, checks: [], monitors: [{
          id: "monitor-24h", window: "24h", status: "action_required", baseline: {},
          observed: { operationalChecks: { chatAuthorityReady: false } },
          verification: { recommendation: "rollback_review", asOf: stamp }, startedAt: stamp, finishedAt: null,
        }] },
        { release: { ...release, id: "another-live-release" }, checks: [], monitors: [] },
      ],
    }));
    const section = [...container.querySelectorAll("details")]
      .find((item) => item.querySelector("summary")?.textContent === "角色状态与回滚");
    expect(section?.open).toBe(isCurrent);
    const pause = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "暂停上线服务");
    expect(pause?.disabled).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("discards a blocked candidate with its exact version and leaves publishing separate", async () => {
    const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue({ commandId: "withdraw-command" });
    const stamp = "2026-09-05T00:00:00.000Z";
    await render(characterWorkspaceDetail({ releases: [{ release: {
      id: "blocked-candidate", projectId: "project-fixture", revisionId: "revision-fixture", characterContentVersionId: "content-fixture",
      visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, generationProvenance: {}, releasePlacementManifest: {},
      snapshotHash: "snapshot", readiness: "blocked", status: "approved", legacy: false, publishedAt: null, supersedesId: null, rollbackOfReleaseId: null,
      version: 4, createdAt: stamp, updatedAt: stamp,
    }, checks: [], monitors: [] }] }));
    const discard = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "放弃待发布版本")!;
    expect(discard.disabled).toBe(false);
    await act(async () => discard.click());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/v2/admin/characters/character-fixture/releases/blocked-candidate/commands/withdraw", expect.objectContaining({ body: expect.objectContaining({ entityVersion: 4, confirmation: "character-fixture:blocked-candidate:withdraw", reason: { code: "operator_withdraw", summary: "放弃待发布版本" } }) }));
  });

  it.each(["inactive", "paused"] as const)("offers direct exit from %s without publishing first", async (state) => {
    const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue({ commandId: "archive-command" });
    await render(characterWorkspaceDetail({ serving: { characterId: "character-fixture", state, version: 9, currentReleaseId: state === "paused" ? "published" : null, updatedAt: "2026-09-05T00:00:00.000Z" } }));
    const label = state === "inactive" ? "归档草稿" : "停用角色";
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
    expect(button).toBeDefined();
    expect(button.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    if (state === "paused") {
      // Retiring a published Character is permanent and needs its own acknowledgement.
      expect(container.textContent).toContain("停用不可撤销");
      expect(button.disabled).toBe(true);
      await act(async () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click());
    } else {
      expect(container.textContent).not.toContain("停用不可撤销");
    }
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(request).toHaveBeenCalledWith("/api/v2/admin/characters/character-fixture/commands/retire", expect.objectContaining({ body: expect.objectContaining({ entityVersion: 9, confirmation: "character-fixture:retire" }) }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("restores an archived draft to editing without offering publication", async () => {
    const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue({ commandId: "restore-command" });
    await render(characterWorkspaceDetail({ ...readyCharacter(), serving: { characterId: "character-fixture", state: "retired", currentReleaseId: null, version: 10, updatedAt: "2026-09-05T00:00:00.000Z" } }));
    expect(publishButton()).toBeUndefined();
    const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "恢复草稿")!;
    expect(button).toBeDefined();
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => button.click());
    expect(request).toHaveBeenCalledWith("/api/v2/admin/characters/character-fixture/commands/restore", expect.objectContaining({ body: expect.objectContaining({ entityVersion: 10, reason: { code: "operator_restore", summary: "恢复草稿" } }) }));
  });

  it.each([
    [new transport.AdminV2RequestError("conflict", 409, "conflict", { activeCommandId: "existing-command", activeCommandType: "character.serving.restore" }), "恢复草稿已在执行。工作台已关联该命令，没有受理另一个命令。"],
    [null, "恢复草稿受理状态不明确。将安全重放同一命令。"],
  ])("translates interpolated submission outcomes in the mounted release panel", async (cause, message) => {
    vi.spyOn(transport, "adminV2Request").mockRejectedValue(cause);
    await render(characterWorkspaceDetail({ ...readyCharacter(), serving: { characterId: "character-fixture", state: "retired", currentReleaseId: null, version: 10, updatedAt: "2026-09-05T00:00:00.000Z" } }));
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    const restore = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "恢复草稿")!;
    await act(async () => restore.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(container.textContent).not.toContain("acceptance is unknown");
    expect(container.textContent).not.toContain("is already active");
  });

  it("never offers draft restoration for a retired published Character", async () => {
    await render(characterWorkspaceDetail({ serving: { characterId: "character-fixture", state: "retired", currentReleaseId: "previously-published", version: 10, updatedAt: "2026-09-05T00:00:00.000Z" } }));
    expect(container.textContent).not.toContain("恢复草稿");
    expect(publishButton()).toBeUndefined();
  });

  it("describes the first release instead of an incident queue when publishing is available", async () => {
    await render(readyCharacter());

    expect(container.textContent).toContain("还没有发布版本");
    expect(container.textContent).toContain("发布当前角色即可创建首个版本。");
    expect(container.textContent).not.toContain("队列已清空");
    expect(container.textContent).not.toContain("事故或工单");
    expect(publishButton()?.disabled).toBe(false);
  });

  it("keeps blocker guidance instead of claiming release checks have passed", async () => {
    await render(characterWorkspaceDetail());

    expect(container.textContent).toContain("还没有发布版本");
    expect(container.textContent).toContain("请先完成此页列出的发布要求，再创建首个版本。");
    expect(container.textContent).not.toContain("发布当前角色即可创建首个版本。");
    expect(container.textContent).not.toContain("事故或工单");
    expect(container.querySelector('a[href="/admin/characters/character-fixture?tab=assets"]')).not.toBeNull();
    expect(container.querySelector('a[href="/admin/characters/character-fixture?tab=soul"]')).not.toBeNull();
    expect(publishButton()?.disabled).toBe(true);
  });

  it("keeps Publish usable after a 409 and drops the server blockers once the workspace refreshes", async () => {
    const data = readyCharacter();
    vi.spyOn(transport, "adminV2Request").mockRejectedValue(new transport.AdminV2RequestError(
      "Character is not ready to publish", 409, "conflict", { blockers: ["approved_avatar_missing", "snapshot_hash_matches"] },
    ));
    await render(data);
    await act(async () => publishButton()!.click());
    const blockers = container.querySelector('[data-testid="release-blockers"]');
    expect(blockers?.querySelector('a[href="/admin/characters/character-fixture?tab=assets"]')).not.toBeNull();
    expect(blockers?.textContent).toContain("snapshot_hash_matches");
    expect(container.querySelector('a[href*="tab=release"]')).toBeNull();
    expect(publishButton()?.disabled).toBe(false);

    await render(withCharacterWorkspaceDetail(data, { project: { version: data.project.version + 1 } }));
    expect(container.querySelector('[data-testid="release-blockers"]')).toBeNull();
    expect(publishButton()?.disabled).toBe(false);
  });

  it("refuses a 1-2 character reason before the server rejects it", async () => {
    const stamp = "2026-09-05T00:00:00.000Z";
    await render(withCharacterWorkspaceDetail(readyCharacter(), {
      serving: { characterId: "character-fixture", state: "live", currentReleaseId: "live-release", version: 5, updatedAt: stamp },
      preview: { changedFields: ["persona"] },
    }));
    const reason = container.querySelector("textarea")!;
    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(reason, value);
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type("ok");
    expect(publishButton()?.disabled).toBe(true);
    expect(container.textContent).toContain("理由至少 3 个字符");
    await type("");
    expect(publishButton()?.disabled).toBe(false);
  });

  it("marks a legacy Release and explains it has no automatic check record", async () => {
    const stamp = "2026-09-05T00:00:00.000Z";
    await render(characterWorkspaceDetail({
      serving: { characterId: "character-fixture", state: "live", currentReleaseId: "legacy-release", version: 5, updatedAt: stamp },
      releases: [{ release: {
        id: "legacy-release", projectId: "project-fixture", revisionId: "revision-fixture", characterContentVersionId: "content-fixture",
        visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, generationProvenance: {}, releasePlacementManifest: {},
        snapshotHash: "snapshot", readiness: "ready", status: "published", legacy: true, publishedAt: null,
        supersedesId: null, rollbackOfReleaseId: null, version: 1, createdAt: stamp, updatedAt: stamp,
      }, checks: [], monitors: [] }],
    }));
    expect(container.textContent).toContain("历史版本");
    expect(container.textContent).toContain("重新发布会走完整检查");
  });

  it("keeps the publish action disabled without release permission", async () => {
    await render(readyCharacter(), false);

    expect(container.textContent).toContain("还没有发布版本");
    expect(publishButton()?.disabled).toBe(true);
  });

  it("hides a live Character from Explore with its current Serving version", async () => {
    const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue({
      character: { id: "character-fixture", visibility: "unlisted", status: "approved" }, replayed: false,
    });
    await render(characterWorkspaceDetail({ character: { visibility: "public" }, serving: { state: "live", version: 7 } }));
    const hide = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "从 Explore 隐藏");
    expect(hide).toBeDefined();
    await act(async () => hide!.click());
    expect(request).toHaveBeenCalledWith("/api/v2/admin/content/characters/character-fixture/visibility", expect.objectContaining({
      method: "POST", idempotencyKey: expect.any(String),
      body: expect.objectContaining({ visibility: "unlisted", entityVersion: 7, confirmation: "character-fixture:visibility:unlisted" }),
    }));
  });

  it("offers Show in Explore for unlisted live Characters and respects its own permission", async () => {
    const data = characterWorkspaceDetail({ character: { visibility: "unlisted" }, serving: { state: "live", version: 7 } });
    await render(data, false);
    const show = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "在 Explore 显示");
    expect(show).toBeDefined();
    expect(show!.disabled).toBe(true);
  });
});
