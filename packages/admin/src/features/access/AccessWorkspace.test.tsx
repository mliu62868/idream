import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccessWorkspace } from "./AccessWorkspace";

describe("Access workspace permissions", () => {
  it("keeps server filters visible and hides both high-risk capabilities without grants", () => {
    const html = renderToStaticMarkup(<AccessWorkspace permissions={{ changeStatus: false, managePermissions: false }} />);
    expect(html).toContain("Search users");
    expect(html).toContain("user.role.write is not granted");
    expect(html).toContain("user.status.write is not granted");
    expect(html).not.toContain("Permission override</h3>");
  });
});
