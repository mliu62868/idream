import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_WORKSPACE_REBUILD_CONTENT_CHUNK_CHARS,
  releasedKnowledgeDigest,
  type CompanionInvocation,
  type CompanionReadiness,
} from "@idream/shared/chat/companion-runtime";
import { createCompanionServer, type InvocationService } from "./server";
import { IgrepMemoryRebuilder, type JsonCommandOptions } from "./igrep";
import { AttemptWorkspaceStore, relationshipWorkspacePath } from "./workspace";

const servers: Array<ReturnType<typeof createCompanionServer>> = [];
const temporary: string[] = [];

async function waitFor(check: () => void | Promise<void>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } while (Date.now() < deadline);
  throw lastError;
}

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const socket = createNetServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("missing ephemeral test port"));
        return;
      }
      socket.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const readiness = {
  protocolVersion: 1,
  service: "dsh-companion",
  ready: true,
  checkedAt: "2026-08-20T12:00:00.000Z",
  instance: { id: "11111111-1111-4111-8111-111111111111", startedAt: "2026-08-20T11:59:00.000Z" },
  dshVersion: "0.1.1-rc.2",
  dshCommit: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
  igrepVersion: "0.1.134",
  pluginVersion: "0.1.0",
  provider: { name: "local", model: "model-1", baseUrl: "http://127.0.0.1:8061/v1", resolved: true },
  profiles: {
    normal: {
      name: "normal",
      loaded: true,
      executionCompositionDigest: "a".repeat(64),
      capabilities: { memoryRead: true, memoryWrite: true, tools: true, commit: true },
    },
    private: {
      name: "private",
      loaded: true,
      executionCompositionDigest: "b".repeat(64),
      capabilities: { memoryRead: false, memoryWrite: false, tools: true, commit: true },
    },
  },
  bridges: { toolReachable: true, commitReachable: true, workspaceRebuildReachable: true },
  verification: {
    duplicateIngest: { replayedSessions: 1, duplicateDialogueFiles: 0 },
    crossScope: { probes: 2, leakedResults: 0 },
  },
} satisfies CompanionReadiness;

function invocation(): InvocationService {
  return {
    run: vi.fn(async () => {}),
    accept: vi.fn(async () => {}),
    purge: vi.fn(async () => 1),
    rebuild: vi.fn(async () => ({ sessions: 1, messages: 2 })),
    prepareRebuild: vi.fn(async () => ({
      rebuildId: "11111111-1111-4111-8111-111111111111",
      sessions: 1,
      messages: 2,
    })),
    promoteRebuild: vi.fn(async () => ({ sessions: 1, messages: 2 })),
    discardRebuild: vi.fn(async () => {}),
    memoryCutoverProof: vi.fn(async () => null),
    shutdown: vi.fn(async () => {}),
  };
}

function runtimeInvocation(): CompanionInvocation {
  const knowledgeAuthority = {
    characterId: "character-1",
    characterContentVersionId: "ccv-1",
    characterReleaseId: "release-1",
    files: [] as [],
  };
  const releasedKnowledge = {
    ...knowledgeAuthority,
    digest: releasedKnowledgeDigest(knowledgeAuthority),
  };
  return {
    invocationId: "invocation-http-1",
    attemptId: "assistant-http-1:1",
    sessionId: "session-http-1",
    userId: "user-1",
    characterId: "character-1",
    memoryMode: "normal",
    expectedProfileDigest: "d".repeat(64),
    deadlineAt: "2026-08-20T12:05:00.000Z",
    preparedTurn: {
      version: 3,
      model: "model-1",
      characterName: "Mira",
      messages: [{
        id: "message-http-1",
        sourceKind: "current_user",
        role: "user",
        content: "Stay connected.",
      }],
      tools: [],
      profile: {
        tier: "free",
        adapter: "openai-compatible-v1",
        provider: "local",
        baseUrl: "http://127.0.0.1:8061/v1",
        model: "model-1",
        supportsTools: true,
        maxOutputTokens: 1_000,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000, completionMs: 2_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      budget: { maxInputTokens: 2_000, usedInputTokens: 100, dropped: [] },
      releasedKnowledge,
      trace: {
        characterContentVersionId: "ccv-1",
        characterReleaseId: "release-1",
        soulFingerprint: "fingerprint",
        compilerVersion: "soul-v1",
        sceneVersion: 1,
        contextRevision: "3",
        releasedKnowledgeDigest: releasedKnowledge.digest,
      },
    },
  };
}

async function start(
  service = invocation(),
  rebuildSpoolRoot?: string,
  readinessCheck: (force?: boolean) => Promise<CompanionReadiness> = async () => readiness,
) {
  const port = await availablePort();
  const server = createCompanionServer({
    authToken: "sidecar-token",
    hostname: "127.0.0.1",
    port,
    readiness: readinessCheck,
    invocation: service,
    rebuildSpoolRoot,
  });
  servers.push(server);
  return { baseUrl: server.http.url.origin, server, service };
}

const authorized = { authorization: "Bearer sidecar-token", "content-type": "application/json" };

function appendMessageFrames(
  lines: string[],
  message: {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
  },
): void {
  const { content, ...header } = message;
  lines.push(JSON.stringify({
    protocolVersion: 1,
    type: "message_start",
    message: header,
    contentLength: content.length,
  }));
  for (let offset = 0; offset < content.length; offset += COMPANION_WORKSPACE_REBUILD_CONTENT_CHUNK_CHARS) {
    lines.push(JSON.stringify({
      protocolVersion: 1,
      type: "content_chunk",
      content: content.slice(offset, offset + COMPANION_WORKSPACE_REBUILD_CONTENT_CHUNK_CHARS),
    }));
  }
  lines.push(JSON.stringify({ protocolVersion: 1, type: "message_complete" }));
}

describe("companion HTTP authority boundary", () => {
  it("keeps liveness public and protects readiness", async () => {
    const { baseUrl } = await start();
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/readyz`, { headers: { authorization: "Bearer sidecar-token" } })).status).toBe(200);
  });

  it("gives authenticated full readiness a finite budget beyond Bun's default idle timeout", async () => {
    const { baseUrl } = await start(invocation(), undefined, async (force) => {
      expect(force).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 10_250));
      return readiness;
    });

    const response = await fetch(`${baseUrl}/readyz?full=1`, {
      headers: { authorization: "Bearer sidecar-token" },
    });
    expect(response.status).toBe(200);
  }, 15_000);

  it("cancels the exact invocation when the NDJSON response consumer disconnects", async () => {
    const running = Promise.withResolvers<void>();
    const service = invocation();
    service.run = vi.fn(async (input, emit) => {
      emit({
        protocolVersion: 1,
        type: "event",
        invocationId: input.invocationId,
        event: {
          type: "text_delta",
          invocationId: input.invocationId,
          attemptId: input.attemptId,
          sequence: 1,
          occurredAt: "2026-08-20T12:00:01.000Z",
          delta: "connected",
        },
      });
      await running.promise;
    });
    service.accept = vi.fn(async (frame) => {
      if (frame.type === "cancel") running.resolve();
    });
    service.shutdown = vi.fn(async () => running.resolve());
    const { baseUrl } = await start(service);

    const response = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        protocolVersion: 1,
        type: "run",
        invocation: runtimeInvocation(),
      }),
    });
    expect(
      response.status,
      response.status === 200 ? undefined : await response.clone().text(),
    ).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toContain('"type":"text_delta"');

    await reader!.cancel();

    await waitFor(() => expect(service.accept).toHaveBeenCalledWith({
      protocolVersion: 1,
      type: "cancel",
      invocationId: "invocation-http-1",
      reason: "user",
    }));
  });

  it("rejects new work while draining but keeps liveness and invocation control available", async () => {
    const shutdownEntered = Promise.withResolvers<void>();
    const finishShutdown = Promise.withResolvers<void>();
    const service = invocation();
    service.shutdown = vi.fn(async () => {
      shutdownEntered.resolve();
      await finishShutdown.promise;
    });
    const { baseUrl, server } = await start(service);
    const closing = server.close();
    await shutdownEntered.promise;

    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`, {
      headers: { authorization: "Bearer sidecar-token" },
    })).status).toBe(503);
    expect((await fetch(`${baseUrl}/v1/workspaces/purge`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({ scope: "user", userId: "user-1" }),
    })).status).toBe(503);
    expect((await fetch(`${baseUrl}/v1/invocations/invocation-http-1/cancel`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify({
        protocolVersion: 1,
        type: "cancel",
        invocationId: "invocation-http-1",
        reason: "shutdown",
      }),
    })).status).toBe(200);
    expect(service.accept).toHaveBeenCalledWith(expect.objectContaining({
      type: "cancel",
      invocationId: "invocation-http-1",
    }));

    finishShutdown.resolve();
    await closing;
  });

  it("strictly validates relationship rebuilds", async () => {
    const { baseUrl, service } = await start();
    const response = await fetch(`${baseUrl}/v1/workspaces/rebuild/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer sidecar-token",
        "content-type": "application/x-ndjson",
      },
      body: [
        JSON.stringify({
          protocolVersion: 1,
          type: "start",
          scope: "relationship",
          userId: "user-1",
          characterId: "character-1",
          messageCount: 0,
          fence: {
            mutationId: "filemut-strict",
            claimToken: "55555555-5555-4555-8555-555555555555",
            authorityVersion: "1",
          },
        }),
        JSON.stringify({ protocolVersion: 1, type: "complete", messageCount: 0 }),
        "",
      ].join("\n"),
    });
    expect(response.status).toBe(200);
    expect(service.prepareRebuild).toHaveBeenCalledOnce();
  });

  it("prepares and promotes only a projection-fenced relationship candidate", async () => {
    const { baseUrl, service } = await start();
    const fence = {
      mutationId: "filemut-1",
      claimToken: "11111111-1111-4111-8111-111111111111",
      authorityVersion: "7",
    };
    const response = await fetch(`${baseUrl}/v1/workspaces/rebuild/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer sidecar-token",
        "content-type": "application/x-ndjson",
      },
      body: [
        JSON.stringify({
          protocolVersion: 1,
          type: "start",
          scope: "relationship",
          userId: "user-1",
          characterId: "character-1",
          messageCount: 0,
          fence,
        }),
        JSON.stringify({ protocolVersion: 1, type: "complete", messageCount: 0 }),
        "",
      ].join("\n"),
    });
    expect(response.status).toBe(200);
    expect(service.prepareRebuild).toHaveBeenCalledOnce();
    expect(service.rebuild).not.toHaveBeenCalled();
    const promotion = {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      rebuildId: "11111111-1111-4111-8111-111111111111",
      fence,
    };
    expect((await fetch(`${baseUrl}/v1/workspaces/rebuild/promote`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify(promotion),
    })).status).toBe(200);
    expect(service.promoteRebuild).toHaveBeenCalledWith(
      promotion,
      expect.any(AbortSignal),
    );
  });

  it("does not enter workspace authority for a truncated rebuild stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-truncated-rebuild-"));
    temporary.push(root);
    const spoolRoot = join(root, "spool");
    const { baseUrl, service } = await start(undefined, spoolRoot);
    const response = await fetch(`${baseUrl}/v1/workspaces/rebuild/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer sidecar-token",
        "content-type": "application/x-ndjson",
      },
      body: `${JSON.stringify({
        protocolVersion: 1,
        type: "start",
        scope: "relationship",
        userId: "user-1",
        characterId: "character-1",
        messageCount: 0,
        fence: {
          mutationId: "filemut-truncated",
          claimToken: "66666666-6666-4666-8666-666666666666",
          authorityVersion: "2",
        },
      })}\n`,
    });

    expect(response.status).toBe(400);
    expect(service.prepareRebuild).not.toHaveBeenCalled();
    expect(await readdir(spoolRoot)).toEqual([]);
  });

  it("aborts an accepted rebuild and removes its spool when Chat disconnects", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-aborted-rebuild-"));
    temporary.push(root);
    const spoolRoot = join(root, "spool");
    const entered = Promise.withResolvers<AbortSignal>();
    const service: InvocationService = {
      ...invocation(),
      prepareRebuild: vi.fn(async (_request, signal): Promise<never> => {
        if (!signal) throw new Error("missing rebuild abort signal");
        entered.resolve(signal);
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    };
    const { baseUrl } = await start(service, spoolRoot);
    const controller = new AbortController();
    const response = fetch(`${baseUrl}/v1/workspaces/rebuild/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer sidecar-token",
        "content-type": "application/x-ndjson",
      },
      body: [
        JSON.stringify({
          protocolVersion: 1,
          type: "start",
          scope: "relationship",
          userId: "user-1",
          characterId: "character-1",
          messageCount: 0,
          fence: {
            mutationId: "filemut-aborted",
            claimToken: "44444444-4444-4444-8444-444444444444",
            authorityVersion: "8",
          },
        }),
        JSON.stringify({ protocolVersion: 1, type: "complete", messageCount: 0 }),
        "",
      ].join("\n"),
      signal: controller.signal,
    });
    const sidecarSignal = await entered.promise;
    controller.abort();

    await expect(response).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => expect(sidecarSignal.aborted).toBe(true));
    await waitFor(async () => expect(await readdir(spoolRoot)).toEqual([]));
  });

  it("applies a complete projection beyond legacy body and message caps and replaces deleted memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-large-rebuild-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const workspaces = new AttemptWorkspaceStore({
      canonicalRoot,
      privateRoot: join(root, "private"),
      verificationPollMs: 1,
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    const identity = { userId: "user-large", characterId: "character-large" };
    await workspaces.rebuildRelationship(identity, async (workspace) => {
      await writeFile(join(workspace, ".igrep", "deleted-memory.txt"), "must disappear");
    });
    const messageCount = 20_004;
    const fence = {
      mutationId: "filemut-large",
      claimToken: "33333333-3333-4333-8333-333333333333",
      authorityVersion: "42",
    };
    const commands: JsonCommandOptions[] = [];
    let transcriptBytes = 0;
    const rebuilder = new IgrepMemoryRebuilder(
      "igrep",
      {
        status: async () => ({
          dialogueFiles: 2,
          pendingProfileRows: 0,
          processedProfileRows: messageCount,
          lastMaintainAt: "2026-08-20T12:00:00.000Z",
        }),
      },
      async (options) => {
        commands.push(options);
        if (options.args[1] === "ingest") {
          const transcriptPath = options.args[options.args.indexOf("--transcript") + 1]!;
          const workspace = options.args[options.args.indexOf("--workspace") + 1]!;
          expect(dirname(transcriptPath)).toBe(join(workspace, ".idream-rebuild-transcripts"));
          expect((await stat(dirname(transcriptPath))).mode & 0o777).toBe(0o700);
          expect((await stat(transcriptPath)).mode & 0o777).toBe(0o600);
          const rows = createInterface({
            input: createReadStream(transcriptPath, { encoding: "utf8" }),
            crlfDelay: Number.POSITIVE_INFINITY,
          });
          for await (const row of rows) {
            expect(() => JSON.parse(row)).not.toThrow();
          }
          transcriptBytes += (await stat(transcriptPath)).size;
          expect((await stat(workspace)).mode & 0o777).toBe(0o700);
          expect((await stat(join(workspace, ".igrep"))).mode & 0o777).toBe(0o700);
          await writeFile(join(workspace, ".igrep", "retained-count.txt"), String(messageCount));
          return {
            events: messageCount / 2,
            dialoguePath: ".igrep/mem/memory/dialogues/rebuilt.jsonl",
          };
        }
        return { ok: true };
      },
    );
    let stagedManifest = "";
    const service: InvocationService = {
      ...invocation(),
      prepareRebuild: vi.fn(async (request, signal) => {
        if (!("kind" in request)) throw new Error("expected a spooled rebuild source");
        if (!request.fence) throw new Error("expected a fenced rebuild source");
        stagedManifest = request.manifestPath;
        expect((await stat(request.manifestPath)).mode & 0o777).toBe(0o600);
        return workspaces.prepareRelationshipRebuild(
          request,
          request.fence,
          (workspace) => rebuilder.rebuild(workspace, request, signal),
          signal,
        );
      }),
      promoteRebuild: vi.fn((request) => workspaces.promoteRelationshipRebuild(request)),
      discardRebuild: vi.fn((request) => workspaces.discardRelationshipRebuild(request)),
    };
    const spoolRoot = join(root, "spool");
    const { baseUrl } = await start(service, spoolRoot);
    const content = "retained-after-delete:".padEnd(900, "x");
    const lines = [JSON.stringify({
      protocolVersion: 1,
      type: "start",
      scope: "relationship",
      ...identity,
      messageCount,
      fence,
    })];
    for (let index = 0; index < messageCount; index += 1) {
      appendMessageFrames(lines, {
        id: `message-${index}`,
        sessionId: index < messageCount / 2 ? "session-large-a" : "session-large-b",
        role: index % 2 === 0 ? "user" : "assistant",
        content: index === 0 ? "x".repeat(300_000) : content,
        createdAt: new Date(1_787_169_600_000 + index).toISOString(),
      });
    }
    lines.push(JSON.stringify({
      protocolVersion: 1,
      type: "complete",
      messageCount,
    }));
    const body = `${lines.join("\n")}\n`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1_048_576);

    const response = await fetch(`${baseUrl}/v1/workspaces/rebuild/prepare`, {
      method: "POST",
      headers: {
        authorization: "Bearer sidecar-token",
        "content-type": "application/x-ndjson",
      },
      body,
    });

    expect(response.status, await response.clone().text()).toBe(200);
    const prepared = await response.json() as {
      ok: true;
      rebuilt: { rebuildId: string; sessions: number; messages: number };
    };
    expect(prepared).toEqual({
      ok: true,
      rebuilt: {
        rebuildId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        sessions: 2,
        messages: messageCount,
      },
    });
    const relationship = relationshipWorkspacePath(
      canonicalRoot,
      identity.userId,
      identity.characterId,
    );
    const oldCurrent = resolve(
      dirname(join(relationship, ".igrep")),
      await readlink(join(relationship, ".igrep")),
    );
    await expect(readFile(join(oldCurrent, "deleted-memory.txt"), "utf8"))
      .resolves.toBe("must disappear");
    const promotion = {
      scope: "relationship" as const,
      ...identity,
      rebuildId: prepared.rebuilt.rebuildId,
      fence,
    };
    expect((await fetch(`${baseUrl}/v1/workspaces/rebuild/promote`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify(promotion),
    })).status).toBe(200);
    const current = resolve(
      dirname(join(relationship, ".igrep")),
      await readlink(join(relationship, ".igrep")),
    );
    await expect(readFile(join(current, "deleted-memory.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(current, "retained-count.txt"), "utf8"))
      .resolves.toBe(String(messageCount));
    expect(commands.map((command) => command.args.slice(0, 2))).toEqual([
      ["mem", "ingest"],
      ["mem", "ingest"],
      ["mem", "maintain"],
      ["mem", "doctor"],
    ]);
    expect(transcriptBytes).toBeGreaterThan(16 * 1_048_576);
    expect((await stat(spoolRoot)).mode & 0o777).toBe(0o700);
    await expect(stat(stagedManifest)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(spoolRoot)).toEqual([]);
  }, 30_000);

  it("has no legacy import endpoint", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/workspaces/import-legacy-memory`, {
      method: "POST",
      headers: authorized,
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("returns the current content-free historical cutover proof", async () => {
    const proof = {
      entries: 0,
      legacySourceChecksum: "a".repeat(64),
      checksum: "d".repeat(64),
      igrepVersion: "0.1.132" as const,
      cutoverWorkspaceVersion: "rebuild-1787169600000-11111111-1111-4111-8111-111111111111",
      workspaceVersion: "commit-1787169700000-22222222-2222-4222-8222-222222222222",
      status: "cutover_ready" as const,
      recallParity: {
        probeSetChecksum: "e".repeat(64),
        total: 0,
        passed: 0,
        probes: [],
      },
      completedAt: "2026-08-19T12:00:00.000Z",
    };
    const service: InvocationService = {
      ...invocation(),
      memoryCutoverProof: vi.fn(async () => proof),
    };
    const { baseUrl } = await start(service);
    const body = {
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
    };
    expect((await fetch(`${baseUrl}/v1/workspaces/memory-cutover-proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })).status).toBe(401);
    const response = await fetch(`${baseUrl}/v1/workspaces/memory-cutover-proof`, {
      method: "POST",
      headers: {
        authorization: "Bearer sidecar-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, proof });
    expect(service.memoryCutoverProof).toHaveBeenCalledWith({
      userId: body.userId,
      characterId: body.characterId,
    });
  });
});

describe("workspace purge request contract", () => {
  it("accepts only physical relationship purge authority", async () => {
    const { baseUrl, service } = await start();
    const purge = async (body: Record<string, unknown>) => fetch(`${baseUrl}/v1/workspaces/purge`, {
      method: "POST",
      headers: authorized,
      body: JSON.stringify(body),
    });

    const destroy = await purge({ scope: "relationship", userId: "user-1", characterId: "character-1" });
    expect(destroy.status).toBe(200);
    expect(service.purge).toHaveBeenLastCalledWith({
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
    });

    const extraAuthority = await purge({
      scope: "relationship",
      userId: "user-1",
      characterId: "character-1",
      quarantine: "retained-copy",
    });
    expect(extraAuthority.status).toBe(400);
    expect(service.purge).toHaveBeenCalledOnce();
  });
});
