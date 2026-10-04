import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hasSession: false, found: null as unknown, fails: false, viewerId: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ has: () => state.hasSession }),
  headers: async () => new Headers(),
}));
vi.mock("@/server/lib/auth", () => ({
  SESSION_COOKIE: "idream_session",
  getAuthCtx: async () => ({ userId: state.viewerId }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/server/lib/db", () => {
  const read = async () => {
    if (state.fails) throw new Error("db down");
    return state.found;
  };
  return { prisma: { character: { findFirst: read }, user: { findFirst: read }, comic: { findFirst: read }, pack: { findFirst: read } } };
});

import {
  requireEditableComic,
  requireEditablePack,
  requirePublicCharacterForAnonymous,
  requirePublicComicForAnonymous,
  requirePublicCreatorForAnonymous,
  requirePublicPackForAnonymous,
} from "./public-route-existence";

const guards = [
  requirePublicCharacterForAnonymous,
  requirePublicCreatorForAnonymous,
  requirePublicComicForAnonymous,
  requirePublicPackForAnonymous,
];

describe("anonymous dynamic-id pages", () => {
  beforeEach(() => {
    state.hasSession = false;
    state.found = null;
    state.fails = false;
  });

  it("404s a missing public object for an anonymous request", async () => {
    for (const guard of guards) await expect(guard("missing")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders an existing public object", async () => {
    state.found = { id: "present" };
    for (const guard of guards) await expect(guard("present")).resolves.toBeUndefined();
  });

  it("leaves signed-in requests to the owner-aware client page", async () => {
    state.hasSession = true;
    for (const guard of guards) await expect(guard("private-or-missing")).resolves.toBeUndefined();
  });

  it("does not turn a database outage into a 404", async () => {
    state.fails = true;
    for (const guard of guards) await expect(guard("unknown")).resolves.toBeUndefined();
  });
});

describe("owner editor pages", () => {
  const editors = [requireEditableComic, requireEditablePack];
  beforeEach(() => {
    state.found = null;
    state.fails = false;
    state.viewerId = "owner-1";
  });

  it("404s a missing object instead of opening a blank editor", async () => {
    for (const guard of editors) await expect(guard("missing")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s another creator's object and opens the viewer's own", async () => {
    state.found = { creatorId: "someone-else" };
    for (const guard of editors) await expect(guard("theirs")).rejects.toThrow("NEXT_NOT_FOUND");
    state.found = { creatorId: "owner-1" };
    for (const guard of editors) await expect(guard("mine")).resolves.toBeUndefined();
  });

  it("lets a signed-out visitor reach the sign-in prompt for an existing object", async () => {
    state.viewerId = undefined;
    state.found = { creatorId: "owner-1" };
    for (const guard of editors) await expect(guard("mine")).resolves.toBeUndefined();
  });

  it("does not turn a database outage into a 404", async () => {
    state.fails = true;
    for (const guard of editors) await expect(guard("unknown")).resolves.toBeUndefined();
  });
});
