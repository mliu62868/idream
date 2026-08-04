import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ageGateAcceptedFromCookieValue,
  canStartAgeGatedLoad,
} from "@/lib/age-gate";
import { creatorLoadErrorMessage } from "./CreatorProfileClient";
import {
  draftStorageKeyForScope,
  initialCharacterDraft,
  viewerScopeFromAuthority,
} from "./CreateWorkspace";
import { AgeGateFrame } from "./AgeGateBoundary";
import {
  ACCOUNT_AUTHORITY_UNAVAILABLE,
  authNavLogoutPresentation,
  authNavMode,
} from "./auth-nav-state";
import { feedLoadFailure, shouldApplyFeedResponse } from "./feed-load-state";
import { publicOptimisticMutationFailure } from "./optimistic-write-state";
import { loadGeneratorWorkspaceInitialData } from "./GeneratorWorkspace";
import { shouldClearTransferredHelpDeskDraft } from "./HelpDeskWorkspace";

function source(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

const COMPONENT_DIR = fileURLToPath(new URL(".", import.meta.url));
const LIB_DIR = fileURLToPath(new URL("../../lib/", import.meta.url));

/** Public components and their data modules; new files join the scan automatically. */
function publishableSources(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const [dir, matches] of [
    [COMPONENT_DIR, (name: string) => name.endsWith(".tsx")],
    [LIB_DIR, (name: string) => name.endsWith(".ts") || name.endsWith(".json")],
  ] as const) {
    for (const name of readdirSync(dir)) {
      if (name.includes(".test.") || !matches(name)) continue;
      files.push({ path: name, text: readFileSync(join(dir, name), "utf8") });
    }
  }
  return files;
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

  it("keeps account-authority failure distinct from an anonymous account", () => {
    expect(authNavMode("error", false)).toBe("authority_error");
    expect(authNavMode("ready", false)).toBe("anonymous");
    expect(authNavMode("ready", true)).toBe("account");
    expect(ACCOUNT_AUTHORITY_UNAVAILABLE).toBe("Account unavailable");
    expect(authNavLogoutPresentation("pending")).toEqual({
      label: "Logging out…",
      error: null,
    });
    expect(authNavLogoutPresentation("error")).toEqual({
      label: "Log out",
      error: "Log out failed. Try again.",
    });
  });

  it("starts character creation empty and scopes drafts to the resolved viewer", () => {
    expect(initialCharacterDraft()).toMatchObject({ name: "", step: 0 });
    expect(viewerScopeFromAuthority({ userId: "user-1", anonymousId: "anon-1" }))
      .toBe("user:user-1");
    expect(viewerScopeFromAuthority({ anonymousId: "anon-1" }))
      .toBe("anonymous:anon-1");
    expect(viewerScopeFromAuthority({})).toBeNull();
    expect(draftStorageKeyForScope("user:user-1"))
      .toBe("ourdream.create.draft.v2:user:user-1");

    // Negative source guards are deliberate: fake seed content must never regain a render path.
    expect(source("CreateWorkspace.tsx")).not.toContain('name: "Nova Vale"');
  });

  it("rejects superseded feed responses and labels stale snapshots", () => {
    expect(shouldApplyFeedResponse({
      requestSerial: 1,
      currentSerial: 2,
      aborted: false,
    })).toBe(false);
    expect(shouldApplyFeedResponse({
      requestSerial: 2,
      currentSerial: 2,
      aborted: true,
    })).toBe(false);
    expect(feedLoadFailure({
      message: "Feed unavailable.",
      loadingMore: false,
      hasSnapshot: true,
    })).toEqual({
      snapshotStale: true,
      status: "Feed unavailable. Showing the last loaded results.",
    });
    expect(feedLoadFailure({
      message: "Feed unavailable.",
      loadingMore: true,
      hasSnapshot: true,
    })).toEqual({
      snapshotStale: false,
      status: "Could not load more dreams. Showing the loaded results.",
    });
  });

  it("does not keep a dormant hard-coded public character catalog", () => {
    const catalogSource = readFileSync(
      new URL("../../lib/ourdream-data.ts", import.meta.url),
      "utf8",
    );
    expect(catalogSource).not.toContain("export const characterCards");
    expect(catalogSource).not.toContain('chats: "2.2M"');
  });

  it("turns optimistic write failures into explicit recovery actions", () => {
    expect(publicOptimisticMutationFailure("follow")).toEqual({
      reloadAuthority: false,
      status: "Could not update follow. Please try again.",
    });
    expect(publicOptimisticMutationFailure("gallery_like")).toEqual({
      reloadAuthority: true,
      status: "Could not update like. Restoring the current gallery.",
    });
  });

  it("keeps server content mounted while age authority is pending", async () => {
    const pending = renderToStaticMarkup(AgeGateFrame({
      state: "checking",
      onAccepted: vi.fn(),
      children: createElement("main", null, "Server content"),
    }));
    expect(pending).toContain("Server content");
    expect(pending).toContain('role="status"');
    expect(pending).toContain("Checking age access");

    const blocked = renderToStaticMarkup(AgeGateFrame({
      state: "blocked",
      onAccepted: vi.fn(),
      children: createElement("main", null, "Server content"),
    }));
    expect(blocked).toContain('role="dialog"');
    expect(blocked).toContain('aria-modal="true"');
    expect(ageGateAcceptedFromCookieValue("true")).toBe(true);
    expect(ageGateAcceptedFromCookieValue("false")).toBe(false);
    expect(canStartAgeGatedLoad(true, true)).toBe(true);
    expect(canStartAgeGatedLoad(true, false)).toBe(false);

    const loadConfig = vi.fn().mockResolvedValue(true);
    const loaders = {
      loadConfig,
      loadCharacters: vi.fn().mockResolvedValue(true),
      loadJobs: vi.fn(),
      loadMedia: vi.fn(),
      loadPresets: vi.fn(),
      loadIdentityMedia: vi.fn(),
    };
    await loadGeneratorWorkspaceInitialData(false, loaders);
    expect(loadConfig).not.toHaveBeenCalled();

    // The fourth negative guard rejects the old content-removing placeholder.
    expect(source("AgeGateBoundary.tsx")).not.toContain(
      'return <div className="min-h-screen bg-black" aria-hidden="true" />',
    );
  });

  it("clears the anonymous help-desk draft only after owner-scope persistence", () => {
    expect(shouldClearTransferredHelpDeskDraft({
      saved: true,
      sourceScope: "anonymous:one",
      targetScope: "user:one",
    })).toBe(true);
    expect(shouldClearTransferredHelpDeskDraft({
      saved: false,
      sourceScope: "anonymous:one",
      targetScope: "user:one",
    })).toBe(false);
    expect(shouldClearTransferredHelpDeskDraft({
      saved: true,
      sourceScope: "user:one",
      targetScope: "user:one",
    })).toBe(false);
  });

  const UNSUPPORTED_CLAIMS = [
    "Dream Studio USA, Inc.",
    "TEKTOPIA LTD",
    "discord.gg/P47YU7je5D",
    "trust@ourdream.ai",
    "help.ourdream.ai",
    "ourdreamaiaffiliate.com",
  ];
  const REFERENCE_CORPUS = "ourdream-safety-docs.json";

  it("扫描域真的覆盖到公开组件与数据模块，而不是空转", () => {
    const scanned = publishableSources();
    expect(scanned.filter((file) => file.path.endsWith(".tsx")).length)
      .toBeGreaterThan(20);
    expect(scanned.some((file) => file.path === REFERENCE_CORPUS)).toBe(true);
  });

  it("does not publish unconfigured reference-site identity claims", () => {
    const violations: string[] = [];
    for (const file of publishableSources()) {
      if (file.path === REFERENCE_CORPUS) continue;
      for (const claim of UNSUPPORTED_CLAIMS) {
        if (file.text.includes(claim)) violations.push(`${file.path}: ${claim}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps the scraped reference corpus out of every render path", () => {
    const importers = publishableSources().filter(
      (file) => file.path !== REFERENCE_CORPUS &&
        file.text.includes("ourdream-safety-docs"),
    );
    expect(importers.map((file) => file.path)).toEqual([]);
  });
});
