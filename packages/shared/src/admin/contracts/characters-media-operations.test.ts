import { describe, expect, it } from "vitest";
import {
  characterMediaOperationsProjectionSchema,
  characterVoiceClipReclaimRequestSchema,
} from "./characters-media-operations";

describe("Character media operations projection contract", () => {
  it("represents a Character with no media runs as three explicit unavailable rows", () => {
    const operation = (modality: "image" | "video" | "voice", tab: string) => ({
      modality,
      requestId: null,
      status: null,
      attempt: null,
      provider: null,
      timing: null,
      costDreamcoins: null,
      output: null,
      recoverability: {
        state: "unavailable",
        reason: "No operation evidence exists for this Character.",
      },
      studioHref: `/admin/characters/character-1?tab=${tab}`,
      operationsHref: null,
    });

    const projection = characterMediaOperationsProjectionSchema.parse({
      projectionVersion: 1,
      asOf: "2026-08-02T03:00:00.000Z",
      operations: [
        operation("image", "assets"),
        operation("video", "video"),
        operation("voice", "voice"),
      ],
    });

    expect(projection.operations.map((row) => [row.modality, row.status]))
      .toEqual([
        ["image", null],
        ["video", null],
        ["voice", null],
      ]);
  });

  it("rejects invented request facts when no request evidence exists", () => {
    const empty = (modality: "image" | "video" | "voice", tab: string) => ({
      modality,
      requestId: null,
      status: null,
      attempt: null,
      provider: null,
      timing: null,
      costDreamcoins: null,
      output: null,
      recoverability: {
        state: "unavailable",
        reason: "No operation evidence exists for this Character.",
      },
      studioHref: `/admin/characters/character-1?tab=${tab}`,
      operationsHref: null,
    });
    const image = {
      ...empty("image", "assets"),
      costDreamcoins: 0,
    };

    expect(characterMediaOperationsProjectionSchema.safeParse({
      projectionVersion: 1,
      asOf: "2026-08-02T03:00:00.000Z",
      operations: [
        image,
        empty("video", "video"),
        empty("voice", "voice"),
      ],
    }).success).toBe(false);
  });

  it("binds a Voice reclaim confirmation to the exact durable request", () => {
    const requestId = "voice-request-1";
    expect(characterVoiceClipReclaimRequestSchema.parse({
      requestId,
      confirmation: `RECLAIM VOICE ${requestId}`,
      reason: "Recover the expired worker lease",
    })).toMatchObject({ requestId });
    expect(characterVoiceClipReclaimRequestSchema.safeParse({
      requestId,
      confirmation: "RECLAIM VOICE another-request",
      reason: "Recover the expired worker lease",
    }).success).toBe(false);
  });
});
