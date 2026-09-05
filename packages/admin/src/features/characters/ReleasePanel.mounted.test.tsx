// @vitest-environment happy-dom

import type { AdminPermissionKey, CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { createCharacterCommandJournal } from "./character-command-journal";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
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
    preview: { draft: { assetPackReady: true } },
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

  async function render(data: CharacterWorkspaceDetail, canPublish = true) {
    await act(async () => {
      root.render(
        <AdminI18nProvider locale="zh">
          <ReleasePanel
            data={data}
            journal={createCharacterCommandJournal({
              actorId: "release-operator",
              characterId: data.character.id,
              storage: null,
            })}
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
    expect(publishButton()).toBeUndefined();
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
