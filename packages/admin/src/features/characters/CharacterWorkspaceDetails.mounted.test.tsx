// @vitest-environment happy-dom

import { act } from "react";
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

const permissions = {
  read: true,
  writeProject: true,
  proposeRelease: true,
  publishRelease: true,
  reviewRelease: true,
  writeVisual: true,
  evaluateRoute: true,
  readAssets: true,
  createAssets: true,
  reviewAssets: true,
  manageVoiceDefaults: true,
};

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
});
