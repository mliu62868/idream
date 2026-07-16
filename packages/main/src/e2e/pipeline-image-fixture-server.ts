import { createServer } from "node:http";
import { MockImageModel } from "@/server/providers/image/mock";

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

const imageModel = new MockImageModel();
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, provider: "pipeline-fixture" }));
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/images/generations") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Not found" } }));
    return;
  }
  try {
    const body = await requestJson(request);
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

server.listen(portFromArgs(), "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
