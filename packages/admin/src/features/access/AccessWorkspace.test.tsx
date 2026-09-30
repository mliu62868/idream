// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AccessWorkspace } from "./AccessWorkspace";

vi.mock("@/components/admin/api", () => ({
  apiGet: vi.fn(async () => ({ items: [], pageInfo: { endCursor: null, hasNextPage: false } })),
  apiWrite: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Access workspace permissions", () => {
  it("keeps server filters available and hides both high-risk capabilities without grants", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<AccessWorkspace permissions={{ changeStatus: false, managePermissions: false }} />));
    const toggle = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Filters");
    expect(toggle).toBeDefined();
    await act(async () => toggle?.click());
    const html = container.innerHTML;
    expect(html).toContain("Search users");
    expect(html).toContain("Data class");
    for (const dataClass of ["customer", "internal", "fixture", "audit"]) {
      expect(html).toContain(`value="${dataClass}"`);
    }
    expect(html).toContain("Changing roles and permission overrides is unavailable");
    expect(html).toContain("Suspending and restoring accounts is unavailable");
    // 权限码只留在 title 属性上，不进正文。
    expect(html).not.toContain("is not granted");
    expect(html).not.toContain("Permission override</h3>");
    await act(async () => root.unmount());
    container.remove();
  });
});
