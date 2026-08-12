import { describe, expect, it } from "vitest";
import { parseFailedSourceResidueCliArgs } from "./acknowledge-generation-failed-source-residue";

describe("failed source residue CLI", () => {
  it("defaults to dry-run and rejects apply-only arguments", () => {
    const parsed = parseFailedSourceResidueCliArgs([
      "--actor-id",
      "admin-1",
      "--queue",
      "ai.video.generate",
      "--bull-job-id",
      "bull-1",
    ]);
    expect(parsed.apply).toBe(false);
    expect(() => parseFailedSourceResidueCliArgs([
      "--actor-id",
      "admin-1",
      "--queue",
      "ai.video.generate",
      "--bull-job-id",
      "bull-1",
      "--reason",
      "must not be accepted",
    ])).toThrow("only valid with --apply");
  });

  it("makes apply explicit, plan-bound, and fail-closed", () => {
    const args = [
      "--apply",
      "--actor-id",
      "admin-1",
      "--plan-file",
      "/tmp/plan.json",
      "--reason",
      "Reviewed historical residue",
      "--request-id",
      "request-1",
      "--idempotency-key",
      "idem-1",
      "--confirmation",
      "ACKNOWLEDGE exact",
    ];
    expect(parseFailedSourceResidueCliArgs(args).apply).toBe(true);
    expect(() => parseFailedSourceResidueCliArgs([
      ...args,
      "--bull-job-id",
      "bull-1",
    ])).toThrow("Apply identity comes only from --plan-file");
    expect(() => parseFailedSourceResidueCliArgs(
      args.filter((value) => value !== "--confirmation"),
    )).toThrow();
  });
});
