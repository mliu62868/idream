import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPANION_PRODUCT_PROMPT_VERSION } from "@idream/shared";
import { CompanionEngine } from "./engine";
import { AttemptWorkspaceStore } from "./workspace";
import { companionCompositionDigest, companionIgrepConfig, companionIgrepRoutes } from "./composition";
import { OpenAiCompatibleAdapter } from "./openai-adapter";
import type { AgentRuntimeConfig } from "./config";
import type { CompanionEvent, CompanionInvocation, CompanionTerminalCandidate, PreparedTurnProfile } from "./contracts";

/**
 * Exercise the installed CLI and production Pi composition without a
 * product Turn or paid effect. The provider is warmed separately: these model
 * responses deliberately omit the original fact so only archive recall can
 * recover it. This proof also checks the final transport's fixed context.
 */
export async function probeCompanionRetrieval(
  config: AgentRuntimeConfig,
  baseProfile: PreparedTurnProfile,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "idream-retrieval-probe-"));
  const identity = `readiness-retrieval:${randomUUID()}`;
  const original = "The trail sign read Cedar Finch — 字面原文 ␊, not Cedar Fawn.";
  const otherOriginal = "I brought the blue thermos, and Mara carried the map.";
  const speaker = { characterId: "readiness-briar", sessionId: "readiness-briar-session", name: "Briar" };
  const system = "You are Mara, an adult astronomer. Speak warmly in character.";
  const profile = { ...baseProfile, maxOutputTokens: 256 };
  const invocation: CompanionInvocation = {
    invocationId: identity, attemptId: `${identity}:1`, sessionId: identity,
    userId: identity, characterId: "readiness-retrieval", memoryMode: "private",
    expectedProfileDigest: companionCompositionDigest("private", companionIgrepConfig("private", config.igrepCommand, config.igrepEnvironment), { maxSteps: config.maxSteps, igrepLlm: config.igrepLlm, igrepRoutes: companionIgrepRoutes(config.igrepEnvironment) }),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    preparedTurn: {
      version: 6, model: profile.model, characterName: "Mara", profile,
      omittedMessages: Array.from({ length: 16 }, (_, index) => ({
        id: `past-${index}`, sourceKind: "replay" as const, role: index % 2 ? "assistant" as const : "user" as const,
        ...(index === 1 ? { speaker } : {}),
        content: index === 1 ? `${original}\n${"We listened to the wind through the cedars. ".repeat(10)}`
          : index === 3 ? `${otherOriginal}\n${"The familiar path curved past the trees. ".repeat(10)}`
          : index % 2 ? "The familiar path curved past the trees. ".repeat(10) : `Remember our walk number ${index / 2 + 1}.`,
      })),
      messages: [
        { id: "soul", sourceKind: "plugin", role: "system", content: system },
        // Omitted originals never enter Pi. Retained dialogue independently
        // exercises actual compaction before archive lookup and its usage totals.
        ...Array.from({ length: 12 }, (_, index) => ({
          id: `retained-${index}`, sourceKind: "replay" as const,
          role: index % 2 ? "assistant" as const : "user" as const,
          content: `Our later library conversation ${index}. ${"Rain tapped against the windows while we sorted books. ".repeat(34)}`,
        })),
        { id: "state:current", sourceKind: "plugin", role: "user", content: "Right now: Scene at the library, tonight." },
        { id: "current", sourceKind: "current_user", role: "user", content: "Quote the trail sign exactly, and remember where we are now." },
      ],
      tools: [], budget: { maxInputTokens: 6000, usedInputTokens: 120, dropped: ["transcript"] },
      trace: { productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION, systemPromptDigest: createHash("sha256").update(system).digest("hex"), characterContentVersionId: "readiness-content", characterReleaseId: null, soulFingerprint: "a".repeat(64), compilerVersion: "readiness", sceneVersion: 1, contextRevision: "1" },
    },
  };
  let sourceIds: string[] = [];
  const events: CompanionEvent[] = [];
  const candidates: CompanionTerminalCandidate[] = [];
  let purpose: string | undefined;
  let requests = 0;
  let step = 0;
  const runtime = new CompanionEngine({
    workspaces: new AttemptWorkspaceStore({ canonicalRoot: join(root, "canonical"), privateRoot: join(root, "private") }),
    igrep: { command: config.igrepCommand, env: config.igrepEnvironment },
    igrepLlm: config.igrepLlm, igrepRoutes: companionIgrepRoutes(config.igrepEnvironment), maxSteps: config.maxSteps,
    adapter: (profile, policy) => new OpenAiCompatibleAdapter({
      profile, ...policy, apiKey: "readiness-controlled-adapter",
      openRouterProviderOnly: config.openRouterProviderOnly,
      observeRequest: evidence => { purpose = evidence.purpose; policy.observeRequest(evidence); },
      fetch: async (_url, init) => {
        requests++;
        const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string; tool_call_id?: string }[]; tools: { function: { name: string } }[] };
        let delta: { content?: string; tool_calls?: unknown[] };
        if (purpose === "compaction") {
          delta = { content: "We talked about a trail. Recall holds the original wording." };
        } else {
          const names = body.tools.map(tool => tool.function.name);
          const expectedTools = ["session_recall", "igrep_search", ...(config.igrepEnvironment.IGREP_WEB_SEARCH_PROVIDER ? ["igrep_web_search"] : [])];
          if (names.length !== expectedTools.length || !expectedTools.every(name => names.includes(name))) throw new Error("private retrieval capability isolation failed");
          const wire = JSON.stringify(body.messages);
          if (!wire.includes("at the library") || !wire.includes("Quote the trail sign exactly")) throw new Error("compaction lost the immutable Turn context");
          const tool = (name: string, args: object, id: string) => ({ tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] });
          const result = (id: string) => {
            const content = body.messages.find(message => message.role === "tool" && message.tool_call_id === id)?.content;
            if (!content) throw new Error(`retrieval probe is missing ${id}`);
            const parsed: unknown = JSON.parse(content);
            if (!Array.isArray(parsed)) throw new Error("retrieval probe returned a non-array result");
            return parsed as Array<{ id: string; content?: string; preview?: string; speaker?: typeof speaker }>;
          };
          if (step === 0) {
            if (wire.includes(original) || wire.includes(otherOriginal)) throw new Error("omitted originals leaked into initial context");
            delta = tool("session_recall", {}, "readiness-recall-index");
          } else if (step === 1) {
            const index = result("readiness-recall-index");
            sourceIds = [original, otherOriginal].map(text => {
              const row = index.find(item => item.preview?.includes(text));
              if (!row?.id) throw new Error("archive index did not identify the original source");
              return row.id;
            });
            delta = tool("session_recall", { ids: sourceIds }, "readiness-recall");
          } else if (step === 2) {
            const recalled = result("readiness-recall");
            const ownSpeaker = { characterId: invocation.characterId, sessionId: invocation.sessionId, name: invocation.preparedTurn.characterName };
            for (const [index, identity] of [speaker, ownSpeaker].entries()) {
              const source = recalled.find(item => item.id === sourceIds[index]);
              if (!source?.content?.includes([original, otherOriginal][index]!)) throw new Error("archive recall did not recover the exact originals");
              if (!source.speaker || Object.entries(identity).some(([key, value]) => source.speaker![key as keyof typeof speaker] !== value)) throw new Error("archive recall lost its authoritative group speaker");
            }
            delta = tool("session_recall", { query: "What was written on the trail sign?" }, "readiness-recall-query");
          } else if (step === 3) {
            if (!result("readiness-recall-query").some(item => item.content?.includes(original))) throw new Error("semantic archive recall did not return the source");
            delta = tool("igrep_search", { query: "What is Mara's profession?" }, "readiness-search");
          } else {
            if (!body.messages.some(message => message.role === "tool" && message.tool_call_id === "readiness-search" && message.content.includes("astronomer"))) throw new Error("authorized local search did not return evidence");
            delta = { content: "I remember the sign: Cedar Finch. We're at the library tonight." };
          }
          step++;
        }
        return new Response(`data: ${JSON.stringify({ id: `readiness-controlled-${requests}`, provider: config.openRouterProviderOnly?.[0] ?? "readiness-controlled", choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
      },
    }),
  });
  try {
    await runtime.run(invocation, {
      emit: event => { events.push(event); },
      executeTool: async () => { throw new Error("retrieval probe attempted a product effect"); },
      commit: async candidate => {
        candidates.push(candidate);
        return { attemptId: candidate.attemptId, accepted: true, status: "committed", terminalMessageId: "readiness-retrieval-terminal", committedAt: new Date().toISOString() };
      },
    });
    if (candidates.length !== 1 || events.some(event => event.type === "failed" || event.type === "cancelled")) throw new Error("companion retrieval probe did not commit");
    for (const operation of ["compaction", "session", "search"] as const) {
      if (!events.some(event => event.type === "igrep_observation" && event.operation === operation && event.outcome === "hit")) throw new Error(`companion retrieval probe lacks ${operation} evidence`);
    }
    if (candidates[0]!.usage?.promptTokens !== requests * 100 || candidates[0]!.usage?.completionTokens !== requests * 10) throw new Error("compaction usage was not included in terminal totals");
    if ((await readdir(join(root, "private"))).length !== 0) throw new Error("private retrieval workspace was not discarded");
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}
