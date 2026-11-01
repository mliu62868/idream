import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CompanionEvent,
  CompanionInvocation,
  CompanionTerminalCandidate,
  CompanionToolCall,
  CompanionToolResult,
} from "./contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { companionCompositionDigest, companionIgrepConfig } from "./composition";
import {
  CompanionEngine,
  CompanionCapacityError,
  buildReplaySeed,
  type CompanionEngineOptions,
  type CompanionRuntimePort,
} from "./engine";
import { AttemptWorkspaceStore } from "./workspace";
import { profileLineKey } from "./resident-profile";
import { PROFILE_EVIDENCE_FILE } from "./profile-evidence";
import { OpenAiCompatibleAdapter, ProviderError, type OpenAiCompatibleAdapterOptions, type TokenUsage } from "./openai-adapter";
import { compilePreparedTurn } from "../prepared-turn";
import { describeRequestedReplyConstraints } from "../prompt";
import { resolvePolicy } from "../policy";
import type { BuiltContext } from "../context";
import { CHARACTER_MEDIA_TOOL_DEFINITIONS } from "@idream/shared/chat/media-library";
import { IMAGE_AGENT_TOOL_DEFINITIONS } from "@idream/shared/chat/image-action";
import { companionInvocationSchema } from "./contracts";

const IGREP_LLM = { url: "https://maintenance.example/v1", model: "maintenance-model" };
const temporary: string[] = [];

// A fence is a Chat-wide durable fact under CHAT_FS_ROOT. Give every test its
// own root so one test's fenced user cannot reject another test's invocation.
beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-fence-engine-"));
  temporary.push(root);
  process.env.CHAT_FS_ROOT = root;
});

afterEach(async () => {
  delete process.env.CHAT_FS_ROOT;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type WireRequest = { messages: Array<{role:string; content:string;tool_call_id?:string}>; tools?: Array<{function:{name:string}}> };
function response(delta: unknown, finish = "stop", usage?: TokenUsage): Response {
  return new Response(`data: ${JSON.stringify({ id: "provider-request-1", provider: "DeepSeek", choices: [{delta, finish_reason:finish}],
    ...(usage ? {usage:{prompt_tokens:usage.inputTokens+(usage.cacheReadTokens??0),completion_tokens:usage.outputTokens,
      prompt_tokens_details:{cached_tokens:usage.cacheReadTokens??0},completion_tokens_details:{reasoning_tokens:usage.reasoningTokens??0}}}:{}),
  })}\n\ndata: [DONE]\n\n`);
}
class FixtureAdapter extends OpenAiCompatibleAdapter {
  constructor(private readonly fixture: OpenAiCompatibleAdapterOptions, private readonly extraction?: typeof fetch) { super({maxInputTokens:8000,...fixture}); }
  bind(profile: Parameters<CompanionEngineOptions["adapter"]>[0], policy: Parameters<CompanionEngineOptions["adapter"]>[1]) {
    let purpose: string | undefined;
    return new OpenAiCompatibleAdapter({...this.fixture, profile, ...policy,
      observeRequest: evidence => { purpose = evidence.purpose; return policy.observeRequest?.(evidence); },
      fetch: (url, init) => purpose === "media_extraction"
        ? (this.extraction ?? (async () => response({ content: '{"requests":[]}' }, "stop", { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 })))(url, init)
        : this.fixture.fetch!(url, init),
    });
  }
}
class OneStepAdapter extends FixtureAdapter {
  constructor(){super({profile:invocation().preparedTurn.profile,apiKey:"fixture",fetch:async()=>response({content:"Tonight, every blue-lit window remembers us."},"stop",{inputTokens:21,outputTokens:9,reasoningTokens:2})});}
}
class ToolThenTextAdapter extends FixtureAdapter {
  calls=0;
  constructor(prompt="Mira fully nude at the blue-lit observatory tonight",reply="Give me a moment, love.",requestedNudity:"unspecified"|"none"|"full"="full",leadIn="") {
    super({profile:invocation().preparedTurn.profile,apiKey:"fixture",fetch:async()=>{
      this.calls++;
      return this.calls===1 ? response({... (leadIn?{content:leadIn}:{}),tool_calls:[{index:0,id:"call-image-1",function:{name:"generate_image_async",arguments:JSON.stringify({prompt,subject:"companion",requestedNudity})}}]},"tool_calls") : response({content:reply});
    }});
  }
}
class LeadInThenToolAdapter extends ToolThenTextAdapter { constructor(leadIn:string){super(undefined,undefined,undefined,leadIn);} }
class BlockingAdapter extends FixtureAdapter {
  constructor(){super({profile:invocation().preparedTurn.profile,apiKey:"fixture",fetch:async(_url,init)=>new Promise<Response>((_resolve,reject)=>{
    const abort=()=>reject(init?.signal?.reason??new Error("aborted"));if(init?.signal?.aborted)abort();else init?.signal?.addEventListener("abort",abort,{once:true});
  })});}
}
class UnreachableProviderAdapter extends FixtureAdapter { constructor(){super({profile:invocation().preparedTurn.profile,apiKey:"fixture",fetch:async()=>{throw new ProviderError("unreachable","TRANSPORT");}});} }
class FirstTokenTimeoutAdapter extends FixtureAdapter { constructor(){super({profile:invocation().preparedTurn.profile,apiKey:"fixture",fetch:async()=>{throw new ProviderError("timeout","MODEL_FIRST_TOKEN_TIMEOUT");}});} }

function invocation(withTool = false): CompanionInvocation {
  const memoryMode = "private" as const;
  return {
    invocationId: `invocation-${withTool ? "tool" : "text"}`,
    attemptId: `attempt-${withTool ? "tool" : "text"}`,
    sessionId: "session-1",
    userId: "user-1",
    characterId: "character-1",
    memoryMode,
    expectedProfileDigest: companionCompositionDigest(
      memoryMode,
      companionIgrepConfig(memoryMode, "igrep"),
      { maxSteps: 8, igrepLlm: IGREP_LLM },
    ),
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    preparedTurn: {
      version: 6,
      model: "deepseek/test",
      characterName: "Mira",
      messages: [
        {
          id: "system:soul",
          sourceKind: "plugin",
          role: "system",
          content: "Pinned Mira Soul and Chat relationship boundary.",
        },
        {
          id: "user:current",
          sourceKind: "current_user",
          role: "user",
          content: "What does the observatory look like tonight?",
        },
      ],
      tools: withTool
        ? [{
            name: "generate_image_async",
            description: "Generate an image.",
            parameters: {
              type: "object",
              properties: { prompt: { type: "string" } },
              required: ["prompt"],
            },
          }]
        : [],
      profile: {
        tier: "test",
        adapter: "openai-compatible-v1",
        provider: "openrouter",
        baseUrl: "https://example.invalid/v1",
        model: "deepseek/test",
        supportsTools: true,
        maxOutputTokens: 256,
        timeout: { firstTokenMs: 1_000, idleMs: 1_000 },
        sampling: { temperature: 0.9, topP: 0.95, repetitionPenalty: 1.05 },
      },
      budget: { maxInputTokens: 8_000, usedInputTokens: 120, dropped: [] },
      trace: {
        productPromptVersion: "companion-product-1",
        systemPromptDigest: "b".repeat(64),
        characterContentVersionId: "content-1",
        characterReleaseId: "release-1",
        soulFingerprint: "a".repeat(64),
        compilerVersion: "soul-v1",
        sceneVersion: 1,
        contextRevision: "3",
      },
    },
  };
}

function imageInvocation(): CompanionInvocation {
  const value = invocation(true);
  value.preparedTurn.messages.at(-1)!.content = "Send me a nude photo at the observatory.";
  return value;
}

function mediaInvocation(): CompanionInvocation {
  const value = imageInvocation();
  value.preparedTurn.messages.at(-1)!.content = "Send me a fully clothed photo at the seaside, with no hat.";
  return companionInvocationSchema.parse({ ...value, preparedTurn: { ...value.preparedTurn,
    tools: [...value.preparedTurn.tools, ...CHARACTER_MEDIA_TOOL_DEFINITIONS] } });
}

async function engine(
  adapter: FixtureAdapter,
  memoryBuilder?: CompanionEngineOptions["memoryBuilder"],
  overrides: Partial<CompanionEngineOptions> = {},
): Promise<CompanionEngine> {
  const root = await mkdtemp(join(tmpdir(), "chat-runtime-engine-"));
  temporary.push(root);
  return new CompanionEngine({
    workspaces: new AttemptWorkspaceStore({
      canonicalRoot: join(root, "canonical"),
      privateRoot: join(root, "private"),
    }),
    adapter: (profile, policy) => adapter.bind(profile, policy),
    igrep: { command: "igrep", env: { IGREP_NO_CACHE: "1" } },
    igrepLlm: IGREP_LLM,
    ...(memoryBuilder ? { memoryBuilder } : {}),
    ...overrides,
  });
}

function normalInvocation(): CompanionInvocation {
  const value = invocation();
  return {
    ...value,
    memoryMode: "normal",
    expectedProfileDigest: companionCompositionDigest(
      "normal", companionIgrepConfig("normal", "igrep"),
      { maxSteps: 8, igrepLlm: IGREP_LLM },
    ),
  };
}

class MemoryReplyAdapter extends FixtureAdapter {
  readonly requests: WireRequest[]=[];
  constructor(text:string,nativeCall=false,usages:readonly(TokenUsage|undefined)[]=[],provisionalText="") {
    super({profile:invocation().preparedTurn.profile,apiKey:"fixture",fetch:async(_url,init)=>{
      this.requests.push(JSON.parse(String(init?.body)));
      if(nativeCall&&this.requests.length===1)return response({...(provisionalText?{content:provisionalText}:{}),tool_calls:[{index:0,id:"memory-1",function:{name:"memory_search",arguments:JSON.stringify({query:"rooftop code word"})}}]},"tool_calls",usages[0]);
      return response({content:text},"stop",usages[this.requests.length-1]);
    }});
  }
}

it.each([
  ["What exact access code did I tell you earlier?", 0.2],
  ["Confirm the exact booking reference code.", 0.2],
  ["Tell me exactly how you want to spend this evening.", 0.9],
] as const)("keeps precision sampling for qualified identifiers: %s", async (question, temperature) => {
  const value = invocation();
  value.preparedTurn.messages.at(-1)!.content = question;
  const adapter = new MemoryReplyAdapter("Your earlier code is unavailable here.");
  const runtime = await engine(adapter);
  const target = port();
  try {
    await runtime.run(value, target.runtimePort);
    expect(target.candidates).toHaveLength(1);
    expect(adapter.requests[0]).toHaveProperty("temperature", temperature);
  } finally { await runtime.shutdown(); }
});

const recallMarker = "idreamrecall_08a47391c06ac75d765597abfd2af7c5";
const recallHit = { citation: "memory/dialogues/deepseek-harness-rooftop.jsonl#L1", snippet: `The rooftop code word is ${recallMarker}.`, sourceClass: "dialogue", score: 1 };
// The engine speaks the real igrep protocol; only the subprocess is replaced,
// so wake/recall parsing and note rendering stay under test here.
const memoryPorts: Partial<CompanionEngineOptions> = {
  runIgrep: async ({ args, stdin }) => {
    if (args.includes("wake")) return { schema: "igrep.mem/1", provider: "igrep", action: "wake", workspaceRoot: args[args.indexOf("--workspace") + 1], markdownContext: "", warnings: [] };
    if (args.includes("reproject")) {
      const workspace = args[args.indexOf("--workspace") + 1]!;
      const at = "2026-09-30T23:55:00.000Z";
      for (const directory of ["dialogues", "sessions"]) await mkdir(join(workspace, ".igrep/mem/memory", directory), { recursive: true });
      await writeFile(join(workspace, ".igrep/mem/memory/sessions/deepseek-harness-rooftop.jsonl"), JSON.stringify({
        schema: "igrep.mem.session/1", agent: "deepseek-harness", id: "event-1", session_id: "rooftop", turn_index: 1,
        role: "user", content: recallHit.snippet, source_at: { instant_utc: at },
      }) + "\n");
      await writeFile(join(workspace, ".igrep/mem/memory/dialogues/deepseek-harness-rooftop.jsonl"), JSON.stringify([at, recallHit.snippet]) + "\n");
      return { schema: "igrep.mem/1", provider: "igrep", action: "reproject", migrated: false };
    }
    return { schema: "igrep.mem/1", provider: "igrep", action: "memory-search", workspaceRoot: JSON.parse(stdin!).workspace, warnings: [], results: [recallHit] };
  },
};

it.each(["normal", "private"] as const)("keeps reply scope after runtime guidance on every %s request", async (mode) => {
  const value = mode === "normal" ? normalInvocation() : invocation();
  const adapter = new MemoryReplyAdapter("I don't know.", mode === "normal");
  const runtime = await engine(adapter, undefined, memoryPorts);
  const target = port();
  try {
    await runtime.run(value, target.runtimePort);
    expect(adapter.requests).toHaveLength(mode === "normal" ? 2 : 1);
    for (const request of adapter.requests) {
      const system = request.messages.find(message => message.role === "system")!.content;
      expect(system.startsWith(value.preparedTurn.messages[0]!.content)).toBe(true);
      expect(system.indexOf("Give only the reply requested, in character.")).toBeGreaterThan(system.indexOf("For a question about what was said earlier"));
      expect(system.endsWith("End when the request is fulfilled.")).toBe(true);
      expect(system.match(/Give only the reply requested, in character\./g)).toHaveLength(1);
      expect(system).not.toContain("write the complete candidate");
    }
  } finally { await runtime.shutdown(); }
});

it("adds reply context after a successful native recall, without leaking it into the next attempt", async () => {
  const value = normalInvocation();
  const adapter = new MemoryReplyAdapter("The recorded answer.", true);
  const runtime = await engine(adapter, undefined, memoryPorts);
  const cue = "Fulfill the original request using the records now available.";
  try {
    await runtime.run(value, port().runtimePort);
    await runtime.run({ ...normalInvocation(), invocationId: "next-invocation", attemptId: "next-attempt" }, port().runtimePort);
    expect(adapter.requests).toHaveLength(3);
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain(cue);
    expect(JSON.stringify(adapter.requests[2]!.messages)).not.toContain(cue);
    const resumed = adapter.requests[1]!.messages;
    expect(resumed.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining(cue) });
    expect(resumed.at(-2)).toMatchObject({ role: "tool" });
    expect(resumed.filter(message => message.content?.includes(cue))).toHaveLength(1);
    expect(resumed.filter(message => message.role === "system")).toEqual(adapter.requests[0]!.messages.filter(message => message.role === "system"));
    const current = value.preparedTurn.messages.find(message => message.sourceKind === "current_user")!.content;
    expect(resumed.filter(message => message.role === "user" && message.content === current)).toHaveLength(1);
  } finally { await runtime.shutdown(); }
});

it.each(["igrep_search", "session_recall"])("keeps one reply context after private %s and a later retrieval", async name => {
  const requests: WireRequest[] = [];
  const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length <= 2) return response({ tool_calls: [{ index: 0, id: `lookup-${requests.length}`, function: {
        name: requests.length === 1 ? name : "session_recall",
        arguments: JSON.stringify(requests.length === 1 && name === "igrep_search" ? { query: "earlier plan" } : {}),
      } }] }, "tool_calls");
      return response({ content: "The recorded answer." });
    },
  });
  const runtime = await engine(adapter, undefined, { runIgrep: async () => ({ results: [] }) });
  const cue = "Fulfill the original request using the records now available.";
  try {
    const target = port();
    await runtime.run(invocation(), target.runtimePort);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[0]!.messages)).not.toContain(cue);
    for (const request of requests.slice(1)) {
      expect(request.messages.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining(cue) });
      expect(request.messages.filter(message => message.content?.includes(cue))).toHaveLength(1);
      expect(request.messages.filter(message => message.role === "tool").every(message => !message.content.includes(cue))).toBe(true);
    }
    expect(target.candidates).toHaveLength(1);
  } finally { await runtime.shutdown(); }
});

it.each([false, true])("keeps a single reply-form context through retrieval (already prepared: %s)", async (prepared) => {
  const value = normalInvocation();
  const current = value.preparedTurn.messages.find(message => message.sourceKind === "current_user")!;
  current.content = "Check earlier conversations and answer in two English sentences.";
  const form = describeRequestedReplyConstraints(current.content);
  if (prepared) value.preparedTurn.messages.splice(-1, 0, {
    id: "state:current", sourceKind: "plugin", role: "user", content: `Right now:\n- ${form}`,
  });
  const adapter = new MemoryReplyAdapter("I don't know. I can't recall.", true);
  const runtime = await engine(adapter, undefined, memoryPorts);
  try {
    await runtime.run(value, port().runtimePort);
    expect(adapter.requests).toHaveLength(2);
    for (const request of adapter.requests) {
      expect(request.messages.filter(message => message.content?.includes(form))).toHaveLength(1);
      const contextIndex = request.messages.findIndex(message => message.content?.includes(form));
      const currentIndex = request.messages.findIndex(message => message.content === current.content);
      expect(request.messages[contextIndex]!.role).toBe("user");
      expect(contextIndex).toBeLessThan(currentIndex);
      expect(request.messages.filter(message => message.content === current.content)).toHaveLength(1);
    }
  } finally { await runtime.shutdown(); }
});

function port(input?: {
  executeTool?: (call: CompanionToolCall) => Promise<CompanionToolResult>;
  commit?: CompanionRuntimePort["commit"];
}) {
  const events: CompanionEvent[] = [];
  const candidates: CompanionTerminalCandidate[] = [];
  const runtimePort: CompanionRuntimePort = {
    emit(event) {
      events.push(event);
    },
    executeTool: input?.executeTool ?? (async (call) => ({
      attemptId: call.attemptId,
      callId: call.callId,
      name: call.name,
      outcome: "succeeded",
      output: { accepted: true, status: "accepted", attachmentId: "attachment-1" },
    })),
    commit: input?.commit ?? (async (candidate) => {
      candidates.push(candidate);
      return {
        attemptId: candidate.attemptId,
        accepted: true,
        status: "committed",
        terminalMessageId: "assistant-1",
        committedAt: new Date().toISOString(),
      };
    }),
  };
  return { events, candidates, runtimePort };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}

describe("Chat embedded companion runtime", () => {
  it.each([
    { name: "edit_last_image", status: "awaiting_confirmation", generationJobId: null, mediaAssetId: null, costDreamcoins: 0 },
    { name: "edit_last_image", status: "cancelled", generationJobId: null, mediaAssetId: null, costDreamcoins: 0 },
    { name: "generate_image_async", status: "accepted", generationJobId: "prior-job", mediaAssetId: null, costDreamcoins: 8 },
    { name: "edit_last_image", status: "completed", generationJobId: "prior-job", mediaAssetId: "prior-image", costDreamcoins: 8 },
    { name: "send_character_media", status: "completed", generationJobId: null, mediaAssetId: "prior-video", costDreamcoins: 0 },
    ...(["failed", "refunded", "blocked", "cancelled"] as const).map(status => ({ name: "edit_last_image" as const, status,
      generationJobId: "prior-job", mediaAssetId: null, costDreamcoins: 8 })),
  ] as const)("recovers Main's $name $status card without selecting or executing another action", async facts => {
    const original = imageInvocation();
    const recovered = { ...facts, attachmentId: "rebound-attachment", instruction: "Change only the green mug to red.", sourceMediaAssetId: "source-image", description: null };
    const value = companionInvocationSchema.parse({ ...original, attemptId: "recovered-attempt", preparedTurn: { ...original.preparedTurn, recoveredMediaAction: recovered } });
    const native = vi.fn(async () => response({ content: "This selection must not run." }));
    const executeTool = vi.fn<CompanionRuntimePort["executeTool"]>();
    const adapter = new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", fetch: native }, async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request.tools).toBeUndefined();
      const data = JSON.parse(request.messages.at(-1).content);
      expect(data.recoveredMediaAction).toEqual(recovered);
      expect(data).not.toHaveProperty("executedMediaAction");
      expect(data).not.toHaveProperty("mainReceipt");
      expect(data.existingAttachmentCard).toEqual({ attachmentId: "rebound-attachment", status: facts.status, mediaAssetId: facts.mediaAssetId });
      return response({ content: '{"requests":[]}' }, "stop", { inputTokens: 7, outputTokens: 2, reasoningTokens: 1 });
    });
    const runtime = await engine(adapter);
    const connection = port({ executeTool });
    await runtime.run(value, connection.runtimePort);
    expect(native).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
    expect(connection.events.some(event => ["failed", "text_delta", "tool_started", "tool_finished"].includes(event.type))).toBe(false);
    expect(connection.candidates).toHaveLength(1);
    expect(connection.candidates[0]).toMatchObject({ attemptId: "recovered-attempt", content: "", tools: [], execution: { steps: 1, toolCalls: 0 },
      usage: { promptTokens: 7, completionTokens: 2, reasoningTokens: 1 }, mediaResponse: { version: 1, attachmentId: "rebound-attachment" } });
    expect(connection.candidates[0]?.modelRequests?.map(request => request.purpose)).toEqual(["media_extraction"]);
    expect(connection.candidates[0]?.attribution).toBeUndefined();
    await runtime.shutdown();
  });

  it.each(["normal", "private"] as const)("answers a recovered-card request through native %s retrieval without media tools", async mode => {
    const original = mode === "normal" ? { ...normalInvocation(), preparedTurn: imageInvocation().preparedTurn } : imageInvocation();
    const independent = "Also check the original conversation and tell me which path I chose.";
    const value = companionInvocationSchema.parse({ ...original, preparedTurn: { ...original.preparedTurn, recoveredMediaAction: {
      name: "edit_last_image", attachmentId: "rebound-draft", status: "awaiting_confirmation", costDreamcoins: 0, generationJobId: null, mediaAssetId: null,
      sourceMediaAssetId: "source-image", instruction: "Change only the green mug to red.",
    } } });
    value.preparedTurn.messages.at(-1)!.content = `Change the green mug to red. ${independent}`;
    value.preparedTurn.omittedMessages = [
      { id: "path-user", sourceKind: "replay", role: "user", content: "I chose the cedar path." },
      { id: "path-assistant", sourceKind: "replay", role: "assistant", content: "The cedar path it is." }];
    const requests: WireRequest[] = [];
    const executeTool = vi.fn<CompanionRuntimePort["executeTool"]>();
    const adapter = new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", fetch: async (_url, init) => {
      const request: WireRequest = JSON.parse(String(init?.body));
      requests.push(request);
      const names = request.tools!.map(tool => tool.function.name);
      expect(names).toContain("igrep_search");
      expect(names).toContain("session_recall");
      expect(names.includes("memory_search")).toBe(mode === "normal");
      expect(names.some(name => ["generate_image_async", "edit_last_image", "search_character_media", "send_character_media"].includes(name))).toBe(false);
      expect(request.messages).toContainEqual(expect.objectContaining({ role: "user", content: independent }));
      expect(JSON.stringify(request.messages)).not.toContain("Change the green mug to red.");
      expect(JSON.stringify(request.messages)).not.toContain("rebound-draft");
      expect(request.messages[0]!.content).toContain("Pinned Mira Soul");
      if (requests.length === 1) return response({ tool_calls: [{ index: 0, id: "recovered-lookup", function: {
        name: "session_recall", arguments: JSON.stringify({ ids: [`attempt:${encodeURIComponent(value.attemptId)}/main:path-user/block:0/byte:0`] }),
      } }] }, "tool_calls", { inputTokens: 10, outputTokens: 3 });
      expect(request.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "recovered-lookup", content: expect.stringContaining("I chose the cedar path.") }));
      return response({ content: "You chose the cedar path, love." }, "stop", { inputTokens: 12, outputTokens: 4 });
    } }, async () => response({ content: JSON.stringify({ requests: [independent] }) }, "stop", { inputTokens: 6, outputTokens: 2 }));
    const runtime = await engine(adapter, undefined, mode === "normal" ? memoryPorts : {});
    const connection = port({ executeTool });
    await runtime.run(value, connection.runtimePort);
    expect(executeTool).not.toHaveBeenCalled();
    expect(requests).toHaveLength(2);
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
    expect(connection.events.filter(event => event.type === "text_delta").map(event => event.delta)).toEqual(["You chose the cedar path, love."]);
    expect(connection.candidates[0]).toMatchObject({ content: "You chose the cedar path, love.", tools: [], execution: { steps: 3, toolCalls: 0 },
      usage: { promptTokens: 28, completionTokens: 9, reasoningTokens: 0 }, mediaResponse: { version: 1, attachmentId: "rebound-draft" } });
    expect(connection.candidates[0]?.modelRequests?.map(request => request.purpose)).toEqual(["media_extraction", "media_body", "media_body"]);
    await runtime.shutdown();
  });

  it.each(["extraction", "body", "budget"] as const)("does not turn a recovered card into success after %s failure", async failure => {
    const original = imageInvocation();
    const independent = "Also tell me the sum.";
    const value = companionInvocationSchema.parse({ ...original, preparedTurn: { ...original.preparedTurn, recoveredMediaAction: {
      name: "edit_last_image", attachmentId: "rebound-failed", status: "failed", costDreamcoins: 8, generationJobId: "prior-job", mediaAssetId: null,
    } } });
    value.preparedTurn.messages.at(-1)!.content += ` ${independent}`;
    const maxSteps = failure === "budget" ? 1 : 8;
    value.expectedProfileDigest = companionCompositionDigest("private", companionIgrepConfig("private", "igrep"), { maxSteps, igrepLlm: IGREP_LLM });
    const executeTool = vi.fn<CompanionRuntimePort["executeTool"]>();
    const native = vi.fn(async () => response({ content: " " }));
    const adapter = new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", fetch: native }, async () =>
      response({ content: failure === "extraction" ? "invalid" : JSON.stringify({ requests: [independent] }) }));
    const runtime = await engine(adapter, undefined, { maxSteps });
    const connection = port({ executeTool });
    await runtime.run(value, connection.runtimePort);
    expect(executeTool).not.toHaveBeenCalled();
    expect(native).toHaveBeenCalledTimes(failure === "body" ? 1 : 0);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.at(-1)).toMatchObject({ type: "failed", error: { code: "media_response_incomplete" } });
    await runtime.shutdown();
  });

  it.each([false, true].flatMap(duplicate => [false, true].map(mixed => ({ duplicate, mixed }))))("preserves the pending confirmation card (duplicate=$duplicate, mixed=$mixed)", async ({ duplicate, mixed }) => {
    const original = invocation();
    const value = companionInvocationSchema.parse({ ...original, preparedTurn: { ...original.preparedTurn, tools: IMAGE_AGENT_TOOL_DEFINITIONS } });
    const independent = "Also tell me what 17 + 25 is, in one friendly sentence.";
    const editRequest = "Edit the last photo: change only the green mug to red.";
    value.preparedTurn.messages.at(-1)!.content = mixed ? `${editRequest} ${independent}` : editRequest;
    const receipt = { accepted: true, duplicate, status: "awaiting_confirmation", attachmentId: "pending-edit",
      generationJobId: null, mediaAssetId: null, costDreamcoins: 0 };
    const executeTool = vi.fn<CompanionRuntimePort["executeTool"]>(async call => ({
      attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded", output: receipt,
    }));
    const requests: WireRequest[] = [];
    const adapter = new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", fetch: async (_url, init) => {
      const request: WireRequest = JSON.parse(String(init?.body));
      requests.push(request);
      if (requests.length === 1) return response({ tool_calls: [{ index: 0, id: "pending-edit-call", function: {
        name: "edit_last_image", arguments: JSON.stringify({ instruction: "Change only the green mug to red.", editScope: { mode: "local", target: "the green mug", selection: "one" } }),
      } }] }, "tool_calls", { inputTokens: 10, outputTokens: 2 });
      if (requests.length === 2) {
        expect(JSON.parse(request.messages.find(message => message.role === "tool")!.content)).toMatchObject({ outcome: "succeeded", output: receipt });
        return response({ content: "Done, I already generated the edit." }, "stop", { inputTokens: 10, outputTokens: 2 });
      }
      expect(request.tools?.map(tool => tool.function.name)).toEqual(expect.arrayContaining(["igrep_search", "session_recall"]));
      expect(request.tools?.some(tool => ["generate_image_async", "edit_last_image", "search_character_media", "send_character_media"].includes(tool.function.name))).toBe(false);
      expect(request.messages).toContainEqual(expect.objectContaining({ role: "user", content: independent }));
      expect(JSON.stringify(request.messages)).not.toContain(editRequest);
      expect(JSON.stringify(request.messages)).not.toContain("pending-edit");
      return response({ content: "17 + 25 is 42, love." }, "stop", { inputTokens: 10, outputTokens: 2 });
    } }, async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const data = JSON.parse(request.messages.at(-1).content);
      expect(data.mainReceipt).toMatchObject({ outcome: "succeeded", output: receipt });
      expect(data.existingAttachmentCard).toEqual({ attachmentId: "pending-edit", status: "awaiting_confirmation", mediaAssetId: null });
      return response({ content: JSON.stringify({ requests: mixed ? [independent] : [] }) }, "stop", { inputTokens: 5, outputTokens: 1 });
    });
    const runtime = await engine(adapter);
    const connection = port({ executeTool });
    await runtime.run(value, connection.runtimePort);
    expect(executeTool).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(mixed ? 3 : 2);
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
    expect(connection.events.filter(event => event.type === "text_delta").map(event => event.delta)).toEqual(mixed ? ["17 + 25 is 42, love."] : []);
    expect(connection.candidates[0]).toMatchObject({ content: mixed ? "17 + 25 is 42, love." : "",
      mediaResponse: { version: 1, attachmentId: "pending-edit" }, execution: { steps: mixed ? 4 : 3, toolCalls: 1 } });
    expect(connection.candidates[0]?.modelRequests?.map(request => request.purpose)).toEqual(mixed
      ? [undefined, undefined, "media_extraction", "media_body"] : [undefined, undefined, "media_extraction"]);
    await runtime.shutdown();
  });

  it.each(["accepted", "queued", "completed", "failed"] as const)("uses only a real %s attachment for a pure-media reply", async status => {
    for (const duplicate of [false, true]) {
      const value = imageInvocation();
      const requests: WireRequest[] = [];
      let actions = 0;
      const connection = port({ executeTool: async call => {
        actions++;
        const identity = { attemptId: call.attemptId, callId: call.callId, name: call.name };
        return status === "failed" ? { ...identity, outcome: "failed", attachmentId: "real-attachment", error: { code: "failed", message: "Failed", retryable: false } }
          : { ...identity, outcome: "succeeded", output: { status, duplicate, attachmentId: "real-attachment" } };
      } });
      const adapter = new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        expect(connection.events.some(event => event.type === "text_delta")).toBe(false);
        return requests.length === 1 ? response({ content: "Done, every pixel is unchanged.", tool_calls: [{ index: 0, id: "one-action", function: {
          name: "generate_image_async", arguments: JSON.stringify({ prompt: "Mira holding a red mug", subject: "companion" }),
        } }] }, "tool_calls", { inputTokens: 10, outputTokens: 2 }) : response({ content: "It will arrive soon, exactly as requested." }, "stop", { inputTokens: 10, outputTokens: 2 });
      } }, async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        expect(request.tools).toBeUndefined();
        expect(request.response_format).toBeUndefined();
        expect(request.chat_template_kwargs).toEqual({ enable_thinking: true });
        const data = JSON.parse(request.messages.at(-1).content);
        expect(data.mainReceipt).toMatchObject(status === "failed" ? { outcome: "failed", attachmentId: "real-attachment" } : { output: { status, attachmentId: "real-attachment" } });
        return response({ content: '```json\n{"requests":[]}\n```' }, "stop", { inputTokens: 5, outputTokens: 1 });
      });
      const runtime = await engine(adapter);
      await runtime.run(value, connection.runtimePort);
      expect(actions).toBe(1);
      expect(requests).toHaveLength(2);
      expect(connection.events.some(event => event.type === "text_delta" || event.type === "failed")).toBe(false);
      expect(connection.candidates[0]).toMatchObject({ content: "", mediaResponse: { version: 1, attachmentId: "real-attachment" },
        execution: { steps: 3, toolCalls: 1 }, usage: { promptTokens: 25, completionTokens: 5, reasoningTokens: 0 } });
      expect(connection.candidates[0]?.modelRequests?.map(request => request.purpose)).toEqual([undefined, undefined, "media_extraction"]);
      await runtime.shutdown();
    }
  });

  it.each(["invalid-json", "invented-excerpt", "unavailable", "length"] as const)("fails the entire reply when extraction is %s", async kind => {
    let nativeRequests = 0;
    let extractionStarted = false;
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async () => {
      if (++nativeRequests === 1) return response({ tool_calls: [{ index: 0, id: "one-effect", function: {
        name: "generate_image_async", arguments: JSON.stringify({ prompt: "Mira at the observatory", subject: "companion" }),
      } }] }, "tool_calls");
      return response({ content: "Provisional" });
    } }, async () => {
      extractionStarted = true;
      if (kind === "unavailable") throw new ProviderError("private-provider-body", "TRANSPORT");
      return response({ content: kind === "invalid-json" ? "not JSON" : JSON.stringify({ requests: kind === "invented-excerpt" ? ["invented request"] : [] }) }, kind === "length" ? "length" : "stop");
    });
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(imageInvocation(), connection.runtimePort);
    expect(extractionStarted).toBe(true);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.some(event => event.type === "text_delta")).toBe(false);
    expect(connection.events.at(-1)).toMatchObject({ type: "failed", error: { code: "media_response_incomplete" } });
    expect(JSON.stringify(connection.events)).not.toContain("private-provider-body");
    await runtime.shutdown();
  });

  it.each([false, true].flatMap(recovered => ["user", "timeout"].flatMap(reason => ["media_extraction", "media_body"].map(stage => ({ recovered, reason, stage })))))("retains $stage dispatch evidence on $reason cancellation (recovered=$recovered)", async ({ recovered, reason, stage }) => {
    let started = false;
    const blocked: typeof fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      started = true;
      const abort = () => reject(init?.signal?.reason ?? new Error("aborted"));
      init?.signal?.addEventListener("abort", abort, { once: true });
      if (init?.signal?.aborted) abort();
    });
    const independent = "Also tell me a fact.";
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async (url, init) => {
      const request: WireRequest = JSON.parse(String(init?.body));
      if (!request.tools?.some(tool => tool.function.name === "generate_image_async")) return blocked(url, init);
      if (request.messages.some(message => message.role === "tool")) return response({ content: "Provisional" });
      return response({ tool_calls: [{ index: 0, id: "cancel-media", function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "Mira at the observatory", subject: "companion" }) } }] }, "tool_calls");
    } }, stage === "media_extraction" ? blocked : async () => response({ content: JSON.stringify({ requests: [independent] }) }));
    const runtime = await engine(adapter);
    const value = imageInvocation();
    value.preparedTurn.messages.at(-1)!.content += ` ${independent}`;
    if (recovered) value.preparedTurn.recoveredMediaAction = { name: "edit_last_image", attachmentId: "rebound-draft", status: "awaiting_confirmation",
      costDreamcoins: 0, generationJobId: null, mediaAssetId: null, sourceMediaAssetId: "source-image" };
    if (reason === "timeout") value.deadlineAt = new Date(Date.now() + 300).toISOString();
    const connection = port();
    const running = runtime.run(value, connection.runtimePort);
    await waitFor(() => started);
    if (reason === "user") runtime.cancel(value.invocationId, "user");
    await running;
    expect(connection.events.at(-1)).toMatchObject({ type: "cancelled", reason });
    expect(connection.events.some(event => event.type === "text_delta")).toBe(false);
    expect(connection.events.filter(event => event.type === "tool_started")).toHaveLength(recovered ? 0 : 1);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.filter(event => event.type === "model_request_started").at(-1)).toMatchObject({ request: { purpose: stage } });
    expect(connection.events.filter(event => event.type === "model_request").at(-1)).toMatchObject({ request: { purpose: stage, usage: null } });
    await runtime.shutdown();
  });

  it("keeps ordinary media-capable replies intact without extraction", async () => {
    const runtime = await engine(new OneStepAdapter());
    const connection = port();
    await runtime.run(invocation(true), connection.runtimePort);
    expect(connection.candidates[0]?.content).toBe("Tonight, every blue-lit window remembers us.");
    expect(connection.candidates[0]?.modelRequests).toHaveLength(1);
    expect(connection.candidates[0]?.mediaResponse).toBeUndefined();
    expect(connection.events.filter(event => event.type === "text_delta").map(event => event.delta)).toEqual(["Tonight, every blue-lit window remembers us."]);
    await runtime.shutdown();
  });

  it("fails a selected invalid action before inventing an attachment", async () => {
    let requests = 0;
    const executeTool = vi.fn<CompanionRuntimePort["executeTool"]>();
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async () => {
      if (++requests === 1) return response({ tool_calls: [{ index: 0, id: "invalid-media-call", function: {
        name: "generate_image_async", arguments: JSON.stringify({ prompt: "short", subject: "companion" }),
      } }] }, "tool_calls");
      return response({ content: "Done, every detail is exact." });
    } });
    const runtime = await engine(adapter);
    const connection = port({ executeTool });
    await runtime.run(imageInvocation(), connection.runtimePort);
    expect(executeTool).not.toHaveBeenCalled();
    expect(connection.candidates).toEqual([]);
    expect(connection.events.at(-1)).toMatchObject({ type: "failed", error: { code: "media_response_incomplete" } });
    expect(connection.events.some(event => event.type === "text_delta")).toBe(false);
    await runtime.shutdown();
  });

  it.each(["normal", "private"] as const)("reuses the %s native loop with actual non-media pairs and current-user boundaries", async mode => {
    const value = mode === "normal" ? { ...normalInvocation(), preparedTurn: imageInvocation().preparedTurn } : imageInvocation();
    const independent = "Also check what I said earlier and answer in one friendly sentence.";
    value.preparedTurn.messages.at(-1)!.content = `Generate a new photo of yourself. ${independent}`;
    value.preparedTurn.messages.splice(1, 0,
      { id: "history-user", sourceKind: "replay", role: "user", content: "I chose the cedar path." },
      { id: "history-assistant", sourceKind: "replay", role: "assistant", content: "The cedar path it is." },
      { id: "preferences:user:current", sourceKind: "plugin", role: "user", content: "Their saved preferences: Follow their lead." });
    const requests: WireRequest[] = [];
    const firstLookup = mode === "normal" ? "memory_search" : "igrep_search";
    const call = (name: string, id: string, args: unknown) => response({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls", { inputTokens: 4, outputTokens: 1 });
    const adapter = new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", fetch: async (_url, init) => {
      const request: WireRequest = JSON.parse(String(init?.body));
      requests.push(request);
      if (requests.length === 1) return call(firstLookup, "prior-lookup", { query: "earlier choice" });
      if (requests.length === 2) return call("generate_image_async", "single-media", { prompt: "Mira walking outdoors", subject: "companion" });
      if (requests.length === 3) return response({ content: "Done, the image is perfect." }, "stop", { inputTokens: 4, outputTokens: 1 });
      const names = request.tools!.map(tool => tool.function.name);
      expect(names).toContain("session_recall");
      expect(names).toContain("igrep_search");
      expect(names.includes("memory_search")).toBe(mode === "normal");
      expect(names.some(name => ["generate_image_async", "edit_last_image", "search_character_media", "send_character_media"].includes(name))).toBe(false);
      expect(JSON.stringify(request.messages)).not.toContain("Generate a new photo of yourself.");
      expect(JSON.stringify(request.messages)).not.toContain("single-media");
      expect(request.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "prior-lookup" }));
      expect(request.messages).toContainEqual(expect.objectContaining({ role: "user", content: independent }));
      expect(request.messages.some(message => message.content?.includes("<context>\nTheir saved preferences"))).toBe(true);
      expect(request.messages.some(message => message.content === "I chose the cedar path.")).toBe(true);
      expect(request.messages[0]!.content).toContain("Pinned Mira Soul");
      return requests.length === 4 ? call("session_recall", "body-lookup", {}) : response({ content: "You chose the cedar path, love." }, "stop", { inputTokens: 4, outputTokens: 1 });
    } }, async () => response({ content: JSON.stringify({ requests: [independent] }) }, "stop", { inputTokens: 4, outputTokens: 1 }));
    const runtime = await engine(adapter, undefined, mode === "normal" ? memoryPorts : { runIgrep: async () => ({ results: [] }) });
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(requests).toHaveLength(5);
    expect(connection.events.filter(event => event.type === "text_delta").map(event => event.delta)).toEqual(["You chose the cedar path, love."]);
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
    expect(connection.candidates[0]).toMatchObject({ content: "You chose the cedar path, love.", execution: { steps: 6, toolCalls: 1 }, mediaResponse: { attachmentId: "attachment-1" } });
    expect(connection.candidates[0]?.modelRequests?.map(request => request.purpose)).toEqual([undefined, undefined, undefined, "media_extraction", "media_body", "media_body"]);
    await runtime.shutdown();
  });

  it.each(["empty", "length", "budget"] as const)("does not let the attachment mask %s independent-body failure", async kind => {
    const value = imageInvocation();
    const independent = "Also tell me the sum.";
    value.preparedTurn.messages.at(-1)!.content += ` ${independent}`;
    const maxSteps = kind === "budget" ? 3 : 8;
    value.expectedProfileDigest = companionCompositionDigest("private", companionIgrepConfig("private", "igrep"), { maxSteps, igrepLlm: IGREP_LLM });
    let calls = 0;
    const adapter = new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", fetch: async () => {
      calls++;
      if (calls === 1) return response({ tool_calls: [{ index: 0, id: "effect", function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "Mira at the cafe", subject: "companion" }) } }] }, "tool_calls");
      return response({ content: calls === 2 ? "Provisional" : kind === "empty" ? " " : "42" }, calls > 2 && kind === "length" ? "length" : "stop");
    } }, async () => response({ content: JSON.stringify({ requests: [independent] }) }));
    const runtime = await engine(adapter, undefined, { maxSteps });
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(calls).toBe(kind === "budget" ? 2 : 3);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.at(-1)).toMatchObject({ type: "failed", error: { code: "media_response_incomplete" } });
    await runtime.shutdown();
  });

  it.each([
    { missingAttempt: 1, zero: false, expected: null },
    { missingAttempt: 2, zero: false, expected: null },
    { missingAttempt: 0, zero: false, expected: { promptTokens: 80, completionTokens: 20, reasoningTokens: null } },
    { missingAttempt: 0, zero: true, expected: { promptTokens: 0, completionTokens: 0, reasoningTokens: null } },
  ])("preserves complete or unknown usage across native image and answer requests: $missingAttempt $zero", async ({ missingAttempt, zero, expected }) => {
    const value = imageInvocation();
    let requests = 0;
    const adapter = new FixtureAdapter({
      profile: value.preparedTurn.profile, apiKey: "fixture-key",
      fetch: async () => {
        requests++;
        return new Response(`data: ${JSON.stringify({
          choices: [{ delta: requests === 1
            ? { tool_calls: [{ index: 0, id: "image-1", function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "Mira at the observatory", subject: "companion" }) } }] }
            : { content: "Give me a moment, love." }, finish_reason: requests === 1 ? "tool_calls" : "stop" }],
          ...(requests === missingAttempt ? {} : { usage: { input_tokens: zero ? 0 : 40, output_tokens: zero ? 0 : 10 } }),
        })}\n\ndata: [DONE]\n\n`);
      },
    });
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(requests).toBe(2);
    expect(connection.candidates).toHaveLength(1);
    expect(connection.candidates[0]).toMatchObject({ usage: expected, execution: { toolCalls: 1 } });
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
    // Every physical request contributes its own receipt; unknown usage
    // cannot become a known terminal sum by omitting that request.
    expect(connection.events.filter(event => event.type === "usage").map(event => event.usage)).toEqual(
      [...[1, 2].filter(attempt => attempt !== missingAttempt).map(() => ({ promptTokens: zero ? 0 : 40, completionTokens: zero ? 0 : 10, reasoningTokens: null })),
        { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 }],
    );
  });

  it.each(["normal", "private"] as const)("rejects %s pool pressure before execution without producing a failure event", async (mode) => {
    const runtime = await engine(new BlockingAdapter(), undefined, { ...memoryPorts, maxConcurrentAgents: { normal: 1, private: 1 } });
    const value = mode === "normal" ? normalInvocation() : invocation();
    const running = port();
    const first = runtime.run(value, running.runtimePort);
    await waitFor(() => running.events.some(event => event.type === "started"));
    const deferred = port();
    const overflow = runtime.run({ ...value, invocationId: "overflow", attemptId: "overflow", userId: "another-user" }, deferred.runtimePort);
    await expect(overflow).rejects.toBeInstanceOf(CompanionCapacityError);
    await expect(overflow).rejects.toMatchObject({
      name: "CompanionCapacityError", pool: mode,
    });
    expect(deferred.events).toEqual([]);
    expect(deferred.candidates).toEqual([]);
    runtime.cancel(value.invocationId, "user");
    await first;
  });

  it.each([true, false])("compacts a free-tier Turn through Pi and accounts for known or missing summary usage (%s)", async (withSummaryUsage) => {
    const policy = resolvePolicy({ modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: false });
    const source: BuiltContext = {
      userLocale: "en", hasRecentImageContext: false,
      persona: {
        characterId: "character-1", creatorId: null, name: "Mara", age: 31,
        description: "A precise adult companion.", systemPrompt: "Stay specific and grounded.",
        visibility: "public", status: "approved", deletedAt: null, voiceId: null,
        visualProfileId: null, visualProfileVersion: null, identityPrompt: null,
        imageToolEnabled: false, contentVersion: null, release: null,
        characterContentVersionId: "content-1", characterReleaseId: null,
        soulFingerprint: "a".repeat(64), compilerVersion: "character-soul-3",
      },
      policy: { ...policy, modelProfile: { ...policy.modelProfile, adapter: "openai-compatible-v1", provider: "openai", baseUrl: "https://provider.example/v1", model: "fixture", supportsTools: true } },
      recentMessages: Array.from({ length: 7 }, (_, index) => ({
        id: `message-${index}`, role: index % 2 === 0 ? "user" : "assistant",
        // Leave room for the product contract and the distinct clock authorities. The additional
        // Pi memory guidance and tool schema must still force one whole exchange out.
        content: index === 6 ? "How are you tonight?" : `Established fact ${index}: ${"t".repeat(3_400)}`,
      })),
      scene: { schemaVersion: 1, version: 1, location: "the library", time: "tonight", participants: ["Mara"], emotionalBeat: "calm", unresolvedThreads: [] },
      sceneVersion: 1, lastExchangeAt: null, dropped: [], contextRevision: 0n,
    };
    const { context: _context, ...compiled } = compilePreparedTurn(source, "message-6", new Date("2026-08-24T15:04:00Z"));
    // Current snapshots trim old exchanges for the runtime reserve, so Pi compaction is
    // only a last resort. A snapshot admitted before that reserve (replayed on recovery)
    // still carries the whole transcript; Pi must compact it safely.
    expect(compiled.budget.dropped).toEqual(["transcript"]);
    const firstReplay = compiled.messages.findIndex(message => message.sourceKind === "replay");
    const preparedTurn = {
      ...compiled,
      messages: [...compiled.messages.slice(0, firstReplay), ...(compiled.omittedMessages ?? []), ...compiled.messages.slice(firstReplay)],
      omittedMessages: undefined,
      budget: { ...compiled.budget, dropped: [] },
    };
    const value = { ...normalInvocation(), preparedTurn };
    let body = "";
    const bodies: string[] = [];
    let requests = 0;
    const runtime = await engine(new OneStepAdapter(), undefined, {
      ...memoryPorts,
      adapter: (profile, requestPolicy) => new FixtureAdapter({
        profile, ...requestPolicy, apiKey: "fixture-key",
        fetch: async (_url, init) => {
          requests += 1;
          body = String(init?.body);
          bodies.push(body);
          return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Ready." }, finish_reason: "stop" }], ...(withSummaryUsage || requests > 1 ? { usage: { prompt_tokens: 100, completion_tokens: 2 } } : {}) })}\n\ndata: [DONE]\n\n`);
        },
      }),
    });
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(requests).toBe(2);
    expect(connection.candidates).toHaveLength(1);
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
    expect(connection.events).toContainEqual(expect.objectContaining({ type: "igrep_observation", operation: "compaction", outcome: "hit" }));
    expect(connection.candidates[0]?.usage).toEqual(withSummaryUsage ? { promptTokens: 200, completionTokens: 4, reasoningTokens: null } : null);
    const request = JSON.parse(body) as { messages: unknown[]; tools: unknown[] };
    const evidence = connection.candidates[0]?.modelRequests?.at(-1);
    expect(evidence?.droppedReplayMessageIds).toBeUndefined();
    expect(connection.candidates[0]?.modelRequests?.[0]?.purpose).toBe("compaction");
    for (const text of ["Established fact 0:", "Established fact 3:"]) expect(bodies[0]).toContain(text);
    expect(evidence?.bodyDigest).toBe(createHash("sha256").update(body).digest("hex"));
    expect(evidence?.estimatedInputTokens).toBe(Math.ceil(JSON.stringify({ messages: request.messages, tools: request.tools }).length / 4));
    expect(evidence?.estimatedInputTokens).toBeLessThanOrEqual(preparedTurn.budget.maxInputTokens);
    const wire = JSON.stringify(request.messages);
    expect(wire).not.toContain("Established fact 0:");
    expect(wire).not.toContain("Established fact 1:");
    for (const text of ["Established fact 4:", "Established fact 5:"]) expect(wire).toContain(text);
    for (const text of ["Stay specific and grounded.", "the library", "How are you tonight?", "memory_search"]) expect(wire).toContain(text);
    expect(source.recentMessages).toHaveLength(7);
  });

  it.each(["normal", "private"] as const)("rebinds only normal memory snapshots before reads (%s)", async (mode) => {
    const operations: string[] = [];
    const adapter = new MemoryReplyAdapter("Ready.");
    const runtime = await engine(adapter, undefined, {
      runIgrep: async (options) => {
        operations.push(options.args[1]!);
        return options.args[1] === "reproject"
          ? { schema: "igrep.mem/1", provider: "igrep", action: "reproject", migrated: false }
          : options.args[1] === "wake" ? { schema: "igrep.mem/1", provider: "igrep", action: "wake", workspaceRoot: options.args[options.args.indexOf("--workspace") + 1], markdownContext: "", warnings: [] } : { schema: "igrep.mem/1", provider: "igrep", action: "memory-search", workspaceRoot: JSON.parse(options.stdin!).workspace, warnings: [], results: [] };
      },
    });
    const connection = port();
    await runtime.run(mode === "normal" ? normalInvocation() : invocation(), connection.runtimePort);
    expect(operations).toEqual(mode === "normal" ? ["reproject", "wake", "memory-search"] : []);
    expect(connection.candidates).toHaveLength(1);
  });

  it.each(["length", "empty", "oversize"].flatMap(rejection => [true, false].map(withUsage => ({ rejection, withUsage }))))(
    "fails closed on a rejected $rejection summary while retaining its physical receipt (receipt=$withUsage)",
    async ({ rejection, withUsage }) => {
      const value = invocation();
      value.preparedTurn.budget.maxInputTokens = 6_000;
      value.preparedTurn.messages.splice(1, 0, ...Array.from({ length: 6 }, (_, index) => ({
        id: `history-${index}`, sourceKind: "replay" as const, role: index % 2 ? "assistant" as const : "user" as const,
        content: `Long authorized history. ${"t".repeat(3_500)}`,
      })));
      let purpose: string | undefined;
      let normalCalls = 0;
      const requests: Array<string | undefined> = [];
      const runtime = await engine(new OneStepAdapter(), undefined, {
        adapter: (profile, policy) => new FixtureAdapter({
          profile, ...policy, apiKey: "fixture-key",
          observeRequest: evidence => { purpose = evidence.purpose; return policy.observeRequest?.(evidence); },
          fetch: async () => {
            requests.push(purpose);
            const compacting = purpose === "compaction";
            const firstReply = !compacting && normalCalls++ === 0;
            const delta = compacting ? { content: rejection === "empty" ? "" : rejection === "oversize" ? "x".repeat(30_000) : "Truncated summary." }
              : firstReply ? { tool_calls: [{ index: 0, id: "lookup", function: { name: "igrep_search", arguments: '{"user_question":"Recall that observation."}' } }] }
                : { content: "Good evening." };
            return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: compacting && rejection === "length" ? "length" : firstReply ? "tool_calls" : "stop" }],
              ...(!compacting || withUsage ? { usage: { prompt_tokens: 100, completion_tokens: 10 } } : {}),
            })}\n\ndata: [DONE]\n\n`);
          },
        }),
      });
      const connection = port();
      await runtime.run(value, connection.runtimePort);

      expect(requests).toEqual(["compaction"]);
      expect(connection.events).toContainEqual(expect.objectContaining({ type: "igrep_observation", operation: "compaction", outcome: "failure" }));
      // Required summaries no longer fall back to the upstream coding prompt or
      // continue with rejected context. Every dispatched summary still has a receipt.
      expect(connection.candidates).toHaveLength(0);
      expect(connection.events.at(-1)?.type).toBe("failed");
      expect(connection.events.filter(event => event.type === "usage")).toHaveLength(withUsage ? 1 : 0);
      expect(connection.events.filter(event => event.type === "model_request")).toEqual([
        expect.objectContaining({ request: expect.objectContaining({ purpose: "compaction",
          provider: value.preparedTurn.profile.provider, model: value.preparedTurn.profile.model,
          usage: withUsage ? { inputTokens: 100, outputTokens: 10 } : null,
        }) }),
      ]);
    },
  );

  it("does not call the model when snapshot reproject fails", async () => {
    const adapter = new MemoryReplyAdapter("Must not execute.");
    const runtime = await engine(adapter, undefined, { runIgrep: async () => { throw new Error("snapshot binding unavailable"); } });
    const connection = port();
    await runtime.run(normalInvocation(), connection.runtimePort);
    expect(adapter.requests).toHaveLength(0);
    expect(connection.candidates).toHaveLength(0);
    expect(connection.events.at(-1)).toMatchObject({ type: "failed" });
  });

  it.each(["current", "profile-empty", "profile-hit", "replay-hit", "unseen-hit", "unknown"] as const)(
    "keeps retrieval evidence independent of memory question wording (%s)", async source => {
      const fact = recallHit.snippet;
      const contexts: unknown[][] = [];
      for (const remembers of [false, true]) {
        const value = normalInvocation();
        const current = `${remembers ? "Do you remember" : "Tell me"} the rooftop code word?${source === "current" ? ` ${fact}` : ""}`;
        value.preparedTurn.messages.at(-1)!.content = current;
        if (source === "replay-hit") value.preparedTurn.messages.splice(1, 0, {
          id: "briar-original", sourceKind: "replay", role: "assistant", content: fact,
          speaker: { characterId: "briar", sessionId: "briar-session", name: "Briar" },
        });
        const adapter = new MemoryReplyAdapter("Fixture terminal.");
        const runtime = await engine(adapter, undefined, { runIgrep: async options => {
          if (options.args.includes("wake") && source.startsWith("profile")) {
            const workspace = options.args[options.args.indexOf("--workspace") + 1]!;
            await writeFile(join(workspace, ".igrep", PROFILE_EVIDENCE_FILE), JSON.stringify({ schema: 1,
              lines: { [profileLineKey(fact)]: { evidence: "fixture", supported: true } },
            }));
            return { schema: "igrep.mem/1", provider: "igrep", action: "wake", workspaceRoot: workspace, markdownContext: `- ${fact}`, warnings: [] };
          }
          if (options.args.includes("memory-search")) return {
            schema: "igrep.mem/1", provider: "igrep", action: "memory-search", workspaceRoot: JSON.parse(options.stdin!).workspace, warnings: [],
            results: source === "profile-hit" ? [{ citation: "profile:fixture", snippet: fact, sourceClass: "profile" }]
              : source === "replay-hit" || source === "unseen-hit" ? [recallHit] : [],
          };
          return memoryPorts.runIgrep!(options);
        } });
        const connection = port();
        await runtime.run(value, connection.runtimePort);
        expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
        expect(connection.candidates).toHaveLength(1);
        const messages = adapter.requests[0]!.messages;
        expect(messages.at(-1)).toEqual({ role: "user", content: current });
        const text = messages.map(message => message.content).join("\n");
        expect(text.split(fact).length - 1).toBe(source === "unknown" ? 0 : 1);
        expect(messages.filter(message => message.role === "system").some(message => message.content.includes(fact))).toBe(false);
        if (source === "replay-hit") expect(messages).toContainEqual({ role: "user", content: `Briar: ${fact}` });
        expect(connection.events).toContainEqual(expect.objectContaining({ type: "igrep_observation", operation: "memory",
          outcome: source.endsWith("hit") ? "hit" : "empty", resultCount: source.endsWith("hit") ? 1 : 0,
        }));
        expect(adapter.requests[0]!.tools?.some(tool => tool.function.name === "memory_search")).toBe(true);
        // The automatic fast search is advisory and has not searched the
        // session archive. Its miss must not become an instruction to deny recall.
        expect(text).not.toContain("The memory search returned no additional facts");
        expect(text).not.toContain("if the requested detail is still unavailable");
        expect(text).toContain("If the requested facts are missing and they ask you simply to say you don't remember");
        contexts.push(messages.slice(0, -1));
      }
      // Changing only the question's memory wording cannot change known facts
      // or turn duplicate/profile-only hits into a claim of global amnesia.
      expect(contexts[0]).toEqual(contexts[1]);
    },
  );

  it.each(["normal", "private"] as const)("keeps supported historical profile instructions below current user authority (%s)", async mode => {
    const value = mode === "normal" ? normalInvocation() : invocation();
    const facts = ["The notebook is in the green cupboard.", "Historical: User asked: Reply in one brief English sentence about the notebook."];
    const adapter = new MemoryReplyAdapter("Current reply.");
    const runtime = await engine(adapter, undefined, {
      runIgrep: async options => {
        if (options.args.includes("wake")) {
          const workspace = options.args[options.args.indexOf("--workspace") + 1]!;
          await writeFile(join(workspace, ".igrep", PROFILE_EVIDENCE_FILE), JSON.stringify({ schema: 1,
            lines: Object.fromEntries(facts.map(fact => [profileLineKey(fact), { evidence: "fixture", supported: true }])),
          }));
          return { schema: "igrep.mem/1", provider: "igrep", action: "wake", workspaceRoot: workspace,
            markdownContext: facts.map(fact => `- ${fact}`).join("\n"), warnings: [] };
        }
        return memoryPorts.runIgrep!(options);
      },
    });
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(connection.candidates).toHaveLength(1);
    const request = adapter.requests[0]!;
    const system = request.messages.find(message => message.role === "system")!.content;
    const current = request.messages.at(-1)!.content;
    const background = request.messages.slice(0, -1).filter(message => message.role === "user").map(message => message.content).join("\n");
    for (const fact of facts) {
      expect(system).not.toContain(fact);
      expect(background.split(fact).length - 1).toBe(mode === "normal" ? 1 : 0);
      if (mode === "normal") expect(background.indexOf(fact)).toBeLessThan(background.indexOf("</context>"));
    }
    const original = value.preparedTurn.messages.find(message => message.sourceKind === "current_user")!.content;
    expect(current).toBe(original);
    if (mode === "normal") expect(system).toContain("call memory_search before answering");
  });

  it.each([false, true])("preserves group speakers through Pi into the provider request (image=%s)", async (image) => {
    const value = image ? imageInvocation() : invocation();
    const speakers = [
      { characterId: "briar", sessionId: "briar-session", name: "Briar" },
      { characterId: "cedar", sessionId: "cedar-session", name: "Cedar" },
    ];
    value.preparedTurn.messages.splice(1, 0,
      { id: "prior-user", sourceKind: "replay", role: "user", content: "Who brought what?" },
      { id: "prior-briar", sourceKind: "replay", role: "assistant", speaker: speakers[0], content: "I brought the cup." },
      { id: "prior-cedar", sourceKind: "replay", role: "assistant", speaker: speakers[1], content: "I moved the book." },
      { id: "preferences:current", sourceKind: "plugin", role: "user", content: "Saved interaction preferences: use a single short sentence." },
    );
    const requests: Array<{ messages: unknown[] }> = [];
    const adapter = new FixtureAdapter({
      profile: value.preparedTurn.profile,
      apiKey: "fixture-key",
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as { messages: unknown[] });
        return new Response(`data: ${JSON.stringify({ choices: [{
          delta: image && requests.length === 1 ? { tool_calls: [{ index: 0, id: "image-1", function: {
            name: "generate_image_async", arguments: JSON.stringify({ prompt: "A rainy observatory portrait", subject: "companion" }),
          } }] } : { content: "Briar brought the cup; Cedar moved the book." },
          finish_reason: image && requests.length === 1 ? "tool_calls" : "stop",
        }] })}\n\ndata: [DONE]\n\n`);
      },
    });
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
    const request = JSON.stringify(requests[0]?.messages);
    for (const speaker of speakers) expect(request).toContain(`${speaker.name}: I `);
    const last = requests[0]!.messages.at(-1) as { role: string; content: string };
    expect(last.role).toBe("user");
    expect(last.content).toBe(value.preparedTurn.messages.find(message => message.sourceKind === "current_user")!.content);
    expect((requests[0]!.messages.at(-2) as { content: string }).content).toContain("Saved interaction preferences: use a single short sentence.");
    expect(request.indexOf("I brought the cup.")).toBeLessThan(request.indexOf("I moved the book."));
  });

  // SPEC (2026-10-08): budget-omitted dialogue is not seeded into the live session, so
  // a long conversation does not cross Pi's compaction trigger on every turn.
  it("does not seed dialogue the PreparedTurn omitted for budget", () => {
    const value = invocation();
    value.preparedTurn.omittedMessages = [{ id: "old-1", sourceKind: "replay", role: "user", content: "An old line trimmed for budget." }];
    const texts = buildReplaySeed(value).flatMap(event => JSON.stringify(event));
    expect(texts.some(text => text.includes("An old line trimmed for budget."))).toBe(false);
  });

  it("keeps omitted originals and runtime instructions out of general knowledge search", async () => {
    const value = invocation();
    const original = "The revised booking is November 18 in Osaka, reservation OSA-816.";
    value.preparedTurn.omittedMessages = [{ id: "revised-booking", sourceKind: "replay", role: "user", content: original }];
    const requests: WireRequest[] = [];
    const knowledge: Record<string, string> = {};
    const runtime = await engine(new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) return response({ tool_calls: [{ index: 0, id: "search", function: {
        name: "igrep_search", arguments: JSON.stringify({ query: "What booking did we confirm?" }),
      } }] }, "tool_calls");
      if (requests.length === 2) return response({ tool_calls: [{ index: 0, id: "recall", function: {
        name: "session_recall", arguments: JSON.stringify({ ids: [`attempt:${value.attemptId}/main:revised-booking/block:0/byte:0`] }),
      } }] }, "tool_calls");
      return response({ content: original });
    } }), undefined, {
      runIgrep: async ({ args }) => {
        const directory = args.at(-1)!;
        for (const name of await readdir(directory)) knowledge[name] = await readFile(join(directory, name), "utf8");
        return { results: [] };
      },
    });
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(connection.candidates).toHaveLength(1);
    expect(JSON.stringify(knowledge)).not.toContain(original);
    expect(JSON.stringify(knowledge)).not.toContain(value.preparedTurn.messages[0]!.content);
    expect(knowledge["conversation.jsonl"]).toContain(value.preparedTurn.messages.at(-1)!.content);
    expect(requests[2]!.messages.find(message => message.tool_call_id === "recall")?.content).toContain(original);
  });

  it.each([false, true])("binds recalled group speakers to original entries without altering passages (invalid=%s)", async (invalid) => {
    const value=invocation();
    const speakers=[{characterId:"briar",sessionId:"briar-session",name:"Briar"},{characterId:"cedar",sessionId:"cedar-session",name:"Cedar"}];
    const originals=["I brought the cup.\n原文 ␊","I moved the book."];
    value.preparedTurn.omittedMessages=speakers.map((speaker,index)=>({id:`group-${index}`,sourceKind:"replay",role:"assistant",speaker,content:originals[index]!}));
    const ids=originals.map((_text,index)=>`attempt:${value.attemptId}/main:group-${invalid&&index===0?999:index}/block:0/byte:0`);
    const requests:WireRequest[]=[];
    const runtime=await engine(new FixtureAdapter({profile:value.preparedTurn.profile,apiKey:"fixture",fetch:async(_url,init)=>{
      requests.push(JSON.parse(String(init?.body)));
      return requests.length===1?response({tool_calls:[{index:0,id:"recall",function:{name:"session_recall",arguments:JSON.stringify({ids})}}]},"tool_calls"):response({content:"Ready."});
    }}));
    const connection=port();await runtime.run(value,connection.runtimePort);
    expect(connection.events).toContainEqual(expect.objectContaining({type:"igrep_observation",operation:"session",outcome:invalid?"failure":"hit"}));
    expect(requests).toHaveLength(invalid?1:2);
    expect(connection.candidates).toHaveLength(invalid?0:1);
    if(!invalid){
      const hits=JSON.parse(requests[1]!.messages.find(message=>message.role==="tool")!.content);
      for(const [index,hit]of hits.entries()){expect(hit.content).toBe(originals[index]);expect(hit.speaker).toEqual(speakers[index]);}
    }
  });

  it.each(["normal","private"] as const)("restricts tools in %s mode at presentation and dispatch",async(mode)=>{
    const requests:WireRequest[]=[];const effects:CompanionToolCall[]=[];
    const adapter=new FixtureAdapter({profile:invocation().preparedTurn.profile,apiKey:"fixture",fetch:async(_url,init)=>{
      requests.push(JSON.parse(String(init?.body)));
      return requests.length===1?response({tool_calls:[{index:0,id:"forbidden",function:{name:"memory_record",arguments:"{}"}},{index:1,id:"unexpected",function:{name:"unexpected_plugin_tool",arguments:"{}"}}]},"tool_calls"):response({content:"I can read only permitted memories."});
    }});
    const runtime=await engine(adapter,undefined,memoryPorts);const connection=port({executeTool:async call=>{effects.push(call);throw new Error("forbidden tools cannot reach Main");}});
    await runtime.run(mode==="normal"?normalInvocation():invocation(),connection.runtimePort);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.tools?.map(tool=>tool.function.name).sort()).toEqual((mode==="normal"?["igrep_search","memory_search","session_recall"]:["igrep_search","session_recall"]).sort());
    const guidance = requests[0]!.messages.filter(message => message.role === "system").map(message => message.content).join("\n");
    if (mode === "private") expect(guidance).not.toContain("Use memory_search");
    expect(effects).toEqual([]);
    const errors=requests[1]!.messages.filter(message=>message.role==="tool");expect(errors).toHaveLength(2);
    for(const error of errors)expect(error.content).toMatch(/not available|not found|unknown|not registered/i);
    expect(connection.candidates).toHaveLength(1);
  });

  it("rejects the observed unexecuted memory call despite preRecall evidence, without another model call or commit", async () => {
    const text = 'I can see the gardens below, rooftops layered against the fading light, and you here beside me. Before we decide on the trains, let me check what I remember from earlier sessions.\n\n{memory_search: "exact rooftop probe code word"}';
    const adapter = new MemoryReplyAdapter(text);
    const runtime = await engine(adapter, undefined, memoryPorts);
    const connection = port();

    await runtime.run(normalInvocation(), connection.runtimePort);

    expect(adapter.requests).toHaveLength(1);
    expect(JSON.stringify(adapter.requests[0].messages)).toContain(recallMarker);
    expect(connection.events).toContainEqual(expect.objectContaining({
      type: "igrep_observation", operation: "memory", outcome: "hit", evidenceMatches: 1,
    }));
    expect(connection.candidates).toEqual([]);
    expect(connection.events.map(event => event.type)).not.toContain("terminal_candidate");
    expect(connection.events.map(event => event.type)).not.toContain("tool_started");
    expect(connection.events.at(-2)).toMatchObject({ type: "text_reset" });
    expect(connection.events.at(-1)).toMatchObject({
      type: "failed", error: { code: "unexecuted_tool_payload", retryable: true },
    });
  });

  it.each([
    "The memory_search tool can look up a previous conversation.",
    'The literal text is \'{memory_search: "rooftop code word"}\'.',
    'An inline example is `{memory_search: "rooftop code word"}`.',
    'Example:\n\n```text\n\n{memory_search: "rooftop code word"}\n```',
    'Example:\n\n```text\n\n{memory_search: "rooftop code word"}',
    'Example:\n\n    {memory_search: "rooftop code word"}',
    'You quoted:\n\n> {memory_search: "rooftop code word"}',
  ])("preserves ordinary memory tool mentions and quoted examples: %s", async (text) => {
    const adapter = new MemoryReplyAdapter(text);
    const runtime = await engine(adapter, undefined, memoryPorts);
    const connection = port();
    await runtime.run(normalInvocation(), connection.runtimePort);
    expect(adapter.requests).toHaveLength(1);
    expect(connection.candidates[0]?.content).toBe(text);
    expect(connection.events.some(event => event.type === "text_reset" || event.type === "failed")).toBe(false);
  });

  it.each([
    { finalUsage: { inputTokens: 30, outputTokens: 7, reasoningTokens: 2 }, expected: { promptTokens: 55, completionTokens: 11, reasoningTokens: 3 } },
    { finalUsage: undefined, expected: null },
  ])("accounts for every model step around native memory_search, including missing final usage: $finalUsage", async ({ finalUsage, expected }) => {
    let searches = 0;
    const adapter = new MemoryReplyAdapter(`We chose ${recallMarker}.`, true, [
      { inputTokens: 20, cacheReadTokens: 5, outputTokens: 4, reasoningTokens: 1 },
      finalUsage,
    ]);
    const runtime = await engine(adapter, undefined, {
      runIgrep: async options => { if(options.args.includes("memory-search")) searches++; return memoryPorts.runIgrep!(options); },
    });
    const connection = port();
    await runtime.run(normalInvocation(), connection.runtimePort);
    expect(searches).toBe(2);
    expect(adapter.requests).toHaveLength(2);
    expect(JSON.stringify(adapter.requests[1].messages)).toContain('"role":"tool"');
    expect(connection.candidates[0]?.content).toBe(`We chose ${recallMarker}.`);
    expect(connection.candidates[0]?.usage).toEqual(expected);
    expect(connection.events.some(event => event.type === "failed")).toBe(false);
  });

  it.each([false, true])("binds native memory_search to original dated sources and blocks invalid citations (invalid=%s)", async (invalid) => {
    const original = "Yesterday (2026-09-30), I wrote 'tomorrow we meet' in an old letter.";
    const adapter = new MemoryReplyAdapter("The old letter said tomorrow.", true, [], "I am checking the old letter.");
    let searches = 0;
    const runtime = await engine(adapter, undefined, {
      runIgrep: async (options) => {
        if (options.args.includes("reproject")) {
          const workspace = options.args[options.args.indexOf("--workspace") + 1]!;
          const name = "deepseek-harness-dated.jsonl";
          for (const directory of ["dialogues", "sessions"]) await mkdir(join(workspace, ".igrep/mem/memory", directory), { recursive: true });
          await writeFile(join(workspace, ".igrep/mem/memory/sessions", name), JSON.stringify({
            schema: "igrep.mem.session/1", agent: "deepseek-harness", id: "event-1", session_id: "dated", turn_index: 1,
            role: "user", content: original, source_at: { instant_utc: "2026-10-01T00:05:00.000Z", timezone: "UTC" },
          }) + "\n");
          await writeFile(join(workspace, ".igrep/mem/memory/dialogues", name), JSON.stringify([
            "2026-10-01T00:05:00.000Z", original.replace("tomorrow", "tomorrow（2026-10-02）"),
          ]) + "\n");
          return { schema: "igrep.mem/1", provider: "igrep", action: "reproject", migrated: false };
        }
        if(options.args.includes("wake")) return {schema:"igrep.mem/1",provider:"igrep",action:"wake",workspaceRoot:options.args[options.args.indexOf("--workspace")+1],markdownContext:"",warnings:[]};
        return {schema:"igrep.mem/1",provider:"igrep",action:"memory-search",workspaceRoot:JSON.parse(options.stdin!).workspace,results:++searches===1?[]:[{
          citation:`memory/dialogues/deepseek-harness-${invalid?"foreign":"dated"}.jsonl#L1`,snippet:original.replace("tomorrow","tomorrow（2026-10-02）"),sourceClass:"dialogue",score:1,
        }],warnings:[]};
      },
    });
    const connection = port();
    await runtime.run(normalInvocation(), connection.runtimePort);
    expect(adapter.requests).toHaveLength(invalid ? 1 : 2);
    const messages = JSON.stringify(adapter.requests.at(-1)!.messages);
    expect(messages).not.toContain("tomorrow（2026-10-02）");
    if (invalid) {
      expect(connection.candidates).toHaveLength(0);
      expect(connection.events).toContainEqual(expect.objectContaining({ type: "igrep_observation", operation: "memory", outcome: "failure" }));
      expect(connection.events).toContainEqual(expect.objectContaining({ type: "text_reset" }));
    } else {
      expect(messages).toContain(original);
      expect(messages).toContain("2026-10-01T00:05:00.000Z");
      expect(connection.candidates).toHaveLength(1);
      expect(connection.events.some(event => event.type === "failed")).toBe(false);
    }
  });

  it("logs only fixed memory failure categories and still blocks a failed native recall", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const adapter = new MemoryReplyAdapter("Must not commit.", true);
      const runtime = await engine(adapter, undefined, {
        runIgrep: async ({ args, stdin }) => args.includes("reproject")
          ? { schema: "igrep.mem/1", provider: "igrep", action: "reproject", migrated: false }
          : args.includes("wake") ? { schema: "igrep.mem/1", provider: "igrep", action: "wake", workspaceRoot: args[args.indexOf("--workspace") + 1], markdownContext: "", warnings: [] }
            : { schema: "igrep.mem/1", provider: "igrep", action: "memory-search", workspaceRoot: JSON.parse(stdin!).workspace, results: [], warnings: ["PRIVATE_MEMORY_WARNING"] },
      });
      const connection = port();
      await runtime.run(normalInvocation(), connection.runtimePort);
      expect(adapter.requests).toHaveLength(1);
      expect(connection.candidates).toHaveLength(0);
      expect(connection.events).toContainEqual(expect.objectContaining({
        type: "failed", error: expect.objectContaining({ code: "igrep_memory_failed" }),
      }));
      const lines = stderr.mock.calls.map(([line]) => String(line));
      const records = lines.map(line => JSON.parse(line));
      expect(records).toContainEqual(expect.objectContaining({ event: "companion_recall_degraded", memoryFailure: "partial_evidence" }));
      expect(records).toContainEqual(expect.objectContaining({ event: "companion_memory_tool_failed", memoryFailure: "partial_evidence" }));
      expect(lines.join("\n")).not.toContain("PRIVATE_");
    } finally {
      stderr.mockRestore();
    }
  });

  it("streams one terminal candidate and commits it directly through Chat", async () => {
    const runtime = await engine(new OneStepAdapter());
    const connection = port();

    await runtime.run(invocation(), connection.runtimePort);

    expect(connection.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "started",
      "text_delta",
      "usage",
      "reasoning_usage",
      "terminal_candidate",
    ]));
    expect(connection.candidates).toHaveLength(1);
    expect(connection.candidates[0]).toMatchObject({
      content: "Tonight, every blue-lit window remembers us.",
      finishReason: "stop",
      execution: { steps: 1, toolCalls: 0 },
      attribution: { requestId: "provider-request-1", actualProvider: "DeepSeek" },
    });
    expect(connection.events.map((event) => event.sequence))
      .toEqual(connection.events.map((_event, index) => index + 1));
  });

  it.each(["stop", "length"])("classifies a thinking-only %s result without committing or retrying it", async finish => {
    let requests = 0;
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture",
      fetch: async () => { requests++; return response({ reasoning_content: "PRIVATE_INCOMPLETE_PLAN", content: " \n" }, finish,
        { inputTokens: 100, outputTokens: 7, reasoningTokens: 6 }); },
    });
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(invocation(), connection.runtimePort);
    expect(requests).toBe(1);
    expect(connection.candidates).toHaveLength(0);
    expect(connection.events.at(-1)).toMatchObject({ type: "failed", error: {
      code: finish === "length" ? "model_output_exhausted" : "empty_model_response", retryable: finish !== "length",
    } });
    expect(connection.events).toContainEqual(expect.objectContaining({ type: "usage",
      usage: { promptTokens: 100, completionTokens: 7, reasoningTokens: 6 } }));
    expect(JSON.stringify(connection.events)).not.toContain("PRIVATE_INCOMPLETE_PLAN");
  });

  it("keeps reasoning private through a native tool round trip and counts it only within provider output totals", async () => {
    const requests: WireRequest[] = [];
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? response({ reasoning_content: "PRIVATE_SELECTION", tool_calls: [{ index: 0, id: "image-reasoned", function: {
          name: "generate_image_async", arguments: JSON.stringify({ prompt: "Mira beside the observatory window", subject: "companion" }),
        } }] }, "tool_calls", { inputTokens: 20, outputTokens: 12, reasoningTokens: 5 })
        : response({ reasoning_content: "PRIVATE_REVIEW", content: "A little glimpse of my evening for you." }, "stop", { inputTokens: 30, outputTokens: 14, reasoningTokens: 6 });
    } });
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(invocation(true), connection.runtimePort);
    expect(connection.candidates).toHaveLength(1);
    expect(connection.candidates[0]).toMatchObject({
      content: "", mediaResponse: { attachmentId: "attachment-1" }, execution: { steps: 3, toolCalls: 1 },
      usage: { promptTokens: 50, completionTokens: 26, reasoningTokens: 11 },
    });
    expect(JSON.stringify({ requests, events: connection.events, candidates: connection.candidates })).not.toContain("PRIVATE_");
    expect(requests[1]?.messages.some(message => message.role === "tool")).toBe(true);
  });

  it("keeps known totals across tool steps when one reasoning subtotal is unknown", async () => {
    let requests = 0;
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async () => {
      if (++requests === 1) return new Response(`data: ${JSON.stringify({ choices: [{ delta: {
        reasoning_content: "Private selection", tool_calls: [{ index: 0, id: "image-unknown-subtotal", function: {
          name: "generate_image_async", arguments: JSON.stringify({ prompt: "Mira beside the observatory window", subject: "companion" }),
        } }],
      }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
      return response({ content: "A little glimpse of my evening for you." }, "stop", { inputTokens: 30, outputTokens: 14, reasoningTokens: 6 });
    } });
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(invocation(true), connection.runtimePort);
    expect(connection.candidates).toHaveLength(1);
    expect(connection.candidates[0]?.usage).toEqual({ promptTokens: 50, completionTokens: 26, reasoningTokens: null });
  });

  it("lets the Agent choose an exposed image tool without a host-classified required action", async () => {
    const adapter = new ToolThenTextAdapter(undefined, "Give me a moment…");
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(invocation(true), connection.runtimePort);
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
    expect(connection.candidates[0]?.execution.toolCalls).toBe(1);
    expect(adapter.calls).toBe(2);
  });

  it("requires the Agent to author and execute the concrete image prompt", async () => {
    const runtime = await engine(new ToolThenTextAdapter());
    const calls: CompanionToolCall[] = [];
    const connection = port({
      executeTool: async (call) => {
        calls.push(call);
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "succeeded",
          output: { status: "accepted", attachmentId: "real-attachment", generationJobId: "job-required" },
        };
      },
    });

    await runtime.run(imageInvocation(), connection.runtimePort);

    expect(calls).toEqual([
      expect.objectContaining({
        name: "generate_image_async",
        effectScope: "turn_action",
        intent: { requestedNudity: "full" },
        arguments: expect.objectContaining({
          prompt: "Mira fully nude at the blue-lit observatory tonight",
        }),
      }),
    ]);
    expect(connection.candidates[0]).toMatchObject({
      execution: { steps: 3, toolCalls: 1 },
      tools: [expect.objectContaining({
        effectScope: "turn_action",
        intent: { requestedNudity: "full" },
      })],
    });
  });

  it.each([
    ["generate_image_async", "accepted"], ["generate_image_async", "queued"], ["generate_image_async", "completed"],
    ["edit_last_image", "accepted"], ["edit_last_image", "queued"], ["edit_last_image", "completed"],
  ] as const)("retains the exact %s %s receipt without spoken acknowledgement guidance", async (name, status) => {
    const original = imageInvocation();
    const value = companionInvocationSchema.parse({ ...original, preparedTurn: {
      ...original.preparedTurn, tools: IMAGE_AGENT_TOOL_DEFINITIONS,
    } });
    const requests: WireRequest[] = [];
    const receipts: CompanionToolResult[] = [];
    const reply = status === "completed" ? "The photo has arrived." : "The photo is still being worked on.";
    const adapter = new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture", fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? response({ tool_calls: [{ index: 0, id: "image-status", function: { name, arguments: JSON.stringify(name === "edit_last_image"
          ? { instruction: "Change the mug to red.", requestedNudity: "none", editScope: { mode: "local", target: "mug", selection: "one" } }
          : { prompt: "Mira holding a red mug.", subject: "companion", requestedNudity: "none" }) } }] }, "tool_calls")
        : response({ content: reply });
    } });
    const runtime = await engine(adapter);
    const connection = port({ executeTool: async call => {
      const receipt: CompanionToolResult = { attemptId: call.attemptId, callId: call.callId, name: call.name,
        outcome: "succeeded", output: { accepted: true, duplicate: false, status, attachmentId: "attachment-status",
          generationJobId: "job-status", mediaAssetId: status === "completed" ? "media-status" : null, costDreamcoins: 8 } };
      receipts.push(structuredClone(receipt));
      return receipt;
    } });
    try {
      await runtime.run(value, connection.runtimePort);
      expect(requests).toHaveLength(2);
      const continuation = requests[1]!.messages.find(message => message.role === "tool");
      expect(continuation?.tool_call_id).toBe("image-status");
      const raw = JSON.stringify(receipts[0]);
      expect(continuation?.content).toBe(raw);
      expect(connection.candidates[0]?.content).toBe("");
      expect(connection.candidates[0]?.mediaResponse).toEqual({ version: 1, attachmentId: "attachment-status" });
      expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
    } finally { await runtime.shutdown(); }
  });

  it("runs a native search and selected free delivery without spending the action on search", async () => {
    const requests: WireRequest[] = [];
    const calls: CompanionToolCall[] = [];
    const description = "Mira wears a blue dress by the seaside without a hat.";
    const searchArgs = { kind: "image", query: "Mira in a blue dress by the seaside, without a hat", requestedNudity: "none", unseenOnly: true };
    const matches = [
      { candidateToken: "high-ranked-other", kind: "image", description: "Mira in a blue dress indoors.",
        facts: ["blue dress", "indoors"], absentFacts: ["hat"], durationSeconds: null, hasAudio: null, alreadySent: false, score: 0.94 },
      { candidateToken: "exact-seaside-result", kind: "image", description,
        facts: ["blue dress", "seaside"], absentFacts: ["hat"], durationSeconds: null, hasAudio: null, alreadySent: false, score: 0.81 },
    ];
    const receipt = { accepted: true, duplicate: false, status: "completed", attachmentId: "attachment-free",
      mediaAssetId: "media-free", generationJobId: null, costDreamcoins: 0, source: "library", description };
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async (_url, init) => {
      const request: WireRequest = JSON.parse(String(init?.body));
      requests.push(request);
      const call = (name: string, args: unknown) => response({ tool_calls: [{ index: 0, id: `media-${requests.length}`,
        function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls", { inputTokens: 20, outputTokens: 3 });
      if (requests.length === 1) return call("search_character_media", searchArgs);
      const observed = JSON.parse(request.messages.filter(message => message.role === "tool").at(-1)!.content);
      if (requests.length === 2) {
        expect(observed.output).toEqual({ accepted: true, status: "matches", matches });
        expect(observed.output).not.toHaveProperty("attachmentId");
        return call("send_character_media", { candidateToken: observed.output.matches[1].candidateToken });
      }
      expect(observed.output).toEqual(receipt);
      return response({ content: observed.output.description }, "stop", { inputTokens: 20, outputTokens: 3 });
    } });
    const runtime = await engine(adapter);
    const connection = port({ executeTool: async call => {
      calls.push(call);
      return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded",
        output: call.name === "search_character_media" ? { accepted: true, status: "matches", matches } : receipt };
    } });
    await runtime.run(mediaInvocation(), connection.runtimePort);
    expect(calls).toEqual([
      expect.objectContaining({ name: "search_character_media", effectScope: "attempt", intent: { requestedNudity: "none" }, arguments: searchArgs }),
      expect.objectContaining({ name: "send_character_media", effectScope: "turn_action", arguments: { candidateToken: "exact-seaside-result" } }),
    ]);
    expect(requests).toHaveLength(3);
    expect(connection.candidates[0]).toMatchObject({ content: "", mediaResponse: { attachmentId: "attachment-free" }, execution: { steps: 4, toolCalls: 2 },
      usage: { promptTokens: 60, completionTokens: 9, reasoningTokens: 0 },
      tools: [expect.objectContaining({ name: "search_character_media", effectScope: "attempt" }), expect.objectContaining({ name: "send_character_media", effectScope: "turn_action" })] });
    expect(JSON.stringify(connection.events)).not.toContain("exact-seaside-result");
    expect(JSON.stringify(connection.candidates[0]?.tools)).not.toContain("Mira wears");
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
  });

  it.each([
    { name: "generate_image_async", user: "Generate a new seaside photo of yourself.", arguments: { prompt: "A clothed seaside portrait", subject: "companion" } },
    { name: "edit_last_image", user: "Edit the last photo to put the mug on the table.", arguments: { instruction: "Put the mug on the table", editScope: { mode: "local", target: "mug", selection: "one" } } },
  ] as const)("keeps explicit $name available without a mandatory library lookup", async action => {
    let requests = 0;
    const calls: CompanionToolCall[] = [];
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async () => {
      requests++;
      return requests === 1 ? response({ tool_calls: [{ index: 0, id: "explicit-image-action", function: {
        name: action.name, arguments: JSON.stringify(action.arguments),
      } }] }, "tool_calls") : response({ content: "Give me a moment, love." });
    } });
    const runtime = await engine(adapter);
    const source = mediaInvocation();
    const value = companionInvocationSchema.parse({ ...source, preparedTurn: { ...source.preparedTurn,
      tools: [...IMAGE_AGENT_TOOL_DEFINITIONS, ...CHARACTER_MEDIA_TOOL_DEFINITIONS] } });
    value.preparedTurn.messages.at(-1)!.content = action.user;
    const connection = port({ executeTool: async call => {
      calls.push(call);
      return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded",
        output: { accepted: true, status: "accepted", attachmentId: "real-attachment", generationJobId: "explicit-image-job" } };
    } });
    await runtime.run(value, connection.runtimePort);
    expect(calls).toEqual([expect.objectContaining({ name: action.name, effectScope: "turn_action", arguments: action.arguments })]);
    expect(connection.candidates[0]?.execution).toEqual({ steps: 3, toolCalls: 1 });
  });

  it("leaves the existing image action available after a completed no-match observation", async () => {
    let requests = 0;
    const calls: CompanionToolCall[] = [];
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async () => {
      requests++;
      if (requests > 2) return response({ content: "Give me a moment, love." });
      return response({ tool_calls: [{ index: 0, id: `media-${requests}`, function: {
        name: requests === 1 ? "search_character_media" : "generate_image_async",
        arguments: JSON.stringify(requests === 1 ? { kind: "image", query: "Mira fully clothed by the seaside without a hat" }
          : { prompt: "Mira fully clothed by the seaside without a hat", subject: "companion", requestedNudity: "none" }),
      } }] }, "tool_calls");
    } });
    const runtime = await engine(adapter);
    const connection = port({ executeTool: async call => {
      calls.push(call);
      const output: Extract<CompanionToolResult, { outcome: "succeeded" }>["output"] = call.name === "search_character_media"
        ? { accepted: true, status: "no_match", matches: [] }
        : { accepted: true, status: "accepted", attachmentId: "real-attachment", generationJobId: "new-image-job" };
      return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded",
        output };
    } });
    await runtime.run(mediaInvocation(), connection.runtimePort);
    expect(calls.map(call => call.name)).toEqual(["search_character_media", "generate_image_async"]);
    expect(connection.candidates).toHaveLength(1);
    expect(connection.candidates[0]?.execution).toEqual({ steps: 4, toolCalls: 2 });
  });

  it.each(["failed", "unknown"] as const)("does not turn a %s lookup into a delivery or an unconfirmed purchase", async outcome => {
    const requests: WireRequest[] = [];
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1 ? response({ tool_calls: [{ index: 0, id: "lookup", function: {
        name: "search_character_media", arguments: JSON.stringify({ kind: "video", query: "A seaside clip" }),
      } }] }, "tool_calls") : response({ content: "I don't have that clip ready for you." });
    } });
    const runtime = await engine(adapter);
    const calls: CompanionToolCall[] = [];
    const connection = port({ executeTool: async call => {
      calls.push(call);
      return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome,
        error: { code: "media_search_unavailable", message: "Search unavailable", retryable: true } };
    } });
    await runtime.run(mediaInvocation(), connection.runtimePort);
    expect(calls.map(call => call.name)).toEqual(["search_character_media"]);
    expect(requests[1]?.messages.find(message => message.role === "tool")?.content).toContain("No media was sent or generated");
    expect(requests[1]?.messages.find(message => message.role === "tool")?.content).toContain("not evidence that the library is empty");
    expect(connection.candidates).toHaveLength(1);
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
  });

  it.each(["unknown", "malformed_success"] as const)("stops on %s media delivery and cannot continue into another purchase", async failure => {
    let requests = 0;
    const calls: CompanionToolCall[] = [];
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async () => {
      requests++;
      return response({ tool_calls: [{ index: 0, id: `action-${requests}`, function: {
        name: requests === 1 ? "send_character_media" : "generate_image_async",
        arguments: JSON.stringify(requests === 1 ? { previousMediaAssetId: "past-media" }
          : { prompt: "A new portrait to replace the lost one", subject: "companion" }),
      } }] }, "tool_calls");
    } });
    const runtime = await engine(adapter);
    const connection = port({ executeTool: async call => {
      calls.push(call);
      return failure === "unknown" ? { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "unknown",
        error: { code: "main_tool_ack_unknown", message: "Receipt lost", retryable: true } }
        : { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded", output: { accepted: true } };
    } });
    await runtime.run(mediaInvocation(), connection.runtimePort);
    expect(requests).toBe(1);
    expect(calls.map(call => call.name)).toEqual(["send_character_media"]);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.at(-1)).toMatchObject({ type: "failed", error: { code: "main_effect_unconfirmed" } });
  });

  it("shares one action slot across free delivery and subsequent image generation", async () => {
    let requests = 0;
    const calls: CompanionToolCall[] = [];
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async () => {
      requests++;
      if (requests === 3) return response({ content: "Here's that seaside photo again." });
      return response({ tool_calls: [{ index: 0, id: `action-${requests}`, function: {
        name: requests === 1 ? "send_character_media" : "generate_image_async",
        arguments: JSON.stringify(requests === 1 ? { previousMediaAssetId: "past-media" }
          : { prompt: "Another seaside portrait", subject: "companion" }),
      } }] }, "tool_calls");
    } });
    const runtime = await engine(adapter);
    const connection = port({ executeTool: async call => {
      calls.push(call);
      return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded", output: {
        accepted: true, duplicate: false, status: "completed", attachmentId: "resent", mediaAssetId: "past-media",
        costDreamcoins: 0, generationJobId: null, source: "previous_media", description: null,
      } };
    } });
    await runtime.run(mediaInvocation(), connection.runtimePort);
    expect(calls.map(call => call.name)).toEqual(["send_character_media"]);
    expect(connection.candidates[0]?.execution.toolCalls).toBe(1);
  });

  it("does not buy a photo after the Agent ends with a clarification instead of a native tool call", async () => {
    const reply = "Before I generate it, could you confirm the details you'd like?";
    const runtime = await engine(new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture",
      fetch: async () => response({ content: reply }),
    }));
    const calls: CompanionToolCall[] = [];
    const connection = port({
      executeTool: async (call) => {
        calls.push(call);
        return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded", output: { status: "accepted", attachmentId: "real-attachment", generationJobId: "job-host" } };
      },
    });
    const value = invocation(true);
    const policy = resolvePolicy({ modelTier: "free", unlimitedMessages: false, voiceEnabled: false, imageToolEnabled: true });
    const source: BuiltContext = {
      userLocale: "en", hasRecentImageContext: false,
      persona: {
        characterId: value.characterId, creatorId: null, name: "Mira", age: 31,
        description: "A precise adult companion.", systemPrompt: "Stay specific and grounded.",
        visibility: "public", status: "approved", deletedAt: null, voiceId: null,
        visualProfileId: null, visualProfileVersion: null, identityPrompt: null,
        imageToolEnabled: true, contentVersion: null, release: null,
        characterContentVersionId: "content-1", characterReleaseId: null,
        soulFingerprint: "a".repeat(64), compilerVersion: "character-soul-3",
      },
      policy: { ...policy, imageToolEnabled: true, modelProfile: { ...policy.modelProfile, supportsTools: true } },
      recentMessages: [{ id: "current", role: "user", content: "Please generate one safe, fully clothed image of you in a blue cardigan, arranging books on a wooden shelf in the sunny apartment." }],
      scene: { schemaVersion: 1, version: 0, location: null, time: null, participants: [], emotionalBeat: null, unresolvedThreads: [] },
      sceneVersion: 0, lastExchangeAt: null, dropped: [], contextRevision: 0n,
    };
    const { context: _context, ...prepared } = compilePreparedTurn(source, "current");
    value.preparedTurn = { ...prepared, profile: value.preparedTurn.profile };

    await runtime.run(value, connection.runtimePort);

    expect(calls).toEqual([]);
    expect(connection.candidates).toEqual([expect.objectContaining({ content: reply, tools: [], execution: { steps: 1, toolCalls: 0 } })]);
  });

  it("executes only the image action called by the Agent", async () => {
    const runtime = await engine(new ToolThenTextAdapter());
    const calls: CompanionToolCall[] = [];
    const connection = port({
      executeTool: async (call) => {
        calls.push(call);
        return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded", output: { status: "accepted", attachmentId: "real-attachment", generationJobId: "job-agent" } };
      },
    });
    const value = imageInvocation();

    await runtime.run(value, connection.runtimePort);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.callId).toBe("call-image-1");
  });

  it("preserves an unknown Main effect when the native image call loses its receipt", async () => {
    const adapter = new ToolThenTextAdapter();
    const runtime = await engine(adapter);
    const calls: CompanionToolCall[] = [];
    const connection = port({ executeTool: async call => {
      calls.push(call);
      throw new Error("connection lost before Main receipt");
    } });
    const value = imageInvocation();

    await runtime.run(value, connection.runtimePort);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.callId).toBe("call-image-1");
    expect(adapter.calls).toBe(1);
    expect(connection.candidates).toEqual([]);
    expect(connection.events).toContainEqual(expect.objectContaining({ type: "tool_finished", outcome: "unknown" }));
    expect(connection.events.at(-1)).toMatchObject({
      type: "failed", error: { code: "main_effect_unconfirmed", retryable: true },
    });
  });

  it.each([
    { code: "rate_limited", message: "another image is still generating", retryable: true,
      reply: "One at a time, love. Let me finish the one I'm already making for you." },
    { code: "tool_effect_cancelled", message: "The image request was cancelled", retryable: false,
      reply: "That photo has been cancelled, love." },
  ])("fails the reply on $code without a real attachment receipt", async ({ code, message, retryable, reply }) => {
    const requests: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    const adapter = new FixtureAdapter({ profile: invocation().preparedTurn.profile, apiKey: "fixture", fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1 ? response({ tool_calls: [{ index: 0, id: "call-image-1", function: {
        name: "generate_image_async", arguments: JSON.stringify({ prompt: "A cozy portrait beside the window.", subject: "companion" }),
      } }] }, "tool_calls") : response({ content: reply });
    } });
    const runtime = await engine(adapter);
    const connection = port({
      executeTool: async (call) => ({
        attemptId: call.attemptId,
        callId: call.callId,
        name: call.name,
        outcome: "failed",
        error: { code, message, retryable },
      }),
    });

    await runtime.run(imageInvocation(), connection.runtimePort);

    expect(connection.events.at(-1)).toMatchObject({ type: "failed", error: { code: "media_response_incomplete" } });
    expect(connection.events).toContainEqual(expect.objectContaining({ type: "tool_finished", outcome: "failed" }));
    expect(requests).toHaveLength(2);
    const receipt = requests[1]?.messages.find(message => message.role === "tool")?.content;
    expect(JSON.parse(receipt!)).toMatchObject({ outcome: "failed", error: { code, message, retryable } });
    expect(connection.candidates).toEqual([]);
    expect(connection.events.some(event => event.type === "text_delta")).toBe(false);
  });

  it.each([
    { scene: "It is night.", request: "Take a fully clothed photo the next morning.", prompt: "A fully clothed morning portrait." },
    { scene: "It is a rainy morning.", request: "Take a fully clothed photo.", prompt: "A fully clothed portrait on a rainy morning." },
    { scene: "The book is left of the cup; the lamp is right of the vase.", request: "Take a fully clothed photo.", prompt: "A fully clothed portrait. The book is left of the cup; the lamp is right of the vase." },
  ])("preserves authorized scene direction without inferring contradictions from isolated words: $scene", async ({ scene, request, prompt }) => {
    const value = imageInvocation();
    value.preparedTurn.messages.splice(1, 0, {
      id: "user:scene", sourceKind: "replay", role: "user", content: scene,
    });
    value.preparedTurn.messages.at(-1)!.content = request;
    const calls: CompanionToolCall[] = [];
    const runtime = await engine(new ToolThenTextAdapter(prompt, undefined, "none"));
    const connection = port({ executeTool: async (call) => {
      calls.push(call);
      return { attemptId: call.attemptId, callId: call.callId, name: call.name,
        outcome: "succeeded", output: { status: "accepted", attachmentId: "real-attachment", generationJobId: "authorized-scene" } };
    } });
    await runtime.run(value, connection.runtimePort);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toMatchObject({ prompt });
    expect(connection.candidates).toHaveLength(1);
  });

  it("forwards the Agent's structured wardrobe intent without host text classification", async () => {
    const runtime = await engine(new ToolThenTextAdapter(
      "Mira wearing a silk robe at the blue-lit observatory tonight", undefined, "none",
    ));
    const calls: CompanionToolCall[] = [];
    const connection = port({
      executeTool: async (call) => {
        calls.push(call);
        return {
          attemptId: call.attemptId,
          callId: call.callId,
          name: call.name,
          outcome: "succeeded",
          output: { status: "accepted", attachmentId: "real-attachment", generationJobId: "job-structured-intent" },
        };
      },
    });

    await runtime.run(imageInvocation(), connection.runtimePort);

    expect(calls).toEqual([
      expect.objectContaining({
        effectScope: "turn_action",
        intent: { requestedNudity: "none" },
        arguments: expect.objectContaining({ prompt: expect.stringContaining("silk robe") }),
      }),
    ]);
    expect(connection.candidates).toHaveLength(1);
  });

  // An unknown outcome can never authorize another media purchase.
  it("does not confirm an image when Main reports unknown", async () => {
    const outcome = "unknown" as const;
    const adapter = new ToolThenTextAdapter();
    const runtime = await engine(adapter);
    const connection = port({ executeTool: async (call) => ({
      attemptId: call.attemptId, callId: call.callId, name: call.name,
      outcome, error: { code: "main_effect_unconfirmed", message: "Unconfirmed", retryable: true },
    }) });
    await runtime.run(imageInvocation(), connection.runtimePort);
    expect(adapter.calls).toBe(1);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.some(event => event.type === "text_delta")).toBe(false);
    expect(connection.events.at(-1)?.type).toBe("failed");
  });

  it("uses the attachment for a pure Chinese media request", async () => {
    const value = imageInvocation();
    value.preparedTurn.messages.at(-1)!.content = "给我一张今晚的自拍";
    const adapter = new ToolThenTextAdapter("A concrete selfie at the observatory tonight", "等我一下，今晚的我给你看。", "unspecified");
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(value, connection.runtimePort);
    expect(adapter.calls).toBe(2);
    expect(connection.candidates[0]).toMatchObject({ content: "", mediaResponse: { attachmentId: "attachment-1" } });
    expect(connection.candidates[0]).not.toHaveProperty("acknowledgement");
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
  });

  it("withholds all provisional media text and commits the real attachment", async () => {
    const adapter = new LeadInThenToolAdapter("Elbow-deep in clay tonight, so give me a second to wash my hands.");
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(imageInvocation(), connection.runtimePort);
    expect(adapter.calls).toBe(2);
    expect(connection.events.some(event => event.type === "text_reset")).toBe(false);
    expect(connection.events.filter(event => event.type === "text_delta")).toEqual([]);
    expect(connection.candidates[0]).toMatchObject({ content: "", mediaResponse: { attachmentId: "attachment-1" } });
    expect(connection.candidates[0]).not.toHaveProperty("acknowledgement");
    expect(connection.events.filter(event => event.type === "failed")).toEqual([]);
  });

  it("permits only one image effect even if the Agent tries a second native call", async () => {
    let requests = 0;
    const value = imageInvocation();
    const calls: CompanionToolCall[] = [];
    const adapter = new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture-key", fetch: async () => {
      requests++;
      return new Response(`data: ${JSON.stringify({ choices: [{
        delta: requests <= 2 ? { tool_calls: [{ index: 0, id: `image-${requests}`, function: { name: "generate_image_async", arguments: JSON.stringify({ prompt: "A portrait beside the rainy window", subject: "companion" }) } }] } : { content: "Give me a moment, love." },
        finish_reason: requests <= 2 ? "tool_calls" : "stop",
      }] })}\n\ndata: [DONE]\n\n`);
    } });
    const runtime = await engine(adapter);
    const connection = port({ executeTool: async call => {
      calls.push(call);
      return { attemptId: call.attemptId, callId: call.callId, name: call.name, outcome: "succeeded", output: { accepted: true, status: "accepted", attachmentId: "real-attachment" } };
    } });
    await runtime.run(value, connection.runtimePort);
    expect(calls).toHaveLength(1);
    expect(connection.candidates[0]?.execution.toolCalls).toBe(1);
  });

  it("turns a rejected Main CAS into a failed runtime terminal", async () => {
    const runtime = await engine(new OneStepAdapter());
    const connection = port({
      commit: async (candidate) => ({
        attemptId: candidate.attemptId,
        accepted: false,
        status: "rejected",
        error: { code: "stale_attempt", message: "stale attempt" },
      }),
    });

    await runtime.run(invocation(), connection.runtimePort);

    expect(connection.events.at(-1)).toMatchObject({
      type: "failed",
      error: { code: "invocation_failed", retryable: false },
    });
  });

  it("preserves a first-token timeout as a retryable provider failure", async () => {
    const runtime = await engine(new FirstTokenTimeoutAdapter());
    const connection = port();

    await runtime.run(invocation(), connection.runtimePort);

    expect(connection.events.at(-1)).toMatchObject({
      type: "failed",
      error: { code: "provider_first_token_timeout", retryable: true },
    });
  });

  it("classifies a fixed dynamic input overflow without claiming a provider outage", async () => {
    const adapter = new FixtureAdapter({profile:invocation().preparedTurn.profile,apiKey:"fixture",fetch:async()=>{throw new ProviderError("input budget","INPUT_BUDGET_EXCEEDED");}});
    const runtime = await engine(adapter);
    const connection = port();
    await runtime.run(invocation(), connection.runtimePort);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.at(-1)).toMatchObject({ type: "failed", error: { code: "input_budget_exceeded", retryable: false } });
  });

  // A stopped model server used to surface as non-retryable invocation_failed.
  it("reports an unreachable model endpoint as a retryable provider outage", async () => {
    const runtime = await engine(new UnreachableProviderAdapter());
    const connection = port();

    await runtime.run(invocation(), connection.runtimePort);

    expect(connection.events.at(-1)).toMatchObject({
      type: "failed",
      error: { code: "provider_unavailable", retryable: true },
    });
  });

  it("does not return before an asynchronous failed event is delivered", async () => {
    const runtime = await engine(new FirstTokenTimeoutAdapter());
    const connection = port();
    connection.runtimePort.emit = async (event) => {
      if (event.type === "failed") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      connection.events.push(event);
    };

    await runtime.run(invocation(), connection.runtimePort);

    expect(connection.events.at(-1)).toMatchObject({
      type: "failed",
      error: { code: "provider_first_token_timeout" },
    });
  });

  it("cancels in-process work without a child-process control protocol", async () => {
    const runtime = await engine(new BlockingAdapter());
    const connection = port();
    const run = runtime.run(invocation(), connection.runtimePort);
    await waitFor(() => connection.events.some((event) => event.type === "started"));

    expect(runtime.cancel(invocation().invocationId, "user")).toBe(true);
    await run;

    expect(connection.events.at(-1)).toMatchObject({ type: "cancelled", reason: "user" });
  });

  it("retains a known tool request and an unknown interrupted answer when cancelled", async () => {
    let requests = 0;
    const value = invocation(true);
    const adapter = new FixtureAdapter({ profile: value.preparedTurn.profile, apiKey: "fixture",
      fetch: async (_url, init) => {
        if (++requests === 1) return response({ tool_calls: [{ index: 0, id: "image-1", function: {
          name: "generate_image_async", arguments: JSON.stringify({ prompt: "Mira by the observatory", subject: "companion", requestedNudity: "none" }),
        } }] }, "tool_calls", { inputTokens: 25, outputTokens: 6, cacheReadTokens: 4 });
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(init?.signal?.reason);
          if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });
    const runtime = await engine(adapter);
    const connection = port();
    const run = runtime.run(value, connection.runtimePort);
    await waitFor(() => requests === 2);
    runtime.cancel(value.invocationId, "user");
    await run;
    expect(connection.candidates).toHaveLength(0);
    expect(connection.events.at(-1)).toMatchObject({ type: "cancelled", reason: "user" });
    expect(connection.events.filter(event => event.type === "model_request").map(event => event.request.usage)).toEqual([
      { inputTokens: 25, outputTokens: 6, cacheReadTokens: 4, reasoningTokens: 0 }, null,
    ]);
  });

  it("passes the active cancellation signal through a pending terminal projection", async () => {
    const runtime = await engine(new OneStepAdapter());
    const committing = Promise.withResolvers<void>();
    let projectionSignal: AbortSignal | undefined;
    const connection = port({ commit: async (_candidate, signal) => {
      projectionSignal = signal;
      committing.resolve();
      await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      throw new Error("cancelled projection must not settle");
    } });
    const running = runtime.run(invocation(), connection.runtimePort);
    await committing.promise;
    expect(projectionSignal?.aborted).toBe(false);
    expect(runtime.cancel(invocation().invocationId, "user")).toBe(true);
    await running;
    expect(projectionSignal?.aborted).toBe(true);
    expect(connection.candidates).toEqual([]);
    expect(connection.events.at(-1)).toMatchObject({ type: "cancelled", reason: "user" });
  });

  it("promotes an async projection without cancelling an active turn", async () => {
    const runtime = await engine(new BlockingAdapter(), {
      async build() {
        return { sessions: 1, messages: 2 };
      },
    });
    const fence = {
      mutationId: "projection-1",
      claimToken: "11111111-1111-4111-8111-111111111111",
      authorityVersion: "1",
    };
    const source = {
      scope: "relationship" as const,
      userId: "user-1",
      characterId: "character-1",
      mode: "project" as const,
      messages: [],
      fence,
    };
    const prepared = await runtime.prepareRebuild(source);
    const connection = port();
    const active = runtime.run(invocation(), connection.runtimePort);
    await waitFor(() => connection.events.some((event) => event.type === "started"));

    await expect(runtime.promoteRebuild({
      scope: "relationship",
      userId: source.userId,
      characterId: source.characterId,
      rebuildId: prepared.rebuildId,
      fence,
    })).resolves.toEqual({ sessions: 1, messages: 2 });
    expect(runtime.cancel(invocation().invocationId, "user")).toBe(true);
    await active;
    expect(connection.events.at(-1)).toMatchObject({ type: "cancelled", reason: "user" });
  });
});
