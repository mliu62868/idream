import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  characterMediaOperationsProjectionSchema,
  type CharacterMediaOperationsProjection,
} from "@idream/shared/admin";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import {
  CharacterMediaOperationsCard,
  shouldReleaseVoiceReclaimIdempotencyKey,
} from "./CharacterWorkspace";

function operation(
  modality: "image" | "video" | "voice",
  tab: "assets" | "video" | "voice",
  overrides: Record<string, unknown> = {},
) {
  return {
    modality,
    requestId: `${modality}-request-1`,
    status: "succeeded",
    attempt: {
      id: modality === "voice" ? null : `${modality}-attempt-1`,
      number: 1,
      status: "succeeded",
      errorCode: null,
      retryability: null,
      operatorGuidance: null,
    },
    provider: { key: `${modality}-provider`, requestId: null },
    timing: {
      requestedAt: "2026-08-02T03:00:00.000Z",
      startedAt: "2026-08-02T03:00:01.000Z",
      finishedAt: "2026-08-02T03:00:09.000Z",
      latencyMs: 8_000,
    },
    costDreamcoins: 12,
    output: {
      mediaAssetId: `${modality}-asset-1`,
      availability: "available",
      url: `/media/${modality}-asset-1`,
      createdAt: "2026-08-02T03:00:09.000Z",
      durationMs: modality === "image" ? null : 4_000,
    },
    recoverability: { state: "not_needed", reason: null },
    studioHref: `/admin/characters/character-1?tab=${tab}`,
    operationsHref: modality === "voice"
      ? null
      : `/admin/ops/jobs?job=${modality}-request-1`,
    ...overrides,
  };
}

const projection = characterMediaOperationsProjectionSchema.parse({
  projectionVersion: 1,
  asOf: "2026-08-02T03:10:00.000Z",
  operations: [
    operation("image", "assets", {
      status: "failed",
      recoverability: {
        state: "retryable",
        reason: "Replay the pinned image attempt.",
      },
    }),
    operation("video", "video", {
      status: "blocked",
      recoverability: {
        state: "operator_action",
        reason: "Inspect capacity before an operator retry.",
      },
    }),
    operation("voice", "voice", {
      output: {
        mediaAssetId: "voice-asset-1",
        availability: "deleted",
        url: null,
        createdAt: "2026-08-02T03:00:09.000Z",
        durationMs: 4_000,
      },
    }),
  ],
}) satisfies CharacterMediaOperationsProjection;

describe("Character media operations card", () => {
  it("renders one compact row per modality with recovery and existing destinations", () => {
    const html = renderToStaticMarkup(createElement(
      CharacterMediaOperationsCard,
      { projection },
    ));

    expect((html.match(/data-media-operation=/g) ?? [])).toHaveLength(3);
    expect(html).toContain("Image");
    expect(html).toContain("Video");
    expect(html).toContain("Voice");
    expect(html).toContain("Retry available");
    expect(html).toContain("Operator action required");
    expect(html).toContain("Deleted");
    expect(html).toContain("/admin/characters/character-1?tab=assets");
    expect(html).toContain("/admin/characters/character-1?tab=video");
    expect(html).toContain("/admin/characters/character-1?tab=voice");
    expect(html).toContain("/admin/ops/jobs?job=image-request-1");
  });

  it("states that execution, review, and publication remain separate", () => {
    const html = renderToStaticMarkup(createElement(
      CharacterMediaOperationsCard,
      { projection },
    ));

    expect(html).toContain(
      "Run completion does not approve or publish an asset.",
    );
    expect(html).toContain(
      "Review and Release remain separate decisions.",
    );
  });

  it("retains the durable key while the accepted reclaim command is in progress", () => {
    expect(
      shouldReleaseVoiceReclaimIdempotencyKey(
        new AdminV2RequestError(
          "Voice reclaim command is already in progress",
          409,
          "conflict",
          { reason: "command_in_progress" },
        ),
      ),
    ).toBe(false);
    expect(
      shouldReleaseVoiceReclaimIdempotencyKey(
        new AdminV2RequestError(
          "Voice request cannot be reclaimed",
          409,
          "conflict",
          { reason: "provider_not_durably_replayable" },
        ),
      ),
    ).toBe(true);
    expect(shouldReleaseVoiceReclaimIdempotencyKey(new TypeError("offline")))
      .toBe(false);
  });
});
