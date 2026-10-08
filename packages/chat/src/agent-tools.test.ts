import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_REGISTRY,
  EDIT_LAST_IMAGE_TOOL,
  findAgentTool,
  GENERATE_IMAGE_ASYNC_TOOL,
  registryChatTools,
} from "./agent-tools.js";

describe("DSH image tool registry", () => {
  it("requires an explicit image subject and preserves a scene without a companion", () => {
    const prompt = "A still life of a basil plant in a terracotta pot on a sunny balcony. No people visible.";
    expect(findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)?.parseCall({ prompt, subject: "scene" })).toMatchObject({
      name: GENERATE_IMAGE_ASYNC_TOOL, arguments: { prompt, subject: "scene" },
    });
    expect(findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)?.parseCall({ prompt })).toBeNull();
    expect(findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)?.parseCall({ prompt, subject: "unknown" })).toBeNull();
  });

  it("exposes only the Chat-owned image bridge schemas", () => {
    expect(AGENT_TOOL_REGISTRY.map((tool) => tool.name)).toEqual([
      GENERATE_IMAGE_ASYNC_TOOL,
      EDIT_LAST_IMAGE_TOOL,
    ]);
    expect(registryChatTools()).toEqual([
      expect.objectContaining({
        name: GENERATE_IMAGE_ASYNC_TOOL,
        parameters: expect.objectContaining({ required: ["prompt", "subject"] }),
      }),
      expect.objectContaining({
        name: EDIT_LAST_IMAGE_TOOL,
        parameters: expect.objectContaining({ required: ["instruction"] }),
      }),
    ]);
  });

  it("validates generated-image calls without a second planner", () => {
    expect(findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)?.parseCall({
      prompt: "A detailed portrait beside a sunlit window",
      subject: "companion",
    })).toEqual({
      name: GENERATE_IMAGE_ASYNC_TOOL,
      arguments: {
        prompt: "A detailed portrait beside a sunlit window",
        subject: "companion",
        orientation: "4:5",
        outputCount: 1,
      },
    });
    expect(findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)?.parseCall({ prompt: "short" }))
      .toBeNull();
  });

  it("validates edit calls and rejects unknown tools", () => {
    expect(findAgentTool(EDIT_LAST_IMAGE_TOOL)?.parseCall({
      instruction: "Change the background to snow",
    })).toEqual({
      name: EDIT_LAST_IMAGE_TOOL,
      arguments: { instruction: "Change the background to snow" },
    });
    expect(findAgentTool(EDIT_LAST_IMAGE_TOOL)?.parseCall({ instruction: "x" }))
      .toBeNull();
    expect(findAgentTool("unknown_tool")).toBeUndefined();
  });

  it("preserves Agent-authored wardrobe intent and validates its enum", () => {
    const args = { prompt: "A fully clothed portrait in a red robe", subject: "companion", requestedNudity: "none" };
    expect(findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)?.parseCall(args)?.arguments).toMatchObject({ requestedNudity: "none" });
    expect(findAgentTool(GENERATE_IMAGE_ASYNC_TOOL)?.parseCall({ ...args, requestedNudity: "unknown" })).toBeNull();
  });
});
