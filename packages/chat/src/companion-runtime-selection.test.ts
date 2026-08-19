import { describe, expect, it } from "vitest";
import {
  genericMemoryOwnedByCompanionRuntime,
  pinCompanionRuntimeForAttempt,
  resolveCompanionRuntimeConfig,
  selectCompanionRuntimeForAttempt,
} from "./companion-runtime-selection.js";

describe("companion runtime selection", () => {
  it("keeps the existing native and legacy-memory path as the safe default", () => {
    const config = resolveCompanionRuntimeConfig({});
    expect(config).toMatchObject({
      runtime: "native",
      memoryBackend: "legacy",
      dshRollout: { thresholdBps: 0, allowlist: [] },
      dshShadow: { enabled: false },
    });
    expect(selectCompanionRuntimeForAttempt({
      config,
      memoryAuthority: "enabled",
      userId: "user_1",
      characterId: "char_1",
    })).toMatchObject({
      runtime: "native",
      memoryBackend: "legacy",
      assignment: {
        policyVersion: 1,
        reason: "disabled",
        thresholdBps: 0,
        bucketBps: null,
      },
    });
  });

  it("enables DSH shadow only as an explicit token-authenticated native comparison", () => {
    expect(resolveCompanionRuntimeConfig({
      CHAT_COMPANION_DSH_SHADOW_ENABLED: "true",
      DSH_AGENT_TOKEN: "secret",
    })).toMatchObject({
      runtime: "native",
      memoryBackend: "legacy",
      dshShadow: { enabled: true },
    });
    expect(() => resolveCompanionRuntimeConfig({
      CHAT_COMPANION_DSH_SHADOW_ENABLED: "true",
    })).toThrow(/DSH_AGENT_TOKEN/);
    expect(() => resolveCompanionRuntimeConfig({
      CHAT_COMPANION_DSH_SHADOW_ENABLED: "1",
      DSH_AGENT_TOKEN: "secret",
    })).toThrow(/SHADOW_ENABLED/);
    expect(() => resolveCompanionRuntimeConfig({
      CHAT_COMPANION_RUNTIME: "dsh",
      CHAT_MEMORY_BACKEND: "igrep-dsh",
      CHAT_COMPANION_DSH_SHADOW_ENABLED: "true",
      DSH_AGENT_TOKEN: "secret",
      CHAT_COMPANION_DSH_ROLLOUT_SALT: "phase4-stable-salt",
    })).toThrow(/shadow.*native/i);
  });

  it("fails closed when DSH is paired with the legacy memory workers", () => {
    expect(() =>
      resolveCompanionRuntimeConfig({
        CHAT_COMPANION_RUNTIME: "dsh",
        CHAT_MEMORY_BACKEND: "legacy",
        DSH_AGENT_TOKEN: "secret",
      }),
    ).toThrow(/CHAT_MEMORY_BACKEND=igrep-dsh/);
  });

  it("requires a sidecar token before admitting DSH turns", () => {
    expect(() =>
      resolveCompanionRuntimeConfig({
        CHAT_COMPANION_RUNTIME: "dsh",
        CHAT_MEMORY_BACKEND: "igrep-dsh",
      }),
    ).toThrow(/DSH_AGENT_TOKEN/);
  });

  it("pins normal and no-memory attempts to different profiles", () => {
    const config = resolveCompanionRuntimeConfig({
      CHAT_COMPANION_RUNTIME: "dsh",
      CHAT_MEMORY_BACKEND: "igrep-dsh",
      DSH_AGENT_TOKEN: "secret",
      CHAT_COMPANION_DSH_ROLLOUT_SALT: "phase4-stable-salt",
      CHAT_COMPANION_DSH_ROLLOUT_BPS: "10000",
      DSH_PROFILE_NORMAL: "idream-companion-memory",
      DSH_PROFILE_PRIVATE: "idream-companion-private",
    });

    expect(
      selectCompanionRuntimeForAttempt({
        config,
        memoryAuthority: "enabled",
        userId: "user_1",
        characterId: "char_1",
      }),
    ).toMatchObject({ runtime: "dsh", profile: "idream-companion-memory", private: false });
    expect(
      selectCompanionRuntimeForAttempt({
        config,
        memoryAuthority: "disabled",
        userId: "user_1",
        characterId: "char_1",
      }),
    ).toMatchObject({ runtime: "dsh", profile: "idream-companion-private", private: true });
  });

  it("rejects profile names the programmatic sidecar cannot load", () => {
    expect(() => resolveCompanionRuntimeConfig({
      DSH_PROFILE_NORMAL: "claimed-but-not-loaded",
    })).toThrow(/DSH_PROFILE_NORMAL must be idream-companion-memory/);
  });

  it("rejects invalid enum values instead of silently changing authority", () => {
    expect(() =>
      resolveCompanionRuntimeConfig({ CHAT_COMPANION_RUNTIME: "typo" }),
    ).toThrow(/CHAT_COMPANION_RUNTIME/);
  });

  it("keeps a retried attempt on its durable DSH route after a deployment rollback", () => {
    const native = resolveCompanionRuntimeConfig({});
    expect(
      pinCompanionRuntimeForAttempt({
        config: native,
        memoryAuthority: "enabled",
        userId: "user_1",
        characterId: "char_1",
        priorPin: {
          runtime: "dsh",
          memoryBackend: "igrep-dsh",
          profile: "idream-companion-memory",
          private: false,
          sidecarUrl: "http://127.0.0.1:3199",
          deadlineMs: 42_000,
        },
      }),
    ).toMatchObject({
      runtime: "dsh",
      memoryBackend: "igrep-dsh",
      profile: "idream-companion-memory",
      sidecarUrl: "http://127.0.0.1:3199",
      deadlineMs: 42_000,
    });
  });

  it("still rejects a retry pin that conflicts with immutable no-memory authority", () => {
    expect(() => pinCompanionRuntimeForAttempt({
      config: resolveCompanionRuntimeConfig({}),
      memoryAuthority: "disabled",
      userId: "user_1",
      characterId: "char_1",
      priorPin: {
        runtime: "native",
        memoryBackend: "legacy",
        profile: "native",
        private: false,
      },
    })).toThrow(/pin is invalid/);
  });

  it("keeps a retried attempt on its persisted pin after rollout changes", () => {
    const native = resolveCompanionRuntimeConfig({});
    expect(pinCompanionRuntimeForAttempt({
      config: native,
      memoryAuthority: "enabled",
      userId: "user_1",
      characterId: "char_1",
      priorPin: {
        runtime: "dsh",
        memoryBackend: "igrep-dsh",
        profile: "idream-companion-memory",
        private: false,
        sidecarUrl: "http://127.0.0.1:3199",
        deadlineMs: 42_000,
        assignment: {
          policyVersion: 1,
          cohortKeyHash: "persisted-hash",
          bucketBps: 4292,
          thresholdBps: 5000,
          reason: "threshold",
        },
      },
    })).toMatchObject({
      runtime: "dsh",
      memoryBackend: "igrep-dsh",
      sidecarUrl: "http://127.0.0.1:3199",
      deadlineMs: 42_000,
      assignment: { cohortKeyHash: "persisted-hash", reason: "threshold" },
    });
  });

  it("assigns a stable relationship cohort by salted basis-point threshold", () => {
    const config = resolveCompanionRuntimeConfig({
      CHAT_COMPANION_RUNTIME: "dsh",
      CHAT_MEMORY_BACKEND: "igrep-dsh",
      DSH_AGENT_TOKEN: "secret",
      CHAT_COMPANION_DSH_ROLLOUT_SALT: "phase4-stable-salt",
      CHAT_COMPANION_DSH_ROLLOUT_BPS: "1000",
    });

    const outside = selectCompanionRuntimeForAttempt({
      config,
      memoryAuthority: "enabled",
      userId: "user_1",
      characterId: "char_1",
    });
    const inside = selectCompanionRuntimeForAttempt({
      config,
      memoryAuthority: "enabled",
      userId: "user_2",
      characterId: "char_1",
    });

    expect(outside).toMatchObject({
      runtime: "native",
      memoryBackend: "legacy",
      assignment: { bucketBps: 4292, thresholdBps: 1000, reason: "outside_cohort" },
    });
    expect(inside).toMatchObject({
      runtime: "dsh",
      memoryBackend: "igrep-dsh",
      assignment: { bucketBps: 418, thresholdBps: 1000, reason: "threshold" },
    });
    expect(selectCompanionRuntimeForAttempt({
      config,
      memoryAuthority: "disabled",
      userId: "user_2",
      characterId: "char_1",
    }).assignment).toEqual(inside.assignment);
  });

  it("lets an exact relationship allowlist override a zero threshold", () => {
    const config = resolveCompanionRuntimeConfig({
      CHAT_COMPANION_RUNTIME: "dsh",
      CHAT_MEMORY_BACKEND: "igrep-dsh",
      DSH_AGENT_TOKEN: "secret",
      CHAT_COMPANION_DSH_ROLLOUT_SALT: "phase4-stable-salt",
      CHAT_COMPANION_DSH_ROLLOUT_ALLOWLIST: "user_1:char_1",
    });

    expect(selectCompanionRuntimeForAttempt({
      config,
      memoryAuthority: "enabled",
      userId: "user_1",
      characterId: "char_1",
    })).toMatchObject({ runtime: "dsh", assignment: { reason: "allowlist" } });
    expect(selectCompanionRuntimeForAttempt({
      config,
      memoryAuthority: "enabled",
      userId: "user_1",
      characterId: "char_2",
    })).toMatchObject({ runtime: "native", assignment: { reason: "outside_cohort" } });
  });

  it("rejects unsafe rollout env instead of silently changing cohort authority", () => {
    expect(() => resolveCompanionRuntimeConfig({
      CHAT_COMPANION_RUNTIME: "dsh",
      CHAT_MEMORY_BACKEND: "igrep-dsh",
      DSH_AGENT_TOKEN: "secret",
      CHAT_COMPANION_DSH_ROLLOUT_BPS: "1",
    })).toThrow(/ROLLOUT_SALT/);
    expect(() => resolveCompanionRuntimeConfig({
      CHAT_COMPANION_DSH_ROLLOUT_BPS: "1",
    })).toThrow(/native/);
    expect(() => resolveCompanionRuntimeConfig({
      CHAT_COMPANION_RUNTIME: "dsh",
      CHAT_MEMORY_BACKEND: "igrep-dsh",
      DSH_AGENT_TOKEN: "secret",
      CHAT_COMPANION_DSH_ROLLOUT_SALT: "phase4-stable-salt",
      CHAT_COMPANION_DSH_ROLLOUT_BPS: "10001",
    })).toThrow(/0\.\.10000/);
    expect(() => resolveCompanionRuntimeConfig({
      CHAT_COMPANION_RUNTIME: "dsh",
      CHAT_MEMORY_BACKEND: "igrep-dsh",
      DSH_AGENT_TOKEN: "secret",
      CHAT_COMPANION_DSH_ROLLOUT_SALT: "phase4-stable-salt",
      CHAT_COMPANION_DSH_ROLLOUT_ALLOWLIST: "malformed",
    })).toThrow(/ALLOWLIST/);
  });

  it("recognizes only a complete DSH runtime pin as the generic-memory owner", () => {
    expect(genericMemoryOwnedByCompanionRuntime({
      companionRuntime: {
        runtime: "dsh",
        memoryBackend: "igrep-dsh",
        profile: "normal",
        private: false,
      },
    })).toBe(true);
    expect(genericMemoryOwnedByCompanionRuntime({
      companionRuntime: { runtime: "dsh", memoryBackend: "legacy" },
    })).toBe(false);
  });
});
