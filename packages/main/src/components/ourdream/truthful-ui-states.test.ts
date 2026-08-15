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
  parseWizardDraft,
  viewerScopeFromAuthority,
} from "./CreateWorkspace";
import { newCreatePreviewBatch } from "./create-preview-flow";
import {
  AgeGateFrame,
  ageGateHistoryRecoveryAction,
} from "./AgeGateBoundary";
import {
  ACCOUNT_AUTHORITY_UNAVAILABLE,
  authNavLogoutPresentation,
  authNavMode,
} from "./auth-nav-state";
import { feedLoadFailure, shouldApplyFeedResponse } from "./feed-load-state";
import { publicOptimisticMutationFailure } from "./optimistic-write-state";
import { loadGeneratorWorkspaceInitialData } from "./GeneratorWorkspace";
import { CharacterCard } from "./CharacterCard";
import { CharacterGrid } from "./CharacterGrid";
import { shouldClearTransferredHelpDeskDraft } from "./HelpDeskWorkspace";
import {
  accountDeletionLoginHref,
  createdCharacterPublicationStatus,
  profileLibraryCardPresentation,
} from "./ProfileWorkspace";
import { accountDeletionGraceEndsAtFromSearch } from "./AuthWorkspace";

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
  it("uses inclusive creator and discovery copy", () => {
    expect(source("CreateWorkspace.tsx")).toContain(
      "Create Your Dream AI Character",
    );
    expect(source("CreateWorkspace.tsx")).not.toContain(
      "Create Your Dream AI Girl",
    );
    expect(source("TopControls.tsx")).toContain(
      "Try 'slow-burn elf' or 'anime adventurer'",
    );
    expect(source("TopControls.tsx")).not.toContain("Petite asian");
  });

  it("keeps the discovery search focus visible at mobile and desktop breakpoints", () => {
    expect(
      source("TopControls.tsx").match(
        /focus-within:ring-2 focus-within:ring-white\/50/g,
      ),
    ).toHaveLength(2);
  });

  it("keeps tablet discovery and character actions unobstructed", () => {
    expect(source("PromoToast.tsx")).toContain(
      "shadow-[2px_2px_8px_3px_rgba(0,0,0,0.25)] lg:block",
    );
    expect(source("PromoToast.tsx")).not.toContain(
      "shadow-[2px_2px_8px_3px_rgba(0,0,0,0.25)] md:block",
    );
    expect(source("CharacterDetailHero.tsx")).toContain(
      "p-6 lg:inset-y-0 lg:bottom-auto lg:p-12",
    );
    expect(source("CharacterDetailHero.tsx")).toContain(
      "leading-[0.95] lg:text-[72px]",
    );
  });

  it("keeps runtime media identifiers and identity prompts out of library cards", () => {
    expect(profileLibraryCardPresentation({
      id: "media_internal_123",
      type: "image",
      prompt: "identity-lock runtime instructions",
    })).toEqual({
      title: "Generated image",
      summary: null,
    });
    expect(profileLibraryCardPresentation({
      id: "character-1",
      type: "character",
      name: "Alexa",
      description: "A public character summary.",
    })).toEqual({
      title: "Alexa",
      summary: "A public character summary.",
    });
  });

  it("eager-loads the above-the-fold route logo", () => {
    expect(source("OurdreamRoutePage.tsx")).toMatch(
      /<Image[\s\S]*?loading="eager"[\s\S]*?src="\/images\/ourdream\/ourdream-logo\.svg"/,
    );
  });

  it("keeps character cards readable beside the tablet sidebar", () => {
    expect(source("CharacterGrid.tsx")).toContain(
      "md:grid-cols-3 md:gap-3 lg:grid-cols-4 xl:grid-cols-5",
    );
    expect(source("CharacterGrid.tsx")).not.toContain(
      "md:grid-cols-5 md:gap-3",
    );
  });

  it("does not turn generator dependency failure into character or gallery facts", () => {
    const generator = source("GeneratorWorkspace.tsx");

    expect(generator).toContain("selectedCharacter && characterImageMode");
    expect(generator).toContain("!configAuthorityUnavailable &&\n                charactersAuthority.phase");
    expect(generator).toContain(
      "Generation jobs are unavailable until the generator reconnects.",
    );
    expect(generator).toContain(
      "Your gallery is unavailable until the generator reconnects.",
    );
  });

  it("distinguishes initial discovery loading from a filter refresh", () => {
    const initial = renderToStaticMarkup(createElement(CharacterGrid, {
      cards: [],
      loading: true,
    }));
    const refreshing = renderToStaticMarkup(createElement(CharacterGrid, {
      cards: [{
        id: "alexa-reeves",
        title: "Alexa Reeves",
        age: "19",
        description: "A character summary.",
        likes: "0",
        chats: "2",
        chatsCount: 2,
        creator: "Official",
        image: "/images/ourdream/card-alexa-reeves.webp",
      }],
      loading: true,
    }));

    expect(initial).toContain("Loading characters...");
    expect(initial).toContain('aria-busy="true"');
    expect(refreshing).toContain("Refreshing characters...");
    expect(refreshing).not.toContain("Loading more characters...");
  });

  it("gives character card headings a complete name-and-age accessible label", () => {
    const html = renderToStaticMarkup(createElement(CharacterCard, {
      card: {
        id: "alexa-reeves",
        title: "Alexa Reeves",
        age: "19",
        description: "A character summary.",
        likes: "0",
        chats: "2",
        chatsCount: 2,
        creator: "Official",
        image: "/images/ourdream/card-alexa-reeves.webp",
      },
    }));

    expect(html).toMatch(/<h2 aria-label="Alexa Reeves, age 19"/);
    expect(html).toContain('<span aria-hidden="true"');
  });

  it("carries the exact account-erasure due time into the signed-out UI", () => {
    const graceEndsAt = "2026-09-10T12:00:00.000Z";
    expect(accountDeletionLoginHref({
      data: { deletion: { graceEndsAt } },
    })).toBe(
      "/login?accountDeletionGraceEndsAt=2026-09-10T12%3A00%3A00.000Z",
    );
    expect(accountDeletionGraceEndsAtFromSearch(
      "?accountDeletionGraceEndsAt=2026-09-10T12%3A00%3A00.000Z",
    )).toBe(graceEndsAt);
    expect(accountDeletionGraceEndsAtFromSearch(
      "?accountDeletionGraceEndsAt=not-a-date",
    )).toBeNull();
  });

  it("states that approval still awaits operator Release publication", () => {
    expect(createdCharacterPublicationStatus({
      status: "approved",
      visibility: "public",
      publicationState: "awaiting_publication",
    })).toBe("approved · awaiting publication");
    expect(createdCharacterPublicationStatus({
      status: "approved",
      visibility: "public",
      publicationState: "live",
    })).toBe("live");
    expect(createdCharacterPublicationStatus({
      status: "approved",
      visibility: "private",
      publicationState: "live",
    })).toBe("approved");
    expect(createdCharacterPublicationStatus({
      status: "approved",
      visibility: "private",
      publicationState: "awaiting_publication",
    })).toBe("approved");
    expect(createdCharacterPublicationStatus({
      status: "pending_review",
      visibility: "public",
    })).toBe("pending review");
    expect(source("CreateWorkspace.tsx")).toContain(
      "Approval starts publication preparation; the character goes live after Release is published.",
    );
    expect(source("CreateWorkspace.tsx")).not.toContain(
      "Public characters go live after approval.",
    );
  });

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

  it("restores the active preview job through the existing viewer-scoped draft authority", () => {
    const activeBatch = {
      ...newCreatePreviewBatch(1_000),
      currentCandidateNumber: 2,
      activePreviewJobId: "preview-job-2",
      activeJobStatus: "running" as const,
      candidates: [
        {
          previewJobId: "preview-job-1",
          assetId: "asset-1",
          url: "/user-content/asset-1",
          isSynthetic: false,
        },
      ],
    };

    expect(
      parseWizardDraft({
        ...initialCharacterDraft(),
        draftId: "draft-1",
        step: 3,
        previewBatch: JSON.parse(JSON.stringify(activeBatch)),
      }),
    ).toMatchObject({
      draftId: "draft-1",
      step: 3,
      previewBatch: {
        phase: "running",
        currentCandidateNumber: 2,
        activePreviewJobId: "preview-job-2",
        activeJobStatus: "running",
      },
    });
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

  it("re-resolves age authority when an accepted page returns from bfcache", () => {
    expect(
      ageGateHistoryRecoveryAction({
        persisted: false,
        acceptedLocally: true,
      }),
    ).toBeNull();
    expect(
      ageGateHistoryRecoveryAction({
        persisted: true,
        acceptedLocally: true,
      }),
    ).toBe("restore");
    expect(
      ageGateHistoryRecoveryAction({
        persisted: true,
        acceptedLocally: false,
      }),
    ).toBe("recheck");
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
