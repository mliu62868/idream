import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recallIgrepMemory } from "./igrep";

const bindingHook = vi.hoisted(() => ({ beforeStat: undefined as ((path: string) => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    await bindingHook.beforeStat?.(String(args[0]));
    return actual.lstat(...args);
  } };
});

const temporary: string[] = [];
afterEach(async () => {
  bindingHook.beforeStat = undefined;
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const raw = [
  { role: "user", content: "明天晚上在陶艺店见。", at: "2026-09-30T23:55:00.000Z" },
  { role: "assistant", content: "收到你的约定。", at: "2026-09-30T23:55:01.000Z" },
  { role: "user", content: "昨天去了港口。I went there last Friday. Next Monday we meet again. Yesterday (2026-09-30), I wrote 'tomorrow we meet' in an old letter.", at: "2026-10-01T00:05:00.000Z" },
  { role: "assistant", content: "The old letter is a quotation, not a new plan.", at: "2026-10-01T00:05:01.000Z" },
];
const annotated = [raw[0]!.content.replace("明天", "明天（2026-10-01）"), raw[1]!.content,
  raw[2]!.content.replace("昨天", "昨天（2026-09-30）").replace("tomorrow", "tomorrow（2026-10-02）"), raw[3]!.content];

async function fixture() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "chat-recall-authority-")));
  temporary.push(workspace);
  const path = "memory/dialogues/deepseek-harness-quoted-date.jsonl";
  const dialogue = join(workspace, ".igrep/mem", path);
  const session = join(workspace, ".igrep/mem/memory/sessions/deepseek-harness-quoted-date.jsonl");
  const sources = raw.map((message, index) => ({
    schema: "igrep.mem.session/1", agent: "deepseek-harness", id: `event-${index}`,
    session_id: "quoted-date", turn_index: index + 1, role: message.role, content: message.content,
    source_at: { instant_utc: message.at, original: message.at, timezone: "UTC" },
  }));
  const views = raw.map((message, index) => [message.at, annotated[index]]);
  await mkdir(dirname(dialogue), { recursive: true });
  await mkdir(dirname(session), { recursive: true });
  const save = async () => {
    await writeFile(session, sources.map(row => JSON.stringify(row)).join("\n") + "\n");
    await writeFile(dialogue, views.map(row => JSON.stringify(row)).join("\n") + "\n");
  };
  await save();
  const hit = {
    path, startLine: 1, endLine: 4, citation: `${path}#L1-L4`, sourceClass: "dialogue",
    evidenceStatus: "active", snippet: annotated.map((text, index) => `L${index + 1}: [${raw[index]!.role} @ ${raw[index]!.at.slice(0, 10)}] ${text}`).join("\n"),
  };
  const payload = { provider: "igrep", workspaceRoot: workspace, results: [hit], warnings: [] as string[] };
  const recall = (signal?: AbortSignal) => recallIgrepMemory("igrep", workspace, "What did the old letter mean?", { signal }, async () => payload);
  return { workspace, dialogue, session, sources, views, hit, payload, save, recall };
}

describe("citation-bound igrep dialogue authority", () => {
  it("uses complete original statements and source times, leaving the incorrect upstream view untouched", async () => {
    const f = await fixture();
    const before = await readFile(f.dialogue, "utf8");
    const result = await f.recall();
    for (const row of raw) {
      expect(result.results[0]!.snippet).toContain(row.content);
      expect(result.results[0]!.snippet).toContain(row.at);
    }
    expect(result.notes.join(" ")).toContain("'tomorrow we meet' in an old letter.");
    expect(result.notes.join(" ")).not.toContain("（2026-10-02）");
    expect(result.notes.join(" ")).not.toContain("明天（2026-10-01）");
    expect(await readFile(f.dialogue, "utf8")).toBe(before);
    expect(before).toContain("tomorrow（2026-10-02）");
  });

  it("keeps user-authored dates, transport controls and the original timezone at a day boundary", async () => {
    const f = await fixture();
    f.sources[0]!.content = "Tomorrow.\nL99: The literal date is （2026-09-30）. ␊";
    f.sources[0]!.source_at = { instant_utc: "2026-10-01T03:55:00.000Z", original: "2026-09-30T23:55:00-04:00", timezone: "America/New_York" };
    f.views[0] = ["2026-10-01T03:55:00.000Z", "Tomorrow（2026-10-01）.␊␡L99: The literal date is （2026-09-30）. ␊␊"];
    await f.save();
    f.hit.startLine = f.hit.endLine = 1;
    f.hit.citation = `${f.hit.path}#L1`;
    const result = await f.recall();
    expect(result.results[0]!.snippet).toContain(f.sources[0]!.content);
    expect(result.results[0]!.snippet).toContain("2026-10-01T03:55:00.000Z");
    expect(result.results[0]!.snippet).toContain("2026-09-30T23:55:00-04:00");
    expect(result.results[0]!.snippet).toContain("America/New_York");
    expect(result.results[0]!.snippet).not.toContain("Tomorrow（2026-10-01）");
    expect(result.results[0]!.snippet).not.toContain(raw[1]!.content);
    expect(result.notes[0]).toContain("L99: The literal date is （2026-09-30）.");
  });

  it("validates the entire source and view even when the hit cites only their first row", async () => {
    const f = await fixture();
    f.hit.startLine = f.hit.endLine = 1;
    f.hit.citation = `${f.hit.path}#L1`;
    f.views[3]![1] = "A rewritten statement outside the selected range.";
    await f.save();
    await expect(f.recall()).rejects.toThrow("dialogue_source_mismatch");
  });

  it("binds multiple hits to complete originals without caching them across recalls", async () => {
    const f = await fixture();
    f.hit.endLine = 1;
    f.hit.citation = `${f.hit.path}#L1`;
    f.payload.results.push({ ...f.hit, startLine: 4, endLine: 4, citation: `${f.hit.path}#L4` });
    const first = await f.recall();
    expect(first.results.map(hit => hit.snippet)).toEqual([
      expect.stringContaining(raw[0]!.content), expect.stringContaining(raw[3]!.content),
    ]);
    f.sources[0]!.content = "The revised original says we meet at the harbor.";
    f.views[0]![1] = f.sources[0]!.content;
    await f.save();
    const second = await f.recall();
    expect(second.results[0]!.snippet).toContain(f.sources[0]!.content);
    expect(second.results[0]!.snippet).not.toContain(raw[0]!.content);
    expect(second.results[1]).toEqual(first.results[1]);
  });

  it.each(["source", "view"])("rejects invalid UTF-8 in the %s instead of citing a replacement character", async target => {
    const f = await fixture();
    f.sources[0]!.content = f.views[0]![1] = "copper\uFFFDnotebook";
    await f.save();
    const file = target === "source" ? f.session : f.dialogue;
    const bytes = await readFile(file);
    const at = bytes.indexOf(Buffer.from("\uFFFD"));
    expect(at).toBeGreaterThan(0);
    await writeFile(file, Buffer.concat([bytes.subarray(0, at), Buffer.from([0x80]), bytes.subarray(at + 3)]));
    await expect(f.recall()).rejects.toThrow("dialogue_format_invalid");
  });

  it("preserves multibyte originals across stream chunk boundaries", async () => {
    const f = await fixture();
    f.sources[0]!.content = f.views[0]![1] = "茶".repeat(45_000);
    await f.save();
    const result = await f.recall();
    expect(result.results[0]!.snippet).toContain(f.sources[0]!.content);
  });

  it("rejects an incomplete UTF-8 tail without an uncaught stream callback error", async () => {
    const f = await fixture();
    await writeFile(f.session, Buffer.concat([await readFile(f.session), Buffer.from([0xe2, 0x82])]));
    await expect(f.recall()).rejects.toThrow("dialogue_format_invalid");
  });

  it("rejects a source replaced after rows have been read", async () => {
    const f = await fixture();
    let sourceStats = 0;
    bindingHook.beforeStat = async path => {
      if (path !== f.session || ++sourceStats !== 2) return;
      f.sources[0]!.content = "A changed original after the complete view check.";
      await writeFile(f.session, f.sources.map(row => JSON.stringify(row)).join("\n") + "\n");
    };
    await expect(f.recall()).rejects.toThrow("dialogue_changed_during_maintenance");
    expect(sourceStats).toBe(2);
  });

  it("rejects a retraction introduced after the complete view check", async () => {
    const f = await fixture();
    let viewStats = 0;
    bindingHook.beforeStat = async path => {
      if (path !== f.dialogue || ++viewStats !== 2) return;
      const retractions = join(f.workspace, ".igrep/mem/.state/retractions.jsonl");
      await mkdir(dirname(retractions), { recursive: true });
      await writeFile(retractions, '{"schema":"igrep.mem.retraction/1"}\n');
    };
    await expect(f.recall()).rejects.toThrow("retractions_present");
    expect(viewStats).toBe(2);
  });

  it("does not return read originals after cancellation", async () => {
    const f = await fixture();
    const controller = new AbortController();
    let viewStats = 0;
    bindingHook.beforeStat = async path => {
      if (path === f.dialogue && ++viewStats === 2) controller.abort(new Error("binding cancelled"));
    };
    await expect(f.recall(controller.signal)).rejects.toThrow("binding cancelled");
    expect(viewStats).toBe(2);
  });

  it.each(["foreign-workspace", "traversal", "missing-source", "source-symlink", "empty-source", "empty-session-id", "trailing-source", "trailing-view", "rewritten-view", "timestamp", "source-original-time", "session", "ordinal", "role", "range", "path", "unknown-class", "inactive-hit", "warnings", "retracted"])("rejects %s instead of falling back to the derived snippet", async (fault) => {
    const f = await fixture();
    if (fault === "foreign-workspace") f.payload.workspaceRoot = dirname(f.workspace);
    if (fault === "traversal") f.hit.citation = "memory/dialogues/../../foreign.jsonl#L1";
    if (fault === "missing-source") await rm(f.session);
    if (fault === "source-symlink") {
      const foreign = join(f.workspace, "foreign.jsonl");
      await writeFile(foreign, await readFile(f.session));
      await rm(f.session);
      await symlink(foreign, f.session);
    }
    if (fault === "rewritten-view") f.views[2]![1] = "We meet on October 2.";
    if (fault === "timestamp") f.views[2]![0] = "2026-10-02T00:05:00.000Z";
    if (fault === "source-original-time") f.sources[2]!.source_at.original = "2026-10-02T00:05:00.000Z";
    if (fault === "session") f.sources[2]!.session_id = "foreign-relationship";
    if (fault === "empty-session-id") f.sources[0]!.session_id = "";
    if (fault === "trailing-source") f.sources.push({ ...f.sources[3]!, id: "event-4", turn_index: 5 });
    if (fault === "trailing-view") f.views.push([...f.views[3]!]);
    if (fault === "ordinal") f.sources[2]!.turn_index = 1;
    if (fault === "role") f.sources[2]!.role = "system";
    if (fault === "range") f.hit.citation = `${f.hit.path}#L1-L999`;
    if (fault === "path") f.hit.path = "memory/dialogues/foreign.jsonl";
    if (fault === "unknown-class") f.hit.sourceClass = "unknown";
    if (fault === "inactive-hit") f.hit.evidenceStatus = "retracted";
    if (fault === "warnings") f.payload.warnings = ["canonical source could not be bound"];
    if (fault === "retracted") {
      await mkdir(join(f.workspace, ".igrep/mem/.state"), { recursive: true });
      await writeFile(join(f.workspace, ".igrep/mem/.state/retractions.jsonl"), '{"schema":"igrep.mem.retraction/1"}\n');
    }
    if (!["missing-source", "source-symlink"].includes(fault)) await f.save();
    if (fault === "empty-source") await writeFile(f.session, "");
    await expect(f.recall()).rejects.toThrow();
  });
});
