import { describe, expect, it } from "vitest";
import type { CompanionTerminalCandidate } from "./contracts";
import {
  evaluateTerminalCandidate,
  type TerminalCandidateFacts,
  type TerminalValidationCode,
} from "./terminal-candidate";

type Reservation = CompanionTerminalCandidate["tools"][number];

const IMAGE_TOOL = "generate_image_async" as const;
const COMPLETED_AT = "2026-09-12T00:00:00.000Z";

function reservation(name: Reservation["name"]): Reservation {
  return {
    attemptId: "attempt-1",
    callId: "call-1",
    name,
    effectScope: "turn_action" as const,
    intent: { requestedNudity: "unspecified" as const },
    argumentsDigest: "a".repeat(64),
  };
}

function facts(overrides: Partial<TerminalCandidateFacts> = {}): TerminalCandidateFacts {
  return {
    attemptId: "attempt-1",
    assistantContent: "I missed you today.",
    finishReasonKind: "stop",
    currentUserText: "How was your day?",
    requiredAction: null,
    tools: [],
    toolCalls: 0,
    reservations: [],
    profile: { provider: "local", model: "model-1" },
    usage: { promptTokens: 10, completionTokens: 4, reasoningTokens: 0 },
    steps: 1,
    completedAt: COMPLETED_AT,
    ...overrides,
  };
}

/** A turn that carries an authorized image action and satisfies every image rule. */
function imageActionFacts(overrides: Partial<TerminalCandidateFacts> = {}): TerminalCandidateFacts {
  return facts({
    assistantContent: "Here you go, love.",
    currentUserText: "send me a selfie",
    requiredAction: { name: IMAGE_TOOL },
    tools: [{ name: IMAGE_TOOL }],
    toolCalls: 1,
    reservations: [reservation(IMAGE_TOOL)],
    ...overrides,
  });
}

describe("evaluateTerminalCandidate", () => {
  // SPEC: 五个 validationCode 各有一条触发用例，且必须与 requiredAction 的有无对齐 ——
  // 四条图片规则只在有 requiredAction 时成立，误伤普通轮次就是把正常回复判死。
  const rejections: {
    name: string;
    code: TerminalValidationCode;
    input: TerminalCandidateFacts;
  }[] = [
    {
      name: "memory_search payload the model never executed",
      code: "unexecuted_tool_payload",
      input: facts({ assistantContent: '{memory_search: "the rooftop code word"}' }),
    },
    {
      name: "image tool payload printed as prose while an image action is required",
      code: "unexecuted_tool_payload",
      input: imageActionFacts({
        assistantContent: `{"name":"${IMAGE_TOOL}","arguments":{"prompt":"a selfie"}}`,
      }),
    },
    {
      name: "required image reply written in the wrong writing system",
      code: "required_image_reply_language_mismatch",
      input: imageActionFacts({ currentUserText: "给我拍一张自拍", assistantContent: "Here you go." }),
    },
    {
      name: "required image reply that narrates the generation process",
      code: "required_image_reply_exposed_process",
      input: imageActionFacts({ assistantContent: "Let me refine the prompt for you." }),
    },
    {
      name: "required image action that never called its tool",
      code: "required_image_tool_missing",
      input: imageActionFacts({ toolCalls: 0, reservations: [] }),
    },
    {
      name: "required image action that called the tool twice",
      code: "required_image_tool_mismatch",
      input: imageActionFacts({
        toolCalls: 2,
        reservations: [reservation(IMAGE_TOOL), reservation(IMAGE_TOOL)],
      }),
    },
    {
      name: "required image action that called a different tool",
      code: "required_image_tool_mismatch",
      input: imageActionFacts({ reservations: [reservation("edit_last_image")] }),
    },
  ];

  it.each(rejections)("rejects $name with $code", ({ code, input }) => {
    const decision = evaluateTerminalCandidate(input);
    expect(decision.accepted).toBe(false);
    expect(decision.accepted === false && decision.code).toBe(code);
  });

  // INVARIANT: 没有 requiredAction 时，同样的正文不带任何图片 validationCode。
  const withoutRequiredAction: { name: string; input: TerminalCandidateFacts }[] = [
    {
      name: "a reply in another writing system",
      input: facts({ currentUserText: "给我讲讲今天", assistantContent: "It was quiet and warm." }),
    },
    {
      name: "a reply that mentions a prompt",
      input: facts({ assistantContent: "Let me refine the prompt for you." }),
    },
    {
      name: "a reply with no tool call at all",
      input: facts({ toolCalls: 0, reservations: [] }),
    },
    {
      name: "a reply after two tool calls",
      input: facts({
        toolCalls: 2,
        reservations: [reservation(IMAGE_TOOL), reservation("edit_last_image")],
      }),
    },
  ];

  it.each(withoutRequiredAction)("accepts $name when no image action is required", ({ input }) => {
    expect(evaluateTerminalCandidate(input).accepted).toBe(true);
  });

  it("keeps an image tool payload legal as prose when the turn exposes no image tool", () => {
    const decision = evaluateTerminalCandidate(facts({
      assistantContent: `{"name":"${IMAGE_TOOL}","arguments":{"prompt":"a selfie"}}`,
    }));
    expect(decision.accepted).toBe(true);
  });

  it("rejects a turn that stopped without an assistant message", () => {
    const decision = evaluateTerminalCandidate(facts({ assistantContent: undefined }));
    expect(decision).toEqual({
      accepted: false,
      message: "turn stopped without a terminal assistant candidate",
    });
  });

  it("rejects a turn that produced no finish chunk", () => {
    const decision = evaluateTerminalCandidate(facts({ finishReasonKind: undefined }));
    expect(decision).toEqual({
      accepted: false,
      message: "turn stopped without a terminal assistant candidate",
    });
  });

  it("rejects empty terminal content without a validation code", () => {
    const decision = evaluateTerminalCandidate(facts({ assistantContent: "" }));
    expect(decision).toEqual({
      accepted: false,
      message: "terminal assistant candidate is empty",
    });
  });

  it("rejects a non-terminal finish reason without a validation code", () => {
    const decision = evaluateTerminalCandidate(facts({ finishReasonKind: "tool-calls" }));
    expect(decision).toEqual({
      accepted: false,
      message: "non-terminal finish reason tool-calls",
    });
  });

  it("builds the candidate Main commits", () => {
    const decision = evaluateTerminalCandidate(imageActionFacts({
      steps: 2,
      modelRequests: [{
        bodyDigest: "b".repeat(64),
        systemPromptDigest: "c".repeat(64),
        estimatedInputTokens: 120,
      }],
      acknowledgement: { version: "image-action-ack-1", locale: "en" },
      attribution: { requestId: "req-1" },
    }));
    expect(decision).toEqual({
      accepted: true,
      candidate: {
        attemptId: "attempt-1",
        content: "Here you go, love.",
        finishReason: "stop",
        provider: "local",
        model: "model-1",
        usage: { promptTokens: 10, completionTokens: 4, reasoningTokens: 0 },
        execution: { steps: 2, toolCalls: 1 },
        tools: [reservation(IMAGE_TOOL)],
        completedAt: COMPLETED_AT,
        modelRequests: [{
          bodyDigest: "b".repeat(64),
          systemPromptDigest: "c".repeat(64),
          estimatedInputTokens: 120,
        }],
        acknowledgement: { version: "image-action-ack-1", locale: "en" },
        attribution: { requestId: "req-1" },
      },
    });
  });

  it("reports a truncated turn as a length finish", () => {
    const decision = evaluateTerminalCandidate(facts({ finishReasonKind: "max-tokens" }));
    expect(decision.accepted === true && decision.candidate.finishReason).toBe("length");
  });

  it("omits optional evidence that the turn never produced", () => {
    const decision = evaluateTerminalCandidate(facts({ modelRequests: [] }));
    expect(decision.accepted === true && decision.candidate).not.toHaveProperty("modelRequests");
    expect(decision.accepted === true && decision.candidate).not.toHaveProperty("acknowledgement");
    expect(decision.accepted === true && decision.candidate).not.toHaveProperty("attribution");
  });
});
