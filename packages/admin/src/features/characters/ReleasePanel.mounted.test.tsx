// @vitest-environment happy-dom

import type { AdminPermissionKey, CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider, translateAdmin } from "@/components/admin/i18n";
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

function unchangedLiveCharacter(readiness: "ready" | "stale") {
  const data = readyCharacter();
  const stamp = "2026-09-05T00:00:00.000Z";
  const release: CharacterWorkspaceDetail["releases"][number]["release"] = {
    id: "current-live-release", projectId: data.project.id, revisionId: "revision-fixture", characterContentVersionId: "content-fixture",
    visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, generationProvenance: {}, releasePlacementManifest: {},
    snapshotHash: "current-snapshot", readiness, status: "published", legacy: false, publishedAt: stamp,
    supersedesId: null, rollbackOfReleaseId: null, version: 4, createdAt: stamp, updatedAt: stamp,
  };
  return characterWorkspaceDetail({
    ...data,
    serving: { state: "live", currentReleaseId: release.id, version: 5, updatedAt: stamp, characterId: data.character.id },
    releases: [{ release, checks: [], monitors: [] }],
    preview: { ...data.preview, live: { ...data.preview.draft, releaseId: release.id }, changedFields: [] },
    journey: { ...data.journey, release: { ...data.journey.release, candidateReleaseId: null, currentReleaseId: release.id } },
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

  it.each(["ready", "stale"] as const)("offers an unchanged draft again only when its current release is %s", async (readiness) => {
    const request = vi.spyOn(transport, "adminV2Request");
    await render(unchangedLiveCharacter(readiness));
    expect(Boolean(publishButton())).toBe(readiness === "stale");
    if (readiness === "stale") {
      expect(container.textContent).toContain("线上版本的发布资格已失效。重新发布会检查当前图片和生成线路；内容可以保持不变。");
      expect(container.textContent).not.toContain("没有需要发布的内容");
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps stale-release recovery disabled without publish permission", async () => {
    const request = vi.spyOn(transport, "adminV2Request");
    await render(unchangedLiveCharacter("stale"), false);
    expect(publishButton()?.disabled).toBe(true);
    await act(async () => publishButton()!.click());
    expect(request).not.toHaveBeenCalled();
  });

  it("prepares a fresh candidate for stale recovery and keeps server qualification checks authoritative", async () => {
    const request = vi.spyOn(transport, "adminV2Request").mockRejectedValue(new transport.AdminV2RequestError("Character is not ready to publish", 409, "conflict", { blockers: ["qualified_generation_route_missing"] }));
    const data = unchangedLiveCharacter("stale");
    await render(data);
    await act(async () => publishButton()!.click());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(`/api/v2/admin/characters/${data.character.id}/releases`);
    expect(request.mock.calls[0][1]?.body).toMatchObject({ entityVersion: data.project.version });
    expect(container.querySelector(`a[href="/admin/characters/${data.character.id}?tab=visual"]`)).not.toBeNull();
    // Server blockers are shown with their repair link but never hide Publish:
    // the next attempt is re-validated by the server.
    expect(publishButton()).toBeDefined();
    expect(data.serving?.currentReleaseId).toBe("current-live-release");
  });

  it("revalidates stale recovery through the normal fresh-candidate publish command", async () => {
    const data = unchangedLiveCharacter("stale");
    const request = vi.spyOn(transport, "adminV2Request").mockImplementation(async (path) => path.endsWith("/releases")
      ? { id: "recovery-candidate", version: 1 }
      : { commandId: "publish-recovery-command" });
    await render(data);
    await act(async () => publishButton()!.click());
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain("/releases/recovery-candidate/commands/publish");
    expect(request.mock.calls[1][1]?.body).toMatchObject({ entityVersion: 1, confirmation: `${data.character.id}:recovery-candidate:publish` });
  });

  it("can discard a recovery candidate without publishing or replacing the current live release", async () => {
    const data = unchangedLiveCharacter("stale");
    const candidate = { ...data.releases[0], release: { ...data.releases[0].release, id: "recovery-candidate", status: "approved" as const, readiness: "ready" as const, publishedAt: null } };
    const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue({ commandId: "withdraw-recovery-command" });
    await render({ ...data, releases: [...data.releases, candidate] });
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === translateAdmin("zh", "Discard candidate"))!.click());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toContain("/releases/recovery-candidate/commands/withdraw");
    expect(request.mock.calls[0][1]?.body).toMatchObject({ entityVersion: candidate.release.version });
    expect(data.serving?.currentReleaseId).toBe("current-live-release");
  });

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

  function button(label: string) {
    return [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);
  }

  function dialog() {
    return document.body.querySelector<HTMLElement>('[role="dialog"]');
  }

  async function confirmInDialog(label: string) {
    const submit = [...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
  }

  const servingFixture = (state: "live" | "paused" | "inactive" | "retired", currentReleaseId: string | null, version = 9) =>
    characterWorkspaceDetail({ serving: { characterId: "character-fixture", state, version, currentReleaseId, updatedAt: "2026-09-05T00:00:00.000Z" } });

  // SPEC: 暂停、恢复、恢复草稿一键执行，既不勾选也不进确认框。
  it.each([
    ["pause", "live", "published", "暂停上线服务"],
    ["resume", "paused", "published", "恢复上线服务"],
    ["restore", "retired", null, "恢复草稿"],
    ["retire", "inactive", null, "归档草稿"],
  ] as const)("runs %s with a single click and an automatic reason", async (action, state, currentReleaseId, label) => {
    const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue({ commandId: `${action}-command` });
    await render(servingFixture(state, currentReleaseId));
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).not.toContain("我确认执行该发布操作");
    await act(async () => button(label)!.click());
    expect(dialog()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      `/api/v2/admin/characters/character-fixture/commands/${action}`,
      expect.objectContaining({ body: expect.objectContaining({
        entityVersion: 9,
        confirmation: `character-fixture:${action}`,
        reason: { code: `operator_${action}`, summary: label === "归档草稿" ? "归档草稿" : expect.any(String) },
      }) }),
    );
  });

  // SPEC: 暂停 / 恢复是最常用的运营动作，不能藏在折叠区里。
  it("keeps pause and resume outside the collapsed availability section", async () => {
    await render(servingFixture("live", "published"));
    const collapsed = [...container.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent === "角色状态与回滚");
    expect(collapsed?.open).toBe(false);
    expect(collapsed?.contains(button("暂停上线服务")!)).toBe(false);
  });

  // SPEC: 不可逆退役只有一个普通确认框：说清影响，不键入、不勾选、不要原因。
  it.each(["live", "paused"] as const)("retires a %s Character through one plain confirmation", async (state) => {
    const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue({ commandId: "retire-command" });
    await render(servingFixture(state, "published"));
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await act(async () => button("停用角色")!.click());
    expect(request).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("停用不可撤销");
    expect(dialog()?.querySelector("input")).toBeNull();
    await confirmInDialog("停用角色");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/v2/admin/characters/character-fixture/commands/retire", expect.objectContaining({
      body: expect.objectContaining({ entityVersion: 9, confirmation: "character-fixture:retire", reason: { code: "operator_retire", summary: "停用角色" } }),
    }));
    expect(dialog()).toBeNull();
  });

  it("cancels a retire without sending anything", async () => {
    const request = vi.spyOn(transport, "adminV2Request");
    await render(servingFixture("paused", "published"));
    await act(async () => button("停用角色")!.click());
    await act(async () => [...dialog()!.querySelectorAll("button")].find((item) => item.textContent?.trim() === translateAdmin("zh", "Cancel"))!.click());
    expect(dialog()).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("rolls back through one plain confirmation with the Serving version", async () => {
    const stamp = "2026-09-05T00:00:00.000Z";
    const release: CharacterWorkspaceDetail["releases"][number]["release"] = {
      id: "older-release", projectId: "project-fixture", revisionId: "revision-fixture", characterContentVersionId: "content-fixture",
      visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, generationProvenance: {}, releasePlacementManifest: {},
      snapshotHash: "snapshot", readiness: "ready", status: "superseded", legacy: false, publishedAt: stamp,
      supersedesId: null, rollbackOfReleaseId: null, version: 2, createdAt: stamp, updatedAt: stamp,
    };
    const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue({ commandId: "rollback-command" });
    await render(characterWorkspaceDetail({
      serving: { characterId: "character-fixture", state: "live", version: 9, currentReleaseId: "current-release", updatedAt: stamp },
      releases: [
        { release, checks: [], monitors: [] },
        { release: { ...release, id: "current-release", status: "published" }, checks: [], monitors: [] },
      ],
    }));
    await act(async () => button("回滚")!.click());
    expect(request).not.toHaveBeenCalled();
    expect(dialog()?.querySelector("input")).toBeNull();
    await confirmInDialog("回滚");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("/api/v2/admin/characters/character-fixture/releases/older-release/commands/rollback", expect.objectContaining({
      body: expect.objectContaining({ entityVersion: 9, confirmation: "character-fixture:older-release:rollback", reason: { code: "operator_rollback", summary: "回滚" } }),
    }));
  });

  // SPEC: 候选状态 approved 没有人批准过，UI 只说「待发布」。
  it("shows a candidate as pending publish, never as approved", async () => {
    const stamp = "2026-09-05T00:00:00.000Z";
    await render(characterWorkspaceDetail({ releases: [{ release: {
      id: "candidate", projectId: "project-fixture", revisionId: "revision-fixture", characterContentVersionId: "content-fixture",
      visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, generationProvenance: {}, releasePlacementManifest: {},
      snapshotHash: "snapshot", readiness: "ready", status: "approved", legacy: false, publishedAt: null, supersedesId: null, rollbackOfReleaseId: null,
      version: 4, createdAt: stamp, updatedAt: stamp,
    }, checks: [], monitors: [] }] }));
    expect(container.textContent).toContain("待发布");
    expect(container.textContent).not.toContain("已通过");
    expect(container.textContent).not.toContain("已批准");
  });

  it("restores an archived draft to editing without offering publication", async () => {
    const request = vi.spyOn(transport, "adminV2Request").mockResolvedValue({ commandId: "restore-command" });
    await render(characterWorkspaceDetail({ ...readyCharacter(), serving: { characterId: "character-fixture", state: "retired", currentReleaseId: null, version: 10, updatedAt: "2026-09-05T00:00:00.000Z" } }));
    expect(publishButton()).toBeUndefined();
    await act(async () => button("恢复草稿")!.click());
    expect(request).toHaveBeenCalledWith("/api/v2/admin/characters/character-fixture/commands/restore", expect.objectContaining({ body: expect.objectContaining({ entityVersion: 10, reason: { code: "operator_restore", summary: "恢复草稿" } }) }));
  });

  it.each([
    [new transport.AdminV2RequestError("conflict", 409, "conflict", { activeCommandId: "existing-command", activeCommandType: "character.serving.restore" }), "恢复草稿已在执行。工作台已关联该命令，没有受理另一个命令。"],
    [null, "恢复草稿受理状态不明确。将安全重放同一命令。"],
  ])("translates interpolated submission outcomes in the mounted release panel", async (cause, message) => {
    vi.spyOn(transport, "adminV2Request").mockRejectedValue(cause);
    await render(characterWorkspaceDetail({ ...readyCharacter(), serving: { characterId: "character-fixture", state: "retired", currentReleaseId: null, version: 10, updatedAt: "2026-09-05T00:00:00.000Z" } }));
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

  it("publishes without asking for a reason", async () => {
    const stamp = "2026-09-05T00:00:00.000Z";
    await render(withCharacterWorkspaceDetail(readyCharacter(), {
      serving: { characterId: "character-fixture", state: "live", currentReleaseId: "live-release", version: 5, updatedAt: stamp },
      preview: { changedFields: ["persona"] },
    }));
    expect(container.querySelector("textarea")).toBeNull();
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
    expect(container.querySelector('[data-testid="legacy-upgrade-guide"]')?.textContent).toContain("升级为经过检查的发布版本");
  });

  // SPEC: leaving a legacy Release means republishing the same content as a checked one,
  // so identical live/draft content must still offer Publish and say what is missing.
  it("offers a path off a legacy Release even when the draft equals live", async () => {
    const stamp = "2026-09-05T00:00:00.000Z";
    const base = characterWorkspaceDetail();
    await render(characterWorkspaceDetail({
      serving: { characterId: "character-fixture", state: "live", currentReleaseId: "legacy-release", version: 5, updatedAt: stamp },
      preview: { live: base.preview.draft, changedFields: [] },
      project: { draftAssetRouteAuthority: { releaseReady: false, status: "current", releaseBlockers: [] } },
      releases: [{ release: {
        id: "legacy-release", projectId: "project-fixture", revisionId: "revision-fixture", characterContentVersionId: "content-fixture",
        visualProfileId: null, visualProfileVersion: null, referenceSetRevisionId: null, generationProvenance: {}, releasePlacementManifest: {},
        snapshotHash: "snapshot", readiness: "ready", status: "published", legacy: true, publishedAt: stamp,
        supersedesId: null, rollbackOfReleaseId: null, version: 1, createdAt: stamp, updatedAt: stamp,
      }, checks: [], monitors: [] }],
    }));
    const guide = container.querySelector('[data-testid="legacy-upgrade-guide"]');
    expect(guide?.textContent).toContain("补齐");
    expect(guide?.querySelector('a[href$="?tab=assets"]')).not.toBeNull();
    expect(container.textContent).not.toContain("线上版本与草稿一致");
    expect(publishButton()).not.toBeNull();
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
