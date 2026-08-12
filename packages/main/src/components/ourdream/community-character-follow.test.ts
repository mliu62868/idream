import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  CommunityCharacter,
  CommunityDreamer,
} from "@/lib/public-api-contracts";
import {
  CommunityCharacterCard,
  CommunityDreamerCard,
  requestCommunityFollow,
} from "./CommunityWorkspace";

function character(
  overrides: Partial<CommunityCharacter> = {},
): CommunityCharacter {
  return {
    id: "character-1",
    title: "Aster",
    age: "24",
    description: "A public character.",
    likes: "0",
    chats: "0",
    creator: "Creator",
    creatorId: "creator-1",
    image: "/images/ourdream/character-placeholder.svg",
    source: "user",
    isFollowing: false,
    canEditIdentity: false,
    ...overrides,
  };
}

function renderCharacterCard(
  value: CommunityCharacter,
  followPending = false,
) {
  return renderToStaticMarkup(
    createElement(CommunityCharacterCard, {
      character: value,
      followPending,
      onEligibleImpression: vi.fn(),
      onReport: vi.fn(),
      onToggleFollow: vi.fn(),
    }),
  );
}

function dreamer(overrides: Partial<CommunityDreamer> = {}): CommunityDreamer {
  return {
    id: "creator-1",
    displayName: "Creator",
    image: null,
    characters: 1,
    followers: 0,
    likes: "0",
    chats: "0",
    likesCount: 0,
    chatsCount: 0,
    isFollowing: false,
    isSelf: false,
    ...overrides,
  };
}

function renderDreamerCard(
  value: CommunityDreamer,
  followPending = false,
) {
  return renderToStaticMarkup(
    createElement(CommunityDreamerCard, {
      dreamer: value,
      followPending,
      onReport: vi.fn(),
      onToggleFollow: vi.fn(),
    }),
  );
}

describe("Community character follow affordance", () => {
  it("shows Official instead of a fake follow button without creator authority", () => {
    const html = renderCharacterCard(character({
      creator: "Official",
      creatorId: null,
      source: "official",
      isFollowing: false,
    }));

    expect(html).toContain("Official");
    expect(html).not.toContain(">Follow<");
  });

  it("renders the viewer relation and pending state for user characters", () => {
    expect(renderCharacterCard(character())).toContain(">Follow<");
    expect(renderCharacterCard(character({ isFollowing: true }))).toContain(
      ">Following<",
    );
    expect(renderCharacterCard(character(), true)).toContain(">Updating...<");
  });

  it("does not offer Follow or Following on the viewer's own character", () => {
    const html = renderCharacterCard(character({ canEditIdentity: true }));

    expect(html).toContain("Your character");
    expect(html).not.toContain(">Follow<");
    expect(html).not.toContain(">Following<");
  });

  it("uses the current viewer relation for POST/DELETE and parses authority", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        ok: true,
        data: { following: true, followers: 4 },
      }))
      .mockResolvedValueOnce(Response.json({
        ok: true,
        data: { following: false, followers: 3 },
      }));

    await expect(
      requestCommunityFollow("creator-1", false, fetcher),
    ).resolves.toMatchObject({
      authority: { following: true, followers: 4 },
    });
    await expect(
      requestCommunityFollow("creator-1", true, fetcher),
    ).resolves.toMatchObject({
      authority: { following: false, followers: 3 },
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "/api/v1/users/creator-1/follow",
      { method: "POST" },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "/api/v1/users/creator-1/follow",
      { method: "DELETE" },
    );
  });

  it("preserves the creator-scoped signup return on 401", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        { error: { code: "unauthorized", message: "Sign in required" } },
        { status: 401 },
      ),
    );

    await expect(
      requestCommunityFollow("creator/one", false, fetcher),
    ).resolves.toMatchObject({
      authority: null,
      signupHref: "/signup?next=%2Fcreators%2Fcreator%252Fone",
    });
  });
});

describe("Community Dreamer follow affordance", () => {
  it("does not offer Follow or Following on the viewer's own Dreamer card", () => {
    const html = renderDreamerCard(dreamer({ isSelf: true }));

    expect(html).not.toContain(">Follow<");
    expect(html).not.toContain(">Following<");
    expect(html).toContain("Report user profile Creator");
  });

  it("keeps Follow, Following, and pending states for other Dreamers", () => {
    expect(renderDreamerCard(dreamer())).toContain(">Follow<");
    expect(renderDreamerCard(dreamer({ isFollowing: true }))).toContain(
      ">Following<",
    );
    expect(renderDreamerCard(dreamer(), true)).toContain(">Updating...<");
  });
});
