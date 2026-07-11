import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CharacterCreateWizard } from "./CharacterCreateWizard";
import { CharacterWorkspace } from "./CharacterWorkspace";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("Character create wizard", () => {
  it("renders the five-step mobile-first server draft workflow", () => {
    const html = renderToStaticMarkup(createElement(CharacterCreateWizard, { canCreate: true }));
    expect(html).toContain("data-testid=\"character-create-wizard\"");
    expect(html).toContain("Positioning");
    expect(html).toContain("Persona");
    expect(html).toContain("Visual direction");
    expect(html).toContain("Commercial intent");
    expect(html).toContain("Review");
    expect(html).toContain("Server draft");
    expect(html).toContain("Save positioning &amp; continue");
  });

  it("fails closed without Character Project write permission", () => {
    const html = renderToStaticMarkup(createElement(CharacterCreateWizard, { canCreate: false }));
    expect(html).toContain("No permission");
    expect(html).toContain("character.project.write");
    expect(html).not.toContain("Save positioning &amp; continue");
  });

  it("dispatches the canonical new subview to the wizard instead of Portfolio", () => {
    const html = renderToStaticMarkup(createElement(CharacterWorkspace, {
      view: { kind: "new" },
      permissions: { read: true, writeProject: true, proposeRelease: true, publishRelease: false, reviewRelease: false },
    }));
    expect(html).toContain("data-testid=\"character-create-wizard\"");
    expect(html).not.toContain("Portfolio &amp; Projects");
  });
});
