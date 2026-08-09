// @vitest-environment happy-dom

import { act } from "react";
import type { AdminPermissionKey } from "@idream/shared/admin";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

import { AdminI18nProvider } from "@/components/admin/i18n";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { CharacterWorkspace } from "./CharacterWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const permissions = new Set<AdminPermissionKey>([
  "character.project.read",
  "character.release.read",
  "character.performance.read",
  "character.project.write",
  "character.release.propose",
  "character.release.publish",
  "character.release.review",
  "content.official.write",
  "content.production.write",
  "creative.run.read",
  "creative.run.write",
  "creative.run.review",
  "generation.config.write",
]);

describe("Character workspace details", () => {
  const workspace = characterWorkspaceDetail({
    character: {
      id: "character-detail",
      name: "Mira",
      imageUrl: "/images/mira.webp",
    },
  });
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    window.history.replaceState(null, "", "/admin/characters/character-detail");
    adminV2Request.mockReset();
    adminV2Request.mockResolvedValue(workspace);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("loads the above-fold primary portrait and recent asset eagerly", async () => {
    await act(async () => {
      root.render(
        <AdminI18nProvider locale="en">
          <CharacterWorkspace
            actorId="operator-a"
            permissions={permissions}
            view={{ kind: "detail", id: "character-detail" }}
          />
        </AdminI18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const images = [...container.querySelectorAll("img")];
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.getAttribute("loading"))).toEqual([
      "eager",
      "eager",
    ]);
  });

  /**
   * SPEC: 服务端说还有命令在跑时，语音页签上的系统默认写入必须是禁用态。
   * INTENT: 这条能被运营真实走到 —— 深链 `?tab=voice` 打开一个服务端仍有 activeCommand 的
   *         角色，页签不会被拨回 release。此前 canManageDefaults 读的是未过写入锁的那份权限，
   *         按钮亮着，点下去只会拿到 journal 抛出的错误。
   */
  it("disables the system voice defaults write while an authoritative command is running", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/characters/character-detail?tab=voice",
    );
    adminV2Request.mockResolvedValue(
      characterWorkspaceDetail({
        character: { id: "character-detail", name: "Mira" },
        activeCommand: {
          commandId: "command-1",
          requestId: "request-1",
          commandType: "character.serving.pause",
          target: { type: "character", id: "character-detail" },
          status: "running",
          needsReconciliation: false,
          createdAt: "2026-08-02T04:00:00.000Z",
          updatedAt: "2026-08-02T04:00:01.000Z",
        },
      }),
    );

    await act(async () => {
      root.render(
        <AdminI18nProvider locale="en">
          <CharacterWorkspace
            actorId="operator-a"
            permissions={permissions}
            view={{ kind: "detail", id: "character-detail" }}
          />
        </AdminI18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain(
      "Read-only: generation.config.write is required to change system voice defaults.",
    );
  });

  it("keeps the system voice defaults write available when no command is running", async () => {
    window.history.replaceState(
      null,
      "",
      "/admin/characters/character-detail?tab=voice",
    );

    await act(async () => {
      root.render(
        <AdminI18nProvider locale="en">
          <CharacterWorkspace
            actorId="operator-a"
            permissions={permissions}
            view={{ kind: "detail", id: "character-detail" }}
          />
        </AdminI18nProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).not.toContain(
      "Read-only: generation.config.write is required to change system voice defaults.",
    );
  });
});
