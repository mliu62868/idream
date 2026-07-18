import { describe, expect, it } from "vitest";
import { resolveSmokeReferences } from "./smoke-args";

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
