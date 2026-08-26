import { describe, expect, it } from "vitest";
import { fitRecentTranscript } from "./context.js";

describe("recent transcript clipping", () => {
  const opening = { id: "opening", role: "assistant" as const, content: "Welcome aboard.", opening: true as const };
  const exchange = [
    { id: "u1", role: "user" as const, content: "Hi there." },
    { id: "a1", role: "assistant" as const, content: "Hey you." },
    { id: "u2", role: "user" as const, content: "How was your day?" },
  ];

  it("keeps the session's pinned opening as the first assistant line", () => {
    const fitted = fitRecentTranscript([opening, ...exchange], 10_000);
    expect(fitted.messages.map((message) => message.id)).toEqual(["opening", "u1", "a1", "u2"]);
    expect(fitted.dropped).toBe(false);
  });

  it("still drops an orphaned assistant reply whose user turn fell out of the window", () => {
    const fitted = fitRecentTranscript(
      [{ id: "a0", role: "assistant", content: "Reply to a dropped message." }, ...exchange],
      10_000,
    );
    expect(fitted.messages.map((message) => message.id)).toEqual(["u1", "a1", "u2"]);
    expect(fitted.dropped).toBe(true);
  });
});
