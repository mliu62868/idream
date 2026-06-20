import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendLine,
  chatFsPaths,
  deletePrefix,
  fileSize,
  listPrefix,
  readWhole,
  writeAtomic,
} from "./chat-fs.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "chatfs-"));
  process.env.CHAT_FS_ROOT = dir;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("chat-fs", () => {
  it("appends jsonl lines (append-only trace)", async () => {
    const p = chatFsPaths.sessionLog("u1", "s1");
    await appendLine(p, JSON.stringify({ seq: 1 }));
    await appendLine(p, JSON.stringify({ seq: 2 }));
    const content = await readWhole(p);
    expect(content).toBe('{"seq":1}\n{"seq":2}\n');
  });

  it("writeAtomic replaces whole file", async () => {
    const p = chatFsPaths.memory("u1", "c1");
    await writeAtomic(p, "v1");
    await writeAtomic(p, "v2");
    expect(await readWhole(p)).toBe("v2");
  });

  it("readWhole returns null for missing file", async () => {
    expect(await readWhole(chatFsPaths.boundaries("nobody"))).toBeNull();
    expect(await fileSize(chatFsPaths.boundaries("nobody"))).toBe(0);
  });

  it("listPrefix + deletePrefix cover a user partition (privacy delete)", async () => {
    await appendLine(chatFsPaths.sessionLog("u9", "s1"), "{}");
    await writeAtomic(chatFsPaths.memory("u9", "c1"), "m");
    await writeAtomic(chatFsPaths.boundaries("u9"), "b");
    const before = await listPrefix(chatFsPaths.userPrefix("u9"));
    // listPrefix is rooted at CHAT_FS_ROOT; user files live under sessions/ and mem/
    expect((await listPrefix(["sessions", "u9"])).length).toBe(1);
    expect((await listPrefix(["mem", "u9"])).length).toBe(2);
    void before;
    await deletePrefix(["sessions", "u9"]);
    await deletePrefix(["mem", "u9"]);
    expect(await listPrefix(["sessions", "u9"])).toEqual([]);
    expect(await listPrefix(["mem", "u9"])).toEqual([]);
  });

  it("rejects path traversal in ids", async () => {
    await expect(appendLine(chatFsPaths.sessionLog("../etc", "s"), "x")).rejects.toThrow(
      /unsafe path segment/,
    );
  });
});
