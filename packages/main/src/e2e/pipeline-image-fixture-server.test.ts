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

it.each([false, true])("returns explicit empty Scene facts without claiming semantic extraction (stream=%s)", async stream => {
  const response = await completion({ stream, response_format: { type: "json_schema", json_schema: { name: "scene_changes" } },
    messages: [{ role: "user", content: JSON.stringify({ text: "We are in a greenhouse. We need to water the basil." }) }],
  });
  expect(response.status).toBe(200);
  const event = stream ? JSON.parse((await response.text()).split("\n")[0]!.slice(6)) : await response.json();
  const message = stream ? event.choices[0].delta : event.choices[0].message;
  expect(JSON.parse(message.content)).toEqual({ location: [], time: [], participant_present: [], participant_absent: [], emotionalBeat: [], thread_unfinished: [], thread_completed: [] });
  expect(event.choices[0].finish_reason).toBe("stop");
  expect(message.tool_calls).toBeUndefined();
});

it.each([
  { known: ["water the basil"], candidates: [], expected: { known: ["pending"], candidates: [], bindings: [] } },
  { known: ["water the basil"], candidates: ["water basil"], expected: { known: ["pending"], candidates: ["uncertain"], bindings: [null] } },
  { known: ["water the basil"], candidates: ["water the basil"], expected: { known: ["uncertain"], candidates: ["uncertain"], bindings: [0] } },
  { known: Array.from({ length: 17 }, (_, index) => `task ${index}`), candidates: [], expected: { known: Array(17).fill("pending"), candidates: [], bindings: [] } },
  { known: Array.from({ length: 17 }, (_, index) => `task ${index}`), candidates: ["task 16"], expected: { known: [...Array(16).fill("pending"), "uncertain"], candidates: ["uncertain"], bindings: [16] } },
])("keeps fixture task decisions conservative for $candidates", async ({ known, candidates, expected }) => {
  const response = await completion({ response_format: { type: "json_schema", json_schema: { name: "scene_task_decisions" } },
    messages: [{ role: "user", content: JSON.stringify({ text: "I finished watering basil.", known, candidates }) }],
  });
  expect(response.status).toBe(200);
  const event = await response.json();
  expect(JSON.parse(event.choices[0].message.content)).toEqual(expected);
  expect(event.choices[0].finish_reason).toBe("stop");
});

it.each([
  { text: "source", known: "water the basil", candidates: [] },
  { text: "source", known: [], candidates: [7] },
  { text: "source", known: [], candidates: Array.from({ length: 17 }, (_, index) => `task ${index}`) },
])("rejects malformed Scene decision input instead of falling back to chat", async payload => {
  const response = await completion({ response_format: { type: "json_schema", json_schema: { name: "scene_task_decisions" } }, messages: [{ role: "user", content: JSON.stringify(payload) }] });
  expect(response.status).toBe(400);
  expect((await response.json()).error.message).toBe("Invalid Scene decision fixture input");
});
