import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccessWorkspace } from "./AccessWorkspace";

describe("Access workspace permissions", () => {
  it("keeps server filters visible and hides both high-risk capabilities without grants", () => {
    const html = renderToStaticMarkup(<AccessWorkspace permissions={{ changeStatus: false, managePermissions: false }} />);
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
  });
});
