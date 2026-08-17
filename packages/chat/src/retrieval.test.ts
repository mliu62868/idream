import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { appendLine, chatFsPaths } from "./chat-fs.js";
import { consolidateMemories, listMemories } from "./memories.js";
import { readBoundaries, retrieveMemories } from "./retrieval.js";

let dir: string;
const U = "u1";
const C = "c1";

// three memory lines (newest last) + one boundary
const MEM = [
  "- [preference] User likes being called Mei. <!-- src:m1 mid:mem_1 conf:0.84 -->",
  "- [user_fact] User is a teacher who loves hiking. <!-- src:m2 mid:mem_2 conf:0.7 -->",
  "- [preference] User enjoys jazz music. <!-- src:m3 mid:mem_3 conf:0.8 -->",
];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "retr-"));
  process.env.CHAT_FS_ROOT = dir;
  delete process.env.CHAT_MEMORY_RETRIEVAL;
  delete process.env.IGREP_BIN;
  delete process.env.CHAT_MEMORY_RETRIEVAL_TIMEOUT_MS;
  for (const l of MEM) await appendLine(chatFsPaths.memory(U, C), l);
  await appendLine(chatFsPaths.boundaries(U), "- [boundary] Do not discuss work. <!-- src:b1 mid:mem_b conf:0.9 -->");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.CHAT_MEMORY_RETRIEVAL;
  delete process.env.IGREP_BIN;
  delete process.env.CHAT_MEMORY_RETRIEVAL_TIMEOUT_MS;
});

/** Write an executable fake igrep that prints `stdout` (after optional sleep). */
async function fakeIgrep(stdout: string, sleepSec = 0): Promise<string> {
  const bin = path.join(dir, "fake-igrep.sh");
  const body = stdout.replace(/'/g, "'\\''");
  await writeFile(bin, `#!/bin/sh\n${sleepSec ? `sleep ${sleepSec}\n` : ""}printf '%s' '${body}'\n`, "utf8");
  await chmod(bin, 0o755);
  return bin;
}

describe("readBoundaries (P0-G: non-degradable)", () => {
  it("reads the global boundaries in full", async () => {
    expect(await readBoundaries(U)).toEqual(["Do not discuss work."]);
  });

  it("returns [] when the boundaries file is absent (ENOENT)", async () => {
    expect(await readBoundaries("no_such_user")).toEqual([]);
  });

  it("fails closed: a genuine read error (not ENOENT) propagates", async () => {
    // Replace the boundaries FILE path with a directory → readFile throws EISDIR.
    await mkdir(path.join(dir, ...chatFsPaths.boundaries("u_eisdir")), { recursive: true });
    await expect(readBoundaries("u_eisdir")).rejects.toThrow();
  });
});

describe("retrieveMemories", () => {
  it("default: highest-priority memories, with a slot reserved for the newest", async () => {
    const r = await retrieveMemories({ userId: U, characterId: C, query: "anything", max: 2 });
    // priority slot → the strongest line (preference, conf .84) even though it is
    // the OLDEST; reserved recency slot → the newest. The middle-ranked user_fact
    // (conf .7) is the one that loses.
    expect(r).toEqual(["User likes being called Mei.", "User enjoys jazz music."]);
  });

  it("igrep: ranks by relevance, intersected with authoritative memories", async () => {
    // fake igrep surfaces the jazz line first (one JSON result, content has Ln rows)
    const content = `L1: ${MEM[2]}\\nL2: ${MEM[0]}`;
    process.env.IGREP_BIN = await fakeIgrep(`{"ref":"memory.md:1-3","score":0.9,"content":"${content}"}\n`);
    process.env.CHAT_MEMORY_RETRIEVAL = "igrep";
    // max=2 so the igrep ranking fully determines the result (no recency backfill).
    const r = await retrieveMemories({ userId: U, characterId: C, query: "music", max: 2 });
    expect(r[0]).toBe("User enjoys jazz music."); // igrep relevance owns the top slot
    expect(r).toContain("User likes being called Mei.");
    // a line igrep never surfaced (hiking) is absent when max < total
    expect(r).not.toContain("User is a teacher who loves hiking.");
  });

  it("igrep mode backfills with recency so it never drops recent context", async () => {
    // igrep surfaces only the oldest line; recency must still fill the rest.
    const content = `L1: ${MEM[0]}`; // only "Mei" (oldest)
    process.env.IGREP_BIN = await fakeIgrep(`{"ref":"memory.md:1-3","score":0.5,"content":"${content}"}\n`);
    process.env.CHAT_MEMORY_RETRIEVAL = "igrep";
    const r = await retrieveMemories({ userId: U, characterId: C, query: "x", max: 2 });
    expect(r[0]).toBe("User likes being called Mei."); // igrep hit first
    expect(r[1]).toBe("User enjoys jazz music."); // most-recent backfill
    expect(r).toHaveLength(2);
  });

  it("igrep timeout → degrades to the default ranking", async () => {
    process.env.IGREP_BIN = await fakeIgrep("{}", 2); // sleeps past the timeout
    process.env.CHAT_MEMORY_RETRIEVAL = "igrep";
    process.env.CHAT_MEMORY_RETRIEVAL_TIMEOUT_MS = "150";
    const r = await retrieveMemories({ userId: U, characterId: C, query: "music", max: 2 });
    expect(r).toEqual(["User likes being called Mei.", "User enjoys jazz music."]);
  });

  it("igrep empty/garbage output → degrades to the default ranking", async () => {
    process.env.IGREP_BIN = await fakeIgrep("not json\n\n");
    process.env.CHAT_MEMORY_RETRIEVAL = "igrep";
    const r = await retrieveMemories({ userId: U, characterId: C, query: "music", max: 2 });
    expect(r).toEqual(["User likes being called Mei.", "User enjoys jazz music."]);
  });
});

// The reason retrieval was rebuilt on memoryPriority: eviction and retrieval used
// to disagree, so the memories kept on disk were exactly the ones that could no
// longer be retrieved — a companion that "remembers" your birthday in a file it
// never reads.
describe("retrieveMemories priority (the long-conversation guarantee)", () => {
  const LONG = "u_long";
  const event = (i: number) => ({
    scope: "character" as const,
    type: "shared_event",
    text: `We talked about the weather on day ${i}.`,
    confidence: 0.6,
    sourceMessageIds: [`m_evt_${i}`],
  });

  it("recalls an old high-confidence fact after the file churns past its storage cap", async () => {
    // turn 3: the fact that makes the companion feel known.
    await consolidateMemories(
      LONG,
      C,
      [{ scope: "character", type: "user_fact", text: "User's birthday is March 3.", confidence: 0.9, sourceMessageIds: ["m_3"] }],
      { maxStored: 30 },
    );
    // turns 4..500-ish: small talk, twice the storage cap worth of it.
    for (let i = 0; i < 60; i++) {
      await consolidateMemories(LONG, C, [event(i)], { maxStored: 30 });
    }

    const stored = await listMemories(LONG, C);
    expect(stored).toHaveLength(30); // cap enforced
    expect(stored.map((m) => m.text)).toContain("User's birthday is March 3."); // survived eviction

    const retrieved = await retrieveMemories({ userId: LONG, characterId: C, query: "hey", max: 6 });
    expect(retrieved).toContain("User's birthday is March 3."); // …and still reaches the prompt
    expect(retrieved).toContain("We talked about the weather on day 59."); // freshness intact
  });

  it("reserves reply slots for the newest lines even when older facts outrank them", async () => {
    for (let i = 0; i < 10; i++) {
      await appendLine(
        chatFsPaths.memory(LONG, C),
        `- [user_fact] User fact number ${i}. <!-- src:m_f${i} mid:mem_f${i} conf:0.9 -->`,
      );
    }
    await appendLine(chatFsPaths.memory(LONG, C), "- [shared_event] We watched the rain. <!-- src:m_r mid:mem_r conf:0.6 -->");
    await appendLine(chatFsPaths.memory(LONG, C), "- [shared_event] We named the cat. <!-- src:m_c mid:mem_c conf:0.6 -->");

    const r = await retrieveMemories({ userId: LONG, characterId: C, query: "hey", max: 6 });
    expect(r).toHaveLength(6);
    // 1/3 reserve → the two newest events keep their seats; priority takes the rest.
    expect(r).toContain("We named the cat.");
    expect(r).toContain("We watched the rain.");
    expect(r.filter((t) => t.startsWith("User fact number"))).toHaveLength(4);
  });

  it("treats an unscored (conf 0) identity fact as unscored, not worthless", async () => {
    // What the LLM extractor writes when it declines to score a semantic memory.
    await appendLine(chatFsPaths.memory(LONG, C), "- [user_fact] User's dog is named Pixel. <!-- src:m_d mid:mem_d conf:0 -->");
    for (let i = 0; i < 5; i++) {
      await appendLine(chatFsPaths.memory(LONG, C), `- [note] Chatted about nothing ${i}. <!-- src:m_n${i} mid:mem_n${i} conf:0.9 -->`);
    }
    const r = await retrieveMemories({ userId: LONG, characterId: C, query: "hey", max: 3 });
    expect(r).toContain("User's dog is named Pixel."); // outranks confident small talk
  });
});
