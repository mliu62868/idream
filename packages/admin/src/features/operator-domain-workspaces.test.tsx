import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CharacterPerformanceWorkspace, CharacterWorkspace } from "./characters/CharacterWorkspace";
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

  it("exposes the Creative brief-and-launch front half only with write authority", () => {
    const writable = renderToStaticMarkup(<CreativeRunWorkspace permissions={{ read: true, write: true, review: true, place: true }} view={{ kind: "list" }} />);
    const readOnly = renderToStaticMarkup(<CreativeRunWorkspace permissions={{ read: true, write: false, review: false, place: false }} view={{ kind: "list" }} />);
    expect(writable).toContain("Brief &amp; launch");
    expect(writable).toContain("Create and launch");
    expect(readOnly).not.toContain("Create and launch");
  });

  it("renders server-authority search controls while portfolio data is loading", () => {
    const html = renderToStaticMarkup(<CharacterWorkspace permissions={{ read: true, writeProject: true, proposeRelease: true, publishRelease: true, reviewRelease: true }} view={{ kind: "list" }} />);
    expect(html).toContain("Search authority");
    expect(html).toContain("Project phase");
    expect(html).toContain("Serving state");
    expect(html).toContain("Readiness");
    expect(html).toContain("Loading release-attributed portfolio");
  });

  it("renders the analyst Character Performance route without granting Project access", () => {
    const html = renderToStaticMarkup(
      <CharacterPerformanceWorkspace canOpenProjects={false} canRead={true} />,
    );
    expect(html).toContain("Character Performance");
    expect(html).toContain("Loading release-attributed portfolio");
    expect(html).not.toContain("No permission");
  });
});
