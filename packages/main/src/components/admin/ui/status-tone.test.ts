import { describe, expect, it } from "vitest";
import { statusTone } from "./status-tone";

describe("statusTone", () => {
  it("maps live/positive states to success", () => {
    for (const s of ["approved", "active", "published", "succeeded", "ready"]) {
      expect(statusTone(s)).toBe("success");
    }
  });
  it("maps waiting states to pending", () => {
    for (const s of ["draft", "pending", "in_review", "queued", "paused"]) {
      expect(statusTone(s)).toBe("pending");
    }
  });
  it("maps real failures to danger — red is reserved for errors", () => {
    for (const s of ["failed", "rejected", "removed", "blocked"]) {
      expect(statusTone(s)).toBe("danger");
    }
  });
  it("maps in-flight states to info", () => {
    for (const s of ["running", "processing", "generating"]) {
      expect(statusTone(s)).toBe("info");
    }
  });
  it("is case-insensitive and defaults to neutral", () => {
    expect(statusTone("APPROVED")).toBe("success");
    expect(statusTone("archived")).toBe("neutral");
    expect(statusTone("whatever")).toBe("neutral");
  });
});
