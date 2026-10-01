const path = require("node:path");
const { pathToFileURL } = require("node:url");

// INTENT: PM2's Bun container requires its entrypoint. Chat's ESM bootstrap
// awaits runtime initialization, so it must be imported rather than required.
const entry = process.argv[2];
if (entry !== "src/main.ts" && entry !== "dist/main.js") {
  throw new Error("Chat entry must be src/main.ts or dist/main.js");
}
import(pathToFileURL(path.resolve(__dirname, "../packages/chat", entry)).href)
  .catch((error) => { console.error(error); process.exit(1); });
