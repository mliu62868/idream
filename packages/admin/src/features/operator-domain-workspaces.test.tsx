import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CharacterPerformanceWorkspace,
  CharacterWorkspace,
  qaRunMatchesCurrentWorkspaceAuthority,
} from "./characters/CharacterWorkspace";
import { CreativeRunWorkspace } from "./creative/CreativeRunWorkspace";
import { parseAdminPath } from "@/components/admin/nav-config";

describe("Character and Creative operator workspaces", () => {
  it("renders explicit effective-permission denial instead of attempting a hidden write", () => {
    const html = renderToStaticMarkup(<CharacterWorkspace actorId="test-admin" permissions={{ read: false, writeProject: false, proposeRelease: false, publishRelease: false, reviewRelease: false, writeVisual: false, evaluateRoute: false, readAssets: false, createAssets: false, reviewAssets: false, manageVoiceDefaults: false }} view={{ kind: "list" }} />);
    expect(html).toContain("No permission");
    expect(html).toContain("character.project.read");
  });

  it("renders a structure-matched Creative loading state and canonical detail route", () => {
    const html = renderToStaticMarkup(<CreativeRunWorkspace permissions={{ read: true, write: true, review: true, place: true }} view={{ kind: "detail", id: "run-42" }} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading Creative Run lineage and outcomes");
    const parsed = parseAdminPath("creative/runs/run-42");
    expect(parsed?.item.id).toBe("content/production");
    expect(parsed?.view).toEqual({ kind: "detail", id: "run-42" });
  });

  it("exposes the Creative brief-and-launch front half only with write authority", () => {
    const writable = renderToStaticMarkup(<CreativeRunWorkspace permissions={{ read: true, write: true, review: true, place: true }} view={{ kind: "list" }} />);
    const readOnly = renderToStaticMarkup(<CreativeRunWorkspace permissions={{ read: true, write: false, review: false, place: false }} view={{ kind: "list" }} />);
    expect(writable).toContain("Create images");
    expect(writable).toContain("Open Character Asset Studio");
    expect(writable).toContain("Creative brief");
    expect(writable).toContain("Create and launch");
    expect(writable).not.toContain("active profile key");
    expect(writable).not.toContain(">Target ID<");
    expect(readOnly).not.toContain("Create and launch");
  });

  it("renders Character-first search controls while Character data is loading", () => {
    const html = renderToStaticMarkup(<CharacterWorkspace actorId="test-admin" permissions={{ read: true, writeProject: true, proposeRelease: true, publishRelease: true, reviewRelease: true, writeVisual: true, evaluateRoute: true, readAssets: true, createAssets: true, reviewAssets: true, manageVoiceDefaults: true }} view={{ kind: "list" }} />);
    expect(html).toContain("Characters");
    expect(html).not.toContain("Portfolio &amp; Projects");
    expect(html).toContain("Search characters");
    expect(html).not.toContain("Search authority");
    expect(html).toContain("Search name or character ID");
    expect(html).toContain("Character stage");
    expect(html).not.toContain("Project phase");
    expect(html).toContain("Serving state");
    expect(html).toContain("Readiness");
    expect(html).toContain('href="/admin/characters/new"');
    expect(html).toContain("Create Character");
    expect(html).toContain("Loading characters");
    expect(html).not.toContain("Loading release-attributed portfolio");
  });

  it("renders the analyst Character Performance route without granting Project access", () => {
    const html = renderToStaticMarkup(
      <CharacterPerformanceWorkspace canOpenProjects={false} canRead={true} />,
    );
    expect(html).toContain("Character Performance");
    expect(html).toContain("Loading release-attributed portfolio");
    expect(html).not.toContain("No permission");
    expect(html).not.toContain("Create Character");
  });

  it("marks QA stale when any pinned Character asset authority changes", () => {
    const run = {
      status: "passed",
      characterId: "character-1",
      projectId: "project-1",
      projectVersion: 7,
      characterContentVersionId: "content-7",
      visualProfileId: "visual-2",
      visualProfileVersion: 2,
      visualProfileHash: "visual-hash",
      referenceSetRevisionId: "refs-4",
      referenceSetRevision: 4,
      referenceSetHash: "reference-hash",
      draftAssetPackHash: "asset-pack-hash",
    } as const;
    const current = {
      character: { id: "character-1" },
      project: { id: "project-1", version: 7, draftAssetPackHash: "asset-pack-hash" },
      preview: { draft: { contentVersionId: "content-7" } },
      visual: {
        activeIdentity: { id: "visual-2", version: 2, immutableHash: "visual-hash" },
        activeReferenceSet: { id: "refs-4", revision: 4, snapshotHash: "reference-hash" },
      },
    } as const;

    expect(qaRunMatchesCurrentWorkspaceAuthority(run, current)).toBe(true);
    expect(qaRunMatchesCurrentWorkspaceAuthority(run, {
      ...current,
      project: { ...current.project, draftAssetPackHash: "new-asset-pack" },
    })).toBe(false);
    expect(qaRunMatchesCurrentWorkspaceAuthority(run, {
      ...current,
      visual: {
        ...current.visual,
        activeReferenceSet: { ...current.visual.activeReferenceSet, revision: 5 },
      },
    })).toBe(false);
  });
});
