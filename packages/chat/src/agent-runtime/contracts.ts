import { z } from "zod";
import {
  EDIT_LAST_IMAGE_TOOL,
  editLastImageArgsSchema,
  GENERATE_IMAGE_ASYNC_TOOL,
  generateImageAsyncArgsSchema,
} from "@idream/shared/chat/image-action";
import { companionMemoryModeSchema } from "@idream/shared/chat/companion-runtime";
import { groupChatMemberSchema } from "@idream/shared/contracts";

const nonEmptyString = z.string().trim().min(1);
const isoDateTime = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const credentialFreeHttpUrl = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username || url.password || url.search || url.hash
  ) context.addIssue({ code: "custom", message: "runtime endpoints must be credential-free HTTP(S) base URLs" });
});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(jsonValue), z.record(z.string(), jsonValue),
]));
const jsonObject = z.record(z.string(), jsonValue);

const modelFunctionCall = z.object({
  id: nonEmptyString,
  type: z.literal("function"),
  function: z.object({ name: nonEmptyString, arguments: z.string() }).strict(),
}).strict();
const preparedMessageBase = {
  id: nonEmptyString,
  sourceKind: z.enum(["current_user", "replay", "plugin"]),
  content: z.string(),
};
export const preparedTurnMessageSchema = z.discriminatedUnion("role", [
  z.object({ ...preparedMessageBase, role: z.literal("system") }).strict(),
  z.object({ ...preparedMessageBase, role: z.literal("user") }).strict(),
  z.object({
    ...preparedMessageBase,
    role: z.literal("assistant"),
    speaker: groupChatMemberSchema.optional(),
    tool_calls: z.array(modelFunctionCall).min(1).optional(),
  }).strict(),
  z.object({
    ...preparedMessageBase,
    role: z.literal("tool"),
    tool_call_id: nonEmptyString,
  }).strict(),
]);

const toolName = z.enum([GENERATE_IMAGE_ASYNC_TOOL, EDIT_LAST_IMAGE_TOOL]);
const preparedToolDefinition = z.object({
  name: toolName,
  description: nonEmptyString,
  parameters: jsonObject,
}).strict();
export const preparedTurnProfileSchema = z.object({
  tier: nonEmptyString,
  adapter: nonEmptyString,
  provider: nonEmptyString,
  baseUrl: credentialFreeHttpUrl,
  model: nonEmptyString,
  supportsTools: z.boolean(),
  maxOutputTokens: positiveInteger,
  answerMaxOutputTokens: positiveInteger.optional(),
  timeout: z.object({ firstTokenMs: positiveInteger, idleMs: positiveInteger }).strict(),
  sampling: z.object({
    temperature: z.number().finite().min(0).max(2),
    topP: z.number().finite().gt(0).max(1),
    repetitionPenalty: z.number().finite().gt(0).max(2),
  }).strict(),
}).strict();
const preparedBudget = z.object({
  maxInputTokens: positiveInteger,
  usedInputTokens: nonNegativeInteger,
  dropped: z.array(z.literal("transcript")),
}).strict().superRefine((budget, context) => {
  if (budget.usedInputTokens > budget.maxInputTokens) {
    context.addIssue({ code: "custom", path: ["usedInputTokens"], message: "used input tokens cannot exceed budget" });
  }
  if (new Set(budget.dropped).size !== budget.dropped.length) {
    context.addIssue({ code: "custom", path: ["dropped"], message: "budget degradation entries must be unique" });
  }
});
const preparedTrace = z.object({
  productPromptVersion: nonEmptyString,
  systemPromptDigest: sha256,
  characterContentVersionId: nonEmptyString,
  characterReleaseId: nonEmptyString.nullable(),
  soulFingerprint: sha256,
  compilerVersion: nonEmptyString,
  sceneVersion: nonNegativeInteger,
  contextRevision: z.string().regex(/^\d+$/),
}).strict();
export const preparedTurnSchema = z.object({
  version: z.literal(5),
  model: nonEmptyString,
  characterName: nonEmptyString,
  messages: z.array(preparedTurnMessageSchema).min(1),
  tools: z.array(preparedToolDefinition),
  profile: preparedTurnProfileSchema,
  budget: preparedBudget,
  trace: preparedTrace,
  requiredAction: z.object({
    name: toolName,
    requestedNudity: z.enum(["unspecified", "none", "full"]),
    replyLocale: nonEmptyString,
  }).strict().nullable(),
}).strict().superRefine((turn, context) => {
  if (turn.model !== turn.profile.model) {
    context.addIssue({ code: "custom", path: ["model"], message: "prepared model must equal profile model" });
  }
  const current = turn.messages.filter((message) => message.sourceKind === "current_user");
  if (current.length !== 1 || current[0]?.role !== "user" || turn.messages.at(-1)?.id !== current[0]?.id) {
    context.addIssue({ code: "custom", path: ["messages"], message: "exactly one final user current message is required" });
  }
  if (new Set(turn.messages.map(({ id }) => id)).size !== turn.messages.length) {
    context.addIssue({ code: "custom", path: ["messages"], message: "prepared message ids must be unique" });
  }
  if (new Set(turn.tools.map(({ name }) => name)).size !== turn.tools.length) {
    context.addIssue({ code: "custom", path: ["tools"], message: "prepared tool names must be unique" });
  }
  if (
    turn.requiredAction &&
    (turn.tools.length !== 1 || turn.tools[0]?.name !== turn.requiredAction.name)
  ) {
    context.addIssue({
      code: "custom",
      path: ["tools"],
      message: "a required action must expose exactly its matching Agent tool",
    });
  }
  if (turn.requiredAction && !turn.profile.supportsTools) {
    context.addIssue({
      code: "custom",
      path: ["profile", "supportsTools"],
      message: "a required action needs a tool-capable model profile",
    });
  }
});

export const companionInvocationSchema = z.object({
  invocationId: nonEmptyString,
  attemptId: nonEmptyString,
  sessionId: nonEmptyString,
  userId: nonEmptyString,
  characterId: nonEmptyString,
  preparedTurn: preparedTurnSchema,
  memoryMode: companionMemoryModeSchema,
  expectedProfileDigest: sha256,
  deadlineAt: isoDateTime,
}).strict();

const imageEffectAuthority = {
  effectScope: z.enum(["attempt", "turn_action"]),
  intent: z.object({
    requestedNudity: z.enum(["unspecified", "none", "full"]),
  }).strict(),
};
const toolIdentity = { attemptId: nonEmptyString, callId: nonEmptyString };
export const companionToolCallSchema = z.discriminatedUnion("name", [
  z.object({ ...toolIdentity, ...imageEffectAuthority, name: z.literal(GENERATE_IMAGE_ASYNC_TOOL), arguments: generateImageAsyncArgsSchema }).strict(),
  z.object({ ...toolIdentity, ...imageEffectAuthority, name: z.literal(EDIT_LAST_IMAGE_TOOL), arguments: editLastImageArgsSchema }).strict(),
]);
export const companionToolReservationSchema = z.object({
  ...toolIdentity,
  ...imageEffectAuthority,
  name: toolName,
  argumentsDigest: sha256,
}).strict();
const companionError = z.object({ code: nonEmptyString, message: nonEmptyString, retryable: z.boolean() }).strict();
export const companionToolResultSchema = z.discriminatedUnion("outcome", [
  z.object({ ...toolIdentity, name: toolName, outcome: z.literal("succeeded"), output: jsonValue }).strict(),
  z.object({ ...toolIdentity, name: toolName, outcome: z.literal("failed"), error: companionError }).strict(),
  z.object({ ...toolIdentity, name: toolName, outcome: z.literal("unknown"), error: companionError }).strict(),
]);
const companionUsage = z.object({
  promptTokens: nonNegativeInteger,
  completionTokens: nonNegativeInteger,
  reasoningTokens: nonNegativeInteger,
}).strict();
export const COMPANION_TERMINAL_CONTENT_MAX_BYTES = 2_097_152;
export const companionModelRequestEvidenceSchema = z.object({
  bodyDigest: sha256,
  systemPromptDigest: sha256,
  estimatedInputTokens: positiveInteger,
  maxInputTokens: positiveInteger.optional(),
}).strict();
export type CompanionModelRequestEvidence = z.infer<typeof companionModelRequestEvidenceSchema>;

export const companionTerminalCandidateSchema = z.object({
  attemptId: nonEmptyString,
  content: z.string().min(1).superRefine((value, context) => {
    if (new TextEncoder().encode(value).byteLength > COMPANION_TERMINAL_CONTENT_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "terminal candidate content exceeds limit" });
    }
  }),
  finishReason: z.enum(["stop", "length"]),
  provider: nonEmptyString,
  model: nonEmptyString,
  usage: companionUsage,
  execution: z.object({ steps: positiveInteger, toolCalls: nonNegativeInteger }).strict(),
  tools: z.array(companionToolReservationSchema),
  completedAt: isoDateTime,
  modelRequests: z.array(companionModelRequestEvidenceSchema).optional(),
  acknowledgement: z.object({
    version: z.literal("image-action-ack-1"),
    locale: nonEmptyString,
  }).strict().optional(),
  attribution: z.object({
    requestId: nonEmptyString.optional(),
    actualProvider: nonEmptyString.optional(),
  }).strict().refine(
    (value) => value.requestId !== undefined || value.actualProvider !== undefined,
    "provider attribution must contain a request id or actual provider",
  ).optional(),
}).strict().superRefine((candidate, context) => {
  if (candidate.execution.toolCalls !== candidate.tools.length) {
    context.addIssue({ code: "custom", path: ["tools"], message: "terminal tools must match execution count" });
  }
});
export const companionCommitAckSchema = z.discriminatedUnion("accepted", [
  z.object({
    attemptId: nonEmptyString,
    accepted: z.literal(true),
    status: z.enum(["committed", "duplicate"]),
    terminalMessageId: nonEmptyString,
    committedAt: isoDateTime,
  }).strict(),
  z.object({
    attemptId: nonEmptyString,
    accepted: z.literal(false),
    status: z.literal("rejected"),
    error: z.object({ code: nonEmptyString, message: nonEmptyString }).strict(),
  }).strict(),
]);

const eventIdentity = {
  invocationId: nonEmptyString,
  attemptId: nonEmptyString,
  sequence: positiveInteger,
  occurredAt: isoDateTime,
};
export const companionEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventIdentity, type: z.literal("started"), instance: z.object({ id: z.string().uuid(), startedAt: isoDateTime }).strict(), profileDigest: sha256 }).strict(),
  z.object({ ...eventIdentity, type: z.literal("text_delta"), delta: z.string().min(1) }).strict(),
  z.object({ ...eventIdentity, type: z.literal("text_reset") }).strict(),
  z.object({ ...eventIdentity, type: z.literal("reasoning_usage"), reasoningTokens: nonNegativeInteger }).strict(),
  z.object({ ...eventIdentity, type: z.literal("tool_started"), callId: nonEmptyString, name: toolName }).strict(),
  z.object({ ...eventIdentity, type: z.literal("tool_finished"), callId: nonEmptyString, name: toolName, outcome: z.enum(["succeeded", "failed", "unknown"]), durationMs: nonNegativeInteger }).strict(),
  z.object({ ...eventIdentity, type: z.literal("usage"), usage: companionUsage }).strict(),
  z.object({ ...eventIdentity, type: z.literal("igrep_observation"), operation: z.enum(["wake", "search", "memory"]), outcome: z.enum(["hit", "empty", "failure"]), resultCount: nonNegativeInteger.optional(), evidenceMatches: nonNegativeInteger.max(8).optional(), durationMs: nonNegativeInteger }).strict(),
  z.object({ ...eventIdentity, type: z.literal("heartbeat") }).strict(),
  z.object({ ...eventIdentity, type: z.literal("terminal_candidate"), candidate: companionTerminalCandidateSchema }).strict(),
  z.object({ ...eventIdentity, type: z.literal("failed"), error: companionError }).strict(),
  z.object({ ...eventIdentity, type: z.literal("cancelled"), reason: z.enum(["user", "timeout", "shutdown", "transport"]) }).strict(),
]).superRefine((event, context) => {
  if (event.type === "terminal_candidate" && event.candidate.attemptId !== event.attemptId) {
    context.addIssue({ code: "custom", path: ["candidate", "attemptId"], message: "candidate must retain event attempt" });
  }
  if (event.type === "igrep_observation") {
    const validCount = event.outcome === "hit"
      ? (event.resultCount ?? 0) > 0
      : event.outcome === "empty" ? event.resultCount === 0 : event.resultCount === undefined;
    if (!validCount) context.addIssue({ code: "custom", path: ["resultCount"], message: "result count must prove outcome" });
    if (event.evidenceMatches !== undefined && (event.operation !== "memory" || event.outcome !== "hit")) {
      context.addIssue({ code: "custom", path: ["evidenceMatches"], message: "evidence matches require a memory hit" });
    }
  }
});

export type PreparedTurnMessage = z.infer<typeof preparedTurnMessageSchema>;
export type PreparedTurnProfile = z.infer<typeof preparedTurnProfileSchema>;
export type PreparedTurnInput = z.infer<typeof preparedTurnSchema>;
export type CompanionInvocation = z.infer<typeof companionInvocationSchema>;
export type CompanionToolCall = z.infer<typeof companionToolCallSchema>;
export type CompanionToolResult = z.infer<typeof companionToolResultSchema>;
export type CompanionTerminalCandidate = z.infer<typeof companionTerminalCandidateSchema>;
export type CompanionCommitAck = z.infer<typeof companionCommitAckSchema>;
export type CompanionEvent = z.infer<typeof companionEventSchema>;
