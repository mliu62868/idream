import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_REGISTRY,
  EDIT_LAST_IMAGE_TOOL,
  GENERATE_IMAGE_ASYNC_TOOL,
  buildToolPlannerMessages,
  findAgentTool,
  imageToolCaption,
  parseAgentToolPlan,
  planAgentToolCall,
  registryChatTools,
  shouldPlanImageTool,
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
    deletedAt: null,
    voiceId: null,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    visualProfileId: "cvp_1",
    visualProfileVersion: 1,
    identityPrompt: "Melissa, adult woman, auburn hair, hazel eyes",
    imageToolEnabled: true,
    characterContentVersionId: null,
    characterReleaseId: null,
  },
  policy: {
    model: "local-model",
    maxContextMessages: 12,
    maxContextChars: 24_000,
    maxMemories: 0,
    maxStoredMemories: 0,
    rateLimitPerHour: 60,
    unlimitedMessages: false,
    voiceEnabled: false,
    allowMemoryWrite: true,
    allowGlobalMemoryWrite: false,
    allowRelationshipPatch: true,
    outputModerationRequired: true,
    imageToolEnabled: true,
  },
  sessionSummary: null,
  recentMessages: [
    { id: "m1", role: "user", content: "给我一张坐在窗边的照片" },
  ],
  boundaries: [],
  longTermMemories: [],
  relationship: null,
  canUpdateSessionSummary: true,
  sessionContextRevision: 0n,
  fileContextRevision: 0n,
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

    const toolCall = plan.toolCall;
    expect(toolCall?.name).toBe(GENERATE_IMAGE_ASYNC_TOOL);
    if (toolCall?.name !== GENERATE_IMAGE_ASYNC_TOOL) throw new Error("expected generate_image_async");
    expect(toolCall.arguments.prompt).toContain("sunlit window");
    expect(toolCall.arguments.caption).toBe("我给你准备一张靠窗的照片。");
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
    expect(messages[0]?.content).toContain("BOUNDARIES");
    expect(messages[0]?.content).toContain("mandatory constraints");
    expect(messages[0]?.content).toContain('{"tool":null}');
    expect(messages[0]?.content).not.toContain("regex");
  });

  it("injects the visual passport identity line into the planner prompt", () => {
    const messages = buildToolPlannerMessages(context);
    expect(messages[0]?.content).toContain("Your appearance (keep consistent when sending photos):");
    expect(messages[0]?.content).toContain(context.persona.identityPrompt);
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

describe("agent tool registry", () => {
  it("contains generate_image_async and edit_last_image", () => {
    expect(AGENT_TOOL_REGISTRY).toHaveLength(2);
    expect(AGENT_TOOL_REGISTRY.map((tool) => tool.name)).toEqual([
      GENERATE_IMAGE_ASYNC_TOOL,
      EDIT_LAST_IMAGE_TOOL,
    ]);
  });

  it("finds a registered tool by name and misses unknown names", () => {
    expect(findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)?.name).toBe(GENERATE_IMAGE_ASYNC_TOOL);
    expect(findAgentTool("not_a_real_tool")).toBeUndefined();
  });

  it("produces a valid JSON Schema for the generate_image_async tool", () => {
    const [chatTool] = registryChatTools();
    expect(chatTool?.name).toBe(GENERATE_IMAGE_ASYNC_TOOL);
    expect(chatTool?.parameters).toMatchObject({
      type: "object",
      required: ["prompt"],
    });
    const properties = (chatTool?.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(["prompt", "caption", "orientation", "outputCount"]),
    );
  });

  it("keeps hasVisualRequestIntent semantics unchanged via shouldPlanImageTool (EN keyword pairs)", () => {
    const withMessage = (content: string): BuiltContext => ({
      ...context,
      recentMessages: [{ id: "m1", role: "user", content }],
    });

    expect(shouldPlanImageTool(withMessage("send me a photo"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("show me a picture of you"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("can I get a selfie"))).toBe(true);
    // requires BOTH a trigger verb/noun AND a visual noun — a lone trigger word is not enough
    expect(shouldPlanImageTool(withMessage("generate a summary of our chat"))).toBe(false);
    expect(shouldPlanImageTool(withMessage("how are you today"))).toBe(false);
  });

  it("keeps hasVisualRequestIntent semantics unchanged via shouldPlanImageTool (ZH regex)", () => {
    const withMessage = (content: string): BuiltContext => ({
      ...context,
      recentMessages: [{ id: "m1", role: "user", content }],
    });

    expect(shouldPlanImageTool(withMessage("给我一张坐在窗边的照片"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("发一张自拍给我"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("生成一张图给我看看"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("你今天怎么样"))).toBe(false);
  });

  it("drives the planner prompt's tool listing from the registry", () => {
    const messages = buildToolPlannerMessages(context);
    const tool = findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)!;
    expect(messages[0]?.content).toContain(tool.name);
    expect(messages[0]?.content).toContain("Available tool");
  });

  it("keeps matching a ZH intent hint when it's mixed with EN text in the same message (raw-text ZH match)", () => {
    const withMessage = (content: string): BuiltContext => ({
      ...context,
      recentMessages: [{ id: "m1", role: "user", content }],
    });

    expect(shouldPlanImageTool(withMessage("SEND ME 一张自拍 please"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("Hey, 给我一张坐在窗边的照片 thanks"))).toBe(true);
  });

  it("parseCall returns a discriminated plan for valid args, and null for invalid args, without throwing", () => {
    const tool = findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)!;

    const plan = tool.parseCall({
      prompt: "Realistic photo of Melissa at a sunlit window, soft light, portrait framing",
      caption: "coming right up",
      orientation: "4:5",
      outputCount: 1,
    });
    expect(plan).toEqual({
      tool: GENERATE_IMAGE_ASYNC_TOOL,
      args: {
        prompt: "Realistic photo of Melissa at a sunlit window, soft light, portrait framing",
        caption: "coming right up",
        orientation: "4:5",
        outputCount: 1,
      },
    });

    expect(tool.parseCall({ prompt: "too short" })).toBeNull();
    expect(tool.parseCall("not an object")).toBeNull();
    expect(tool.parseCall(undefined)).toBeNull();
  });
});

describe("edit_last_image tool", () => {
  it("produces a valid JSON Schema requiring instruction only", () => {
    const tool = findAgentTool(EDIT_LAST_IMAGE_TOOL)!;
    const chatTool = tool.toChatTool();
    expect(chatTool.name).toBe(EDIT_LAST_IMAGE_TOOL);
    expect(chatTool.description).toContain("identity");
    expect(chatTool.parameters).toMatchObject({ type: "object", required: ["instruction"] });
    const properties = (chatTool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties)).toEqual(expect.arrayContaining(["instruction", "caption"]));
  });

  it("parseCall validates instruction length and returns a discriminated plan", () => {
    const tool = findAgentTool(EDIT_LAST_IMAGE_TOOL)!;

    const plan = tool.parseCall({
      instruction: "change the background to snowy mountains",
      caption: "one sec!",
    });
    expect(plan).toEqual({
      tool: EDIT_LAST_IMAGE_TOOL,
      args: { instruction: "change the background to snowy mountains", caption: "one sec!" },
    });

    expect(tool.parseCall({ instruction: "hi" })).toBeNull(); // below min(4)
    expect(tool.parseCall({})).toBeNull();
    expect(tool.parseCall("not an object")).toBeNull();
  });

  it("matches ZH edit-intent phrasing (改/换/变成/把...照片/背景换/重P)", () => {
    const withMessage = (content: string): BuiltContext => ({
      ...context,
      recentMessages: [{ id: "m1", role: "user", content }],
    });

    expect(shouldPlanImageTool(withMessage("把刚才那张照片改成雪山背景"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("换个背景"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("背景换成沙滩"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("重新P一下这张图"))).toBe(true);
  });

  it("matches EN edit-intent phrasing (edit/change/redo/make it/turn it into + photo/picture/image/background/that)", () => {
    const withMessage = (content: string): BuiltContext => ({
      ...context,
      recentMessages: [{ id: "m1", role: "user", content }],
    });

    expect(shouldPlanImageTool(withMessage("can you change the background in that photo"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("edit that picture please"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("turn that photo into a snowy scene"))).toBe(true);
    expect(shouldPlanImageTool(withMessage("how are you today"))).toBe(false);
  });

  it("planner path: parseAgentToolPlan resolves an edit_last_image tool call via the registry", () => {
    const plan = parseAgentToolPlan(JSON.stringify({
      tool: {
        name: EDIT_LAST_IMAGE_TOOL,
        arguments: { instruction: "change the background to snowy mountains", caption: "coming right up" },
      },
    }));

    const toolCall = plan.toolCall;
    expect(toolCall?.name).toBe(EDIT_LAST_IMAGE_TOOL);
    if (toolCall?.name !== EDIT_LAST_IMAGE_TOOL) throw new Error("expected edit_last_image");
    expect(toolCall.arguments.instruction).toContain("snowy mountains");
    expect(toolCall.arguments.caption).toBe("coming right up");
  });

  it("buildToolPlannerMessages lists edit_last_image and its arguments.instruction guidance", () => {
    const messages = buildToolPlannerMessages(context);
    expect(messages[0]?.content).toContain(EDIT_LAST_IMAGE_TOOL);
    expect(messages[0]?.content).toContain("arguments.instruction");
  });
});
