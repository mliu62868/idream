import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendLine, chatFsPaths, readWhole } from "./chat-fs.js";
import {
  deleteMemory,
  forgetByMessageIds,
  listMemories,
  parseLine,
  updateMemory,
} from "./memories.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mem-"));
  process.env.CHAT_FS_ROOT = dir;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Two memory lines (one new-format with mid, one legacy without) + a boundary.
async function seed(): Promise<void> {
  await appendLine(
    chatFsPaths.memory("u1", "c1"),
    "- [preference] User likes being called Mei. <!-- src:msg_a mid:mem_fixed1 conf:0.84 -->",
  );
  await appendLine(
    chatFsPaths.memory("u1", "c1"),
    "- [user_fact] User is a teacher. <!-- src:msg_b conf:0.7 -->", // legacy, hash id
  );
  await appendLine(
    chatFsPaths.boundaries("u1"),
    "- [boundary] Do not bring up work. <!-- src:msg_c mid:mem_b1 conf:0.9 -->",
  );
}

describe("memories", () => {
  it("parseLine extracts type/text/src/mid", () => {
    const p = parseLine("c1", "- [preference] Likes tea. <!-- src:m1,m2 mid:mem_x conf:0.5 -->", 0);
    expect(p).toMatchObject({
      id: "mem_x",
      characterId: "c1",
      type: "preference",
      text: "Likes tea.",
      sourceMessageIds: ["m1", "m2"],
      confidence: 0.5,
    });
    expect(parseLine("c1", "## heading", 0)).toBeNull();
    expect(parseLine("c1", "", 0)).toBeNull();
  });

  it("legacy line (no mid) gets a stable hash id across reads", async () => {
    await seed();
    const a = await listMemories("u1", "c1");
    const b = await listMemories("u1", "c1");
    const legacyA = a.find((m) => m.text.startsWith("User is a teacher"))!;
    const legacyB = b.find((m) => m.text.startsWith("User is a teacher"))!;
    expect(legacyA.id).toBe(legacyB.id);
    expect(legacyA.id).toMatch(/^mem_[0-9a-f]{16}$/);
  });

  it("lists character memories + global boundaries when scoped to a character", async () => {
    await seed();
    const items = await listMemories("u1", "c1");
    const types = items.map((m) => m.type).sort();
    expect(types).toEqual(["boundary", "preference", "user_fact"]);
    expect(items.find((m) => m.type === "boundary")?.characterId).toBeNull();
  });

  it("updateMemory edits text in place and keeps a stable id", async () => {
    await seed();
    const updated = await updateMemory("u1", "mem_fixed1", "User likes being called Mimi.");
    expect(updated?.id).toBe("mem_fixed1");
    expect(updated?.text).toBe("User likes being called Mimi.");
    const reread = (await listMemories("u1", "c1")).find((m) => m.id === "mem_fixed1");
    expect(reread?.text).toBe("User likes being called Mimi.");
  });

  it("deleteMemory removes the line from the authority file", async () => {
    await seed();
    expect(await deleteMemory("u1", "mem_fixed1")).toBe(true);
    const items = await listMemories("u1", "c1");
    expect(items.find((m) => m.id === "mem_fixed1")).toBeUndefined();
    // file still holds the legacy line
    expect(await readWhole(chatFsPaths.memory("u1", "c1"))).toContain("User is a teacher");
    // deleting a missing id is a no-op false
    expect(await deleteMemory("u1", "nope")).toBe(false);
  });

  it("forgetByMessageIds drops memories whose source was deleted (privacy)", async () => {
    await seed();
    const dropped = await forgetByMessageIds("u1", ["msg_a", "msg_c"]);
    expect(dropped).toBe(2); // the preference (msg_a) + the boundary (msg_c)
    const remaining = await listMemories("u1");
    expect(remaining.map((m) => m.text)).toEqual(["User is a teacher."]);
    expect(await forgetByMessageIds("u1", [])).toBe(0);
  });
});
