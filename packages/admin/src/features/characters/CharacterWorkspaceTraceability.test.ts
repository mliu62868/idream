import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  characterMonitorWindows,
  latestQaRunForCurrentWorkspaceAuthority,
  qaRunMatchesCurrentWorkspaceAuthority,
  releasableQaRunForCurrentWorkspaceAuthority,
} from "./CharacterWorkspace";

const currentAuthority = {
  character: { id: "character-1" },
  project: {
    id: "project-1",
    version: 7,
    draftAssetPackHash: "asset-pack-hash",
  },
  preview: {
    draft: { contentVersionId: "content-version-3" },
  },
  visual: {
    activeIdentity: {
      id: "identity-2",
      version: 2,
      immutableHash: "identity-hash",
    },
    activeReferenceSet: {
      id: "reference-set-4",
      revision: 4,
      snapshotHash: "reference-hash",
    },
  },
} as const;

const qaRun = {
  status: "passed",
  characterId: "character-1",
  projectId: "project-1",
  projectVersion: 7,
  characterContentVersionId: "content-version-3",
  visualProfileId: "identity-2",
  visualProfileVersion: 2,
  visualProfileHash: "identity-hash",
  referenceSetRevisionId: "reference-set-4",
  referenceSetRevision: 4,
  referenceSetHash: "reference-hash",
  draftAssetPackHash: "asset-pack-hash",
} as const;

describe("Character workspace traceability", () => {
  it("matches QA only when every current authority pin matches", () => {
    expect(qaRunMatchesCurrentWorkspaceAuthority(qaRun, currentAuthority)).toBe(true);
    expect(qaRunMatchesCurrentWorkspaceAuthority(
      { ...qaRun, status: "failed" },
      currentAuthority,
    )).toBe(false);
    const authorityDrifts: ReadonlyArray<{
      readonly pin: string;
      readonly run: Parameters<typeof qaRunMatchesCurrentWorkspaceAuthority>[0];
    }> = [
      { pin: "characterId", run: { ...qaRun, characterId: "character-2" } },
      { pin: "projectId", run: { ...qaRun, projectId: "project-2" } },
      { pin: "projectVersion", run: { ...qaRun, projectVersion: 6 } },
      {
        pin: "characterContentVersionId",
        run: { ...qaRun, characterContentVersionId: "content-version-2" },
      },
      { pin: "visualProfileId", run: { ...qaRun, visualProfileId: "identity-1" } },
      { pin: "visualProfileVersion", run: { ...qaRun, visualProfileVersion: 1 } },
      {
        pin: "visualProfileHash",
        run: { ...qaRun, visualProfileHash: "older-identity-hash" },
      },
      {
        pin: "referenceSetRevisionId",
        run: { ...qaRun, referenceSetRevisionId: "reference-set-3" },
      },
      { pin: "referenceSetRevision", run: { ...qaRun, referenceSetRevision: 3 } },
      {
        pin: "referenceSetHash",
        run: { ...qaRun, referenceSetHash: "older-reference-hash" },
      },
      {
        pin: "draftAssetPackHash",
        run: { ...qaRun, draftAssetPackHash: "older-pack-hash" },
      },
    ];
    for (const drift of authorityDrifts) {
      expect(
        qaRunMatchesCurrentWorkspaceAuthority(drift.run, currentAuthority),
        drift.pin,
      ).toBe(false);
    }
  });

  it("selects only the newest QA authority, including a revoking failure", () => {
    const firstPass = {
      ...qaRun,
      id: "qa-pass-1",
      createdAt: "2026-07-16T10:00:00.000Z",
    };
    const laterFailure = {
      ...qaRun,
      id: "qa-fail-2",
      status: "failed" as const,
      createdAt: "2026-07-16T10:01:00.000Z",
    };

    expect(latestQaRunForCurrentWorkspaceAuthority(
      [firstPass, laterFailure],
      currentAuthority,
    )).toBe(laterFailure);
    expect(releasableQaRunForCurrentWorkspaceAuthority(
      [firstPass, laterFailure],
      currentAuthority,
    )).toBeNull();

    const recoveredPass = {
      ...qaRun,
      id: "qa-pass-3",
      createdAt: "2026-07-16T10:02:00.000Z",
    };
    expect(latestQaRunForCurrentWorkspaceAuthority(
      [firstPass, laterFailure, recoveredPass],
      currentAuthority,
    )).toBe(recoveredPass);
    expect(releasableQaRunForCurrentWorkspaceAuthority(
      [firstPass, laterFailure, recoveredPass],
      currentAuthority,
    )).toBe(recoveredPass);
  });

  it("revokes the apparent current QA authority as soon as the draft pack route is stale", () => {
    const priorPass = {
      ...qaRun,
      id: "qa-pass-under-q1",
      createdAt: "2026-07-16T10:00:00.000Z",
    };
    const staleRouteAuthority = {
      ...currentAuthority,
      project: {
        ...currentAuthority.project,
        draftAssetRouteAuthority: { status: "stale" as const, qaReady: false },
      },
    };
    expect(qaRunMatchesCurrentWorkspaceAuthority(priorPass, staleRouteAuthority))
      .toBe(false);
    expect(latestQaRunForCurrentWorkspaceAuthority(
      [priorPass],
      staleRouteAuthority,
    )).toBeNull();
    expect(releasableQaRunForCurrentWorkspaceAuthority(
      [priorPass],
      staleRouteAuthority,
    )).toBeNull();
  });

  it("does not treat a route-current but incomplete asset pack as QA authority", () => {
    const priorPass = {
      ...qaRun,
      id: "qa-pass-before-pack-completion",
      createdAt: "2026-07-16T10:00:00.000Z",
    };
    const incompletePackAuthority = {
      ...currentAuthority,
      project: {
        ...currentAuthority.project,
        draftAssetRouteAuthority: {
          status: "current" as const,
          qaReady: false,
        },
      },
    };

    expect(qaRunMatchesCurrentWorkspaceAuthority(
      priorPass,
      incompletePackAuthority,
    )).toBe(false);
    expect(latestQaRunForCurrentWorkspaceAuthority(
      [priorPass],
      incompletePackAuthority,
    )).toBeNull();
    expect(releasableQaRunForCurrentWorkspaceAuthority(
      [priorPass],
      incompletePackAuthority,
    )).toBeNull();
  });

  it("revokes QA authority when any exact preview asset is missing or unavailable", () => {
    const priorPass = {
      ...qaRun,
      id: "qa-pass-before-media-drift",
      createdAt: "2026-07-16T10:00:00.000Z",
    };
    const unavailablePackAuthority = {
      ...currentAuthority,
      project: {
        ...currentAuthority.project,
        draftAssetRouteAuthority: {
          status: "current" as const,
          qaReady: true,
        },
      },
      preview: {
        draft: {
          ...currentAuthority.preview.draft,
          assetPackReady: false,
        },
      },
    };

    expect(qaRunMatchesCurrentWorkspaceAuthority(
      priorPass,
      unavailablePackAuthority,
    )).toBe(false);
    expect(latestQaRunForCurrentWorkspaceAuthority(
      [priorPass],
      unavailablePackAuthority,
    )).toBeNull();
    expect(releasableQaRunForCurrentWorkspaceAuthority(
      [priorPass],
      unavailablePackAuthority,
    )).toBeNull();
  });

  it("projects required and persisted monitor windows without duplicates", () => {
    expect(characterMonitorWindows([
      { window: "route_qualification" },
      { window: "24h" },
      { window: "7d" },
      { window: "7d" },
    ])).toEqual([
      "route_qualification",
      "24h",
      "72h",
      "7d",
    ]);
  });

  it("renders immutable QA evidence, repair links, and pinned release lineage", () => {
    const source = readFileSync(new URL("./CharacterWorkspace.tsx", import.meta.url), "utf8");

    expect(source).toContain('<option value="">Not run</option>');
    expect(source).toContain("Checks, evidence, and repair paths");
    expect(source).toContain("check.comment");
    expect(source).toContain("check.evidenceRef");
    expect(source).toContain("check.fixDeepLink");
    expect(source).toContain("Pinned assets, generation, and review lineage");
    expect(source).toContain("releasePlacementManifest: release.releasePlacementManifest");
    expect(source).toContain("generationProvenance: release.generationProvenance");
    expect(source).toContain("activeReleaseCandidate");
    expect(source).toContain(
      "Request changes to withdraw it before recording another QA Run.",
    );
    expect(source).toContain("Regenerate under current route");
    expect(source).toContain("Complete Character Assets");
  });

  it("keeps route qualification empty state semantically distinct from pending time windows", () => {
    const source = readFileSync(new URL("./CharacterWorkspace.tsx", import.meta.url), "utf8");

    expect(source).toContain('window === "route_qualification" ? "not_required" : "pending"');
    expect(source).toContain("No route qualification action is currently required.");
    expect(source).toContain("Open route qualification");
  });
});
