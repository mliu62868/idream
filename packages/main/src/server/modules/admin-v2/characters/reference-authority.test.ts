import { describe, expect, it } from "vitest";
import { characterReferenceAuthorityFrom } from "./reference-authority";

function referenceSet(references: { mediaAssetId: string; role: string }[]) {
  return { id: "revision-1", revision: 3, references };
}

describe("character reference authority", () => {
  it("returns null when the character has no active reference set", () => {
    expect(characterReferenceAuthorityFrom(null)).toBeNull();
  });

  it("keeps references in the order the revision pinned them", () => {
    expect(characterReferenceAuthorityFrom(referenceSet([
      { mediaAssetId: "asset-a", role: "primary_face" },
      { mediaAssetId: "asset-b", role: "identity_reference" },
      { mediaAssetId: "asset-c", role: "identity_anchor" },
    ]))).toMatchObject({
      revisionId: "revision-1",
      revision: 3,
      refs: ["asset-a", "asset-b", "asset-c"],
    });
  });

  it("derives anchors from role, matching the paid generation path", () => {
    expect(characterReferenceAuthorityFrom(referenceSet([
      { mediaAssetId: "asset-a", role: "primary_face" },
      { mediaAssetId: "asset-b", role: "identity_reference" },
      { mediaAssetId: "asset-c", role: "identity_anchor" },
    ]))?.anchors).toEqual(["asset-a", "asset-c"]);
  });

  it("treats identity_reference as a reference but never an anchor", () => {
    const authority = characterReferenceAuthorityFrom(referenceSet([
      { mediaAssetId: "asset-b", role: "identity_reference" },
    ]));
    expect(authority?.refs).toEqual(["asset-b"]);
    expect(authority?.anchors).toEqual([]);
  });

  it("reports an empty authority for a revision with no references", () => {
    expect(characterReferenceAuthorityFrom(referenceSet([]))).toMatchObject({
      refs: [],
      anchors: [],
    });
  });
});
