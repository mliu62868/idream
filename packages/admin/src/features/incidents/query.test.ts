import { describe, expect, it } from "vitest";
import { buildIncidentQuery } from "./query";

describe("incident workspace query", () => {
  it("serializes only server-supported filters and cursor", () => {
    expect(
      buildIncidentQuery({
        search: "timeout",
        status: "monitoring",
        severity: "high",
        ownerId: "",
        cursor: "incident_42",
        limit: 25,
      }),
    ).toBe("search=timeout&status=monitoring&severity=high&cursor=incident_42&limit=25");
  });
});
