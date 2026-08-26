// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiGet, apiWrite } = vi.hoisted(() => ({
  apiGet: vi.fn<(path: string) => Promise<unknown>>(),
  apiWrite: vi.fn(),
}));

vi.mock("@/components/admin/api", () => ({ apiGet, apiWrite }));

import { AccessWorkspace } from "./AccessWorkspace";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emptyUserList = {
  items: [],
  pageInfo: { endCursor: null, hasNextPage: false },
};

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for access workspace");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function typeUserId(container: HTMLElement, userId: string) {
  const input = [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("Permission user ID"))
    ?.querySelector("input");
  if (!input) throw new Error("Permission user ID field is missing");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(input, userId);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// SPEC: 角色与授权包的入口必须真的发出后端要的那条命令 —— 确认串差一个字符就是 400。
// INTENT: 这两个 API（users/:id/role、users/:id/grant-bundles）后端一直都在，界面上却没有入口，
//         运营只能一条一条打权限覆盖补丁。补入口的同时把确认串的形状钉死：它由服务端定
//         （`${userId}:${role}` / `${userId}:${bundleKey}:grant|revoke`），不是界面文案。
describe("role and grant bundle commands", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    apiGet.mockReset();
    apiWrite.mockReset();
    apiGet.mockImplementation(async (path: string) => {
      if (path.includes("/grant-bundles")) {
        return {
          user: { id: "user-9", role: "support", status: "active" },
          items: [
            {
              id: "bundle-1",
              userId: "user-9",
              bundleKey: "creative_operator",
              scope: null,
              expiresAt: null,
              revokedAt: null,
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
              state: "active",
              permissions: ["creative.run.read"],
            },
            // 已撤销的仍在列表里，但不该再给撤销按钮。
            {
              id: "bundle-2",
              userId: "user-9",
              bundleKey: "growth_operator",
              scope: null,
              expiresAt: null,
              revokedAt: "2026-08-10T00:00:00.000Z",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-10T00:00:00.000Z",
              state: "revoked",
              permissions: ["growth.promo.read"],
            },
          ],
        };
      }
      if (path.includes("/permissions")) {
        return { user: { id: "user-9", role: "support", status: "active" }, overrides: [], effective: [] };
      }
      return emptyUserList;
    });
    apiWrite.mockResolvedValue({});
    window.history.replaceState(null, "", "/admin/system/access");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function mountWithTarget() {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <AccessWorkspace permissions={{ changeStatus: true, managePermissions: true }} />,
      );
    });
    await typeUserId(container, "user-9");
    await waitUntil(() =>
      apiGet.mock.calls.some(([path]) => String(path).includes("/grant-bundles")),
    );
  }

  // ConfirmDialog 渲染在 document 上而不是 container 里，两个输入框靠 aria-label 区分。
  function clickButton(label: string) {
    const button = [...document.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.trim() === label ||
        candidate.getAttribute("aria-label") === label,
    );
    if (!button) throw new Error(`Button not found: ${label}`);
    return act(async () => button.click());
  }

  async function confirmDialog(reason: string, confirmation: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    const reasonField = document.querySelector<HTMLInputElement>('input[aria-label="Reason"]');
    const confirmField = document.querySelector<HTMLInputElement>('input[aria-label="Confirmation"]');
    if (!reasonField || !confirmField) throw new Error("Confirm dialog fields are missing");
    await act(async () => {
      setter?.call(reasonField, reason);
      reasonField.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(confirmField, confirmation);
      confirmField.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton("Confirm");
  }

  it("offers revoke only for the bundles that are still active", async () => {
    await mountWithTarget();
    const revokeLabels = [...container.querySelectorAll("button")]
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => Boolean(label?.startsWith("Revoke ")));

    expect(revokeLabels).toEqual(["Revoke creative_operator"]);
  });

  it("sends the role command with the confirmation string the authority compares", async () => {
    await mountWithTarget();
    await clickButton("Change role");
    await confirmDialog("Promoting to ops on-call", "user-9:support");

    await waitUntil(() => apiWrite.mock.calls.length > 0);
    const [path, method, body] = apiWrite.mock.calls[0];
    expect(path).toBe("/api/v2/admin/users/user-9/role");
    expect(method).toBe("POST");
    expect(body).toMatchObject({ role: "support", confirmation: "user-9:support" });
  });

  // SPEC: character_producer 必须带上非空 scope.characterIds 才授得出去。
  // INTENT: 服务端 `permissions/grant-bundles.ts:assertBundleScope` 对它强制要求非空范围，
  //         而它恰好是 ADMIN_GRANT_BUNDLES 里的第一个 key，也就是下拉框的默认值——没有范围
  //         输入框时，这个默认选项发出去必定是一条 400，运营看到的是"确认串没问题却失败了"。
  it("carries the character scope the authority requires for character_producer", async () => {
    await mountWithTarget();
    const scopeInput = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Assigned character IDs"))
      ?.querySelector("input");
    if (!scopeInput) throw new Error("Character scope field is missing for character_producer");
    const grant = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Grant bundle",
    );
    // 范围为空时不给按 —— 与其发一条注定 400 的命令，不如先要范围。
    expect((grant as HTMLButtonElement).disabled).toBe(true);

    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(scopeInput, "char-1, char-2");
      scopeInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickButton("Grant bundle");
    await confirmDialog("Joining the character rota", "user-9:character_producer:grant");

    await waitUntil(() => apiWrite.mock.calls.length > 0);
    const [path, method, body] = apiWrite.mock.calls[0];
    expect(path).toBe("/api/v2/admin/users/user-9/grant-bundles");
    expect(method).toBe("POST");
    expect(body).toMatchObject({
      bundleKey: "character_producer",
      confirmation: "user-9:character_producer:grant",
      scope: { characterIds: ["char-1", "char-2"] },
    });
  });

  it("revokes a bundle with a DELETE that still carries reason and confirmation", async () => {
    await mountWithTarget();
    await clickButton("Revoke creative_operator");
    await confirmDialog("Left the creative rota", "user-9:creative_operator:revoke");

    await waitUntil(() => apiWrite.mock.calls.length > 0);
    const [path, method, body] = apiWrite.mock.calls[0];
    expect(path).toBe("/api/v2/admin/users/user-9/grant-bundles/creative_operator");
    expect(method).toBe("DELETE");
    expect(body).toMatchObject({
      reason: "Left the creative rota",
      confirmation: "user-9:creative_operator:revoke",
    });
  });
});

describe("permission override impact", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    apiGet.mockReset();
    apiWrite.mockReset();
    window.history.replaceState(null, "", "/admin/system/access");
    container = document.createElement("div");
    document.body.append(container);
    root = null;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  /**
   * SPEC: 选中一个权限时，管理员要看到能力名 + 这个人现在有没有 + 点下去会变成什么。
   *
   * INTENT: `GET /users/:id/permissions` 和写命令共用 user.role.write 门槛，一直可用，
   * 而这个台面从来没查过它。最常见的误操作是给一个已经通过角色拿到该能力的人再发一条 grant ——
   * 多出来的那条覆盖会盖过将来的角色调整，而界面此前完全不提。
   */
  it("warns that a grant on an already-effective capability outlives role changes", async () => {
    apiGet.mockImplementation(async (path) => {
      if (path.includes("/permissions")) {
        return {
          role: "ops",
          overrides: [],
          effective: ["billing.ledger.adjust", "billing.read"],
        };
      }
      return emptyUserList;
    });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <AccessWorkspace permissions={{ changeStatus: true, managePermissions: true }} />,
      );
    });
    await typeUserId(container, "user-1");
    await waitUntil(() =>
      apiGet.mock.calls.some(([path]) => path.includes("/user-1/permissions")),
    );
    await waitUntil(() => container.textContent?.includes("already has this capability") ?? false);

    const text = container.textContent ?? "";
    // 能力名在场，权限码也还在——核对时看得到，但不再是唯一线索。
    expect(text).toContain("Adjusting customer Dreamcoin balances");
    expect(text).toContain("billing.ledger.adjust");
    expect(text).toContain("2 capabilities in total");
    expect(text).toContain("outlives any role change");
  });

  // INVARIANT: 查不到就说查不到。绝不能把「没查到」显示成「这个人没有权限」。
  it("says the current permissions are unreadable instead of implying the user has none", async () => {
    apiGet.mockImplementation(async (path) => {
      if (path.includes("/permissions")) throw new Error("not found");
      return emptyUserList;
    });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <AccessWorkspace permissions={{ changeStatus: true, managePermissions: true }} />,
      );
    });
    await typeUserId(container, "ghost-user");
    await waitUntil(() =>
      container.textContent?.includes("Could not read this user's current permissions") ?? false,
    );

    const text = container.textContent ?? "";
    expect(text).not.toContain("does not have this capability");
    expect(text).not.toContain("already has this capability");
  });

  /**
   * SPEC: 余额是钱，按梦币口径排版；分页条的「上一页」在第一页置灰而不是消失。
   *
   * INTENT: 余额以前走的是 billing/money.ts 这份本地实现，和 ui/format 的梦币口径各写一套；
   * 分页条以前只有一个「下一页」，运营翻过去就回不来。
   */
  it("groups the balance and keeps a greyed-out Previous page on the first page", async () => {
    apiGet.mockImplementation(async (path) => {
      if (path.includes("/permissions")) throw new Error("not requested");
      return {
        items: [
          {
            id: "user-1",
            email: "ledger@example.test",
            displayName: "Ledger Tester",
            role: "user",
            status: "active",
            dataClass: "fixture",
            plan: null,
            dreamcoins: 1_500_000,
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        pageInfo: { endCursor: "cursor-2", hasNextPage: true },
      };
    });

    await act(async () => {
      root = createRoot(container);
      root.render(
        <AccessWorkspace permissions={{ changeStatus: true, managePermissions: true }} />,
      );
    });
    await waitUntil(() => container.textContent?.includes("Ledger Tester") ?? false);

    expect(container.textContent).toContain("1,500,000");
    const buttons = [...container.querySelectorAll("button")];
    const previous = buttons.find((button) => button.textContent?.trim() === "Previous page");
    const next = buttons.find((button) => button.textContent?.trim() === "Next page");
    expect(previous?.disabled).toBe(true);
    expect(next?.disabled).toBe(false);
  });
});
