// @vitest-environment happy-dom

import type { AdminPermissionKey, CharacterWorkspaceDetail } from "@idream/shared/admin";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { createCharacterCommandJournal } from "./character-command-journal";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { characterWorkspacePermissions } from "./character-workspace-permissions";
import { ReleasePanel } from "./ReleasePanel";

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
              new Set<AdminPermissionKey>(canPublish ? ["character.release.publish"] : []),
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
});
