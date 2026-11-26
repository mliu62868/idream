import { describe, expect, it } from "vitest";
import { WakeProfileCache } from "./wake-cache";

const wake = (profile: string) => ({ outcome: "hit" as const, resultCount: 1 as const, profile });
const alice = { userId: "alice", characterId: "mira" };

describe("WakeProfileCache", () => {
  it("serves only the exact version and relationship scope", () => {
    const cache = new WakeProfileCache(4);
    const { token } = cache.lookup("/v/1", alice);
    cache.store(token, "/v/1", alice, wake("likes tea"));
    expect(cache.lookup("/v/1", alice).wake?.profile).toBe("likes tea");
    expect(cache.lookup("/v/2", alice).wake).toBeUndefined();
    expect(cache.lookup("/v/1", { userId: "bob", characterId: "mira" }).wake).toBeUndefined();
    expect(cache.lookup("/v/1", { userId: "alice", characterId: "other" }).wake).toBeUndefined();
  });

  it("evicts the least recently used version beyond its bound", () => {
    const cache = new WakeProfileCache(2);
    for (const version of ["/v/1", "/v/2"]) cache.store(cache.lookup(version, alice).token, version, alice, wake(version));
    cache.lookup("/v/1", alice);
    cache.store(cache.lookup("/v/3", alice).token, "/v/3", alice, wake("/v/3"));
    expect(cache.size).toBe(2);
    expect(cache.lookup("/v/2", alice).wake).toBeUndefined();
    expect(cache.lookup("/v/1", alice).wake?.profile).toBe("/v/1");
  });

  it("drops a relationship or a whole user and refuses stores taken before invalidation", () => {
    const cache = new WakeProfileCache(8);
    const other = { userId: "alice", characterId: "noa" };
    const bob = { userId: "bob", characterId: "mira" };
    for (const [version, scope] of [["/v/a", alice], ["/v/b", other], ["/v/c", bob]] as const) {
      cache.store(cache.lookup(version, scope).token, version, scope, wake(version));
    }
    const pending = cache.lookup("/v/late", alice);
    cache.invalidate({ scope: "relationship", userId: "alice", characterId: "mira" });
    expect(cache.lookup("/v/a", alice).wake).toBeUndefined();
    expect(cache.lookup("/v/b", other).wake).toBeDefined();
    cache.store(pending.token, "/v/late", alice, wake("superseded profile"));
    expect(cache.lookup("/v/late", alice).wake).toBeUndefined();
    cache.invalidate({ scope: "user", userId: "alice" });
    expect(cache.size).toBe(1);
    expect(cache.lookup("/v/c", bob).wake).toBeDefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
