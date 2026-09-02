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
