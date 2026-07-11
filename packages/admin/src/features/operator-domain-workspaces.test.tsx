import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CharacterWorkspace } from "./characters/CharacterWorkspace";
import { CreativeRunWorkspace } from "./creative/CreativeRunWorkspace";
import { parseAdminPath } from "@/components/admin/nav-config";

describe("Character and Creative operator workspaces", () => {
  it("renders explicit effective-permission denial instead of attempting a hidden write", () => {
    const html = renderToStaticMarkup(<CharacterWorkspace permissions={{ read: false, writeProject: false, proposeRelease: false, publishRelease: false, reviewRelease: false }} view={{ kind: "list" }} />);
    expect(html).toContain("No permission");
    expect(html).toContain("character.project.read");
  });

  it("renders a structure-matched Creative loading state and canonical detail route", () => {
    const html = renderToStaticMarkup(<CreativeRunWorkspace permissions={{ read: true, write: true, review: true, place: true }} view={{ kind: "detail", id: "run-42" }} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading Creative Run lineage and outcomes");
    expect(parseAdminPath("creative/runs/run-42")).toEqual({
      sectionId: "content/production",
      view: { kind: "detail", id: "run-42" },
    });
  });

  it("renders server-authority search controls while portfolio data is loading", () => {
    const html = renderToStaticMarkup(<CharacterWorkspace permissions={{ read: true, writeProject: true, proposeRelease: true, publishRelease: true, reviewRelease: true }} view={{ kind: "list" }} />);
    expect(html).toContain("Search authority");
    expect(html).toContain("Loading release-attributed portfolio");
  });
});
