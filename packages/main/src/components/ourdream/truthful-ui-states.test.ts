import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { creatorLoadErrorMessage } from "./CreatorProfileClient";

function source(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

describe("truthful public UI states", () => {
  it("distinguishes creator auth, age, not-found, and dependency failures", () => {
    expect(creatorLoadErrorMessage(401)).toBe("Sign in to view this creator.");
    expect(creatorLoadErrorMessage(403)).toBe("Accept the age gate to view this creator.");
    expect(creatorLoadErrorMessage(404)).toBe("Creator not found or not public.");
    expect(creatorLoadErrorMessage(503)).toBe(
      "Creator is temporarily unavailable. Please try again.",
    );
    expect(creatorLoadErrorMessage(null)).toBe(
      "Creator is temporarily unavailable. Please try again.",
    );
  });

  it("does not turn an account-authority failure into anonymous Login calls to action", () => {
    const authNav = source("AuthNav.tsx");

    expect(authNav).toContain("Account unavailable");
    expect(authNav).toContain('if (!response.ok) throw new Error("Account authority unavailable")');
    expect(authNav).toContain('if (!response.ok) throw new Error("Logout failed")');
    expect(authNav).toContain("Log out failed. Try again.");
  });

  it("starts character creation empty and scopes browser drafts to the current viewer", () => {
    const createWorkspace = source("CreateWorkspace.tsx");

    expect(createWorkspace).not.toContain('name: "Nova Vale"');
    expect(createWorkspace).toContain(`${"${STORAGE_KEY_PREFIX}"}:${"${viewerScope}"}`);
    expect(createWorkspace).toContain(`user:${"${userId}"}`);
    expect(createWorkspace).toContain(`anonymous:${"${anonymousId}"}`);
    expect(createWorkspace).toContain('setViewerAuthorityState("error")');
    expect(createWorkspace).toContain('data-testid="create-viewer-authority-error"');
  });

  it("labels the last feed snapshot and rejects out-of-order refreshes", () => {
    const feed = source("FeedWorkspace.tsx");

    expect(feed).toContain("requestSerialRef");
    expect(feed).toContain("requestControllerRef.current?.abort()");
    expect(feed).toContain("requestSerial !== requestSerialRef.current");
    expect(feed).toContain("Showing the last loaded results.");
    expect(feed).toContain('data-stale={snapshotStale ? "true" : "false"}');
  });

  it("does not keep a dormant hard-coded public character catalog", () => {
    const catalogSource = readFileSync(
      new URL("../../lib/ourdream-data.ts", import.meta.url),
      "utf8",
    );

    expect(catalogSource).not.toContain("export const characterCards");
    expect(catalogSource).not.toContain('chats: "2.2M"');
  });

  it("rolls back or reloads optimistic follow and like state on network failure", () => {
    const community = source("CommunityWorkspace.tsx");
    const generator = source("GeneratorWorkspace.tsx");

    expect(community).toContain('setStatus("Could not update follow. Please try again.")');
    expect(generator).toContain('setStatus("Could not update like. Restoring the current gallery.")');
    expect(generator).toContain('setStatus("Retry failed. Check your connection and try again.")');
  });

  it("keeps server-rendered content in the tree while the age decision is pending", () => {
    const boundary = source("AgeGateBoundary.tsx");
    const explore = source("ExploreWorkspace.tsx");
    const generator = source("GeneratorWorkspace.tsx");
    const layout = readFileSync(
      new URL("../../app/layout.tsx", import.meta.url),
      "utf8",
    );

    expect(boundary).toContain("{children}");
    expect(boundary).toContain('state === "checking"');
    expect(boundary).not.toContain(
      'return <div className="min-h-screen bg-black" aria-hidden="true" />',
    );
    expect(layout).toContain('from "next/headers"');
    expect(layout).toContain("await cookies()");
    expect(layout).toContain("initialAccepted={ageGateAccepted}");
    expect(explore).toContain("if (!ageGateAccepted || !initialized) return");
    expect(generator).toContain("if (!ageGateAccepted) return");
    expect(boundary).toContain("usePathname");
    expect(source("AgeGate.tsx")).toContain('role="dialog"');
    expect(source("AgeGate.tsx")).toContain('aria-modal="true"');
  });

  it("does not publish unconfigured reference-site identity claims", () => {
    const publicSources = [
      source("SiteFooter.tsx"),
      source("AppSidebar.tsx"),
      source("HelpDeskWorkspace.tsx"),
      source("SafetyCenterPage.tsx"),
    ].join("\n");

    for (const unsupportedClaim of [
      "Dream Studio USA, Inc.",
      "TEKTOPIA LTD",
      "discord.gg/P47YU7je5D",
      "trust@ourdream.ai",
      "help.ourdream.ai",
      "ourdreamaiaffiliate.com",
    ]) {
      expect(publicSources).not.toContain(unsupportedClaim);
    }
  });

  it("moves anonymous help-desk drafts into the signed-in owner scope once", () => {
    const helpDesk = source("HelpDeskWorkspace.tsx");

    expect(helpDesk).toContain("sourceScope: claimed.sourceScope");
    expect(helpDesk).toContain("if (saveSupportDraft(viewerScope, restoredSupport))");
    expect(helpDesk).toContain("clearSupportDraft(resumed.sourceScope)");
    expect(helpDesk).toContain("clearFeedbackDraft(resumed.sourceScope)");
    expect(helpDesk).toContain("clearAppealDraft(resumed.sourceScope)");
  });
});
