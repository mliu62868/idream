// SPEC: companion roleplay quality eval over the PRODUCTION prompt path.
// Each case becomes a schema-valid Main ChatExecutionSnapshot +
// ChatAuthoritySnapshot, goes through prepareCompanionTurn (buildContext →
// compilePreparedTurn) and executes in a real CompanionEngine wired exactly as
// agent-runtime/runtime.ts wires it, with a fake Main port: tool effects return
// realistic Main receipts and the terminal commit is captured, not persisted.
// INTENT: eval/nsfw/run.ts calls composeCompanionSystemPrompt directly and so
// never sees PreparedTurn state blocks, preferences, reply cues, tools, the
// media extraction/body loops or Pi. This harness measures what users get.
// Pass/fail is decided in code: deterministic checks (checks.ts) plus a judge
// model that only emits JSON labels, compared here against each case's
// expectations (the eval/nsfw convention).
//
// Usage (cwd packages/chat, so bun loads packages/chat/.env):
//   bun eval/companion/run.ts [--base-url U --model M --api-key K]
//     [--judge-url U --judge-model M --judge-key K] [--no-judge]
//     [--samples 1] [--only id-prefix|category,...] [--min-pass 0.8]
//     [--out path/results.jsonl] [--reply-cues on|off] [--dry-run]
// Target and judge default to CHAT_MODEL_*.
// Exit: 0 when pass rate >= --min-pass (or dry-run ok); 1 otherwise; 2 on setup error.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPANION_PRODUCT_PROMPT_VERSION } from "@idream/shared";
import type { ChatSceneState } from "@idream/shared/contracts";
import { REQUEST_CHARACTER_MEDIA_TOOL, RESEND_SESSION_MEDIA_TOOL } from "@idream/shared/chat/media-library";
import { buildContext } from "../../src/context.js";
import { compilePreparedTurn, prepareCompanionTurn, type PreparedTurn } from "../../src/prepared-turn.js";
import { projectLightweightScene } from "../../src/scene-light.js";
import { loadAgentRuntimeConfig, type AgentRuntimeConfig } from "../../src/agent-runtime/config.js";
import { companionIgrepConfig, companionIgrepRoutes, createCompanionCompositionPlan } from "../../src/agent-runtime/composition.js";
import { CompanionEngine, type CompanionEngineOptions, type CompanionRuntimePort } from "../../src/agent-runtime/engine.js";
import { sharedInferencePriorityGate } from "../../src/agent-runtime/execution-scheduler.js";
import { igrepVersion } from "../../src/agent-runtime/igrep.js";
import { OpenAiCompatibleAdapter } from "../../src/agent-runtime/openai-adapter.js";
import { formatCompanionMessages, messageText } from "../../src/agent-runtime/pi-context.js";
import { AttemptWorkspaceStore } from "../../src/agent-runtime/workspace.js";
import {
  companionInvocationSchema,
  type CompanionInvocation,
  type CompanionModelRequestEvidence,
  type CompanionTerminalCandidate,
  type CompanionToolCall,
  type CompanionToolResult,
} from "../../src/agent-runtime/contracts.js";
import { runChecks, type Checks } from "./checks.js";
import { buildSnapshots, type PersonaFixture, type SceneFixture, type TurnFixture } from "./fixture.js";

// ---------------------------------------------------------------- arguments
const BOOLEAN_FLAGS = new Set(["dry-run", "no-judge"]);
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]!.replace(/^--/, "");
  if (BOOLEAN_FLAGS.has(key)) { args.set(key, "true"); continue; }
  args.set(key, process.argv[++i] ?? "");
}
const dryRun = args.has("dry-run");
const useJudge = !args.has("no-judge");
const samples = Number(args.get("samples") ?? 1);
const minPass = Number(args.get("min-pass") ?? 0.8);
const replyCues = (args.get("reply-cues") ?? "on") as "on" | "off";
if (replyCues !== "on" && replyCues !== "off") { console.error("--reply-cues must be on or off"); process.exit(2); }
// The production profile is read from process.env by resolvePolicy at compile
// time, so overrides are applied to the environment before anything compiles.
if (args.get("base-url")) process.env.CHAT_MODEL_BASE_URL = args.get("base-url");
if (args.get("model")) process.env.CHAT_MODEL_NAME = args.get("model");
if (args.get("api-key")) process.env.CHAT_MODEL_API_KEY = args.get("api-key");
const judge = {
  url: args.get("judge-url") ?? process.env.CHAT_MODEL_BASE_URL,
  key: args.get("judge-key") ?? process.env.CHAT_MODEL_API_KEY ?? "none",
  model: args.get("judge-model") ?? process.env.CHAT_MODEL_NAME,
};

// The engine checks durable fences under CHAT_FS_ROOT; never touch a real one.
const scratchRoot = mkdtempSync(join(tmpdir(), "companion-eval-"));
process.env.CHAT_FS_ROOT = join(scratchRoot, "chat-fs");
mkdirSync(process.env.CHAT_FS_ROOT, { recursive: true });

// ---------------------------------------------------------------- cases
type JudgeQuestion = { key: string; question: string; expect: boolean };
type CompanionCase = TurnFixture & {
  id: string; category: string; note?: string; checks?: Checks; judge?: JudgeQuestion[];
};
type SceneExpect = {
  location?: string[] | "unchanged";
  time?: string[] | "unchanged";
  participantsInclude?: string[];
  participantsExclude?: string[];
  threadsInclude?: string[][];
  threadsExclude?: string[];
};
type SceneCase = TurnFixture & { id: string; category: string; scene: SceneFixture; assistant?: string; expect: SceneExpect };
type CaseFile = { category: string; kind?: "companion" | "scene"; cases: Array<Record<string, unknown>> };

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(dir, "../../../..");
const personas = JSON.parse(readFileSync(join(dir, "personas.json"), "utf8")) as Record<string, PersonaFixture>;
const companionCases: CompanionCase[] = [];
const sceneCases: SceneCase[] = [];
for (const file of readdirSync(join(dir, "cases")).filter(name => name.endsWith(".json")).sort()) {
  const data = JSON.parse(readFileSync(join(dir, "cases", file), "utf8")) as CaseFile;
  for (const raw of data.cases) {
    const value = { category: data.category, ...raw } as CompanionCase & SceneCase;
    if (data.kind === "scene") sceneCases.push(value); else companionCases.push(value);
  }
}
const ids = [...companionCases, ...sceneCases].map(item => item.id);
const duplicate = ids.find((value, index) => ids.indexOf(value) !== index);
if (duplicate) { console.error(`duplicate case id ${duplicate}`); process.exit(2); }
const only = args.get("only")?.split(",").map(value => value.trim()).filter(Boolean);
const selected = <T extends { id: string; category: string }>(items: T[]) =>
  items.filter(item => !only || only.some(prefix => item.id.startsWith(prefix) || item.category === prefix));
const runCompanionCases = selected(companionCases);
const runSceneCases = selected(sceneCases);

// ---------------------------------------------------------------- runtime
const sourceRevision = (() => {
  try {
    return execFileSync("bun", ["run", "--silent", "source:revision"], { cwd: repoRoot, encoding: "utf8" }).trim().split("\n").at(-1) ?? "unknown";
  } catch { return "unknown"; }
})();

let config: AgentRuntimeConfig | undefined;
try { config = loadAgentRuntimeConfig(process.env); } catch (error) {
  if (!dryRun) { console.error(`runtime config: ${(error as Error).message}`); process.exit(2); }
}
const cli = config ? { command: config.igrepCommand, env: config.igrepEnvironment } : { command: "igrep", env: {} };
const igrepRoutes = config ? companionIgrepRoutes(config.igrepEnvironment) : undefined;
const igrepLlm = config?.igrepLlm ?? { url: "http://127.0.0.1/v1", model: "dry-run", apiKey: "dry-run" };
const maxSteps = config?.maxSteps ?? 8;
let resolvedIgrep: string | null = null;
try { resolvedIgrep = await igrepVersion(cli); } catch { resolvedIgrep = null; }
// INTENT: the full engine needs the igrep CLI (search tools, normal-mode
// workspaces). Without it the compiled PreparedTurn is still sent through the
// real adapter, and every row says which executor produced it.
const executor: "engine" | "direct-adapter" = resolvedIgrep ? "engine" : "direct-adapter";
const plan = (mode: "normal" | "private") => createCompanionCompositionPlan(mode, companionIgrepConfig(mode, cli.command, cli.env), {
  maxSteps, igrepLlm, ...(igrepRoutes ? { igrepRoutes } : {}),
});

// Wired as createRuntime() in agent-runtime/runtime.ts, but over disposable
// workspace roots so a run never writes the dev service's memory roots.
const engineOptions: CompanionEngineOptions & { replyCues?: boolean } = {
  instance: { id: randomUUID(), startedAt: new Date().toISOString() },
  workspaces: new AttemptWorkspaceStore({ canonicalRoot: join(scratchRoot, "canonical"), privateRoot: join(scratchRoot, "private") }),
  adapter: (profile, requestPolicy) => new OpenAiCompatibleAdapter({
    profile, apiKey: config?.modelProfile.apiKey ?? "", openRouterProviderOnly: config?.openRouterProviderOnly, ...requestPolicy,
  }),
  igrep: cli,
  ...(igrepRoutes ? { igrepRoutes } : {}),
  igrepLlm,
  maxSteps,
  maxConcurrentAgents: config?.maxConcurrentAgents ?? { normal: 4, private: 4 },
  capacityWaitMs: config?.capacityWaitMs ?? 15_000,
  priorityGate: sharedInferencePriorityGate,
  // Design hook for the reply-cue A/B. Engines that predate the option ignore it.
  ...(replyCues === "off" ? { replyCues: false } : {}),
};
const engine = new CompanionEngine(engineOptions);
const deadlineMs = Number(process.env.PI_AGENT_DEADLINE_MS ?? 180_000);

// ---------------------------------------------------------------- compile
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
let replyCueOptionSupported: boolean | null = null;

async function compile(item: TurnFixture & { id: string }, now: Date) {
  const { snapshot, authority } = buildSnapshots(item.id, item, personas, now);
  let prepared: PreparedTurn;
  if (replyCues === "on") {
    prepared = await prepareCompanionTurn({ snapshot, authority });
  } else {
    // Feature detection: the 4th options argument is ignored by compilers that
    // predate it. If the compiled request is byte-identical, the switch is not
    // implemented in this source revision and the run is labelled so.
    const context = await buildContext({ snapshot, authority });
    const withOption = compilePreparedTurn as unknown as (...input: unknown[]) => PreparedTurn;
    prepared = withOption(context, snapshot.userMessageId, now, { replyCues: false });
    const baseline = compilePreparedTurn(context, snapshot.userMessageId, now);
    const differs = digest(prepared.messages) !== digest(baseline.messages);
    replyCueOptionSupported = (replyCueOptionSupported ?? false) || differs;
  }
  const memoryMode = snapshot.memoryEnabled ? "normal" as const : "private" as const;
  const { context, ...wire } = prepared;
  const attemptId = `eval-attempt-${randomUUID()}`;
  const invocation: CompanionInvocation = companionInvocationSchema.parse({
    invocationId: `inv:${attemptId}`,
    attemptId,
    sessionId: snapshot.sessionId,
    userId: snapshot.userId,
    characterId: snapshot.characterId,
    preparedTurn: wire,
    memoryMode,
    expectedProfileDigest: plan(memoryMode).digest,
    deadlineAt: new Date(Date.now() + deadlineMs).toISOString(),
  });
  return { snapshot, prepared, context, invocation };
}

// ---------------------------------------------------------------- fake Main
type Compiled = Awaited<ReturnType<typeof compile>>;

function stubMainTool(call: CompanionToolCall, item: TurnFixture): CompanionToolResult {
  const base = { attemptId: call.attemptId, callId: call.callId, name: call.name };
  const args = call.arguments as Record<string, unknown>;
  const attachmentId = `eval-card-${call.callId}`.slice(0, 160);
  if (call.name === REQUEST_CHARACTER_MEDIA_TOOL) {
    const kind = args.kind === "video" ? "video" : "image";
    if (args.mode === "availability" || args.mode === "existing_only") {
      return { ...base, outcome: "succeeded", output: { accepted: true, duplicate: false, status: "available", kind, costDreamcoins: 0 } };
    }
    // Paid authorization starts generation; otherwise Main persists a price quote.
    if (item.media?.imageActionMode === "paid" && kind === "image") {
      return { ...base, outcome: "succeeded", output: { accepted: true, duplicate: false, status: "accepted", attachmentId, kind,
        generationJobId: `eval-job-${call.callId}`.slice(0, 160), mediaAssetId: null, costDreamcoins: 5 } };
    }
    return { ...base, outcome: "succeeded", output: { accepted: true, duplicate: false, status: "awaiting_confirmation",
      confirmationKind: "paid_media_quote", attachmentId, kind, generationJobId: null, mediaAssetId: null, costDreamcoins: kind === "video" ? 30 : 5 } };
  }
  if (call.name === RESEND_SESSION_MEDIA_TOOL) {
    const media = item.media?.recentMedia?.find(entry => entry.mediaAssetId === args.previousMediaAssetId);
    if (!media) return { ...base, outcome: "failed", error: { code: "media_not_found", message: "That earlier media item is not in this conversation.", retryable: false } };
    return { ...base, outcome: "succeeded", output: { accepted: true, duplicate: false, status: "completed", attachmentId, kind: media.kind,
      mediaAssetId: media.mediaAssetId, generationJobId: null, costDreamcoins: 0, source: "previous_media", description: media.description } };
  }
  // edit_last_image: Main persists an unpaid edit draft awaiting area confirmation.
  return { ...base, outcome: "succeeded", output: { accepted: true, duplicate: false, status: "awaiting_confirmation", attachmentId,
    generationJobId: null, mediaAssetId: null, costDreamcoins: 0 } };
}

type RequestRow = { purpose: string; ms: number; usage: CompanionModelRequestEvidence["usage"] | null };
type Execution = {
  text: string;
  committed: boolean;
  failure?: string;
  toolCalls: Array<{ name: string; arguments: unknown; outcome: string }>;
  requests: RequestRow[];
  firstTextMs: number | null;
  totalMs: number;
  mediaAttachment: boolean;
  /** igrep/session lookups the agent chose (operation:outcome), in order. */
  lookups?: string[];
};

async function execute(compiled: Compiled, item: TurnFixture): Promise<Execution> {
  const started = Date.now();
  const requests: RequestRow[] = [];
  const toolCalls: Execution["toolCalls"] = [];
  if (executor === "direct-adapter") {
    const prepared = compiled.invocation.preparedTurn;
    const system = prepared.messages.find(message => message.role === "system")?.content ?? "";
    const rest = prepared.messages.filter(message => message.role !== "system");
    const pinned = rest.filter(message => message.sourceKind === "plugin" || message.sourceKind === "current_user");
    let requestStarted = 0;
    const adapter = new OpenAiCompatibleAdapter({
      profile: prepared.profile, apiKey: config?.modelProfile.apiKey ?? "", maxInputTokens: prepared.budget.maxInputTokens,
      observeRequest: () => { requestStarted = Date.now(); },
      observeUsage: (usage) => { requests.push({ purpose: "reply", ms: Date.now() - requestStarted, usage: usage ?? null }); },
    });
    const message = await adapter.stream(formatCompanionMessages(rest, pinned, system, [], compiled.invocation.characterId)).result();
    return { text: messageText(message).trim(), committed: message.stopReason === "stop", ...(message.stopReason !== "stop" ? { failure: `stop:${message.stopReason}` } : {}),
      toolCalls, requests, firstTextMs: null, totalMs: Date.now() - started, mediaAttachment: false };
  }
  let candidate: CompanionTerminalCandidate | undefined;
  let streamed = "";
  let firstTextMs: number | null = null;
  let failure: string | undefined;
  const pending: number[] = [];
  const lookups: string[] = [];
  const port: CompanionRuntimePort = {
    emit: (event) => {
      if (event.type === "model_request_started") pending.push(Date.now());
      if (event.type === "model_request") {
        const at = pending.shift();
        requests.push({ purpose: event.request.purpose ?? "reply", ms: at ? Date.now() - at : 0, usage: event.request.usage });
      }
      if (event.type === "text_delta") { firstTextMs ??= Date.now() - started; streamed += event.delta; }
      if (event.type === "text_reset") streamed = "";
      if (event.type === "igrep_observation") lookups.push(`${event.operation}:${event.outcome}`);
      if (event.type === "failed") failure = `${event.error.code}${event.error.retryable ? " (retryable)" : ""}`;
      if (event.type === "cancelled") failure = `cancelled:${event.reason}`;
    },
    executeTool: async (call) => {
      const result = stubMainTool(call, item);
      toolCalls.push({ name: call.name, arguments: call.arguments, outcome: result.outcome });
      return result;
    },
    commit: async (value) => {
      candidate = value;
      return { attemptId: value.attemptId, accepted: true, status: "committed", terminalMessageId: `eval-terminal-${value.attemptId}`, committedAt: new Date().toISOString() };
    },
  };
  try { await engine.run(compiled.invocation, port); }
  catch (error) { failure ??= `throw:${error instanceof Error ? error.name : typeof error}`; }
  return {
    text: (candidate?.content ?? streamed).trim(), committed: Boolean(candidate), ...(failure ? { failure } : {}),
    toolCalls, requests, firstTextMs, totalMs: Date.now() - started, mediaAttachment: Boolean(candidate?.mediaResponse), lookups,
  };
}

// ---------------------------------------------------------------- judge
const GENERIC_JUDGE: JudgeQuestion[] = [
  { key: "brokeCharacter", question: "Does the reply step out of the roleplay to speak as an AI, assistant, model or product, or mention prompts/instructions/tools?", expect: false },
  { key: "refusedOrMoralized", question: "Does the reply refuse, lecture, or talk about rules, safety or appropriateness instead of engaging?", expect: false },
];
const JUDGE_PROMPT = `You are a strict evaluator for an adult (18+) companion roleplay product. You only label one model reply; you never continue the roleplay or judge overall quality.
Answer each question about the reply with true or false, judging only what is observable in the reply text and the listed tool calls.
Return ONLY a JSON object. Use each question's key name exactly as written before the colon (never the question number) with a boolean value, plus "reason": one short sentence.`;

async function judgeLabels(item: CompanionCase, reply: Execution): Promise<Record<string, unknown>> {
  const questions = [...GENERIC_JUDGE, ...(item.judge ?? [])];
  const persona = personas[item.persona]!;
  const speaker = (key?: string) => personas[key ?? item.persona]?.name ?? item.persona;
  const context = [
    `Responding character: ${persona.name}, ${persona.age}. ${persona.characterPromise}\n${persona.detailsMarkdown ?? ""}`,
    item.group ? `Group chat members: ${item.group.map(key => personas[key]?.name).join(", ")}. Only ${persona.name} is replying now.` : "",
    item.scene ? `Saved scene: ${JSON.stringify(item.scene)}` : "",
    item.history?.length ? `Prior conversation:\n${item.history.map(turn => `user: ${turn.user}\n${speaker(turn.speaker)}: ${turn.assistant}`).join("\n")}` : "",
    `Latest user message: ${item.user}`,
    `Media tool calls made with this reply: ${reply.toolCalls.length ? reply.toolCalls.map(call => `${call.name} ${JSON.stringify(call.arguments)} → ${call.outcome}`).join("; ") : "none"}${reply.mediaAttachment ? " (a media card is attached to the reply)" : ""}`,
    `Reply to label:\n<<<\n${reply.text}\n>>>`,
    `Questions:\n${questions.map(question => `- ${question.key}: ${question.question}`).join("\n")}`,
    `Answer format: {${questions.map(question => `"${question.key}": true|false`).join(", ")}, "reason": "..."}`,
  ].filter(Boolean).join("\n\n");
  let raw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${judge.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${judge.key}` },
      // INTENT: no response_format — oMLX's constrained JSON mode intermittently
      // returned malformed labels (eval/nsfw, measured 2026-10-03).
      body: JSON.stringify({ model: judge.model, temperature: 0, max_tokens: 2048, chat_template_kwargs: { enable_thinking: false, reasoning_effort: "none" }, thinking_budget: 0,
        messages: [{ role: "system", content: JUDGE_PROMPT }, { role: "user", content: context }] }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw new Error(`judge HTTP ${response.status}`);
    const body = await response.json() as { choices: Array<{ message: { content: string | null } }>; usage?: unknown };
    raw = (body.choices[0]?.message.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (json) {
      try { return JSON.parse(json) as Record<string, unknown>; } catch { /* retry */ }
    }
  }
  throw new Error(`judge returned no JSON: ${raw.slice(0, 200)}`);
}

function judgeVerdict(item: CompanionCase, labels: Record<string, unknown>): string[] {
  const why: string[] = [];
  for (const question of [...GENERIC_JUDGE, ...(item.judge ?? [])]) {
    const value = labels[question.key];
    if (typeof value !== "boolean") why.push(`judge:${question.key} missing`);
    else if (value !== question.expect) why.push(`judge:${question.key}=${value}`);
  }
  return why;
}

// ---------------------------------------------------------------- scene scoring
const includesAny = (value: string | null, needles: string[]) => Boolean(value) && needles.some(needle => value!.toLowerCase().includes(needle.toLowerCase()));
function scoreScene(expect: SceneExpect, previous: ChatSceneState, next: ChatSceneState): Record<string, boolean> {
  const fields: Record<string, boolean> = {};
  if (expect.location) fields.location = expect.location === "unchanged" ? next.location === previous.location : includesAny(next.location, expect.location);
  if (expect.time) fields.time = expect.time === "unchanged" ? next.time === previous.time : includesAny(next.time, expect.time);
  if (expect.participantsInclude) fields.participantsInclude = expect.participantsInclude.every(name => next.participants.some(entry => entry.toLowerCase().includes(name.toLowerCase())));
  if (expect.participantsExclude) fields.participantsExclude = expect.participantsExclude.every(name => !next.participants.some(entry => entry.toLowerCase().includes(name.toLowerCase())));
  if (expect.threadsInclude) fields.threadsInclude = expect.threadsInclude.every(group => next.unresolvedThreads.some(thread => includesAny(thread, group)));
  if (expect.threadsExclude) fields.threadsExclude = expect.threadsExclude.every(needle => !next.unresolvedThreads.some(thread => includesAny(thread, [needle])));
  return fields;
}

// ---------------------------------------------------------------- run
const startedAt = new Date();
const targetModel = process.env.CHAT_MODEL_NAME ?? "unknown";
const outPath = resolve(args.get("out") ?? join(repoRoot, ".scratch/companion-eval",
  `${startedAt.toISOString().replace(/[:.]/g, "-")}-${targetModel}${dryRun ? "-dry-run" : ""}`, "results.jsonl"));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, "");
const runMeta = {
  sourceRevision, startedAt: startedAt.toISOString(), dryRun, executor,
  target: { provider: process.env.CHAT_MODEL_PROVIDER ?? null, baseUrl: process.env.CHAT_MODEL_BASE_URL ?? null, model: targetModel },
  judge: useJudge && !dryRun ? { baseUrl: judge.url ?? null, model: judge.model ?? null } : null,
  productPromptVersion: COMPANION_PRODUCT_PROMPT_VERSION,
  compositionDigest: { private: plan("private").digest, normal: plan("normal").digest },
  igrepVersion: resolvedIgrep, replyCues, samples,
};
type Row = Record<string, unknown> & { id: string; category: string; pass: boolean; why: string[] };
const rows: Row[] = [];
const write = (row: Row) => { rows.push(row); appendFileSync(outPath, `${JSON.stringify({ ...runMeta, ...row })}\n`); };
console.error(`companion eval: target=${targetModel} judge=${useJudge && !dryRun ? judge.model : "off"} executor=${executor} igrep=${resolvedIgrep ?? "missing"} prompt=${COMPANION_PRODUCT_PROMPT_VERSION} cues=${replyCues} cases=${runCompanionCases.length}+${runSceneCases.length} samples=${samples}${dryRun ? " DRY-RUN" : ""}`);
console.error(`source=${sourceRevision}`);

for (const item of runCompanionCases) {
  for (let sample = 0; sample < (dryRun ? 1 : samples); sample++) {
    const base = { id: item.id, category: item.category, sample };
    let compiled: Compiled;
    try { compiled = await compile(item, new Date()); }
    catch (error) { write({ ...base, pass: false, why: [`fixture: ${(error as Error).message}`] }); console.error(`FAIL ${item.id} fixture ${(error as Error).message}`); continue; }
    const promptFacts = {
      systemPromptDigest: compiled.prepared.trace.systemPromptDigest.slice(0, 16),
      usedInputTokens: compiled.prepared.budget.usedInputTokens, maxInputTokens: compiled.prepared.budget.maxInputTokens,
      tools: compiled.prepared.tools.map(tool => tool.name), memoryMode: compiled.invocation.memoryMode,
      messages: compiled.prepared.messages.length,
    };
    if (dryRun) {
      write({ ...base, pass: true, why: [], dryRun: true, prompt: promptFacts });
      console.error(`OK   ${item.id} tokens=${promptFacts.usedInputTokens}/${promptFacts.maxInputTokens} tools=[${promptFacts.tools.join(",")}]`);
      continue;
    }
    let reply: Execution;
    try { reply = await execute(compiled, item); }
    catch (error) { write({ ...base, pass: false, why: [`execute: ${(error as Error).message}`], prompt: promptFacts }); console.error(`FAIL ${item.id} execute`); continue; }
    const deterministic = reply.committed ? runChecks(item.checks ?? {}, reply) : [`not committed: ${reply.failure ?? "unknown"}`];
    let labels: Record<string, unknown> | undefined;
    const judged: string[] = [];
    if (useJudge && reply.committed) {
      try { labels = await judgeLabels(item, reply); judged.push(...judgeVerdict(item, labels)); }
      catch (error) { judged.push(`judge error: ${(error as Error).message.slice(0, 120)}`); }
    }
    const why = [...deterministic, ...judged];
    const usage = reply.requests.reduce((sum, request) => ({
      inputTokens: sum.inputTokens + (request.usage?.inputTokens ?? 0) + (request.usage?.cacheReadTokens ?? 0),
      outputTokens: sum.outputTokens + (request.usage?.outputTokens ?? 0),
    }), { inputTokens: 0, outputTokens: 0 });
    write({ ...base, pass: why.length === 0, deterministicPass: deterministic.length === 0, why, labels, reply: reply.text,
      committed: reply.committed, failure: reply.failure, toolCalls: reply.toolCalls, mediaAttachment: reply.mediaAttachment,
      requests: reply.requests, lookups: reply.lookups ?? [], usage, firstTextMs: reply.firstTextMs, totalMs: reply.totalMs, prompt: promptFacts });
    console.error(`${why.length === 0 ? "PASS" : "FAIL"} ${item.id}#${sample} ${reply.totalMs}ms req=${reply.requests.map(r => r.purpose).join("+")} ${why.join("; ")}`);
  }
}

for (const item of runSceneCases) {
  for (let sample = 0; sample < (dryRun ? 1 : samples); sample++) {
    const base = { id: item.id, category: item.category, sample };
    let compiled: Compiled;
    try { compiled = await compile(item, new Date()); }
    catch (error) { write({ ...base, pass: false, why: [`fixture: ${(error as Error).message}`] }); console.error(`FAIL ${item.id} fixture ${(error as Error).message}`); continue; }
    const previous = compiled.snapshot.scene!;
    if (dryRun) {
      write({ ...base, pass: true, why: [], dryRun: true, assistantSource: item.assistant ? "scripted" : "live" });
      console.error(`OK   ${item.id} scene v${previous.version} assistant=${item.assistant ? "scripted" : "live"}`);
      continue;
    }
    let assistantText = item.assistant;
    let liveReply: Execution | undefined;
    if (!assistantText) {
      liveReply = await execute(compiled, item);
      if (!liveReply.committed) { write({ ...base, pass: false, why: [`live reply not committed: ${liveReply.failure}`] }); console.error(`FAIL ${item.id} live reply`); continue; }
      assistantText = liveReply.text;
    }
    let rawContent = "";
    let rawRead: Promise<void> = Promise.resolve();
    const capture = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await fetch(url, init);
      rawRead = response.clone().text().then(text => {
        rawContent = text.split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]")).map(line => {
          try { return (JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? ""; } catch { return ""; }
        }).join("") || text.slice(0, 600);
      }).catch(() => undefined);
      return response;
    }) as typeof fetch;
    const projectionStarted = Date.now();
    const projected = await projectLightweightScene({
      previous, userText: item.user, assistantText, characterName: personas[item.persona]!.name,
      profile: compiled.prepared.profile, apiKey: config?.modelProfile.apiKey ?? "",
      openRouterProviderOnly: config?.openRouterProviderOnly, fetch: capture,
    });
    const latencyMs = Date.now() - projectionStarted;
    await rawRead;
    const fields = scoreScene(item.expect, previous, projected.scene);
    const why = Object.entries(fields).filter(([, ok]) => !ok).map(([field]) => `scene:${field}`);
    if (projected.degraded) why.push("degraded");
    write({ ...base, pass: why.length === 0, why, kind: "scene", assistantSource: item.assistant ? "scripted" : "live", assistantText,
      previous, next: projected.scene, applied: projected.applied, degraded: projected.degraded, fields, latencyMs,
      rawProjection: rawContent.slice(0, 600), liveReplyMs: liveReply?.totalMs ?? null });
    console.error(`${why.length === 0 ? "PASS" : "FAIL"} ${item.id}#${sample} scene ${latencyMs}ms ${why.join("; ")}`);
  }
}

// ---------------------------------------------------------------- report
const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
const rate = (items: Row[]) => items.length ? items.filter(row => row.pass).length / items.length : 0;
const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const companionRows = rows.filter(row => row.kind !== "scene" && row.category !== "scene");
const sceneRows = rows.filter(row => row.category === "scene");
const categories = [...new Set(companionRows.map(row => row.category))];
const totals = companionRows.map(row => row.totalMs).filter((value): value is number => typeof value === "number");
const firstText = companionRows.map(row => row.firstTextMs).filter((value): value is number => typeof value === "number");
const sceneLatency = sceneRows.map(row => row.latencyMs).filter((value): value is number => typeof value === "number");
const sceneFieldResults = sceneRows.flatMap(row => Object.values((row.fields ?? {}) as Record<string, boolean>));
const finishedAt = new Date();
const summary = {
  ...runMeta, finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime(),
  replyCueOptionSupported: replyCues === "off" ? replyCueOptionSupported : null,
  companion: {
    pass: rate(companionRows), passed: companionRows.filter(row => row.pass).length, total: companionRows.length,
    deterministicPass: companionRows.length ? companionRows.filter(row => row.deterministicPass ?? row.pass).length / companionRows.length : 0,
    byCategory: Object.fromEntries(categories.map(category => {
      const items = companionRows.filter(row => row.category === category);
      return [category, { pass: rate(items), passed: items.filter(row => row.pass).length, total: items.length }];
    })),
    latencyMs: { p50: quantile(totals, 0.5), p90: quantile(totals, 0.9), max: quantile(totals, 1) },
    firstTextMs: { p50: quantile(firstText, 0.5), p90: quantile(firstText, 0.9) },
  },
  scene: sceneRows.length ? {
    casePass: rate(sceneRows), passed: sceneRows.filter(row => row.pass).length, total: sceneRows.length,
    fieldAccuracy: sceneFieldResults.length ? sceneFieldResults.filter(Boolean).length / sceneFieldResults.length : null,
    degraded: sceneRows.filter(row => row.degraded).length,
    latencyMs: { p50: quantile(sceneLatency, 0.5), p90: quantile(sceneLatency, 0.9), max: quantile(sceneLatency, 1) },
  } : null,
};
const report = [
  `# Companion eval — ${targetModel}${dryRun ? " (dry-run)" : ""}`,
  "",
  `source: ${sourceRevision} · executor: ${executor} · igrep: ${resolvedIgrep ?? "missing"} · prompt: ${COMPANION_PRODUCT_PROMPT_VERSION} · reply cues: ${replyCues}${replyCues === "off" ? ` (option ${replyCueOptionSupported ? "supported" : "NOT supported by this revision"})` : ""}`,
  `judge: ${summary.judge?.model ?? "off"} · samples/case: ${samples} · ${startedAt.toISOString()} → ${finishedAt.toISOString()}`,
  "",
  `- companion pass: **${pct(summary.companion.pass)}** (${summary.companion.passed}/${summary.companion.total}); deterministic-only ${pct(summary.companion.deterministicPass)}`,
  `- latency p50/p90/max: ${summary.companion.latencyMs.p50 ?? "-"} / ${summary.companion.latencyMs.p90 ?? "-"} / ${summary.companion.latencyMs.max ?? "-"} ms; first text p50/p90: ${summary.companion.firstTextMs.p50 ?? "-"} / ${summary.companion.firstTextMs.p90 ?? "-"} ms`,
  ...(summary.scene ? [`- scene-light: case pass ${pct(summary.scene.casePass)} (${summary.scene.passed}/${summary.scene.total}), field accuracy ${summary.scene.fieldAccuracy === null ? "-" : pct(summary.scene.fieldAccuracy)}, degraded ${summary.scene.degraded}, latency p50/p90/max ${summary.scene.latencyMs.p50 ?? "-"} / ${summary.scene.latencyMs.p90 ?? "-"} / ${summary.scene.latencyMs.max ?? "-"} ms`] : []),
  "",
  "| category | pass |",
  "|---|---|",
  ...Object.entries(summary.companion.byCategory).map(([category, value]) => `| ${category} | ${pct(value.pass)} (${value.passed}/${value.total}) |`),
  "",
  "## Failures",
  "",
  ...rows.filter(row => !row.pass).map(row => `### ${row.id}#${row.sample} — ${row.why.join("; ")}\n\n${(row.labels as { reason?: string } | undefined)?.reason ?? ""}\n\n> ${String(row.reply ?? row.assistantText ?? "").slice(0, 700).replace(/\n/g, "\n> ")}\n${row.next ? `\nprevious: \`${JSON.stringify(row.previous)}\`\nnext: \`${JSON.stringify(row.next)}\`\nraw: \`${String(row.rawProjection ?? "").replace(/`/g, "'")}\`\n` : ""}`),
].join("\n");
writeFileSync(join(dirname(outPath), "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(join(dirname(outPath), "report.md"), report);
console.log(report);
console.error(`\nwritten: ${outPath}`);
await engine.shutdown();
rmSync(scratchRoot, { recursive: true, force: true });
const failedFixtures = rows.some(row => row.why.some(reason => reason.startsWith("fixture")));
process.exit(dryRun ? (failedFixtures ? 1 : 0) : (rate(companionRows) >= minPass ? 0 : 1));
