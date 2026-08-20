import { describe, expect, it } from "vitest";
import {
  pinCompanionRuntimeForAttempt,
  resolveCompanionRuntimeConfig,
  selectCompanionRuntimeForAttempt,
} from "./companion-runtime-selection.js";

const source = {
  DSH_AGENT_TOKEN: "secret",
  DSH_AGENT_URL: "http://127.0.0.1:3101",
};

describe("single companion runtime selection", () => {
  it("resolves only the DSH runtime and official igrep memory backend", () => {
    expect(resolveCompanionRuntimeConfig(source)).toEqual({
      runtime: "dsh",
      memoryBackend: "igrep-dsh",
      sidecarUrl: "http://127.0.0.1:3101",
      sidecarToken: "secret",
      normalProfile: "idream-companion-memory",
      privateProfile: "idream-companion-private",
      deadlineMs: 300_000,
    });
  });

  it("fails closed without the sidecar capability", () => {
    expect(() => resolveCompanionRuntimeConfig({})).toThrow(/DSH_AGENT_TOKEN/);
  });

  it("keeps the authenticated sidecar on loopback", () => {
    expect(() => resolveCompanionRuntimeConfig({
      ...source,
      DSH_AGENT_URL: "https://sidecar.example.com:3101",
    })).toThrow(/DSH_AGENT_URL.*loopback/);
    expect(() => resolveCompanionRuntimeConfig({
      ...source,
      DSH_AGENT_URL: "http://token@127.0.0.1:3101",
    })).toThrow(/DSH_AGENT_URL.*credentials/);
  });

  it("pins normal and private profiles without a rollout cohort", () => {
    const config = resolveCompanionRuntimeConfig(source);
    expect(selectCompanionRuntimeForAttempt({
      config,
      memoryAuthority: "enabled",
    })).toMatchObject({
      runtime: "dsh",
      memoryBackend: "igrep-dsh",
      profile: "idream-companion-memory",
      private: false,
    });
    expect(selectCompanionRuntimeForAttempt({
      config,
      memoryAuthority: "disabled",
    })).toMatchObject({
      runtime: "dsh",
      memoryBackend: "igrep-dsh",
      profile: "idream-companion-private",
      private: true,
    });
  });

  it("reuses only a complete DSH pin and rejects a native historical pin", () => {
    const config = resolveCompanionRuntimeConfig(source);
    const priorPin = {
      runtime: "dsh" as const,
      memoryBackend: "igrep-dsh" as const,
      profile: "idream-companion-memory",
      private: false,
      sidecarUrl: "http://127.0.0.1:3101",
      deadlineMs: 12_000,
    };
    expect(pinCompanionRuntimeForAttempt({
      config,
      memoryAuthority: "enabled",
      priorPin,
    })).toEqual(priorPin);
    expect(() => pinCompanionRuntimeForAttempt({
      config,
      memoryAuthority: "enabled",
      priorPin: {
        runtime: "native",
        memoryBackend: "legacy",
        profile: "native",
        private: false,
        sidecarUrl: "http://127.0.0.1:3101",
        deadlineMs: 12_000,
      },
    })).toThrow(/runtime pin is invalid/);
  });
});
