import type { ChatChunk, ChatModel } from "../types";

export class MockChatModel implements ChatModel {
  async *stream(input: Parameters<ChatModel["stream"]>[0]): AsyncIterable<ChatChunk> {
    const lastUserMessage =
      [...input.messages].reverse().find((message) => message.role === "user")?.content ??
      "";
    const response = `Mock ${input.characterName ?? "character"} reply: ${lastUserMessage}`.trim();

    yield { delta: response, done: false };
    yield { delta: "", done: true };
  }
}
