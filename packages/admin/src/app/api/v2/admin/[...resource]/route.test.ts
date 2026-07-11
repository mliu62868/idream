import { describe, expect, it } from "vitest";
import { adminV2Path } from "./route";

describe("Admin v2 route strangler", () => {
  it("encodes every path segment without changing the authority route", () => {
    expect(adminV2Path(["incidents", "incident/42", "commands", "resolve"])).toBe(
      "/api/v2/admin/incidents/incident%2F42/commands/resolve",
    );
  });
});
