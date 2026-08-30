import { describe, expect, it } from "vitest";
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
});
