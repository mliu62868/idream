import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { appendLine, chatFsPaths } from "./chat-fs.js";
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
  it("recency (default): returns the most recent <= max memories", async () => {
    const r = await retrieveMemories({ userId: U, characterId: C, query: "anything", max: 2 });
    expect(r).toEqual(["User is a teacher who loves hiking.", "User enjoys jazz music."]);
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

  it("igrep timeout → degrades to recency", async () => {
    process.env.IGREP_BIN = await fakeIgrep("{}", 2); // sleeps past the timeout
    process.env.CHAT_MEMORY_RETRIEVAL = "igrep";
    process.env.CHAT_MEMORY_RETRIEVAL_TIMEOUT_MS = "150";
    const r = await retrieveMemories({ userId: U, characterId: C, query: "music", max: 2 });
    expect(r).toEqual(["User is a teacher who loves hiking.", "User enjoys jazz music."]);
  });

  it("igrep empty/garbage output → degrades to recency", async () => {
    process.env.IGREP_BIN = await fakeIgrep("not json\n\n");
    process.env.CHAT_MEMORY_RETRIEVAL = "igrep";
    const r = await retrieveMemories({ userId: U, characterId: C, query: "music", max: 2 });
    expect(r).toEqual(["User is a teacher who loves hiking.", "User enjoys jazz music."]);
  });
});
