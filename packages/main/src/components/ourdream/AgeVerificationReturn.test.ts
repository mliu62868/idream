import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AgeVerificationReturnFrame,
  ageVerificationReturnStateForStatus,
  loadAgeVerificationReturnStatus,
  safeAgeVerificationReturnTarget,
} from "./AgeVerificationReturn";

describe("age verification return", () => {
  it("resumes only a controlled product path", () => {
    expect(safeAgeVerificationReturnTarget("/generate?mode=image#prompt"))
      .toBe("/generate?mode=image#prompt");
    expect(safeAgeVerificationReturnTarget("https://attacker.example/steal"))
      .toBe("/");
    expect(safeAgeVerificationReturnTarget("//attacker.example/steal"))
      .toBe("/");
    expect(safeAgeVerificationReturnTarget("/login"))
      .toBe("/");
    expect(safeAgeVerificationReturnTarget("/age-verification/return"))
      .toBe("/");
    expect(
      safeAgeVerificationReturnTarget(
        "/age-verification/return?next=%2Fgenerate",
      ),
    ).toBe("/");
    expect(safeAgeVerificationReturnTarget("/age-verification/return#done"))
      .toBe("/");
  });

  it("keeps pending, verified, and failed provider outcomes explicit", () => {
    expect(ageVerificationReturnStateForStatus("required")).toBe("pending");
    expect(ageVerificationReturnStateForStatus("pending")).toBe("pending");
    expect(ageVerificationReturnStateForStatus("verified")).toBe("verified");
    expect(ageVerificationReturnStateForStatus("not_required")).toBe(
      "verified",
    );
    expect(ageVerificationReturnStateForStatus("failed")).toBe("failed");
    expect(ageVerificationReturnStateForStatus("expired")).toBe("failed");
  });

  it("loads the signed-in status through the canonical public endpoint", async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/v1/age-verification/status");
      return new Response(JSON.stringify({
        ok: true,
        data: { status: "pending" },
      }), { status: 200 });
    };

    await expect(loadAgeVerificationReturnStatus(fetcher)).resolves.toEqual({
      kind: "status",
      status: "pending",
    });
    await expect(loadAgeVerificationReturnStatus(async () =>
      new Response(JSON.stringify({
        ok: false,
        error: { code: "unauthorized", message: "Unauthorized" },
      }), { status: 401 }))).resolves.toEqual({ kind: "signed_out" });
  });

  it("renders deterministic, accessible return states with recovery actions", () => {
    const render = (state: Parameters<typeof AgeVerificationReturnFrame>[0]["state"]) =>
      renderToString(createElement(AgeVerificationReturnFrame, {
        nextPath: "/generate",
        onRetry: () => undefined,
        state,
      }));

    const serverMarkup = render("checking");
    expect(render("checking")).toBe(serverMarkup);
    expect(serverMarkup).toContain('role="status"');
    expect(serverMarkup).toContain('aria-live="polite"');
    expect(serverMarkup).toContain("Checking your verification");

    expect(render("pending")).toContain("Verification in progress");
    const verified = render("verified");
    expect(verified).toContain("Age verified");
    expect(verified).toContain('href="/generate"');

    const failed = render("failed");
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Verification wasn’t completed");
    expect(failed).toContain("Check again");

    const signedOut = render("signed_out");
    expect(signedOut).toContain("Sign in to finish verification");
    expect(signedOut).toContain(
      'href="/login?next=%2Fage-verification%2Freturn%3Fnext%3D%252Fgenerate"',
    );
  });
});
