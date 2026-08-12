import { describe, expect, it } from "vitest";
import { compileCharacterSoul } from "@idream/shared";
import {
  auditCharacterSoulAuthority,
  auditSoulSnapshots,
  characterSoulAuthorityIsLaunchSafe,
} from "./soul-authority-audit";

describe("Character Soul authority audit", () => {
  it("reports exact owners of missing or invalid pinned snapshots", () => {
    const compiled = compileCharacterSoul({
      name: "June",
      age: 28,
      gender: "female",
      relationshipArchetype: "neighbor",
      characterPromise: "A candid neighbor.",
      personality: "Direct.",
    });
    if (!compiled.ok) throw new Error("fixture compilation failed");
    const result = auditSoulSnapshots([
      { ownerType: "serving_release", ownerId: "character-1", contentVersionId: "v1" },
      { ownerType: "pinned_session", ownerId: "session-1", contentVersionId: "missing" },
    ], [{ id: "v1", personaSnapshot: compiled.snapshot }]);
    expect(result).toMatchObject({ referenced: 2, valid: 1, v1: 1, legacy: 0 });
    expect(result.invalid).toEqual([
      expect.objectContaining({ ownerId: "session-1", contentVersionId: "missing" }),
    ]);
  });

  it("treats legacy and null-pin drain counts as observable migration state", () => {
    expect(characterSoulAuthorityIsLaunchSafe({
      topologyMode: "same_cluster_views",
      parityMismatches: 0,
      invalidSnapshots: 0,
      nullPinSessions: 271,
      legacyServingSnapshots: 15,
      legacyCurrentPointers: 0,
    })).toBe(true);
    expect(characterSoulAuthorityIsLaunchSafe({
      topologyMode: "same_cluster_views",
      parityMismatches: 0,
      invalidSnapshots: 1,
      nullPinSessions: 0,
      legacyServingSnapshots: 0,
      legacyCurrentPointers: 0,
    })).toBe(false);
    expect(characterSoulAuthorityIsLaunchSafe({
      topologyMode: "same_cluster_views",
      parityMismatches: 0,
      invalidSnapshots: 0,
      nullPinSessions: -1,
      legacyServingSnapshots: 0,
      legacyCurrentPointers: 0,
    })).toBe(false);
  });

  it("reads pinned Chat sessions through the Chat database role", async () => {
    const mainRows = [
      [{
        database: "idream",
        characterView: "core.chat_character_view",
        contentView: "core.chat_character_content_version_view",
        releaseView: "core.chat_character_release_view",
      }],
      [],
      [],
      [],
    ];
    const mainDb = {
      $queryRaw: async () => {
        const next = mainRows.shift();
        if (!next) throw new Error("Main role cannot read chat.chat_sessions");
        return next;
      },
      characterContentVersion: { findMany: async () => [] },
    };
    const chatRows = [
      [{ database: "idream" }],
      [],
      [{ active: 0n, nullPins: 0n }],
    ];
    const chatDb = {
      $queryRaw: async () => chatRows.shift() ?? [],
    };

    const audit = await (
      auditCharacterSoulAuthority as unknown as (
        main: typeof mainDb,
        chat: typeof chatDb,
      ) => ReturnType<typeof auditCharacterSoulAuthority>
    )(mainDb, chatDb);

    expect(audit.ok).toBe(true);
    expect(audit.drain).toMatchObject({
      activeSessions: 0,
      nullPinSessions: 0,
      legacyPinnedSessions: 0,
    });
  });
});
