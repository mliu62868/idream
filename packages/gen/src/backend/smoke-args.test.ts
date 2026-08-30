import { describe, expect, it } from "vitest";
import {
  resolveSmokeGenerationOverrides,
  resolveSmokeReferences,
  resolveSmokeWorkflowPin,
} from "./smoke-args";

describe("backend smoke workflow pin", () => {
  const descriptors = [
    {
      modelId: "qwen-image-edit",
      workflowKey: "qwen-image-edit-img2img",
      version: 1,
    },
  ];

  it("pins the exact descriptor selected by model id", () => {
    expect(
      resolveSmokeWorkflowPin(descriptors, "qwen-image-edit"),
    ).toEqual({
      modelId: "qwen-image-edit",
      workflowKey: "qwen-image-edit-img2img",
      workflowVersion: 1,
    });
  });

  it("fails before generation when no descriptor matches", () => {
    expect(() => resolveSmokeWorkflowPin(descriptors, "missing-model"))
      .toThrow("no workflow descriptor found for --model missing-model");
  });
});

describe("backend smoke generation arguments", () => {
  it("parses an explicit seed and positive integer step override", () => {
    expect(
      resolveSmokeGenerationOverrides([
        "--seed",
        "486071801727172",
        "--steps=12",
        "--ref-boost=2",
        "--grounding-px",
        "512",
      ]),
    ).toEqual({
      seed: "486071801727172",
      steps: 12,
      refBoost: 2,
      groundingPx: 512,
    });
  });

  it.each(["0", "-1", "1.5", "abc"])(
    "rejects invalid --steps=%s",
    (steps) => {
      expect(() =>
        resolveSmokeGenerationOverrides([`--steps=${steps}`]),
      ).toThrow("--steps must be a positive integer");
    },
  );

  it.each([
    ["--ref-boost", "-1"],
    ["--ref-boost", "abc"],
    ["--grounding-px", "-1"],
    ["--grounding-px", "1.5"],
  ])("rejects invalid %s=%s", (flag, value) => {
    expect(() => resolveSmokeGenerationOverrides([flag, value])).toThrow();
  });
});

describe("backend smoke reference arguments", () => {
  it("keeps the single-reference command backward compatible as source_image", () => {
    expect(resolveSmokeReferences(["--ref", "/tmp/source.jpg"])).toEqual([
      { path: "/tmp/source.jpg", role: "source_image" },
    ]);
  });

  it("pairs repeated references with explicit semantic roles", () => {
    expect(resolveSmokeReferences([
      "--ref",
      "/tmp/identity.jpg",
      "--ref=/tmp/source.png",
      "--ref-role",
      "identity_anchor",
      "--ref-role=source_image",
    ])).toEqual([
      { path: "/tmp/identity.jpg", role: "identity_anchor" },
      { path: "/tmp/source.png", role: "source_image" },
    ]);
  });

  it("requires explicit roles when more than one reference is supplied", () => {
    expect(() => resolveSmokeReferences([
      "--ref",
      "/tmp/one.jpg",
      "--ref",
      "/tmp/two.jpg",
    ])).toThrow("one --ref-role per reference");
  });

  it("rejects incomplete or unsupported role assignments", () => {
    expect(() => resolveSmokeReferences([
      "--ref",
      "/tmp/one.jpg",
      "--ref",
      "/tmp/two.jpg",
      "--ref-role",
      "identity_anchor",
    ])).toThrow("one --ref-role per reference");

    expect(() => resolveSmokeReferences([
      "--ref",
      "/tmp/one.jpg",
      "--ref-role",
      "portrait",
    ])).toThrow("unsupported --ref-role portrait");
  });

  it("rejects flags without values", () => {
    expect(() => resolveSmokeReferences(["--ref"])).toThrow("--ref requires a value");
    expect(() => resolveSmokeReferences(["--ref-role"])).toThrow("--ref-role requires a value");
  });
});
