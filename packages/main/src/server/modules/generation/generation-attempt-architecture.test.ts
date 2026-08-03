import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function productionTypescriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    // Never follow symlinks or descend into dot/build directories: generated
    // trees carry pre-move copies of this very code and would be read as drift.
    if (entry.isSymbolicLink() || entry.name.startsWith(".")) return [];
    if (entry.isDirectory()) return productionTypescriptFiles(filePath);
    if (!/\.tsx?$/.test(entry.name) || /(?:\.test|\.integration\.test|\.e2e)\.tsx?$/.test(entry.name)) {
      return [];
    }
    return [filePath];
  }));
  return nested.flat();
}

// SPEC: every production write to a GenerationAttempt row belongs to one of
// these three modules, for the stated reason.
// INTENT: this list is asserted by *set equality*, not as a blacklist of absent
// symbols. The previous version only forbade `create`/`upsert` outside the
// reservation authority, which never covered the write that actually decides a
// customer's money: `generationAttempt.update({ data: { status } })`. A new
// module doing exactly that passed silently, and no database constraint stands
// behind that column — the one-terminal-event-per-Attempt unique index
// constrains the event table, not the Attempt row. Per ADR-13 §3.1 a fourth
// writer now fails, and so does a stale entry that stopped writing.
const GENERATION_ATTEMPT_WRITERS: Readonly<Record<string, string>> = {
  "src/server/modules/generation/generation-attempt-authority.ts":
    "reserves the immutable Attempt together with its dispatch Outbox",
  "src/server/ai/generation-attempt-events.ts":
    "sole owner of GenerationAttempt.status, behind the append-only event log",
  "src/server/ai/generation-terminal-record-ingest.ts":
    "binds provider and terminalRecordRef evidence; must never write status",
};

describe("GenerationAttempt write authority boundary", () => {
  it("keeps every production Attempt row write inside the declared authorities", async () => {
    const root = path.join(process.cwd(), "src");
    const files = await productionTypescriptFiles(root);

    // Self-check: a renamed directory must fail loudly instead of scanning an
    // empty set and reporting green.
    expect(files.length).toBeGreaterThan(200);
    for (const declared of Object.keys(GENERATION_ATTEMPT_WRITERS)) {
      expect(files).toContain(path.join(process.cwd(), declared));
    }

    const writers: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/generationAttempt\.(?:create|upsert|update|updateMany)\s*\(/.test(source)) {
        writers.push(path.relative(process.cwd(), file));
      }
    }

    expect(writers.sort()).toEqual(Object.keys(GENERATION_ATTEMPT_WRITERS).sort());
  });

  it("keeps generation queue enqueue behind the Outbox dispatcher", async () => {
    const dispatchBuilder = await readFile(
      path.join(process.cwd(), "src/server/modules/generation/attempt-dispatch.ts"),
      "utf8",
    );
    const authority = await readFile(
      path.join(
        process.cwd(),
        "src/server/modules/generation/generation-attempt-authority.ts",
      ),
      "utf8",
    );

    expect(dispatchBuilder).not.toContain("jobQueue.enqueue(");
    expect(dispatchBuilder).not.toContain("generationAttempt.create(");
    expect(dispatchBuilder).not.toContain("generationAttempt.upsert(");
    expect(authority.match(/jobQueue\.enqueue\(/g)).toHaveLength(1);
  });
});
