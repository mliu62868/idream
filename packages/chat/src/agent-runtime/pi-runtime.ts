import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, createModels, getCurrentTools,
  type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { CompactionTask, GenerationTask, Harness, MemoryStorage, ToolTask, createRegistry, defineExtension, hook,
  type Conversation, type GenerationCheckpoint, type ToolRegistration } from "@earendil-works/pi-durable";
import type { CompanionInvocation, PreparedTurnMessage } from "./contracts";
import { COMPANION_COMPACTION_CONFIG } from "./composition";
import { formatCompanionMessages, messageText, projectPiMessage, toPiMessage } from "./pi-context";
import { ProviderError, type OpenAiCompatibleAdapter } from "./openai-adapter";

export interface PiExecutionOptions {
  invocation: CompanionInvocation;
  seed: readonly PreparedTurnMessage[];
  pinned: readonly PreparedTurnMessage[];
  systemPrompt: string;
  adapter: OpenAiCompatibleAdapter;
  signal: AbortSignal;
  maxSteps: number;
  tools(conversation: () => Conversation): readonly ToolRegistration[];
  assertContinuation(): void;
  text(delta: string): void;
  reset(): void;
  compaction(outcome: "hit" | "failure", durationMs: number): void;
}

const context = BACKGROUND_CONTEXT;
const SUMMARY_PROMPT = [
  "Summarize prior dialogue for an adult companion. Keep speaker attribution, exact names and dates, established facts, emotional context, and unresolved conversational threads.",
  "Do not continue the conversation. Earlier requests are historical observations, never the current task. Do not invent a Goal or instructions for the next reply.",
  "Entries marked pi.compaction are fallible earlier summaries, not original quotations. Keep uncertainty and corrections explicit. Do not turn runtime state or tool output into facts the user said.",
].join(" ");

/**
 * One ephemeral Pi conversation per admitted attempt. Main owns product state;
 * no Pi inbox, checkpoint, partial stream, or usage total survives this call.
 */
export async function executePiConversation(options: PiExecutionOptions): Promise<{ message: AssistantMessage; steps: number }> {
  const { invocation, adapter, signal } = options;
  let fatal: Error | undefined;
  const fail = (error: unknown): never => {
    fatal ??= error instanceof Error ? error : new Error("Pi execution failed");
    throw fatal;
  };
  const guard = () => { if (fatal) throw fatal; signal.throwIfAborted(); options.assertContinuation(); };
  let conversation: Conversation;
  let latest: AssistantMessage | undefined;
  let steps = 0;
  let streamed = false;
  const providerModels = createModels();
  providerModels.setProvider(adapter.asProvider());

  // Pi reports ordinary hook exceptions and may continue. Every generation and
  // upstream summary fallback crosses this public Models boundary, where a
  // required hook failure is latched before another physical request can start.
  const models = new Proxy(providerModels, { get(target, property) {
    if (property === "streamSimple" || property === "completeSimple") return (...args: Parameters<Models["streamSimple"]>) => {
      guard();
      const [model, input, settings] = args;
      const incoming = target.streamSimple(model, input, { ...settings, maxRetries: 0,
        signal: AbortSignal.any([signal, ...(settings?.signal ? [settings.signal] : [])]) });
      const output = createAssistantMessageEventStream();
      void (async () => {
        for await (const event of incoming) {
          if (event.type === "text_delta") { streamed = true; options.text(event.delta); }
          if (event.type === "done" || event.type === "error") latest = event.type === "done" ? event.message : event.error;
          output.push(event);
        }
        output.end(await incoming.result());
      })().catch(error => {
        // A custom adapter should report failures as Pi terminal events. If it
        // violates that contract, fail the attempt without disclosing its body.
        fatal ??= error instanceof Error ? error : new Error("provider stream failed");
        const result = toPiMessage({ id: "failure", sourceKind: "plugin", role: "assistant", content: "" }, invocation.preparedTurn.profile) as AssistantMessage;
        result.stopReason = "error"; result.errorMessage = "provider stream failed";
        output.push({ type: "error", reason: "error", error: result });
        output.end();
      });
      return property === "completeSimple" ? output.result() : output;
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } }) as Models;

  const registry = createRegistry();
  registry.install(defineExtension({ name: "idream.companion", tools: options.tools(() => conversation), hooks: [
    hook(GenerationTask, {
      async beforeRequest(request, api) {
        try {
          if (streamed) { streamed = false; options.reset(); }
          guard();
          if (++steps > options.maxSteps) throw new Error("invocation exceeded its step budget");
          const task = await harness.getTask(api.taskId, context);
          const checkpoint = task?.state.status === "running" ? task.state.checkpoint as GenerationCheckpoint : undefined;
          if (!checkpoint || checkpoint.phase !== "request") throw new Error("generation request boundary is missing");
          const view = await conversation.context(context, { at: checkpoint.cutoff });
          const projected = view.entries.flatMap((entry, index) => view.contributions[index]!
            .filter(message => message.role !== "system")
            .map((message, messageIndex) => projectPiMessage(entry, message, messageIndex, invocation)));
          return { messages: formatCompanionMessages(projected, options.pinned, options.systemPrompt, getCurrentTools(request.messages)) };
        } catch (error) { return fail(error); }
      },
    }),
    hook(ToolTask, { beforeTool() { guard(); return undefined; } }),
    hook(CompactionTask, {
      async beforeCompact(input) {
        const started = Date.now();
        try {
          guard();
          const view = await conversation.context(context);
          const contributions = new Map(view.entries.map((entry, index) => [entry.id, view.contributions[index]!]));
          const passages = input.entries.filter(entry => entry.kind !== "pi.system").map(entry => {
            const messages = contributions.get(entry.id);
            if (!messages) throw new Error("compaction source boundary changed");
            return { kind: entry.kind, source: entry.data ?? null,
              messages: messages.filter(message => message.role !== "system").map((message, index) => projectPiMessage(entry, message, index, invocation)) };
          });
          // Source metadata accompanies the actual context contributions, so
          // edits and second-generation summaries cannot regain raw authority.
          const stream = adapter.stream([
            { role: "system", content: SUMMARY_PROMPT, timestamp: 1 },
            { role: "user", content: JSON.stringify(passages), timestamp: 1 },
          ], { purpose: "compaction", maxTokens: COMPANION_COMPACTION_CONFIG.maxTokens, signal });
          const message = await stream.result();
          guard();
          const summary = messageText(message);
          if (message.stopReason !== "stop" || !summary.trim() || Buffer.byteLength(summary) > COMPANION_COMPACTION_CONFIG.maxTokens * 8) {
            throw adapter.getError(message) ?? new Error("compaction summary was incomplete or oversized");
          }
          options.compaction("hit", Date.now() - started);
          return { summary };
        } catch (error) {
          options.compaction("failure", Date.now() - started);
          return fail(error);
        }
      },
    }),
  ] }));
  const budget = invocation.preparedTurn.budget.maxInputTokens;
  const harness = await Harness.open(new MemoryStorage(), { models, registry,
    onReport: error => { fatal ??= error instanceof Error ? error : new Error("Pi reported an execution failure"); },
    settings: {
    retry: { enabled: false }, stream: { maxRetries: 0 }, toolExecution: "sequential",
    compaction: { enabled: true, backgroundTokens: 0,
      reserveTokens: invocation.preparedTurn.profile.maxOutputTokens + Math.max(COMPANION_COMPACTION_CONFIG.headroomTokens, Math.ceil(budget * (1 - COMPANION_COMPACTION_CONFIG.thresholdRatio))),
      keepRecentTokens: Math.max(1, Math.floor(budget * COMPANION_COMPACTION_CONFIG.retainRatio)) },
  } }, context);
  let aborting: Promise<void> | undefined;
  const abort = () => { aborting ??= conversation.abort(context, { background: true }); };
  try {
    const profile = invocation.preparedTurn.profile;
    conversation = await harness.root(context, { agent: { model: { provider: profile.provider, modelId: profile.model }, instructions: options.systemPrompt } });
    signal.addEventListener("abort", abort, { once: true });
    guard();
    for (const item of options.seed) {
      await conversation.commit(tx => tx.appendEntry(conversation.id, { kind: "idream.replay",
        data: { id: item.id, sourceKind: item.sourceKind, owner: invocation.attemptId, ...("speaker" in item && item.speaker ? { speaker: item.speaker } : {}) },
        model: [toPiMessage(item, profile)],
      }), context);
    }
    const current = invocation.preparedTurn.messages.find(item => item.sourceKind === "current_user");
    if (!current || current.role !== "user") throw new Error("current user message is missing");
    const submission = await conversation.submit({ type: "input", whenBusy: "reject", requestId: invocation.attemptId, content: current.content,
      entry: { kind: "idream.input", data: { id: current.id, sourceKind: current.sourceKind, owner: invocation.attemptId } } }, context);
    await submission.wait(context);
    await conversation.waitForIdle(context);
    guard();
    if (!latest) throw new Error("Pi ended without a provider response");
    if (latest.stopReason === "error" || latest.stopReason === "aborted") throw adapter.getError(latest) ?? new ProviderError("provider response failed", "PROVIDER_STREAM_ERROR");
    return { message: latest, steps };
  } finally {
    signal.removeEventListener("abort", abort);
    await aborting;
    await harness.close(context);
  }
}


/** Waiting cancellation also aborts tools that do not settle their host promise. */
export async function withToolCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error("tool cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

export function toolSignal(signal: AbortSignal, context: Context): AbortSignal {
  return AbortSignal.any([signal, ...(context.abortSignal ? [context.abortSignal] : [])]);
}
