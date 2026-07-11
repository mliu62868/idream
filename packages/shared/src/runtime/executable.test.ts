import { describe, expect, it } from "vitest";
import { resolveExecutable } from "./executable";

describe("resolveExecutable", () => {
  it("accepts an explicit executable path", async () => {
    await expect(resolveExecutable("/usr/bin/true")).resolves.toBe("/usr/bin/true");
  });

  it("resolves a command name from the supplied PATH", async () => {
    await expect(resolveExecutable("true", "/usr/bin")).resolves.toBe("/usr/bin/true");
  });

  it("rejects a command that is not executable or on PATH", async () => {
    await expect(resolveExecutable("idream-command-that-does-not-exist", "/usr/bin")).rejects.toThrow(
      /not found on PATH/,
    );
  });
});
