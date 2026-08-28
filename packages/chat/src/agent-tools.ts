import {
  EDIT_LAST_IMAGE_TOOL,
  editLastImageArgsSchema,
  GENERATE_IMAGE_ASYNC_TOOL,
  generateImageAsyncArgsSchema,
  IMAGE_AGENT_TOOL_DEFINITIONS,
  imageIntentForUserRequest,
  parseImageAgentToolCall,
  requiredImageToolCallForUserRequest,
  type EditLastImageArgs,
  type EditLastImageToolCall,
  type GenerateImageAsyncArgs,
  type GenerateImageAsyncToolCall,
  type ImageAgentToolCall,
  type ImageIntentDecision,
} from "@idream/shared/chat/image-action";
import type { ChatToolDefinition } from "@idream/shared";

export {
  EDIT_LAST_IMAGE_TOOL,
  editLastImageArgsSchema,
  GENERATE_IMAGE_ASYNC_TOOL,
  generateImageAsyncArgsSchema,
  imageIntentForUserRequest,
  requiredImageToolCallForUserRequest,
};
export type {
  EditLastImageArgs,
  EditLastImageToolCall,
  GenerateImageAsyncArgs,
  GenerateImageAsyncToolCall,
  ImageAgentToolCall,
  ImageIntentDecision,
};

// Chat keeps only the execution adapter. Names, schemas, descriptions and
// deterministic action routing are cross-service product contracts in shared.
export type AgentTool = {
  name: string;
  description: string;
  toChatTool(): ChatToolDefinition;
  parseCall(rawArgs: unknown): ImageAgentToolCall | null;
};

export const AGENT_TOOL_REGISTRY: AgentTool[] = IMAGE_AGENT_TOOL_DEFINITIONS.map(
  (definition) => ({
    name: definition.name,
    description: definition.description,
    toChatTool: () => definition,
    parseCall: (rawArguments) => parseImageAgentToolCall(definition.name, rawArguments),
  }),
);

export function findAgentTool(name: string): AgentTool | undefined {
  return AGENT_TOOL_REGISTRY.find((tool) => tool.name === name);
}

export function registryChatTools(): ChatToolDefinition[] {
  return AGENT_TOOL_REGISTRY.map((tool) => tool.toChatTool());
}

export function imageToolCaption(
  toolCall: ImageAgentToolCall,
  characterName: string,
): string {
  const caption = toolCall.arguments.caption?.trim();
  if (caption) return caption;
  return `${characterName || "I"} will make that image for you now.`;
}
