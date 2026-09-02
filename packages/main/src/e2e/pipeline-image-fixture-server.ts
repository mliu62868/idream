import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

function portFromArgs() {
  const index = process.argv.indexOf("--port");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("pipeline image fixture requires --port <1-65535>");
  }
  return port;
}

async function requestJson(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) as Record<string, unknown> : {};
}

// INTENT: this fixture exercises the Gen-owned execution adapter. Main must not
// grow a second image provider registry just to support Playwright.
const genProviderModulePath = new URL("../../../gen/src/providers.ts", import.meta.url).href;
const { createMockGenProviders } = await import(genProviderModulePath) as {
  createMockGenProviders(): {
    image: {
      generate(input: {
        prompt: string;
        count: number;
        seed?: string;
        requestId?: string;
      }): Promise<{
        ok: true;
        data: {
          assets: Array<{ key?: string; body?: Uint8Array }>;
        };
      }>;
    };
  };
};
const imageModel = createMockGenProviders().image;

function fixtureChatMessage(body: Record<string, unknown>) {
  const choice = body.tool_choice as { function?: { name?: string } } | undefined;
  const name = choice?.function?.name;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const offered = tools.some(tool => tool?.function?.name === name);
  // Test only the real native-call seam: offered tools alone never authorize a
  // paid action, and the conversational step after a tool must not call again.
  if (offered && (name === "generate_image_async" || name === "edit_last_image")) {
    return {
      role: "assistant", content: null,
      tool_calls: [{ id: `call_${randomUUID()}`, type: "function", function: {
        name,
        arguments: JSON.stringify(name === "generate_image_async"
          ? { prompt: "An adult companion smiling beside a rain-streaked cafe window.", outputCount: 1, orientation: "4:5" }
          : { instruction: "Keep the companion's identity and move the portrait beside a rainy cafe window.", outputCount: 1, orientation: "4:5" }),
      } }],
    };
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = messages.filter(message => message?.role === "system")
    .map(message => typeof message.content === "string" ? message.content : "").join("\n");
  // The official igrep maintenance protocol is plain text, not JSON: no
  // profile observations => NONE; no reconciliation changes => empty output.
  const content = system.includes("You are Dream, the only writer")
    ? ""
    : system.includes("Extract core user-profile observations") || system.includes("Extract changes in the user's standing state")
      ? "NONE"
      : messages.some(message => message?.role === "tool")
        ? "Your image request is on its way. We can keep chatting while it finishes."
        : "It's good to hear from you. Tell me more about your day.";
  return { role: "assistant", content };
}

export const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, provider: "pipeline-fixture" }));
    return;
  }
  if (request.method !== "POST" || !["/images/generations", "/v1/chat/completions"].includes(url.pathname)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Not found" } }));
    return;
  }
  try {
    const body = await requestJson(request);
    if (url.pathname === "/v1/chat/completions") {
      const message = fixtureChatMessage(body);
      const toolCalls = message.tool_calls;
      const finishReason = toolCalls ? "tool_calls" : "stop";
      const id = `chatcmpl_${randomUUID()}`;
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      if (body.stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const delta = toolCalls
          ? { ...message, tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }
          : message;
        response.end(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }], usage })}\n\ndata: [DONE]\n\n`);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id, object: "chat.completion", model: body.model,
          choices: [{ index: 0, message, finish_reason: finishReason }], usage }));
      }
      return;
    }
    const requestedCount = Number(body.n ?? body.count ?? 1);
    const result = await imageModel.generate({
      prompt: typeof body.prompt === "string" ? body.prompt : "Playwright portrait",
      count: Number.isInteger(requestedCount) ? requestedCount : 1,
      seed: body.seed === undefined ? undefined : String(body.seed),
      requestId: typeof body.requestId === "string" ? body.requestId : undefined,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      data: result.data.assets.map((asset) => ({
        key: asset.key,
        b64_json: Buffer.from(asset.body ?? []).toString("base64"),
      })),
    }));
  } catch (error) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: {
        message: error instanceof Error ? error.message : "Invalid fixture request",
      },
    }));
  }
});

if (import.meta.main) {
  server.listen(portFromArgs(), "127.0.0.1");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
