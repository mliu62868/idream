import { afterEach, describe, expect, it, vi } from "vitest";
import { contentAssetPatchRequestSchema } from "@idream/shared/admin";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import {
  assetArchiveBlocker,
  assetAuthorityDependencyView,
  assetBulkArchivePayload,
  assetPatchPayload,
  assetsListPath,
  bulkArchiveAssets,
  canonicalAssetIds,
  draftFromAsset,
  preflightArchiveAssets,
  splitTags,
  type AssetAuthorityDependency,
  type ContentAsset,
} from "./assets-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assetsListPath", () => {
  it("returns the bare endpoint when no filters (or 'all') are given", () => {
    expect(assetsListPath()).toBe("/api/v2/admin/assets");
    expect(assetsListPath({ status: "all", purpose: "all" })).toBe("/api/v2/admin/assets");
  });

  it("appends status and purpose as query params", () => {
    expect(assetsListPath({ status: "approved" })).toBe("/api/v2/admin/assets?status=approved");
    expect(assetsListPath({ status: "approved", purpose: "feed" })).toBe(
      "/api/v2/admin/assets?status=approved&purpose=feed",
    );
  });
});

describe("splitTags", () => {
  it("trims and drops blank entries", () => {
    expect(splitTags(" neon ,  , city, ")).toEqual(["neon", "city"]);
  });

  it("returns an empty array for a blank string", () => {
    expect(splitTags("   ")).toEqual([]);
  });
});

describe("draftFromAsset", () => {
  it("joins tags and falls back to an empty description", () => {
    const asset = { tags: ["neon", "city"], description: null } as ContentAsset;
    expect(draftFromAsset(asset)).toEqual({ tags: "neon, city", description: "" });
  });
});

describe("assetAuthorityDependencyView", () => {
  it("names every backend authority kind without falling through to Campaign", () => {
    const dependencies: AssetAuthorityDependency[] = [
      {
        kind: "character_primary_image",
        characterId: "character-1",
        repairPath: "/character",
      },
      {
        kind: "character_project_draft",
        characterId: "character-1",
        projectId: "project-1",
        repairPath: "/project",
      },
      {
        kind: "character_visual_identity",
        characterId: "character-1",
        visualProfileId: "profile-1",
        repairPath: "/visual",
      },
      {
        kind: "character_reference_set",
        characterId: "character-1",
        visualProfileId: "profile-1",
        referenceSetRevisionId: "reference-set-1",
        repairPath: "/references",
      },
      {
        kind: "character_generation_job",
        characterId: "character-1",
        generationJobId: "job-1",
        runId: "run-1",
        repairPath: "/job",
      },
      {
        kind: "character_look",
        characterId: "character-1",
        lookId: "look-1",
        status: "active",
        repairPath: "/look",
      },
      {
        kind: "creative_run_asset",
        characterId: "character-1",
        itemId: "item-1",
        runId: "run-1",
        status: "generated",
        repairPath: "/run",
      },
      {
        kind: "character_release",
        characterId: "character-1",
        releaseId: "release-1",
        releaseState: "scheduled",
        slot: "hero",
        repairPath: "/release",
      },
      {
        kind: "verified_campaign",
        placementId: "placement-1",
        runId: "run-1",
        targetId: "campaign-1",
        repairPath: "/campaign",
      },
      {
        kind: "placement_verification",
        placementId: "placement-2",
        runId: "run-1",
        targetId: "campaign-2",
        repairPath: "/placement",
      },
    ];

    expect(dependencies.map(assetAuthorityDependencyView)).toEqual([
      expect.objectContaining({ title: "Character primary image", detail: "character-1" }),
      expect.objectContaining({ title: "Character project draft", detail: "character-1 · project-1" }),
      expect.objectContaining({ title: "Active visual identity", detail: "character-1 · profile-1" }),
      expect.objectContaining({ title: "Published character reference set", detail: "character-1 · reference-set-1" }),
      expect.objectContaining({ title: "Active character generation job", detail: "character-1 · job-1" }),
      expect.objectContaining({ title: "Active character look", detail: "active · character-1 · look-1" }),
      expect.objectContaining({ title: "Creative Run asset in use", detail: "generated · run-1 · item-1" }),
      expect.objectContaining({ title: "Scheduled Character Release", detail: "hero · release-1" }),
      expect.objectContaining({ title: "Verified live campaign", detail: "campaign-1 · placement-1" }),
      expect.objectContaining({ title: "Campaign verification in progress", detail: "campaign-2 · placement-2" }),
    ]);
  });
});

describe("bulk archive transport authority", () => {
  it.each(["archive", "preflight"])("preserves the authority status, code and request ID for a failed %s", async (operation) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: false,
      error: {
        code: "admin_upstream_unavailable",
        message: "Admin authority is temporarily unavailable",
        requestId: "bulk-upstream-request",
      },
    }, { status: 503 })));
    const failure = await (operation === "archive"
      ? bulkArchiveAssets({ assetIds: ["asset-upstream"], reason: "Retire unused upload" })
      : preflightArchiveAssets(["asset-upstream"])).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AdminV2RequestError);
    expect(failure).toMatchObject({
      status: 503,
      code: "admin_upstream_unavailable",
      requestId: "bulk-upstream-request",
    });
  });

  it("preserves a shared comic publication dependency in a rejected archive", async () => {
    const dependency: AssetAuthorityDependency = {
      kind: "comic_publication",
      comicId: "comic-active",
      repairPath: "/admin/moderation?tab=comics",
    };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: false,
      error: {
        code: "conflict",
        message: "Asset remains in use",
        details: { code: "asset_authority_dependency_active", assetId: "comic-asset", dependencies: [dependency] },
      },
    }, { status: 409 })));
    const failure = await bulkArchiveAssets({ assetIds: ["comic-asset"], reason: "Retire old upload" })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ details: { dependencies: [dependency] } });
  });
});

describe("assetPatchPayload", () => {
  it("preserves an explicit cleared description through JSON and the shared PATCH contract", () => {
    const payload = assetPatchPayload({
      id: "asset-123",
      draft: { tags: "neon", description: "  \n\t " },
      reason: "Remove outdated search description",
    });
    const body = contentAssetPatchRequestSchema.parse(
      JSON.parse(JSON.stringify(payload)),
    );
    expect(body).toMatchObject({ description: "", tags: ["neon"] });
    expect(body).not.toHaveProperty("status");
    // Omission remains a partial update; clearing is represented only by an explicit empty string.
    expect(contentAssetPatchRequestSchema.parse({
      reason: "Keep existing description",
      confirmation: "asset-123",
    })).not.toHaveProperty("description");
  });

  it("only exposes the Library archive state mutation and trims blank description", () => {
    expect(
      assetPatchPayload({
        id: "asset-123",
        draft: { tags: "neon, city", description: "  " },
        reason: "Archive unused asset",
        status: "archived",
      }),
    ).toEqual({
      status: "archived",
      reason: "Archive unused asset",
      confirmation: "asset-123",
    });
  });

  it("omits status when not provided (metadata-only save)", () => {
    expect(
      assetPatchPayload({
        id: "asset-123",
        draft: { tags: "", description: "Chat reuse note" },
        reason: "Updated search metadata",
      }),
    ).toEqual({
      status: undefined,
      tags: [],
      description: "Chat reuse note",
      reason: "Updated search metadata",
      confirmation: "asset-123",
    });
  });
});

describe("bulk asset archival", () => {
  it("canonicalizes the exact target list before building the confirmation", () => {
    expect(canonicalAssetIds([" asset-b ", "asset-a", "asset-b", ""])).toEqual([
      "asset-a",
      "asset-b",
    ]);
    expect(assetBulkArchivePayload({
      assetIds: ["asset-b", "asset-a", "asset-b"],
      reason: "  retire unused set  ",
    })).toEqual({
      assetIds: ["asset-a", "asset-b"],
      status: "archived",
      reason: "retire unused set",
      confirmation: "asset-a,asset-b",
    });
  });

  it("sends one atomic POST with exact IDs and returns every updated target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: { updatedIds: ["asset-a", "asset-b"] },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(bulkArchiveAssets({
      assetIds: ["asset-b", "asset-a"],
      reason: "Archive unused set",
    })).resolves.toEqual({ updatedIds: ["asset-a", "asset-b"] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v2/admin/assets/bulk", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        assetIds: ["asset-a", "asset-b"],
        status: "archived",
        reason: "Archive unused set",
        confirmation: "asset-a,asset-b",
      }),
    }));
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toEqual(expect.any(String));
    expect(headers.get("x-request-id")).toEqual(expect.any(String));
  });

  it("reuses the original bulk key when a 200 response body is interrupted, and settles only the readable replay", async () => {
    const interruptedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":true,"data":'));
        controller.error(new DOMException("Response body interrupted after headers", "AbortError"));
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(interruptedBody, { status: 200 }))
      .mockImplementation(async () => Response.json({ ok: true, data: { updatedIds: ["body-loss-asset"] } }));
    vi.stubGlobal("fetch", fetchMock);
    const intent = { assetIds: ["body-loss-asset"], reason: "Retire body-loss audit upload" };

    await expect(bulkArchiveAssets(intent)).rejects.toMatchObject({
      outcome: "unknown",
      details: { cause: "Response body interrupted after headers" },
    });
    await expect(bulkArchiveAssets(intent)).resolves.toEqual({ updatedIds: ["body-loss-asset"] });
    const firstKey = new Headers(fetchMock.mock.calls[0][1]?.headers).get("idempotency-key");
    expect(firstKey).toBeTruthy();
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("idempotency-key")).toBe(firstKey);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);

    await bulkArchiveAssets(intent);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("idempotency-key")).not.toBe(firstKey);
  });

  it.each(["truncated JSON", "invalid receipt"])("retains the original bulk key when a 200 answer contains %s", async (failure) => {
    const assetId = failure === "truncated JSON" ? "truncated-receipt-asset" : "invalid-receipt-asset";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(failure === "truncated JSON"
        ? new Response('{"ok":true,"data":', { status: 200 })
        : Response.json({ ok: true, data: { updatedIds: assetId } }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { updatedIds: [assetId] } }));
    vi.stubGlobal("fetch", fetchMock);
    const intent = { assetIds: [assetId], reason: "Verify the unreadable receipt before completing" };

    await expect(bulkArchiveAssets(intent)).rejects.toThrow();
    await expect(bulkArchiveAssets(intent)).resolves.toEqual({ updatedIds: [assetId] });
    const firstKey = new Headers(fetchMock.mock.calls[0][1]?.headers).get("idempotency-key");
    expect(firstKey).toBeTruthy();
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("idempotency-key")).toBe(firstKey);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
  });

  it.each([503, 409])("keeps the existing unknown-versus-answered key contract for a readable %s rejection", async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, error: {
        code: status === 503 ? "unavailable" : "conflict", message: "Archive rejected",
      } }, { status }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { updatedIds: [`readable-${status}-asset`] } }));
    vi.stubGlobal("fetch", fetchMock);
    const intent = { assetIds: [`readable-${status}-asset`], reason: "Verify readable rejection semantics" };
    await expect(bulkArchiveAssets(intent)).rejects.toThrow("Archive rejected");
    await bulkArchiveAssets(intent);
    const firstKey = new Headers(fetchMock.mock.calls[0][1]?.headers).get("idempotency-key");
    const retryKey = new Headers(fetchMock.mock.calls[1][1]?.headers).get("idempotency-key");
    expect(firstKey).toBeTruthy();
    if (status === 503) expect(retryKey).toBe(firstKey);
    else expect(retryKey).not.toBe(firstKey);
  });

  it("preflights every canonical target in one POST and preserves exact blocker IDs", async () => {
    const dependency: AssetAuthorityDependency = {
      kind: "character_primary_image",
      characterId: "character-1",
      repairPath: "/admin/characters/character-1?tab=assets",
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: {
        assetIds: ["asset-a", "asset-b"],
        blockers: [{ assetId: "asset-b", dependencies: [dependency] }],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      preflightArchiveAssets(["asset-b", "asset-a", "asset-b"]),
    ).resolves.toEqual({
      assetIds: ["asset-a", "asset-b"],
      blockers: [{ assetId: "asset-b", dependencies: [dependency] }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v2/admin/assets/bulk/preflight", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ assetIds: ["asset-a", "asset-b"] }),
    }));
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBeNull();
    expect(headers.get("x-request-id")).toEqual(expect.any(String));
  });

  it("preserves structured authority dependencies for repair links", async () => {
    const dependency: AssetAuthorityDependency = {
      kind: "character_release",
      characterId: "character-1",
      releaseId: "release-1",
      releaseState: "current",
      slot: "portrait",
      repairPath: "/admin/characters/character-1?tab=release",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      ok: false,
      error: {
        code: "conflict",
        message: "Asset remains in use",
        details: {
          code: "asset_authority_dependency_active",
          dependencies: [dependency],
          repairPath: dependency.repairPath,
        },
      },
    }, { status: 409 })));

    const error = await bulkArchiveAssets({
      assetIds: ["asset-a"],
      reason: "Archive stale image",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdminV2RequestError);
    expect(error).toMatchObject({
      message: "Asset remains in use",
      details: {
        code: "asset_authority_dependency_active",
        dependencies: [dependency],
        repairPath: dependency.repairPath,
      },
    });
    expect(assetArchiveBlocker(error)).toEqual({
      kind: "dependency",
      dependencies: [dependency],
      repairPath: dependency.repairPath,
    });
  });
});
