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
      DSH_PROFILE_NORMAL: "idream-companion-memory",
      DSH_PROFILE_PRIVATE: "idream-companion-private",
    });

    expect(
      selectCompanionRuntimeForAttempt({
        config,
        memoryAuthority: "enabled",
      }),
    ).toMatchObject({ runtime: "dsh", profile: "idream-companion-memory", private: false });
    expect(
      selectCompanionRuntimeForAttempt({
        config,
        memoryAuthority: "disabled",
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
      priorPin: {
        runtime: "native",
        memoryBackend: "legacy",
        profile: "native",
        private: false,
      },
    })).toThrow(/immutable memory authority/);
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
