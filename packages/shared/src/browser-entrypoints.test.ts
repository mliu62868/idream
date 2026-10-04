import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("bundles browser contracts and authoring renderers without Node built-ins", () => {
  const entrypoints = ["contracts/index.ts", "chat/persona-render.ts", "admin/index.ts"]
    .map((path) => fileURLToPath(new URL(path, import.meta.url)));
  // Bun can polyfill built-ins; reject them explicitly so this also protects
  // Next's webpack client graph, which cannot load node:crypto.
  const result = spawnSync("bun", ["-e", `
    const builtins = new Set(${JSON.stringify(builtinModules)});
    const result = await Bun.build({
      entrypoints: ${JSON.stringify(entrypoints)},
      target: "browser",
      write: false,
      plugins: [{ name: "browser-boundary", setup(build) {
        build.onResolve({ filter: /.*/ }, ({ path }) => {
          if (path.startsWith("node:") || builtins.has(path)) {
            throw new Error("Browser entry point imports Node built-in: " + path);
          }
        });
      }}],
    });
    if (!result.success) {
      console.error(result.logs.map(String).join("\\n"));
      process.exit(1);
    }
  `], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
