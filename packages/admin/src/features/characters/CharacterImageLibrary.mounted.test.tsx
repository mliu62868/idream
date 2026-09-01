// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, studioProps } = vi.hoisted(() => ({
  apiGet: vi.fn(async () => ({ items: [] })),
  studioProps: vi.fn(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet }));
vi.mock("./CharacterAssetStudio", () => ({
  CharacterAssetStudio: (props: unknown) => {
    studioProps(props);
    return <div data-testid="character-asset-review-path" />;
  },
}));

import { AdminI18nProvider } from "@/components/admin/i18n";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { CharacterImageLibrary } from "./CharacterImageLibrary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Character image library production wiring", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    studioProps.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps review available inside the same Character image workflow", async () => {
    await act(async () => {
      root.render(
        <AdminI18nProvider locale="en">
          <CharacterImageLibrary
            actorId="operator-1"
            canArchive
            canCreate
            canRead
            canReadProduction
            canReview
            commitProjectMutation={async ({ commit }) => ({
              result: await commit(),
              refreshed: true,
            })}
            data={characterWorkspaceDetail({
              visual: { identityBootstrap: { allowed: true } },
            })}
            onContinue={() => undefined}
            onProjectReload={async () => undefined}
          />
        </AdminI18nProvider>,
      );
    });

    expect(container.querySelector('[data-testid="character-asset-review-path"]')).toBeTruthy();
    expect(studioProps).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: expect.objectContaining({ review: true }),
        productionOnly: false,
      }),
    );
  });
});
