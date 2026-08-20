import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendLine,
  chatFsPaths,
  deletePrefix,
  listPrefix,
  readWhole,
  writeAtomic,
  withFileMutationLock,
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
  it("appends relationship evidence lines", async () => {
    const p = chatFsPaths.relationshipEvidence("u1", "c1");
    await appendLine(p, JSON.stringify({ seq: 1 }));
    await appendLine(p, JSON.stringify({ seq: 2 }));
    const content = await readWhole(p);
    expect(content).toBe('{"seq":1}\n{"seq":2}\n');
  });

  it("writeAtomic replaces whole file", async () => {
    const p = chatFsPaths.relationship("u1", "c1");
    await writeAtomic(p, "v1");
    await writeAtomic(p, "v2");
    expect(await readWhole(p)).toBe("v2");
  });

  it("readWhole returns null for missing file", async () => {
    expect(await readWhole(chatFsPaths.boundaries("nobody"))).toBeNull();
  });

  it("listPrefix + deletePrefix cover a user partition (privacy delete)", async () => {
    await appendLine(chatFsPaths.relationshipEvidence("u9", "c1"), "{}");
    await writeAtomic(chatFsPaths.relationship("u9", "c1"), "r");
    await writeAtomic(chatFsPaths.boundaries("u9"), "b");
    expect((await listPrefix(["mem", "u9"])).length).toBe(3);
    await deletePrefix(["mem", "u9"]);
    expect(await listPrefix(["mem", "u9"])).toEqual([]);
  });

  it("rejects path traversal in ids", async () => {
    await expect(appendLine(chatFsPaths.relationshipEvidence("../etc", "c"), "x")).rejects.toThrow(
      /unsafe path segment/,
    );
  });

  it("serializes read-modify-write work for the same authority file", async () => {
    const target = chatFsPaths.relationship("u-lock", "c-lock");
    const order: string[] = [];
    let releaseFirst = (): void => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withFileMutationLock(target, async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = withFileMutationLock(target, async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });
});
