import { describe, expect, it } from "vitest";
import { presetPayload } from "./presets-api";

describe("presetPayload", () => {
  it("parses legal JSON controls and trims label/category", () => {
    expect(
      presetPayload({
        type: "background",
        category: " Studio ",
        label: " Neon city ",
        controlsJson: '{"strength": 0.8, "tag": "neon"}',
        visibility: "public",
      }),
    ).toEqual({
      type: "background",
      label: "Neon city",
      category: "Studio",
      controls: { strength: 0.8, tag: "neon" },
      visibility: "public",
    });
  });

  it("treats a blank controlsJson as an empty object and drops a blank category", () => {
    expect(
      presetPayload({
        type: "pose",
        category: "   ",
        label: "Standing",
        controlsJson: "   ",
        visibility: "private",
      }),
    ).toEqual({
      type: "pose",
      label: "Standing",
      category: undefined,
      controls: {},
      visibility: "private",
    });
  });

  it("throws when controlsJson parses to a non-object (array/primitive)", () => {
    expect(() =>
      presetPayload({
        type: "outfit",
        category: "",
        label: "Casual",
        controlsJson: "[1, 2, 3]",
        visibility: "unlisted",
      }),
    ).toThrow();

    expect(() =>
      presetPayload({
        type: "outfit",
        category: "",
        label: "Casual",
        controlsJson: '"just a string"',
        visibility: "unlisted",
      }),
    ).toThrow();
  });
});
