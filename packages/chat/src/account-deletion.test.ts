import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { durableEnvelopeHash, MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const purgeCompanionWorkspace = vi.hoisted(() => vi.fn(async () => ({ purged: 1 })));
vi.mock("./agent-runtime/runtime.js", () => ({ purgeCompanionWorkspace }));

import { consumeAccountDeletionRequest } from "./account-deletion.js";

const roots: string[] = [];

beforeEach(() => {
  purgeCompanionWorkspace.mockReset().mockResolvedValue({ purged: 1 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  for (const name of [
    "CHAT_FS_ROOT",
    "MAIN_WEB_URL",
    "INTERNAL_TOKEN",
  ]) delete process.env[name];
});

describe("local Chat account deletion", () => {
  it("purges local user bytes and commits one request-bound completion to Main", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "idream-chat-delete-"));
    roots.push(root);
    Object.assign(process.env, {
      CHAT_FS_ROOT: root,
      MAIN_WEB_URL: "http://127.0.0.1:3000",
      INTERNAL_TOKEN: "test-internal-token",
    });
    const userId = "user-delete-1";
    const turnId = "turn-delete-1";
    const runInput = path.join(root, "runs", turnId, "1", "input.json");
    const boundary = path.join(root, "mem", userId, "global", "boundaries.md");
    await mkdir(path.dirname(runInput), { recursive: true });
    await mkdir(path.dirname(boundary), { recursive: true });
    await writeFile(runInput, `${JSON.stringify({
      snapshot: { userId, assistantMessageId: "assistant-delete-1" },
    })}\n`);
    await writeFile(boundary, "private boundary\n");

    const fetchMock = vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith("/api/internal/events/account-erasure-completion-v2/ingest")) {
        return Response.json({ acknowledged: true, status: "persisted", receiptId: "completion-1" });
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const event = {
      sourceService: "main",
      sourceEventId: "user_deleted_user-delete-1",
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      schemaVersion: 2,
      occurredAt: "2026-08-27T12:00:00.000Z",
      aggregateType: "user",
      aggregateId: userId,
      payload: { userId },
    };

    await expect(consumeAccountDeletionRequest(event)).resolves.toMatchObject({
      acknowledged: true,
      status: "persisted",
    });
    await expect(stat(runInput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(boundary)).rejects.toMatchObject({ code: "ENOENT" });
    const receiptName = (await readdir(path.join(root, "account-deletions")))[0]!;
    const receipt = await readFile(path.join(root, "account-deletions", receiptName), "utf8");
    expect(receipt).not.toContain(userId);

    await expect(consumeAccountDeletionRequest(event)).resolves.toMatchObject({
      acknowledged: true,
      status: "duplicate",
    });
    expect(purgeCompanionWorkspace).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses the exact completion when the same deletion request arrives concurrently", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "idream-chat-delete-concurrent-"));
    roots.push(root);
    Object.assign(process.env, {
      CHAT_FS_ROOT: root,
      MAIN_WEB_URL: "http://127.0.0.1:3000",
      INTERNAL_TOKEN: "test-internal-token",
    });
    // Force distinct wall-clock evidence whenever code constructs a new receipt;
    // an identical millisecond must not conceal the concurrent-first-write race.
    const originalToISOString = Date.prototype.toISOString;
    let clock = Date.parse("2026-09-30T12:00:00.000Z");
    vi.spyOn(Date.prototype, "toISOString").mockImplementation(function () {
      return originalToISOString.call(new Date(clock++));
    });
    const completions: unknown[] = [];
    let acceptedHash: string | undefined;
    let quarantined = false;
    vi.stubGlobal("fetch", vi.fn(async (_request: string | URL | Request, options?: RequestInit) => {
      const completion = JSON.parse(String(options?.body));
      completions.push(completion);
      const hash = durableEnvelopeHash(completion);
      if (acceptedHash && acceptedHash !== hash) quarantined = true;
      acceptedHash ??= hash;
      return quarantined
        ? Response.json({ acknowledged: false, status: "quarantined", receiptId: completion.sourceEventId }, { status: 409 })
        : Response.json({ acknowledged: true, status: completions.length === 1 ? "persisted" : "duplicate", receiptId: completion.sourceEventId });
    }));
    const event = {
      sourceService: "main",
      sourceEventId: "user_deleted_user-delete-concurrent",
      eventType: MAIN_TO_CHAT_EVENTS.accountDeletionRequestedV2,
      schemaVersion: 2,
      occurredAt: "2026-08-27T12:00:00.000Z",
      aggregateType: "user",
      aggregateId: "user-delete-concurrent",
      payload: { userId: "user-delete-concurrent" },
    };

    const results = await Promise.allSettled([
      consumeAccountDeletionRequest(event),
      consumeAccountDeletionRequest(event),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(completions).toHaveLength(2);
    expect(completions[1]).toEqual(completions[0]);
    await expect(consumeAccountDeletionRequest(event)).resolves.toMatchObject({ acknowledged: true, status: "duplicate" });
    expect(completions[2]).toEqual(completions[0]);
    expect(quarantined).toBe(false);
  });
});
