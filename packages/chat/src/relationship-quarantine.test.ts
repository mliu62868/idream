import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLine, chatFsPaths, listPrefix, writeAtomic } from "./chat-fs.js";
import {
  getRelationshipState,
  listRelationships,
  quarantineRelationshipFiles,
} from "./relationship.js";

let dir = "";
const previousRoot = process.env.CHAT_FS_ROOT;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "chat-relationship-quarantine-"));
  process.env.CHAT_FS_ROOT = dir;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.CHAT_FS_ROOT;
  else process.env.CHAT_FS_ROOT = previousRoot;
  await rm(dir, { recursive: true, force: true });
});

describe("relationship reset quarantine", () => {
  it("retires relationship.md and its evidence log where the product no longer reads them", async () => {
    const relationship = "---\nstage: close\nversion: 3\n---\nThey trust each other.\n";
    await writeAtomic(chatFsPaths.relationship("user-1", "mara"), relationship);
    await appendLine(chatFsPaths.relationshipEvidence("user-1", "mara"), "{\"recordType\":\"baseline\"}");
    await writeAtomic(chatFsPaths.boundaries("user-1"), "- No jokes about my weight\n");

    await quarantineRelationshipFiles("user-1", "mara", "filemut_reset_1");

    const retired = chatFsPaths.relationshipQuarantine("user-1", "mara", "filemut_reset_1");
    expect(await readFile(path.join(dir, ...retired, "relationship.md"), "utf8")).toBe(relationship);
    expect(await readFile(path.join(dir, ...retired, "relationship-evidence.jsonl"), "utf8"))
      .toBe("{\"recordType\":\"baseline\"}\n");
    await expect(stat(path.join(dir, ...chatFsPaths.relationship("user-1", "mara"))))
      .rejects.toMatchObject({ code: "ENOENT" });

    // The live bond is gone: nothing lists it and the state reads as empty.
    expect(await listRelationships("user-1")).toEqual([]);
    expect(await getRelationshipState("user-1", "mara")).toMatchObject({ stage: "new", version: 0 });
    // Boundaries are user-global and untouched by a relationship reset.
    expect(await listPrefix(["mem", "user-1", "global"])).toHaveLength(1);
  });

  it("is a no-op for a relationship that never wrote files", async () => {
    await expect(quarantineRelationshipFiles("user-1", "nobody", "filemut_reset_2")).resolves.toBeUndefined();
    expect(await listPrefix(["mem", "user-1"])).toEqual([]);
  });
});
