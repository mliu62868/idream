import { describe, expect, it } from "vitest";
import {
  safetyDocuments,
  safetyDocumentVersion,
  safetyRoutePaths,
  toSafetyHref,
} from "./ourdream-safety-data";

describe("local Safety Center content authority", () => {
  it("publishes one substantive local document for every navigation path", () => {
    expect(safetyDocuments).toHaveLength(15);
    expect(new Set(safetyDocuments.map((document) => document.path)).size).toBe(
      15,
    );
    for (const document of safetyDocuments) {
      expect(document.description.length).toBeGreaterThan(40);
      expect(document.markdown.length).toBeGreaterThan(300);
    }
  });

  it("does not expose unconfigured reference-operator facts", () => {
    const publicCopy = JSON.stringify(safetyDocuments);
    for (const unsupportedClaim of [
      "Dream Studio USA",
      "TEKTOPIA",
      "trust@ourdream.ai",
      "support@ourdream.ai",
      "discord.gg/",
      "safety.ourdream.ai",
      "Go.cam",
      "1111B South Governors",
    ]) {
      expect(publicCopy).not.toContain(unsupportedClaim);
    }
  });
});

describe("Safety Center link resolution", () => {
  it("scopes in-section paths under /safety", () => {
    expect(toSafetyHref("/policies/acceptable-use")).toBe(
      "/safety/policies/acceptable-use",
    );
    expect(toSafetyHref("introduction")).toBe("/safety/introduction");
  });

  it("keeps site-absolute product links outside the Safety namespace", () => {
    expect(toSafetyHref("/helpdesk")).toBe("/helpdesk");
    expect(toSafetyHref("/terms")).toBe("/terms");
  });

  it("leaves every document body link pointing at a real destination", () => {
    const safetyRoutes = new Set(safetyRoutePaths);
    const siteRoutes = new Set(["/", "/helpdesk", "/terms", "/upgrade"]);
    for (const document of safetyDocuments) {
      for (const match of document.markdown.matchAll(/\]\((\/[^)\s]*)\)/g)) {
        const href = toSafetyHref(match[1]);
        expect(
          safetyRoutes.has(href) || siteRoutes.has(href),
          `${document.path} links to ${match[1]} -> ${href}`,
        ).toBe(true);
      }
    }
  });
});

describe("Safety Center publication archive", () => {
  it("gives every published document a version that is stable for the same text", () => {
    for (const document of safetyDocuments) {
      expect(safetyDocumentVersion(document)).toBe(safetyDocumentVersion(document));
    }
    expect(new Set(safetyDocuments.map(safetyDocumentVersion)).size).toBe(
      safetyDocuments.length,
    );
  });

  // 存档的意义就在于改了文案会得到新版本号，而不是把旧那行改写掉。
  it("moves to a new version as soon as the published text changes", () => {
    const [document] = safetyDocuments;
    const before = safetyDocumentVersion(document);
    expect(
      safetyDocumentVersion({
        title: document.title,
        markdown: `${document.markdown}\n\nAdded clause.`,
      }),
    ).not.toBe(before);
    expect(
      safetyDocumentVersion({ title: `${document.title} v2`, markdown: document.markdown }),
    ).not.toBe(before);
  });
});
