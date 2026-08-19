import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmAdapter, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { CompanionInvocation } from "@idream/shared/chat/companion-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { CompanionEngine } from "./engine";
import { createCompanionServer, type CompanionServer } from "./server";
import {
  AttemptWorkspaceStore,
  relationshipWorkspacePath,
} from "./workspace";

const AUTH_TOKEN = "purge-test-secret";
const temporary: string[] = [];
const servers: CompanionServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function listen(server: CompanionServer): Promise<string> {
  server.http.listen(0, "127.0.0.1");
  await once(server.http, "listening");
  const address = server.http.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return `http://127.0.0.1:${address.port}`;
}

async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

class UnusedAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<never> {
    throw new Error("not used");
  }
}

class BlockingAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await new Promise<never>((_resolve, reject) => {
      const abort = () => reject(options.signal?.reason ?? new Error("aborted"));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function activeInvocation(): CompanionInvocation {
  return {
    invocationId: "invocation-purge-active",
    attemptId: "attempt-purge-active",
    sessionId: "session-purge-active",
    userId: "user-active",
    characterId: "character-active",
    memoryMode: "normal",
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    preparedTurn: {
      version: 1,
      model: "deepseek/test",
      characterName: "Mira",
      messages: [{
        id: "current-active",
        sourceKind: "current_user",
        role: "user",
        content: "Wait here while privacy cleanup starts.",
      }],
      tools: [],
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl: "https://example.invalid/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 32,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000, completionMs: 5_000 },
        sampling: { temperature: 1, topP: 1, repetitionPenalty: 1, structuredTemperature: 0 },
      },
      budget: { maxInputTokens: 100, usedInputTokens: 10, dropped: [] },
      trace: {
        characterContentVersionId: "ccv-active",
        characterReleaseId: null,
        soulFingerprint: "active",
        compilerVersion: "test",
        sceneVersion: 0,
        relationshipVersion: 0,
        fileContextRevision: "0",
      },
    },
  };
}

describe("authenticated workspace privacy authority", () => {
  it("fails closed immediately when a completed igrep maintain leaves profile rows pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-maintain-failure-"));
    temporary.push(root);
    let calls = 0;
    const store = new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
      verificationTimeoutMs: 30_000,
      memoryProbe: {
        status: async () => calls++ === 0
          ? {
              dialogueFiles: 0,
              pendingProfileRows: 0,
              processedProfileRows: 0,
              lastMaintainAt: null,
            }
          : {
              dialogueFiles: 1,
              pendingProfileRows: 2,
              processedProfileRows: 0,
              lastMaintainAt: "2026-08-19T14:20:57Z",
            },
      },
    });
    const workspace = await store.prepare(activeInvocation());

    await expect(workspace.commit()).rejects.toThrow(/left 2 profile rows pending/);
    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      "user-active",
      "character-active",
    );
    expect(await readdir(join(relationship, ".attempts"))).toEqual([]);
  });

  it("removes an unpromoted candidate version when pointer replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-promotion-failure-"));
    temporary.push(root);
    let calls = 0;
    const canonicalRoot = join(root, "canonical");
    const store = new AttemptWorkspaceStore({
      canonicalRoot,
      privateRoot: join(root, "private"),
      verificationPollMs: 1,
      memoryProbe: {
        status: async () => calls++ === 0
          ? { dialogueFiles: 0, pendingProfileRows: 0, processedProfileRows: 0, lastMaintainAt: null }
          : {
              dialogueFiles: 1,
              pendingProfileRows: 0,
              processedProfileRows: 2,
              lastMaintainAt: "2026-08-19T15:00:00Z",
            },
      },
    });
    const workspace = await store.prepare(activeInvocation());
    const relationship = relationshipWorkspacePath(canonicalRoot, "user-active", "character-active");
    const canonical = join(relationship, ".igrep");
    await rm(canonical, { recursive: true, force: true });
    await mkdir(canonical);
    await writeFile(join(canonical, "blocks-rename"), "sentinel");

    await expect(workspace.commit()).rejects.toThrow();

    const versions = await readdir(join(relationship, ".igrep.versions"));
    expect(versions.filter((name) => name.startsWith("commit-"))).toEqual([]);
    expect(await readdir(join(relationship, ".attempts"))).toEqual([]);
  });

  it("waits for fire-and-forget disposal maintain before deleting a rejected attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-disposal-settle-"));
    temporary.push(root);
    let lastMaintainAt: string | null = null;
    const store = new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
      verificationTimeoutMs: 1_000,
      verificationPollMs: 5,
      memoryProbe: {
        status: async () => ({
          dialogueFiles: 0,
          pendingProfileRows: 0,
          processedProfileRows: 0,
          lastMaintainAt,
        }),
      },
    });
    const workspace = await store.prepare(activeInvocation());
    setTimeout(() => {
      lastMaintainAt = "2026-08-19T14:50:21Z";
    }, 20);

    await workspace.settleAndDiscard();

    expect(await present(workspace.path)).toBe(false);
    const relationship = relationshipWorkspacePath(
      join(root, "canonical"),
      "user-active",
      "character-active",
    );
    expect(await readdir(join(relationship, ".attempts"))).toEqual([]);
  });

  it("hashes hostile ids, purges idempotently and never deletes another tenant", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-purge-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const victimUser = "../../victim";
    const victimCharacter = "../../../character";
    const neighborUser = "neighbor";
    const neighborCharacter = "character-2";
    const victim = relationshipWorkspacePath(canonicalRoot, victimUser, victimCharacter);
    const neighbor = relationshipWorkspacePath(canonicalRoot, neighborUser, neighborCharacter);
    await mkdir(victim, { recursive: true });
    await mkdir(neighbor, { recursive: true });
    await writeFile(join(victim, "victim.txt"), "victim");
    await writeFile(join(neighbor, "neighbor.txt"), "neighbor");
    const outside = join(root, "must-survive.txt");
    await writeFile(outside, "authority sentinel");

    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot,
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new UnusedAdapter(),
      igrepCommand: "igrep",
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);

    expect((await fetch(`${baseUrl}/v1/workspaces/purge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "relationship", userId: victimUser, characterId: victimCharacter }),
    })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/workspaces/purge`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        scope: "relationship",
        userId: victimUser,
        characterId: victimCharacter,
        recursive: true,
      }),
    })).status).toBe(400);

    const purge = async () => {
      const response = await fetch(`${baseUrl}/v1/workspaces/purge`, {
        method: "POST",
        headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ scope: "relationship", userId: victimUser, characterId: victimCharacter }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ ok: true; purged: number }>;
    };
    expect(await purge()).toEqual({ ok: true, purged: 1 });
    expect(await purge()).toEqual({ ok: true, purged: 0 });
    expect(await present(victim)).toBe(false);
    expect(await present(neighbor)).toBe(true);
    expect(await present(outside)).toBe(true);
  });

  it("purges every relationship for one user without crossing the user boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-user-purge-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const first = relationshipWorkspacePath(canonicalRoot, "user-a", "character-1");
    const second = relationshipWorkspacePath(canonicalRoot, "user-a", "character-2");
    const neighbor = relationshipWorkspacePath(canonicalRoot, "user-b", "character-1");
    await Promise.all([first, second, neighbor].map((path) => mkdir(path, { recursive: true })));
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot,
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new UnusedAdapter(),
      igrepCommand: "igrep",
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/workspaces/purge`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "user", userId: "user-a" }),
    });
    expect(await response.json()).toEqual({ ok: true, purged: 2 });
    expect(await present(first)).toBe(false);
    expect(await present(second)).toBe(false);
    expect(await present(neighbor)).toBe(true);
  });

  it("places private crash leftovers under the relationship authority and purges them", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-private-purge-"));
    temporary.push(root);
    const store = new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
      memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
    });
    const invocation: CompanionInvocation = {
      ...activeInvocation(),
      invocationId: "invocation-private-leftover",
      attemptId: "attempt-private-leftover",
      userId: "user-private",
      characterId: "character-private",
      memoryMode: "private",
    };
    const workspace = await store.prepare(invocation);
    await writeFile(join(workspace.path, "sigkill-leftover.txt"), "private sentinel");

    expect(await present(workspace.path)).toBe(true);
    expect(await store.purge({
      scope: "relationship",
      userId: invocation.userId,
      characterId: invocation.characterId,
    })).toBe(1);
    expect(await present(workspace.path)).toBe(false);
    expect(await store.purge({
      scope: "relationship",
      userId: invocation.userId,
      characterId: invocation.characterId,
    })).toBe(0);
  });

  it("cancels an active relationship invocation before deleting canonical and attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-agent-active-purge-"));
    temporary.push(root);
    const canonicalRoot = join(root, "canonical");
    const run = activeInvocation();
    const engine = new CompanionEngine({
      workspaces: new AttemptWorkspaceStore({
        canonicalRoot,
        privateRoot: join(root, "private"),
        memoryProbe: { status: async () => ({ dialogueFiles: 0 }) },
      }),
      plugin: async () => ({ name: "igrep", apply() {} }),
      adapter: () => new BlockingAdapter(),
      igrepCommand: "igrep",
    });
    const server = createCompanionServer({
      authToken: AUTH_TOKEN,
      readiness: async () => { throw new Error("not used"); },
      invocation: engine,
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const runResponse = await fetch(`${baseUrl}/v1/invocations`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, type: "run", invocation: run }),
    });
    const stream = runResponse.text();
    const purgeResponse = await fetch(`${baseUrl}/v1/workspaces/purge`, {
      method: "POST",
      headers: { authorization: `Bearer ${AUTH_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        scope: "relationship",
        userId: run.userId,
        characterId: run.characterId,
      }),
    });
    expect(await purgeResponse.json()).toEqual({ ok: true, purged: 1 });
    expect(await stream).toContain('"type":"cancelled"');
    expect(await stream).toContain('"reason":"user"');
    expect(await present(relationshipWorkspacePath(canonicalRoot, run.userId, run.characterId))).toBe(false);
  });
});
