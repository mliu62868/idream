import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendLine, chatFsPaths, readWhole } from "./chat-fs.js";
import {
  consolidateMemories,
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

describe("consolidateMemories (P1-C)", () => {
  const pref = (text: string, confidence: number, src: string) => ({
    scope: "character" as const,
    type: "preference",
    text,
    confidence,
    sourceMessageIds: [src],
  });

  it("dedups a repeated preference into ONE line (unions sources, keeps max confidence)", async () => {
    await consolidateMemories("u1", "c1", [pref("User likes jazz.", 0.7, "m1")], { maxStored: 30 });
    await consolidateMemories("u1", "c1", [pref("User likes jazz.", 0.9, "m2")], { maxStored: 30 });
    await consolidateMemories("u1", "c1", [pref("user likes jazz", 0.5, "m3")], { maxStored: 30 });

    const items = await listMemories("u1", "c1");
    const jazz = items.filter((m) => m.text.toLowerCase().includes("jazz"));
    expect(jazz).toHaveLength(1); // no unbounded duplicate stack
    expect(jazz[0].confidence).toBe(0.9); // new high-confidence supersedes old low
    expect(jazz[0].sourceMessageIds.sort()).toEqual(["m1", "m2", "m3"]); // union
  });

  it("keeps distinct preferences as separate lines", async () => {
    await consolidateMemories(
      "u1",
      "c1",
      [pref("User likes jazz.", 0.7, "m1"), pref("User likes hiking.", 0.7, "m2")],
      { maxStored: 30 },
    );
    const items = await listMemories("u1", "c1");
    expect(items.filter((m) => m.type === "preference")).toHaveLength(2);
  });

  it("enforces the storage cap by evicting the lowest-confidence memory", async () => {
    await consolidateMemories(
      "u1",
      "c1",
      [pref("Likes A.", 0.9, "m1"), pref("Likes B.", 0.3, "m2"), pref("Likes C.", 0.8, "m3")],
      { maxStored: 2 },
    );
    const items = await listMemories("u1", "c1");
    expect(items).toHaveLength(2);
    expect(items.map((m) => m.text)).not.toContain("Likes B."); // lowest conf evicted
  });

  it("routes boundaries to boundaries.md and never caps them", async () => {
    await consolidateMemories(
      "u1",
      "c1",
      [
        { scope: "global", type: "boundary", text: "Do not discuss work.", confidence: 0.9, sourceMessageIds: ["m1"] },
        { scope: "global", type: "boundary", text: "Do not discuss work.", confidence: 0.95, sourceMessageIds: ["m2"] },
      ],
      { maxStored: 1 },
    );
    const boundaries = (await listMemories("u1")).filter((m) => m.type === "boundary");
    expect(boundaries).toHaveLength(1); // deduped
    expect(boundaries[0].characterId).toBeNull(); // global scope file
    expect(boundaries[0].sourceMessageIds.sort()).toEqual(["m1", "m2"]);
  });
});
