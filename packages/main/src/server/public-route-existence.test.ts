import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hasSession: false, found: null as unknown, fails: false }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ has: () => state.hasSession }),
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
  return { prisma: { character: { findFirst: read }, user: { findFirst: read }, comic: { findFirst: read } } };
});

import {
  requirePublicCharacterForAnonymous,
  requirePublicComicForAnonymous,
  requirePublicCreatorForAnonymous,
} from "./public-route-existence";

const guards = [
  requirePublicCharacterForAnonymous,
  requirePublicCreatorForAnonymous,
  requirePublicComicForAnonymous,
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
