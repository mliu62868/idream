import { describe, expect, it, vi } from "vitest";
import {
  AdminV2RequestError,
  apiWrite,
  formatApiError,
} from "./api";

describe("admin API error formatting", () => {
  it("shows CMS publication issue paths instead of a generic conflict", () => {
    expect(
      formatApiError(
        {
          message: "CMS page is not ready to publish",
          details: {
            issues: [
              {
                code: "too_small",
                path: "body.intro",
                message: "Too small: expected string to have >=60 characters",
              },
              {
                code: "too_small",
                path: "body.sections",
                message: "Too small: expected array to have >=2 items",
              },
            ],
          },
        },
        "Request failed",
      ),
    ).toContain(
      "body.intro: Too small: expected string to have >=60 characters",
    );
  });

  it("preserves response status and structured conflict details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: false,
      error: {
        code: "conflict",
        message: "Featured configuration changed",
        details: {
          reason: "featured_setting_version_conflict",
          settingVersion: 8,
          configuredCharacterIds: ["character-current"],
        },
      },
    }, { status: 409 })));
    try {
      const error = await apiWrite(
        "/api/v2/admin/content/featured",
        "PUT",
        {},
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AdminV2RequestError);
      expect(error).toMatchObject({
        status: 409,
        code: "conflict",
        details: {
          reason: "featured_setting_version_conflict",
          settingVersion: 8,
          configuredCharacterIds: ["character-current"],
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
