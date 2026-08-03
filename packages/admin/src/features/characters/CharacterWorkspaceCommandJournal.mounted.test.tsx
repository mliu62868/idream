// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { adminV2Request } = vi.hoisted(() => ({
  adminV2Request: vi.fn<
    (
      path: string,
      options?: {
        readonly method?: string;
        readonly idempotencyKey?: string;
        readonly body?: unknown;
      },
    ) => Promise<unknown>
  >(),
}));

vi.mock("@/lib/admin-v2-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-v2-api")>();
  return { ...actual, adminV2Request };
});

import { AdminI18nProvider } from "@/components/admin/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { characterWorkspaceDetail } from "./character-workspace-fixture";
import { CharacterWorkspace } from "./CharacterWorkspace";

/**
 * SPEC: 这一屏证明的不是 journal 的判断对不对（那由 character-command-journal.test.ts 覆盖），
 *       而是**角色运营台确实接上了 journal 的每一个出口**。
 * INTENT: 本轮在 CharacterAssetStudio 上实证过一次：把模块两个出口塌成任意一个，496 个测试
 *         全绿——模块层的分流有测试，组件接到哪个出口没人管。所以这里逐个出口驱动真实响应，
 *         断言运营在页面上看到的结果（写入锁 / 通知 / 旁注 / 落盘日志）。
 */

const workspace = characterWorkspaceDetail({
  character: { id: "character-1", name: "Mira" },
  releases: [],
});

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

const pendingCommandKey =
  "idream:admin:character:operator-a:character-1:pending-command";

let container: HTMLElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitUntil(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await flush();
  }
}

function text() {
  return container.textContent ?? "";
}

function statusBanners() {
  return [
    ...container.querySelectorAll('[role="status"], [role="alert"]'),
  ].map((node) => node.textContent ?? "");
}

function bannerContaining(fragment: string) {
  return statusBanners().find((banner) => banner.includes(fragment)) ?? null;
}

function commandTab() {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.id?.startsWith("character-tab-"),
  );
}

function releaseTabSelected() {
  return (
    document.getElementById("character-tab-release")?.getAttribute("aria-selected") ===
    "true"
  );
}

async function render() {
  await act(async () => {
    root.render(
      <AdminI18nProvider locale="en">
        <CharacterWorkspace
          actorId="operator-a"
          permissions={permissions}
          view={{ kind: "detail", id: "character-1" }}
        />
      </AdminI18nProvider>,
    );
  });
  await waitUntil(() => text().includes("Mira"), "the workspace to load");
}

/** 点击 Release 页签上的 Publish（或 Pause 等）按钮。 */
function clickButton(label: string) {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((node) => (node.textContent ?? "").trim() === label);
  if (!button) {
    throw new Error(
      `no button labelled "${label}"; saw ${[
        ...container.querySelectorAll("button"),
      ]
        .map((node) => `"${(node.textContent ?? "").trim()}"`)
        .join(", ")}`,
    );
  }
  return button;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/admin/characters/character-1");
  adminV2Request.mockReset();
  adminV2Request.mockImplementation(async (path) => {
    if (path === "/api/v2/admin/characters/character-1") return workspace;
    throw new Error(`unexpected request: ${path}`);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * SPEC: 直接把一条落盘日志放进浏览器存储再挂载，等价于「运营提交后立刻刷新了页面」。
 * INTENT: 提交按钮藏在 Release 页签的多层护栏（确认勾选 / 候选 release）后面；恢复路径是
 *         同一套出口，而且它才是这套协议真正存在的理由。
 */
function seedPendingCommand(
  overrides: Record<string, unknown> = {},
  createdAt = Date.now(),
) {
  window.localStorage.setItem(
    pendingCommandKey,
    JSON.stringify({
      schemaVersion: 1,
      actorId: "operator-a",
      environment: window.location.origin,
      commandId: null,
      action: "Release publish",
      signature: "publish:release-1",
      endpoint:
        "/api/v2/admin/characters/character-1/releases/release-1/commands/publish",
      body: { entityVersion: 1 },
      idempotencyKey: "command-key-1",
      createdAt,
      autoReplayUntil: createdAt + 5 * 60_000,
      ...overrides,
    }),
  );
}

describe("Character workspace — 每个命令出口都接到了运营界面", () => {
  // SPEC: 有落盘日志时首屏直接落在 Release 页签，并锁住写入。
  it("restores a persisted command, locks writes, and lands on the release tab", async () => {
    seedPendingCommand();
    adminV2Request.mockImplementation(async (path) => {
      if (path === "/api/v2/admin/characters/character-1") return workspace;
      // 重放挂起，让恢复停在「已恢复、未受理」这一刻。
      return new Promise(() => undefined);
    });

    await render();
    await waitUntil(
      () => bannerContaining("may already be accepted") !== null,
      "the restored command notice",
    );

    expect(releaseTabSelected()).toBe(true);
    expect(commandTab()?.disabled).toBe(true);
    expect(window.location.search).toBe("?tab=release");
  });

  // SPEC: 重放被受理 → 通知换成「命令待决」，并出现命令证据链接。
  it("wires the accepted replay exit to a pending-command notice with evidence", async () => {
    seedPendingCommand();
    adminV2Request.mockImplementation(async (path) => {
      if (path === "/api/v2/admin/characters/character-1") return workspace;
      if (path.includes("/commands/publish")) return { commandId: "command-1" };
      return { commandId: "command-1", status: "running" };
    });

    await render();
    await waitUntil(
      () => bannerContaining("command is pending") !== null,
      "the accepted replay notice",
    );

    expect(
      container.querySelector<HTMLAnchorElement>(
        'a[href*="commandId=command-1"]',
      ),
    ).not.toBeNull();
  });

  // SPEC: 重放撞上另一条活动命令 → 挂到那一条上，绝不提交第二条。
  it("wires the attached exit to the other command instead of submitting a second one", async () => {
    seedPendingCommand();
    const submissions: string[] = [];
    adminV2Request.mockImplementation(async (path) => {
      if (path === "/api/v2/admin/characters/character-1") return workspace;
      if (path.includes("/commands/publish")) {
        submissions.push(path);
        throw new AdminV2RequestError("conflict", 409, "conflict", {
          activeCommandId: "command-other",
          activeCommandType: "character.serving.pause",
        });
      }
      return { commandId: "command-other", status: "running" };
    });

    await render();
    await waitUntil(
      () => bannerContaining("attached to that command") !== null,
      "the attached recovery note",
    );

    expect(bannerContaining("attached to that command")).toContain(
      "serving pause",
    );
    expect(submissions).toHaveLength(1);
    expect(commandTab()?.disabled).toBe(true);
  });

  // SPEC: 会话/权限不足 → 保持锁定并继续重试，不许静默解锁。
  it("wires the blocked exit to a locked workspace that keeps retrying", async () => {
    seedPendingCommand();
    adminV2Request.mockImplementation(async (path) => {
      if (path === "/api/v2/admin/characters/character-1") return workspace;
      throw new AdminV2RequestError("forbidden", 403);
    });

    await render();
    await waitUntil(
      () =>
        bannerContaining("acceptance cannot be proven with the current session") !==
        null,
      "the blocked recovery note",
    );

    expect(bannerContaining("Character writes remain locked")).not.toBeNull();
    expect(commandTab()?.disabled).toBe(true);
    expect(window.localStorage.getItem(pendingCommandKey)).not.toBeNull();
  });

  // SPEC: 重放被明确拒绝 → 与服务端对账；服务端说没有活动命令才解锁。
  it("wires the reconcile exit through server authority before unlocking writes", async () => {
    seedPendingCommand();
    adminV2Request.mockImplementation(async (path) => {
      if (path === "/api/v2/admin/characters/character-1") return workspace;
      throw new AdminV2RequestError("gone", 409);
    });

    await render();
    await waitUntil(
      () => bannerContaining("no active command remains") !== null,
      "the reconciled recovery note",
    );

    expect(window.localStorage.getItem(pendingCommandKey)).toBeNull();
    await waitUntil(() => commandTab()?.disabled === false, "writes to unlock");
  });

  // SPEC: 重放窗口过期 → 停下来，给运营一个显式恢复按钮，不再自动发。
  it("wires the expired window to an explicit operator resume control", async () => {
    seedPendingCommand({}, Date.now() - 6 * 60_000);
    const submissions: string[] = [];
    adminV2Request.mockImplementation(async (path) => {
      if (path === "/api/v2/admin/characters/character-1") return workspace;
      submissions.push(path);
      return { commandId: "command-1" };
    });

    await render();
    await waitUntil(
      () => bannerContaining("automatic replay window expired") !== null,
      "the reconfirmation notice",
    );
    expect(submissions).toHaveLength(0);

    await act(async () => {
      clickButton("Review and resume saved command").click();
    });
    await waitUntil(
      () => submissions.length === 1,
      "the explicitly authorized replay",
    );
  });

  // SPEC: 命令证据 404 → 不许直接解锁，必须先由服务端权威证明没有命令还活着。
  it("wires the missing-evidence exit through server authority before unlocking", async () => {
    seedPendingCommand({ commandId: "command-1" });
    let workspaceLoads = 0;
    adminV2Request.mockImplementation(async (path) => {
      if (path === "/api/v2/admin/characters/character-1") {
        workspaceLoads += 1;
        return workspace;
      }
      throw new AdminV2RequestError("missing", 404);
    });

    await render();
    const loadsBeforeRecovery = workspaceLoads;
    await waitUntil(
      () =>
        bannerContaining("server-side Character authority confirmed") !== null,
      "the reconciled evidence note",
    );

    // 解锁之前确实又问了一次服务端权威，而不是凭 404 自己放行。
    expect(workspaceLoads).toBeGreaterThan(loadsBeforeRecovery);
    expect(window.localStorage.getItem(pendingCommandKey)).toBeNull();
    await waitUntil(() => commandTab()?.disabled === false, "writes to unlock");
  });

  // SPEC: 命令成功终结 → 解锁写入并清掉日志；失败终结 → 解锁但留下可查证的告警。
  it.each([
    ["succeeded", false],
    ["failed", true],
  ] as const)(
    "wires the settled %s status to an unlocked workspace",
    async (status, expectsAlert) => {
      seedPendingCommand({ commandId: "command-1" });
      adminV2Request.mockImplementation(async (path) => {
        if (path === "/api/v2/admin/characters/character-1") return workspace;
        return { commandId: "command-1", status };
      });

      await render();
      await waitUntil(
        () => window.localStorage.getItem(pendingCommandKey) === null,
        "the settled command journal to clear",
      );
      await waitUntil(() => commandTab()?.disabled === false, "writes to unlock");

      expect(bannerContaining(`command ${status}`) !== null).toBe(expectsAlert);
    },
  );

  // SPEC: 另一个标签页清掉了日志 → 本标签页必须先与服务端对账，不能直接放行写入。
  it("wires a cross-tab journal clear to server reconciliation", async () => {
    seedPendingCommand();
    adminV2Request.mockImplementation(async (path) => {
      if (path === "/api/v2/admin/characters/character-1") return workspace;
      return new Promise(() => undefined);
    });

    await render();
    await waitUntil(
      () => bannerContaining("may already be accepted") !== null,
      "the restored command",
    );

    const loadsBeforeClear = adminV2Request.mock.calls.filter(
      ([path]) => path === "/api/v2/admin/characters/character-1",
    ).length;
    window.localStorage.removeItem(pendingCommandKey);
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: pendingCommandKey,
          newValue: null,
        }),
      );
    });
    await waitUntil(() => commandTab()?.disabled === false, "writes to unlock");

    // INVARIANT: 别的标签页清掉日志不等于「可以写了」——本标签页必须自己再问一次权威。
    expect(
      adminV2Request.mock.calls.filter(
        ([path]) => path === "/api/v2/admin/characters/character-1",
      ).length,
    ).toBeGreaterThan(loadsBeforeClear);
  });

  // SPEC: 服务端投影自带活动命令时，运营台也要立刻锁住并跳到 Release 页签。
  it("wires a server-reported active command to the same locked release view", async () => {
    adminV2Request.mockImplementation(async (path) => {
      if (path === "/api/v2/admin/characters/character-1") {
        return {
          ...workspace,
          activeCommand: {
            commandId: "command-server",
            commandType: "character.serving.retire",
            status: "running",
            createdAt: new Date().toISOString(),
          },
        };
      }
      return { commandId: "command-server", status: "running" };
    });

    await render();
    await waitUntil(
      () => bannerContaining("command is pending") !== null,
      "the server-reported command notice",
    );

    expect(bannerContaining("command is pending")).toContain("serving retire");
    expect(releaseTabSelected()).toBe(true);
    expect(commandTab()?.disabled).toBe(true);
  });
});
