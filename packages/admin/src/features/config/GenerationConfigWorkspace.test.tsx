import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GenerationConfigWorkspace, publishBlockedReason } from "./GenerationConfigWorkspace";

describe("Generation Config workspace permission surface", () => {
  it("renders server-query controls and explicit read-only capabilities", () => {
    const html = renderToStaticMarkup(<GenerationConfigWorkspace permissions={{ manageFlags: false, manageProfiles: false }} />);

    expect(html).toContain("Profiles &amp; Rollout");
    expect(html).toContain('role="searchbox"');
    expect(html).toContain("Profiles: loading");
    expect(html).toContain('aria-label="Loading profiles…"');
  });

  it("keeps independent profile and feature-flag permissions in the public contract", () => {
    const source = GenerationConfigWorkspace.toString();
    expect(source).toContain("manageProfiles");
    expect(source).toContain("manageFlags");
  });

  it("never fabricates provider success from a manual consistency review", () => {
    const source = readFileSync(new URL("./GenerationConfigWorkspace.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("successRate: 1");
    expect(source).toContain("consistencySampleCount");
    expect(source).toContain("Configuration check");
  });
});

describe("profile publish gate", () => {
  const echo = (key: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      key,
    );

  // SPEC: 提示必须和 reviewReady 判同一组数字，否则会出现「说达标了但按钮还是灰的」。
  it("asks for the sample count before anything else", () => {
    expect(publishBlockedReason(null, null, echo)).toContain("at least 20 samples");
    expect(publishBlockedReason(19, 19, echo)).toContain("at least 20 samples");
  });

  it("asks for the pass count once enough samples exist", () => {
    expect(publishBlockedReason(20, null, echo)).toBe("Enter how many of the 20 samples passed.");
    expect(publishBlockedReason(20, 21, echo)).toBe("Enter how many of the 20 samples passed.");
  });

  it("reports the shortfall when the pass rate is below the gate", () => {
    expect(publishBlockedReason(20, 15, echo)).toBe(
      "15 of 20 samples passed. Publishing needs at least 80%.",
    );
  });

  it("says nothing once the review clears the gate", () => {
    expect(publishBlockedReason(20, 16, echo)).toBe("");
  });
});
