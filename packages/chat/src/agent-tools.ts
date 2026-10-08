import {
  EDIT_LAST_IMAGE_TOOL,
  editLastImageArgsSchema,
  GENERATE_IMAGE_ASYNC_TOOL,
  generateImageAsyncArgsSchema,
  IMAGE_AGENT_TOOL_DEFINITIONS,
  parseImageAgentToolCall,
  type EditLastImageArgs,
  type EditLastImageToolCall,
  type GenerateImageAsyncArgs,
  type GenerateImageAsyncToolCall,
  type ImageAgentToolCall,
} from "@idream/shared/chat/image-action";
import type { ChatToolDefinition } from "@idream/shared";

export {
  EDIT_LAST_IMAGE_TOOL,
  editLastImageArgsSchema,
  GENERATE_IMAGE_ASYNC_TOOL,
  generateImageAsyncArgsSchema,
};
export type {
  EditLastImageArgs,
  EditLastImageToolCall,
  GenerateImageAsyncArgs,
  GenerateImageAsyncToolCall,
  ImageAgentToolCall,
};

// Chat keeps only the execution adapter. Names, schemas, descriptions and
// argument validation are cross-service product contracts in shared.
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
