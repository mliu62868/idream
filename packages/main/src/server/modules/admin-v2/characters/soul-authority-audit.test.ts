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
      characterPromise: "A candid neighbor.",
      detailsMarkdown: "Direct.",
    });
    if (!compiled.ok) throw new Error("fixture compilation failed");
    const result = auditSoulSnapshots([
      { ownerType: "serving_release", ownerId: "character-1", contentVersionId: "v1" },
      { ownerType: "pinned_session", ownerId: "session-1", contentVersionId: "missing" },
    ], [{ id: "v1", personaSnapshot: compiled.snapshot }]);
    expect(result).toMatchObject({ referenced: 2, valid: 1, current: 1, historical: 0 });
    expect(result.invalid).toEqual([
      expect.objectContaining({ ownerId: "session-1", contentVersionId: "missing" }),
    ]);
  });

  it("blocks launch until legacy and null-pin migration state is drained", () => {
    expect(characterSoulAuthorityIsLaunchSafe({
      topologyMode: "main_turn_ledger",
      parityMismatches: 0,
      invalidSnapshots: 0,
      nullPinSessions: 271,
      legacyPinnedSessions: 0,
      legacyServingSnapshots: 15,
      legacyCurrentPointers: 0,
    })).toBe(false);
    expect(characterSoulAuthorityIsLaunchSafe({
      topologyMode: "main_turn_ledger",
      parityMismatches: 0,
      invalidSnapshots: 0,
      nullPinSessions: 0,
      legacyPinnedSessions: 0,
      legacyServingSnapshots: 0,
      legacyCurrentPointers: 0,
    })).toBe(true);
    expect(characterSoulAuthorityIsLaunchSafe({
      topologyMode: "main_turn_ledger",
      parityMismatches: 0,
      invalidSnapshots: 0,
      nullPinSessions: 0,
      legacyPinnedSessions: 1,
      legacyServingSnapshots: 0,
      legacyCurrentPointers: 0,
    })).toBe(false);
    expect(characterSoulAuthorityIsLaunchSafe({
      topologyMode: "main_turn_ledger",
      parityMismatches: 0,
      invalidSnapshots: 1,
      nullPinSessions: 0,
      legacyPinnedSessions: 0,
      legacyServingSnapshots: 0,
      legacyCurrentPointers: 0,
    })).toBe(false);
    expect(characterSoulAuthorityIsLaunchSafe({
      topologyMode: "main_turn_ledger",
      parityMismatches: 0,
      invalidSnapshots: 0,
      nullPinSessions: -1,
      legacyPinnedSessions: 0,
      legacyServingSnapshots: 0,
      legacyCurrentPointers: 0,
    })).toBe(false);
  });

  it("reads pinned Chat sessions from Main's Turn ledger", async () => {
    const mainRows = [
      [{ database: "idream" }],
      [],
      [],
      [],
      [{ active: BigInt(0), nullPins: BigInt(0) }],
    ];
    const mainDb = {
      $queryRaw: async () => {
        const next = mainRows.shift();
        if (!next) throw new Error("Main role cannot read chat.chat_sessions");
        return next;
      },
      characterContentVersion: { findMany: async () => [] },
    };
    const audit = await (
      auditCharacterSoulAuthority as unknown as (
        main: typeof mainDb,
      ) => ReturnType<typeof auditCharacterSoulAuthority>
    )(mainDb);

    expect(audit.ok).toBe(true);
    expect(audit.drain).toMatchObject({
      activeSessions: 0,
      nullPinSessions: 0,
      legacyPinnedSessions: 0,
    });
  });
});
