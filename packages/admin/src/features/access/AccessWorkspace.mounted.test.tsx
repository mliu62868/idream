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
});
