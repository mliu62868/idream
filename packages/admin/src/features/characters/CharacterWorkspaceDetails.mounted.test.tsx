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
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { CharacterWorkspace } from "./CharacterWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// INTENT: 一次 0ms flush 在机器忙的时候接不住「加载 -> 投影 -> 重渲染」这条链，
//         等到条件成立为止才是稳的。
async function waitUntil(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const VOICE_DEFAULTS_READ_ONLY =
  "Read-only: generation.config.write is required to change system voice defaults.";

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
    // INTENT: 这份 mock 此前对所有路径一律返回 workspace，于是协作活动流拿到的 response.items
    //         是 undefined，只是因为它的 promise 落在断言窗口之后才没炸。详情页每多一个自取数
    //         面板都会改变 flush 顺序、把它掀出来。按路径给形状，别再让顺序决定成败。
    adminV2Request.mockImplementation(async (path: string) => {
      if (path.includes("/collaboration/")) {
        return { items: [], actors: [], watcherIds: [], pageInfo: { endCursor: null, hasNextPage: false } };
      }
      if (path.includes("/admin/content/tags")) return { items: [] };
      if (/\/admin\/content\/characters\/[^/]+$/.test(path)) return { character: { tags: [] } };
      return workspace;
    });
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

  it("repairs a structured approved-customer Project gap and opens Images", async () => {
    let prepared = false;
    const submittedIdempotencyKeys: string[] = [];
    adminV2Request.mockImplementation(async (
      path: string,
      options?: { method?: string; idempotencyKey?: string },
    ) => {
      if (path === "/api/v2/admin/characters/character-detail/project" && options?.method === "POST") {
        submittedIdempotencyKeys.push(options.idempotencyKey ?? "");
        if (submittedIdempotencyKeys.length === 1) {
          throw new AdminV2RequestError("Temporary publication-prep failure", 503, "unavailable");
        }
        prepared = true;
        return {
          state: "publication_prep",
          characterId: "character-detail",
          submissionId: "submission-detail",
          projectId: "project-detail",
          revisionId: "revision-detail",
          projectVersion: 1,
          servingState: "inactive",
          deepLink: "/admin/characters/character-detail?tab=assets",
          created: true,
          replayed: false,
        };
      }
      if (!prepared) {
        throw new AdminV2RequestError(
          "Character Project not found",
          404,
          "not_found",
          {
            reason: "customer_publication_prep_missing",
            characterId: "character-detail",
            submissionId: "submission-detail",
            recoveryOperation: "POST /api/v2/admin/characters/:id/project",
          },
        );
      }
      return workspace;
    });

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
    await waitUntil(
      () => container.textContent?.includes("Approved · awaiting publication preparation") === true,
      "publication preparation recovery",
    );
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.includes("Prepare publication workspace"),
    );
    expect(button).toBeDefined();

    await act(async () => {
      button?.click();
    });
    expect(prepared).toBe(false);
    expect(document.body.textContent).toContain(
      "It does not create or publish a Release and does not make the Character visible in Explore or Community.",
    );
    const reason = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Operational reason (≥3)"]',
    );
    const confirmation = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Type the publication preparation confirmation"]',
    );
    expect(reason).toBeTruthy();
    expect(confirmation).toBeTruthy();
    await act(async () => {
      setInput(reason!, "Repair the approved customer publication workspace");
      setInput(confirmation!, "PREPARE PUBLICATION character-detail");
    });
    const submit = [...document.body.querySelectorAll("button")].find(
      (candidate) =>
        candidate !== button &&
        candidate.textContent?.includes("Prepare publication workspace"),
    );
    expect(submit?.disabled).toBe(false);
    await act(async () => {
      submit?.click();
    });
    await waitUntil(
      () => document.body.textContent?.includes("Temporary publication-prep failure") === true,
      "inline publication preparation failure",
    );
    await act(async () => {
      submit?.click();
    });
    await waitUntil(
      () => prepared && window.location.search === "?tab=assets",
      "prepared Images workspace",
    );

    expect(adminV2Request).toHaveBeenCalledWith(
      "/api/v2/admin/characters/character-detail/project",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          submissionId: "submission-detail",
          reason: "Repair the approved customer publication workspace",
          confirmation: "PREPARE PUBLICATION character-detail",
        }),
        idempotencyKey: expect.any(String),
      }),
    );
    expect(submittedIdempotencyKeys).toHaveLength(2);
    expect(new Set(submittedIdempotencyKeys).size).toBe(1);
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
    await waitUntil(
      () => container.textContent?.includes(VOICE_DEFAULTS_READ_ONLY) === true,
      "the locked system voice defaults notice",
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
    await waitUntil(
      () => container.textContent?.includes("System voice defaults") === true,
      "the system voice defaults panel",
    );

    expect(container.textContent).not.toContain(VOICE_DEFAULTS_READ_ONLY);
  });
});
