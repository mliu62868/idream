import { describe, expect, it } from "vitest";
import {
  GENERATE_IMAGE_ASYNC_TOOL,
  buildToolPlannerMessages,
  imageToolCaption,
  parseAgentToolPlan,
  planAgentToolCall,
  type GenerateImageAsyncToolCall,
} from "./agent-tools.js";
import type { BuiltContext } from "./context.js";
import type { ChatModel } from "./providers.js";

const context = {
  persona: {
    characterId: "char_1",
    creatorId: "creator_1",
    name: "Melissa",
    age: 38,
    description: "A realistic adult companion.",
    systemPrompt: null,
    relationship: "companion",
    visibility: "public",
    status: "approved",
    voiceId: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  },
  policy: {
    model: "local-model",
    maxContextMessages: 12,
    maxMemories: 0,
    maxStoredMemories: 0,
    rateLimitPerHour: 60,
    unlimitedMessages: false,
    voiceEnabled: false,
    allowMemoryWrite: true,
    allowGlobalMemoryWrite: false,
    allowRelationshipPatch: true,
    outputModerationRequired: true,
  },
  sessionSummary: null,
  recentMessages: [
    { id: "m1", role: "user", content: "给我一张坐在窗边的照片" },
  ],
  boundaries: [],
  longTermMemories: [],
  relationship: null,
  canUpdateSessionSummary: true,
} satisfies BuiltContext;

describe("agent image tool planning", () => {
  it("parses a model-selected async image tool call", () => {
    const plan = parseAgentToolPlan(JSON.stringify({
      tool: {
        name: GENERATE_IMAGE_ASYNC_TOOL,
        arguments: {
          prompt: "Realistic photo of Melissa sitting beside a sunlit window, soft afternoon light, intimate portrait framing",
          caption: "我给你准备一张靠窗的照片。",
          orientation: "4:5",
          outputCount: 1,
        },
      },
    }));

    expect(plan.toolCall?.arguments.prompt).toContain("sunlit window");
    expect(plan.toolCall?.arguments.caption).toBe("我给你准备一张靠窗的照片。");
  });

  it("returns no tool when the model selects none or emits invalid JSON", () => {
    expect(parseAgentToolPlan("{\"tool\":null}").toolCall).toBeNull();
    expect(parseAgentToolPlan("ordinary chat text").toolCall).toBeNull();
  });

  it("asks the model to plan tools from persona and recent conversation", async () => {
    const fakeToolCall: GenerateImageAsyncToolCall = {
      name: GENERATE_IMAGE_ASYNC_TOOL,
      arguments: {
        prompt: "Realistic in-character portrait of Melissa at a window, natural light, close framing",
        caption: "我来生成这张。",
        orientation: "4:5",
        outputCount: 1,
      },
    };
    const fakeChat: ChatModel = {
      async *stream() {
        yield { delta: "", done: true };
      },
      async complete(input) {
        expect(input.messages[0]?.content).toContain(GENERATE_IMAGE_ASYNC_TOOL);
        expect(input.messages.at(-1)?.content).toBe("给我一张坐在窗边的照片");
        return { content: JSON.stringify({ tool: fakeToolCall }) };
      },
    };

    const plan = await planAgentToolCall({ chat: fakeChat, model: "local-model", context });

    expect(plan.toolCall).toEqual(fakeToolCall);
  });

  it("builds planner messages without embedding regex trigger rules", () => {
    const messages = buildToolPlannerMessages(context);
    expect(messages[0]?.content).toContain("Available tool");
    expect(messages[0]?.content).not.toContain("regex");
  });

  it("falls back to a caption when the tool call omits one", () => {
    const caption = imageToolCaption({
      name: GENERATE_IMAGE_ASYNC_TOOL,
      arguments: {
        prompt: "Realistic portrait prompt with enough detail",
        orientation: "4:5",
        outputCount: 1,
      },
    }, "Melissa");

    expect(caption).toContain("Melissa");
  });
});
