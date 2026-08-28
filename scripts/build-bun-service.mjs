#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharedRoot = path.join(repoRoot, "packages/shared");
const sharedPackage = JSON.parse(
  await readFile(path.join(sharedRoot, "package.json"), "utf8"),
);

function parseArguments(argv) {
  const entrypoints = [];
  let outdir = "dist";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--outdir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--outdir requires a path");
      outdir = value;
      index += 1;
      continue;
    }
    entrypoints.push(argument);
  }
  if (entrypoints.length === 0) {
    throw new Error("Usage: bun scripts/build-bun-service.mjs [--outdir <path>] <entrypoint...>");
  }
  return {
    entrypoints: entrypoints.map((entrypoint) => path.resolve(process.cwd(), entrypoint)),
    outdir: path.resolve(process.cwd(), outdir),
  };
}

function sharedExportPath(specifier) {
  const subpath = specifier === "@idream/shared"
    ? "."
    : `.${specifier.slice("@idream/shared".length)}`;
  const target = sharedPackage.exports?.[subpath];
  if (typeof target !== "string" || !target.startsWith("./")) {
    throw new Error(`Unknown @idream/shared export: ${specifier}`);
  }
  return path.resolve(sharedRoot, target);
}

const { entrypoints, outdir } = parseArguments(process.argv.slice(2));
const result = await Bun.build({
  entrypoints,
  outdir,
  target: "bun",
  packages: "external",
  sourcemap: "external",
  plugins: [{
    name: "inline-idream-shared",
    setup(build) {
      build.onResolve({ filter: /^@idream\/shared(?:\/.*)?$/ }, ({ path: specifier }) => ({
        path: sharedExportPath(specifier),
      }));
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
