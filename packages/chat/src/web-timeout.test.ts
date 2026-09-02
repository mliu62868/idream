import { describe, expect, it } from "vitest";
import {
  CHAT_RUNTIME_DIAGNOSTICS_PATH,
  chatRuntimeDiagnosticsSchema,
} from "@idream/shared/contracts";
import { handleChatRequest, requestOwnsTimeout } from "./web.js";
import { RuntimeReadiness } from "./runtime-readiness.js";

describe("Chat HTTP timeout ownership", () => {
  it("lets internally bounded long operations outlive Bun's idle timeout", () => {
    expect(requestOwnsTimeout(new URL("http://chat.internal/readyz?full=1"))).toBe(true);
    expect(requestOwnsTimeout(new URL("http://chat.internal/internal/companion-memory/rebuild/prepare"))).toBe(true);
    expect(requestOwnsTimeout(new URL("http://chat.internal/readyz"))).toBe(false);
  });

  it("keeps runtime authority behind Main's signed boundary", async () => {
    const response = await handleChatRequest(
      new Request("http://chat.internal/api/v1/chat/runtime-authority"),
      new RuntimeReadiness(),
    );

    expect(response.status).toBe(401);
  });

  it("produces the shared runtime diagnostics contract at its declared path", async () => {
    const previousToken = process.env.INTERNAL_TOKEN;
    process.env.INTERNAL_TOKEN = "runtime-diagnostics-test-token";
    try {
      const readiness = new RuntimeReadiness({ ttlMs: 60_000 });
      readiness.markReady();
      const response = await handleChatRequest(
        new Request(`http://chat.internal${CHAT_RUNTIME_DIAGNOSTICS_PATH}`, {
          headers: { "x-internal-token": "runtime-diagnostics-test-token" },
        }),
        readiness,
      );

      expect(response.status).toBe(200);
      expect(chatRuntimeDiagnosticsSchema.parse(await response.json())).toMatchObject({
        version: 1,
        service: "chat",
        runtime: { accepting: true, agentRuntime: true, fresh: true },
        provider: { adapter: "mock" },
      });
    } finally {
      if (previousToken === undefined) delete process.env.INTERNAL_TOKEN;
      else process.env.INTERNAL_TOKEN = previousToken;
    }
  });
});
