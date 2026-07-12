import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GenerationConfigWorkspace } from "./GenerationConfigWorkspace";

describe("Generation Config workspace permission surface", () => {
  it("renders server-query controls and explicit read-only capabilities", () => {
    const html = renderToStaticMarkup(<GenerationConfigWorkspace permissions={{ manageFlags: false, manageProfiles: false }} />);

    expect(html).toContain("Test and publish generation profiles");
    expect(html).toContain('role="searchbox"');
    expect(html).toContain("Legacy compatibility authority");
    expect(html).toContain("Profiles: refreshing");
    expect(html).toContain('aria-label="Loading generation config authority"');
  });

  it("keeps independent profile and feature-flag permissions in the public contract", () => {
    const source = GenerationConfigWorkspace.toString();
    expect(source).toContain("manageProfiles");
    expect(source).toContain("manageFlags");
  });
});
