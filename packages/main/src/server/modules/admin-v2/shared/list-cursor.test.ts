import { describe, expect, it } from "vitest";
import { decodeAdminListCursor, encodeAdminListCursor, parseIsoCursorKey } from "./list-cursor";

describe("Admin list cursor", () => {
  it("round trips compound keys only for the exact query identity", () => {
    const cursor = encodeAdminListCursor("assets", { search: "portrait", status: "approved" }, [
      "2026-07-11T12:00:00.000Z",
      "asset-1",
    ]);
    expect(decodeAdminListCursor(cursor, "assets", { search: "portrait", status: "approved" })).toEqual([
      "2026-07-11T12:00:00.000Z",
      "asset-1",
    ]);
    expect(() => decodeAdminListCursor(cursor, "assets", { search: "different", status: "approved" })).toThrow(/invalid/);
    expect(() => decodeAdminListCursor(cursor, "placements", { search: "portrait", status: "approved" })).toThrow(/invalid/);
  });

  it("rejects malformed encodings and invalid timestamp keys", () => {
    expect(() => decodeAdminListCursor("not-a-cursor", "assets", {})).toThrow(/invalid/);
    expect(() => parseIsoCursorKey("not-a-date", "assets")).toThrow(/timestamp/);
  });
});
