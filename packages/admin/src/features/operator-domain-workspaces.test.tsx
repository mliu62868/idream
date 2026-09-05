import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminPermissionKey } from "@idream/shared/admin";
import {
  CharacterPerformanceWorkspace,
  CharacterWorkspace,
} from "./characters/CharacterWorkspace";
import { CreativeRunWorkspace } from "./creative/CreativeRunWorkspace";
import { parseAdminPath } from "@/components/admin/nav-config";

const FULL_CHARACTER_PERMISSIONS = new Set<AdminPermissionKey>([
  "character.project.read",
  "character.release.read",
  "character.performance.read",
  "character.project.write",
  "creative.run.read",
]);

describe("Character and Creative operator workspaces", () => {
  it("renders explicit effective-permission denial instead of attempting a hidden write", () => {
    const html = renderToStaticMarkup(
      <CharacterWorkspace
        actorId="test-admin"
        permissions={new Set()}
        view={{ kind: "list" }}
      />,
    );
    expect(html).toContain("No permission");
    expect(html).toContain("character.project.read");
  });

  it("renders a structure-matched Creative loading state and canonical detail route", () => {
    const html = renderToStaticMarkup(
      <CreativeRunWorkspace
        permissions={{ read: true, write: true, review: true, place: true }}
        view={{ kind: "detail", id: "run-42" }}
      />,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading Creative Run lineage and outcomes");
    const parsed = parseAdminPath("creative/runs/run-42");
    expect(parsed?.item.id).toBe("content/production");
    expect(parsed?.view).toEqual({ kind: "detail", id: "run-42" });
  });

  it("keeps the Creative list as generation history for both read and write operators", () => {
    const writable = renderToStaticMarkup(
      <CreativeRunWorkspace
        permissions={{ read: true, write: true, review: true, place: true }}
        view={{ kind: "list" }}
      />,
    );
    const readOnly = renderToStaticMarkup(
      <CreativeRunWorkspace
        permissions={{ read: true, write: false, review: false, place: false }}
        view={{ kind: "list" }}
      />,
    );
    for (const html of [writable, readOnly]) {
      expect(html).toContain("Generate assets, choose where to use them, and verify delivery.");
      expect(html).toContain("Run, title or purpose");
      expect(html).toContain("Loading Creative Run facts");
      expect(html).not.toContain("Create images");
      expect(html).not.toContain("Creative brief");
      expect(html).not.toContain("Create and launch");
    }
  });

  it("renders Character-first search controls while Character data is loading", () => {
    const html = renderToStaticMarkup(
      <CharacterWorkspace
        actorId="test-admin"
        permissions={FULL_CHARACTER_PERMISSIONS}
        view={{ kind: "list" }}
      />,
    );
    expect(html).toContain("Characters");
    expect(html).not.toContain("Portfolio &amp; Projects");
    expect(html).toContain("Search characters");
    expect(html).not.toContain("Search authority");
    expect(html).toContain("Search name or character ID");
    expect(html).not.toContain("Character stage");
    expect(html).not.toContain("Project phase");
    expect(html).toContain('aria-label="Character operations filters"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">Draft<");
    expect(html).toContain(">Live<");
    expect(html).toContain(">Needs attention<");
    expect(html).not.toContain("Serving state");
    expect(html).not.toContain("Readiness");
    expect(html).toContain('href="/admin/characters/new"');
    expect(html).toContain("Create Character");
    expect(html).toContain("Loading characters");
    expect(html).not.toContain("Loading release-attributed portfolio");
  });

  it("renders the analyst Character Performance route without granting Project access", () => {
    const html = renderToStaticMarkup(
      <CharacterPerformanceWorkspace
        permissions={
          new Set<AdminPermissionKey>(["character.performance.read"])
        }
      />,
    );
    expect(html).toContain("Character Performance");
    expect(html).toContain("Loading release-attributed portfolio");
    expect(html).not.toContain("No permission");
    expect(html).not.toContain("Create Character");
  });
});
