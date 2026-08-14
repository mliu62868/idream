import { describe, expect, it } from "vitest";
import { chatFsRootFingerprint, resolveChatFsRoot } from "./authority";

describe("runtime authority fingerprints", () => {
  it("binds one canonical absolute Chat FS root without revealing the path", () => {
    const first = chatFsRootFingerprint("/var/lib/idream/chat");
    const equivalent = chatFsRootFingerprint("/var/lib/idream/./chat");
    const different = chatFsRootFingerprint("/var/lib/idream/chat-next");

    expect(first).toMatch(/^[a-f0-9]{64}$/u);
    expect(equivalent).toBe(first);
    expect(different).not.toBe(first);
    expect(first).not.toContain("/var/lib/idream/chat");
    expect(() => chatFsRootFingerprint("data/chat")).toThrow(
      "Chat FS authority root must be absolute",
    );
    expect(resolveChatFsRoot("./data/chat", "/srv/idream/packages/chat")).toBe(
      "/srv/idream/packages/chat/data/chat",
    );
  });
});
