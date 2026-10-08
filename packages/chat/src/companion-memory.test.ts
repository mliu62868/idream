import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { createCompanionWorkspaceRebuildStream } from "@idream/shared/chat/companion-runtime";
import { rebuildSpoolSessions, type CompanionWorkspaceRebuildSpool } from "./agent-runtime/rebuild-source";

const observed = vi.hoisted(() => ({
  writes: [] as number[],
  paths: [] as string[],
  shortWriteBytes: 0,
  zeroWrite: false,
  writeError: null as Error | null,
  syncError: null as Error | null,
  osRoot: "",
  afterTranscriptWrite: undefined as (() => void) | undefined,
  prepare: vi.fn(),
}));
vi.mock("node:os", async importOriginal => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, tmpdir: () => observed.osRoot || actual.tmpdir() };
});
vi.mock("./agent-runtime/runtime.js", () => ({
  prepareCompanionWorkspaceRebuild: observed.prepare,
  promoteCompanionWorkspaceRebuild: vi.fn(),
  purgeCompanionWorkspace: vi.fn(),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (/session-[a-f0-9]+\.jsonl$/u.test(String(args[0]))) {
        observed.paths.push(String(args[0]));
        const write = handle.write;
        Object.defineProperty(handle, "write", { value: async (...values: unknown[]) => {
          const content = Buffer.isBuffer(values[0])
            ? values[0].subarray(Number(values[1] ?? 0), Number(values[1] ?? 0) + Number(values[2] ?? values[0].length))
            : Buffer.from(String(values[0]));
          observed.writes.push(content.byteLength);
          if (observed.writeError) throw observed.writeError;
          if (observed.zeroWrite) return { bytesWritten: 0, buffer: content };
          const result = await Reflect.apply(write, handle, observed.shortWriteBytes
            ? [content.subarray(0, observed.shortWriteBytes)] : values);
          observed.afterTranscriptWrite?.();
          return result;
        } });
        const sync = handle.sync;
        Object.defineProperty(handle, "sync", { value: () => {
          if (observed.syncError) throw observed.syncError;
          return Reflect.apply(sync, handle, []);
        } });
      }
      return handle;
    },
  };
});
import { cleanupInterruptedCompanionData, prepareCompanionMemory } from "./companion-memory";
import { consumeAccountDeletionRequest } from "./account-deletion";

let root = "";

function messagesFor(sessionId: string, count: number, content?: string) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${sessionId}-${index}`, sessionId, role: index % 2 ? "assistant" as const : "user" as const,
    content: content ?? `Controlled visible source ${index}. ${"The notebook rests beside the window. ".repeat(30)}`.slice(0, 1000),
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  }));
}

function rebuildRequest(messages: ReturnType<typeof messagesFor>, signal?: AbortSignal) {
  const body = createCompanionWorkspaceRebuildStream({
    scope: "relationship", userId: "owned-user", characterId: "owned-character", mode: "project",
    fence: { mutationId: "owned-mutation", authorityVersion: "1", claimToken: "11111111-1111-4111-8111-111111111111" },
    messageCount: messages.length, messages: (async function* () { yield* messages; })(),
  });
  return new Request("http://chat.internal/prepare", {
    method: "POST", headers: { "content-type": "application/x-ndjson" }, body, duplex: "half", signal,
  } as RequestInit);
}

async function expectDisposed() {
  for (const path of observed.paths) await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "idream-memory-staging-test-"));
  process.env.CHAT_FS_ROOT = join(root, "chat");
  observed.osRoot = join(root, "os");
  observed.writes = [];
  observed.paths = [];
  observed.shortWriteBytes = 0;
  observed.zeroWrite = false;
  observed.writeError = null;
  observed.syncError = null;
  observed.afterTranscriptWrite = undefined;
  observed.prepare.mockReset();
});

afterEach(async () => {
  observed.osRoot = "";
  observed.afterTranscriptWrite = undefined;
  vi.unstubAllGlobals();
  delete process.env.CHAT_FS_ROOT;
  await rm(root, { recursive: true, force: true });
});

describe("Chat memory transcript staging", () => {
  it("keeps plaintext request spools inside the erasable user scope", async () => {
    observed.prepare.mockImplementation(async (source: CompanionWorkspaceRebuildSpool) => {
      const userHash = createHash("sha256").update("owned-user").digest("hex");
      const ownedScope = join(root, "chat", "rebuild-spools", `user-${userHash}`);
      expect(source.manifestPath.startsWith(`${ownedScope}/`)).toBe(true);
      for await (const session of rebuildSpoolSessions(source)) {
        expect(session.transcriptPath.startsWith(`${ownedScope}/`)).toBe(true);
      }
    });
    await prepareCompanionMemory(rebuildRequest(messagesFor("owned-session", 2)));
    await expectDisposed();
  });

  it("erases a partially staged request and rejects its later writes before acknowledging account deletion", async () => {
    const original = rebuildRequest(messagesFor("interrupted-erasure-session", 2, "private erasure sentinel ".repeat(4000)));
    const frames = (await original.text()).trimEnd().split("\n");
    const stagedWrite = Promise.withResolvers<void>();
    observed.afterTranscriptWrite = () => stagedWrite.resolve();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const request = new Request(original.url, {
      method: "POST", headers: original.headers,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          controller.enqueue(Buffer.from(`${frames.slice(0, -1).join("\n")}\n`));
        },
      }), duplex: "half",
    } as RequestInit);
    const preparing = prepareCompanionMemory(request);
    // Observe the rejection immediately so the pending request cannot produce
    // an unhandled failure while the deletion callback is still settling.
    const outcome = preparing.then(() => "accepted", error => error);
    await stagedWrite.promise;
    vi.stubGlobal("fetch", vi.fn(async () => {
      await expectDisposed();
      return Response.json({ acknowledged: true, status: "persisted", receiptId: "completion-erasure" });
    }));
    try {
      await expect(consumeAccountDeletionRequest({
        sourceService: "main", sourceEventId: "delete-staged-owned-user",
        eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2, schemaVersion: 2,
        occurredAt: "2026-09-30T12:00:00.000Z", aggregateType: "user", aggregateId: "owned-user",
        payload: { userId: "owned-user" },
      })).resolves.toMatchObject({ acknowledged: true });
    } finally {
      bodyController.enqueue(Buffer.from(`${frames.at(-1)}\n`));
      bodyController.close();
      await outcome;
    }
    expect(await outcome).toEqual(expect.objectContaining({ message: "Chat user is fenced" }));
    expect(observed.prepare).not.toHaveBeenCalled();
    await expectDisposed();
  });

  it("clears interrupted request files and recognized legacy OS spools during startup recovery", async () => {
    const legacyFile = join(observed.osRoot, "idream-chat-rebuilds", "request-interrupted", "session-interrupted.jsonl");
    const ownedFile = join(root, "chat", "rebuild-spools", "user-interrupted", "request-interrupted", "session-interrupted.jsonl");
    for (const file of [legacyFile, ownedFile]) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "private erasure sentinel\n");
    }
    await cleanupInterruptedCompanionData();
    for (const file of [legacyFile, ownedFile]) await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears abandoned recall plaintext before admission and preserves live or unowned roots", async () => {
    const cases = [
      { name: "stale", owner: { host: hostname(), pid: 2_147_483_647 }, erased: true },
      { name: "live", owner: { host: hostname(), pid: process.pid }, erased: false },
      { name: "foreign", owner: { host: "another-host", pid: 2_147_483_647 }, erased: false },
      { name: "unmarked", owner: undefined, erased: false },
      { name: "invalid", owner: { host: hostname(), pid: "unknown" }, erased: false },
    ];
    for (const entry of cases) {
      const directory = join(observed.osRoot, `igrep-dsh-recall-${entry.name}`);
      await mkdir(join(directory, "session/archive"), { recursive: true });
      await writeFile(join(directory, "session/archive/1.txt"), "Private archived dialogue.");
      if (entry.owner) await writeFile(join(directory, "owner.json"), JSON.stringify(entry.owner));
    }

    await cleanupInterruptedCompanionData();

    for (const entry of cases) {
      const plaintext = join(observed.osRoot, `igrep-dsh-recall-${entry.name}/session/archive/1.txt`);
      if (entry.erased) await expect(stat(plaintext)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await readFile(plaintext, "utf8")).toBe("Private archived dialogue.");
    }
  });

  it("batches small protocol fragments without changing the complete transcript or its private lifecycle", async () => {
    const messages = messagesFor("owned-session", 512);
    let bytes = 0;
    observed.prepare.mockImplementation(async (source: CompanionWorkspaceRebuildSpool) => {
      expect(source.messageCount).toBe(messages.length);
      expect(source.sessionCount).toBe(1);
      for await (const session of rebuildSpoolSessions(source)) {
        const transcriptPath = session.transcriptPath;
        const text = await readFile(transcriptPath, "utf8");
        bytes = Buffer.byteLength(text);
        expect(session.estimatedBytes).toBe(bytes);
        expect((await stat(transcriptPath)).mode & 0o777).toBe(0o600);
        expect(text.trimEnd().split("\n").map(line => JSON.parse(line))).toEqual(messages.map(message => ({
          role: message.role, content: message.content, source_at: message.createdAt, source_timezone: "UTC",
        })));
      }
      return { rebuildId: "11111111-1111-4111-8111-111111111111", sessions: 1, messages: messages.length };
    });
    await prepareCompanionMemory(rebuildRequest(messages));
    await expectDisposed();
    expect(observed.writes.length).toBeLessThanOrEqual(Math.ceil(bytes / (64 * 1024)) + 1);
    expect(Math.max(...observed.writes)).toBeLessThanOrEqual(64 * 1024);
  });

  it("preserves escaped Unicode across protocol chunks, buffer boundaries and sessions despite short writes", async () => {
    const messages = [
      ...messagesFor("first-session", 2, '茶🫖\n"\\'.repeat(20_000)),
      ...messagesFor("second-session", 2, "A separate conversation."),
    ];
    observed.shortWriteBytes = 7_919;
    const controller = new AbortController();
    const request = rebuildRequest(messages, controller.signal);
    observed.prepare.mockImplementation(async (source: CompanionWorkspaceRebuildSpool, signal: AbortSignal) => {
      expect(signal).toBe(request.signal);
      expect(source.sessionCount).toBe(2);
      let totalBytes = 0;
      const sessions = [];
      for await (const session of rebuildSpoolSessions(source)) {
        const transcript = await readFile(session.transcriptPath, "utf8");
        totalBytes += Buffer.byteLength(transcript);
        expect(session.estimatedBytes).toBe(Buffer.byteLength(transcript));
        const expected = messages.filter(message => message.sessionId === session.sessionId).map(message => ({
          role: message.role, content: message.content, source_at: message.createdAt, source_timezone: "UTC",
        }));
        // A protocol boundary may split a surrogate pair, which JSON preserves
        // as adjacent escapes instead of a literal code point. Compare all data.
        expect(transcript.trimEnd().split("\n").map(line => JSON.parse(line))).toEqual(expected);
        sessions.push(session.sessionId);
      }
      expect(sessions).toEqual(["first-session", "second-session"]);
      expect(source.estimatedBytes).toBe(totalBytes);
    });
    await prepareCompanionMemory(request);
    expect(Math.max(...observed.writes)).toBeLessThanOrEqual(64 * 1024);
    await expectDisposed();
  });

  it.each(["write", "sync"] as const)("does not admit or retain a transcript after a %s failure", async operation => {
    const failure = new Error(`controlled ${operation} failure`);
    observed[operation === "write" ? "writeError" : "syncError"] = failure;
    await expect(prepareCompanionMemory(rebuildRequest(messagesFor("failed-session", 2)))).rejects.toBe(failure);
    expect(observed.prepare).not.toHaveBeenCalled();
    expect(observed.paths).toHaveLength(1);
    await expectDisposed();
  });

  it("rejects a zero-progress write instead of publishing a truncated transcript or retrying forever", async () => {
    observed.zeroWrite = true;
    await expect(prepareCompanionMemory(rebuildRequest(messagesFor("zero-progress-session", 2))))
      .rejects.toThrow("relationship transcript write made no progress");
    expect(observed.prepare).not.toHaveBeenCalled();
    expect(observed.writes).toHaveLength(1);
    await expectDisposed();
  });

  it("does not admit staged data when the stream ends without its completion frame", async () => {
    const original = rebuildRequest(messagesFor("incomplete-session", 2));
    const frames = (await original.text()).trimEnd().split("\n");
    const request = new Request(original.url, { method: "POST", headers: original.headers, body: `${frames.slice(0, -1).join("\n")}\n` });
    await expect(prepareCompanionMemory(request)).rejects.toThrow("relationship rebuild complete frame is required");
    expect(observed.prepare).not.toHaveBeenCalled();
    expect(observed.paths).toHaveLength(1);
    await expectDisposed();
  });

  it("disposes buffered partial transcripts when the source stream fails", async () => {
    const original = rebuildRequest(messagesFor("interrupted-session", 2));
    const reader = original.body!.getReader();
    let received = 0;
    const request = new Request(original, {
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (++received === 4) {
            await reader.cancel();
            controller.error(new Error("controlled source interruption"));
            return;
          }
          const result = await reader.read();
          if (result.done) controller.close(); else controller.enqueue(result.value);
        },
      }),
      duplex: "half",
    } as RequestInit);
    await expect(prepareCompanionMemory(request)).rejects.toThrow("controlled source interruption");
    expect(observed.prepare).not.toHaveBeenCalled();
    expect(observed.paths).toHaveLength(1);
    await expectDisposed();
  });
});
