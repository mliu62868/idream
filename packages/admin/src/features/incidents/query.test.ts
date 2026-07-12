import { describe, expect, it } from "vitest";
import { buildIncidentQuery, buildIncidentWorkspaceParams, incidentWorkspacePath, parseIncidentWorkspaceParams } from "./query";

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

  it("round-trips cursor, selection, and saved view through the URL", () => {
    const params = buildIncidentWorkspaceParams({
      query: {
        search: "timeout",
        status: "monitoring",
        severity: "critical",
        ownerId: "ops-1",
        cursor: "opaque:incident:cursor",
        limit: 45,
      },
      selectedId: "incident-7",
      savedViewId: "saved-7",
    });

    expect(parseIncidentWorkspaceParams(params)).toEqual({
      query: {
        search: "timeout",
        status: "monitoring",
        severity: "critical",
        ownerId: "ops-1",
        cursor: "opaque:incident:cursor",
        limit: 45,
      },
      selectedId: "incident-7",
      savedViewId: "saved-7",
    });
  });

  it("keeps canonical detail routes stable", () => {
    expect(incidentWorkspacePath("incident/7")).toBe("/admin/ops/incidents/incident%2F7");
    expect(incidentWorkspacePath(null)).toBe("/admin/ops/incidents");
  });
});
