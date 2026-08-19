import { describe, expect, it } from "vitest";
import {
  genericMemoryOwnedByCompanionRuntime,
  pinCompanionRuntimeForAttempt,
  resolveCompanionRuntimeConfig,
  selectCompanionRuntimeForAttempt,
} from "./companion-runtime-selection.js";

describe("companion runtime selection", () => {
  it("keeps the existing native and legacy-memory path as the safe default", () => {
    expect(resolveCompanionRuntimeConfig({})).toMatchObject({
      runtime: "native",
      memoryBackend: "legacy",
    });
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
      DSH_PROFILE_NORMAL: "relationship-profile",
      DSH_PROFILE_PRIVATE: "private-profile",
    });

    expect(
      selectCompanionRuntimeForAttempt({
        config,
        memoryAuthority: "enabled",
      }),
    ).toMatchObject({ runtime: "dsh", profile: "relationship-profile", private: false });
    expect(
      selectCompanionRuntimeForAttempt({
        config,
        memoryAuthority: "disabled",
      }),
    ).toMatchObject({ runtime: "dsh", profile: "private-profile", private: true });
  });

  it("rejects invalid enum values instead of silently changing authority", () => {
    expect(() =>
      resolveCompanionRuntimeConfig({ CHAT_COMPANION_RUNTIME: "typo" }),
    ).toThrow(/CHAT_COMPANION_RUNTIME/);
  });

  it("fails a retry when deployment routing drifted after the attempt was pinned", () => {
    const native = resolveCompanionRuntimeConfig({});
    expect(() =>
      pinCompanionRuntimeForAttempt({
        config: native,
        memoryAuthority: "enabled",
        priorPin: {
          runtime: "dsh",
          memoryBackend: "igrep-dsh",
          profile: "idream-companion-memory",
          private: false,
        },
      }),
    ).toThrow(/pinned companion runtime/);
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
