import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFenced } from "./fence.js";
import { RuntimeReadiness } from "./runtime-readiness.js";

const runtime = vi.hoisted(() => ({ certify: vi.fn() }));
vi.mock("./agent-runtime/runtime.js", async importOriginal => ({
  ...await importOriginal<typeof import("./agent-runtime/runtime.js")>(),
  certifyAgentRuntime: runtime.certify,
}));

import { handleChatRequest } from "./web.js";

describe("Chat maintenance authority", () => {
  let root: string;
  let readiness: RuntimeReadiness;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "idream-chat-maintenance-"));
    vi.stubEnv("CHAT_FS_ROOT", root);
    vi.stubEnv("INTERNAL_TOKEN", "maintenance-test-token");
    readiness = new RuntimeReadiness({ ttlMs: 60_000 });
    readiness.markReady();
    runtime.certify.mockReset().mockResolvedValue({ ready: true });
    for (const attempt of [1, 2]) {
      const directory = join(root, "runs", "turn-1", String(attempt));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "evidence.txt"), `attempt ${attempt}`);
    }
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  function purge(body?: string) {
    return handleChatRequest(new Request("http://chat.internal/internal/agent-runs/turn-1/purge", {
      method: "POST",
      headers: { "x-internal-token": "maintenance-test-token" },
      body,
    }), readiness);
  }

  it.each([
    '{"throughAttempt":0}', '{"throughAttempt":-1}', '{"throughAttempt":1.5}',
    '{"throughAttempt":"1"}', '{"throughAttempt":null}', '{"throughAttempt":9007199254740992}',
    '{"throughAttemp":1}', '[]', 'null', 'true', '{',
  ])("rejects malformed purge scope without widening it to a whole Turn: %s", async body => {
    const response = await purge(body);
    expect(response.status).toBe(400);
    expect(await isFenced({ scope: "turn", turnId: "turn-1" })).toBe(false);
    expect(await readFile(join(root, "runs", "turn-1", "2", "evidence.txt"), "utf8")).toBe("attempt 2");
  });

  it("purges a superseded attempt while preserving the replacement", async () => {
    expect((await purge('{"throughAttempt":1}')).status).toBe(200);
    expect(await isFenced({ scope: "attempt", turnId: "turn-1", attempt: 1 })).toBe(true);
    expect(await isFenced({ scope: "attempt", turnId: "turn-1", attempt: 2 })).toBe(false);
    await expect(readFile(join(root, "runs", "turn-1", "1", "evidence.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, "runs", "turn-1", "2", "evidence.txt"), "utf8")).toBe("attempt 2");
  });

  it.each([undefined, "{}"])('preserves the existing whole-Turn purge contract for %s', async body => {
    expect((await purge(body)).status).toBe(200);
    expect(await isFenced({ scope: "turn", turnId: "turn-1" })).toBe(true);
    await expect(readFile(join(root, "runs", "turn-1", "2", "evidence.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([undefined, "wrong-token"])("rejects unauthorized full certification before probing dependencies: %s", async token => {
    const refresh = vi.spyOn(readiness, "refreshDependencies");
    const response = await handleChatRequest(new Request("http://chat.internal/readyz?full=1", {
      headers: token ? { "x-internal-token": token } : undefined,
    }), readiness);
    expect(response.status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
    expect(runtime.certify).not.toHaveBeenCalled();
  });

  it("keeps shallow readiness public and requires the internal capability for certification", async () => {
    expect((await handleChatRequest(new Request("http://chat.internal/readyz"), readiness)).status).toBe(200);
    expect(runtime.certify).not.toHaveBeenCalled();
    const response = await handleChatRequest(new Request("http://chat.internal/readyz?full=1", {
      headers: { "x-internal-token": "maintenance-test-token" },
    }), readiness);
    expect(response.status).toBe(200);
    expect(runtime.certify).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ certification: { ready: true } });
  });
});
