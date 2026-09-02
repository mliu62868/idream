import { once } from "node:events";
import { afterAll, beforeAll, expect, it } from "vitest";
import { server } from "./pipeline-image-fixture-server";

let base: string;
beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

async function completion(body: Record<string, unknown>) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

it("returns real OpenAI SSE and a single required native image call before a conversational reply", async () => {
  const tools = [{ type: "function", function: { name: "generate_image_async" } }];
  const first = await completion({ model: "playwright-chat", stream: true, tools,
    tool_choice: { type: "function", function: { name: "generate_image_async" } },
    messages: [{ role: "user", content: "Send a portrait." }],
  });
  expect(first.headers.get("content-type")).toBe("text/event-stream");
  const stream = await first.text();
  expect(stream).toContain("data: [DONE]");
  const event = JSON.parse(stream.split("\n")[0]!.slice(6));
  expect(event.choices[0]).toMatchObject({ finish_reason: "tool_calls", delta: {
    tool_calls: [{ index: 0, type: "function", function: { name: "generate_image_async" } }],
  } });
  expect(JSON.parse(event.choices[0].delta.tool_calls[0].function.arguments)).toMatchObject({ outputCount: 1, orientation: "4:5" });
  const followup = await completion({ stream: true, tools, tool_choice: "auto", messages: [{ role: "tool", content: "accepted" }] });
  const finished = await followup.text();
  expect(finished).toContain('"finish_reason":"stop"');
  expect(finished).not.toContain('"tool_calls"');
});

it("does not invent image actions from an offered tool or an unoffered forced name", async () => {
  for (const body of [
    { tools: [{ function: { name: "generate_image_async" } }], tool_choice: "auto" },
    { tools: [], tool_choice: { function: { name: "generate_image_async" } } },
  ]) {
    const response = await completion({ ...body, messages: [{ role: "user", content: "What would you photograph?" }] });
    expect((await response.json()).choices[0]).toMatchObject({ finish_reason: "stop" });
  }
});

it("speaks the official igrep non-stream profile-maintenance protocol", async () => {
  for (const [system, content] of [
    ["Extract core user-profile observations from target user messages only.", "NONE"],
    ["Extract changes in the user's standing state from target user messages.", "NONE"],
    ["You are Dream, the only writer of the current user profile.", ""],
  ]) {
    const response = await completion({ stream: false, messages: [{ role: "system", content: system }] });
    expect((await response.json()).choices[0]).toMatchObject({ message: { role: "assistant", content }, finish_reason: "stop" });
  }
});
