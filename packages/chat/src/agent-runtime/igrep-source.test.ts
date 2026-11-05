import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createIgrepTools, type JsonCommandOptions } from "./igrep";

let root: string;
const path = "conversation.jsonl";
const fingerprint = `sha256:${"a".repeat(64)}`;
const cli = { command: "/runtime/igrep", env: { IGREP_NO_CACHE: "1" } };
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "chat-source-read-")));
  await writeFile(join(root, path), "First line\n海豚🙂\nthird line\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));
function page(overrides: Record<string, unknown> = {}) {
  return { schema_version: 1, path: join(root, path), content: "海豚", fingerprint,
    source_sha256: "b".repeat(64), content_kind: "text", coverage: "complete", encoding: "utf-8",
    lossy: false, warnings: [], range: { start_line: 2, end_line: 3, byte_start: 0, byte_end: 6 },
    line_space: "original", truncated: true, next_offset: 6, ...overrides };
}
function tool(run: (command: JsonCommandOptions) => Promise<unknown>, observe?: Parameters<typeof createIgrepTools>[0]["observe"]) {
  return createIgrepTools({ cli, workspace: "/relationship", knowledgePath: root, mode: "private", run, observe,
    recall: async () => { throw new Error("source read must not access session recall"); },
  }).find(item => item.name === "igrep_read_source")!;
}

it("reads only the authorized source and preserves versioned UTF-8 continuation arguments", async () => {
  const calls: JsonCommandOptions[] = [];
  const observations: unknown[] = [];
  const reader = tool(async command => {
    calls.push(command);
    return calls.length === 1 ? page() : page({ content: "🙂\nthird line\n", truncated: false, next_offset: null,
      range: { start_line: 2, end_line: 3, byte_start: 6, byte_end: 22 } });
  }, event => observations.push(event));
  const signal = new AbortController().signal;
  const first = await reader.execute({ path, start_line: 2, end_line: 3 }, signal) as { results: unknown[]; next: Record<string, unknown> };
  expect(first.next).toEqual({ path, start_line: 2, end_line: 3, offset: 6, fingerprint });
  const second = await reader.execute(first.next, signal) as { results: Array<{ content: string }>; next: null };
  expect(second.next).toBeNull();
  expect(second.results[0]?.content).toBe("🙂\nthird line\n");
  expect(JSON.stringify(first)).not.toContain(root);
  expect(calls[0]).toEqual({ ...cli, args: ["read-source", "--root", root, "--start-line", "2", "--end-line", "3", "--offset", "0", "--max-bytes", "6000", "--", path], timeoutMs: 10000, signal });
  expect(calls[1]?.args).toContain("--expected-fingerprint");
  expect(observations).toEqual([expect.objectContaining({ operation: "search", outcome: "hit", resultCount: 1 }), expect.objectContaining({ operation: "search", outcome: "hit", resultCount: 1 })]);
});

it.each([
  { path: "../private" }, { path: "/private" }, { path: "a/../../private" }, { path: "a\\private" },
  { path: "conversation.jsonl\n" }, { path, offset: 1 }, { path, start_line: 0 },
  { path, start_line: 3, end_line: 2 }, { path, fingerprint: "unknown" },
])("rejects unscoped paths and unversioned or invalid pages before dispatch (%j)", async args => {
  let calls = 0;
  await expect(tool(async () => { calls++; return page(); }).execute(args, new AbortController().signal)).rejects.toThrow();
  expect(calls).toBe(0);
});

it("refuses linked sources and cancellation before launching the CLI", async () => {
  await symlink(join(root, path), join(root, "linked.jsonl"));
  let calls = 0;
  const reader = tool(async () => { calls++; return page(); });
  await expect(reader.execute({ path: "linked.jsonl" }, new AbortController().signal)).rejects.toThrow("unverifiable evidence");
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(reader.execute({ path }, controller.signal)).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
});

it.each([
  { path: "/different-source" }, { coverage: "partial" }, { lossy: true }, { warnings: ["incomplete"] },
  { fingerprint: `sha256:${"c".repeat(64)}` }, { content: "x".repeat(6001) }, { next_offset: 0 },
  { truncated: false }, { range: { start_line: 2, end_line: 3, byte_start: 0, byte_end: 5 } },
])("rejects forged, changed or incomplete source evidence (%j)", async overrides => {
  const observations: unknown[] = [];
  await expect(tool(async () => page(overrides), event => observations.push(event))
    .execute({ path, start_line: 2, end_line: 3, fingerprint }, new AbortController().signal)).rejects.toThrow("unverifiable evidence");
  expect(observations).toEqual([expect.objectContaining({ operation: "search", outcome: "failure" })]);
});
