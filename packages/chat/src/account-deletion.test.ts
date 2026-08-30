import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const purgeCompanionWorkspace = vi.hoisted(() => vi.fn(async () => ({ purged: 1 })));
vi.mock("./agent-runtime/runtime.js", () => ({ purgeCompanionWorkspace }));

import { consumeAccountDeletionRequest } from "./account-deletion.js";

const roots: string[] = [];

afterEach(async () => {
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
});
