import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GENERATION_PROFILE_RUNNERS } from "./runner-vocabulary";

// SPEC: `GenerationModelProfile.runner` has three independent copies of one
// vocabulary — the enum comment on schema.prisma's `runner` column, the
// GENERATION_PROFILE_RUNNERS constant that backs both admin zod enums, and the
// switch in gen's `workerAdapterForRecordedProvider`. Nothing but this guard stops
// them drifting apart.
// INTENT: drift here is silent. Main happily writes a runner gen cannot map, and
// the failure only surfaces as "Unsupported pinned generation provider" inside the
// worker, one dispatch at a time, after the profile is already live. That is how
// `sd_cpp` survived long after gen deleted its sd.cpp backend.
// INVARIANT: schema comment == constant as a SET (not "both mention sd_cpp"), gen
// maps every member, and no literal anywhere in main assigns a runner outside it.

const SCHEMA_PATH = path.join(process.cwd(), "prisma/schema.prisma");
const GEN_PIPELINE_URL = new URL(
  "../../../../../gen/src/pipeline.ts",
  import.meta.url,
).href;

// The adapters gen is willing to hand back. A runner that maps outside this set
// means the mapper grew a case the queue cannot route.
const GEN_ADAPTERS = ["mock", "backend", "pipeline"];

async function schemaRunnerLine() {
  const schema = await readFile(SCHEMA_PATH, "utf8");
  const line = schema
    .split("\n")
    .find((candidate) => /^\s*runner\s+String\s/.test(candidate));
  // Guard self-check: a renamed column or reflowed line must fail loudly here
  // rather than silently reduce every assertion below to a no-op.
  expect(line, "prisma/schema.prisma has no `runner String` column line").toBeTruthy();
  return line as string;
}

function parseEnumComment(line: string) {
  const match = /\/\/\s*enum:\s*([^\n]+)$/.exec(line);
  expect(match, `no \`// enum: ...\` comment on: ${line.trim()}`).toBeTruthy();
  const values = (match as RegExpExecArray)[1]
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);
  expect(values.length, "enum comment parsed to fewer than 2 values").toBeGreaterThan(1);
  return values;
}

async function loadGenAdapterMapper() {
  const genPipeline = (await import(GEN_PIPELINE_URL)) as {
    workerAdapterForRecordedProvider(provider: string): string;
  };
  expect(typeof genPipeline.workerAdapterForRecordedProvider).toBe("function");
  return genPipeline.workerAdapterForRecordedProvider;
}

async function productionAndTestSources(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(root, entry.name);
      if (entry.isDirectory()) return productionAndTestSources(filePath);
      return /\.tsx?$/.test(entry.name) ? [filePath] : [];
    }),
  );
  return nested.flat();
}

describe("GenerationModelProfile.runner vocabulary", () => {
  it("keeps the schema.prisma enum comment and GENERATION_PROFILE_RUNNERS the same set", async () => {
    const declared = parseEnumComment(await schemaRunnerLine());

    expect([...declared].sort()).toEqual([...GENERATION_PROFILE_RUNNERS].sort());
  });

  it("defaults the column to a runner inside the vocabulary", async () => {
    const line = await schemaRunnerLine();
    const match = /@default\("([^"]+)"\)/.exec(line);
    expect(match, `no @default(...) on: ${line.trim()}`).toBeTruthy();

    expect(GENERATION_PROFILE_RUNNERS).toContain((match as RegExpExecArray)[1]);
  });

  it("lets gen map every runner in the vocabulary to a real adapter", async () => {
    const workerAdapterForRecordedProvider = await loadGenAdapterMapper();
    const declared = parseEnumComment(await schemaRunnerLine());

    const mapped = Object.fromEntries(
      declared.map((runner) => [runner, workerAdapterForRecordedProvider(runner)]),
    );

    expect(Object.keys(mapped).sort()).toEqual([...declared].sort());
    for (const [runner, adapter] of Object.entries(mapped)) {
      expect(GEN_ADAPTERS, `${runner} mapped to an unknown adapter`).toContain(adapter);
    }
  });

  it("still rejects a runner outside the vocabulary", async () => {
    // Guard self-check: without this, "gen maps every runner" would also pass
    // against a mapper that returned a default for anything at all.
    const workerAdapterForRecordedProvider = await loadGenAdapterMapper();
    const retired = ["sd", "cpp"].join("_");

    expect(GENERATION_PROFILE_RUNNERS).not.toContain(retired);
    expect(() => workerAdapterForRecordedProvider(retired)).toThrow(
      /Unsupported pinned generation provider/,
    );
  });

  it("never assigns a runner literal outside the vocabulary anywhere in main", async () => {
    const roots = [path.join(process.cwd(), "src"), path.join(process.cwd(), "prisma")];
    const files = (await Promise.all(roots.map(productionAndTestSources))).flat();
    expect(files.length, "source scan found no files").toBeGreaterThan(100);

    const offenders: string[] = [];
    let literalCount = 0;
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(/\brunner:\s*"([^"]*)"/g)) {
        literalCount += 1;
        if (!(GENERATION_PROFILE_RUNNERS as readonly string[]).includes(match[1])) {
          offenders.push(`${path.relative(process.cwd(), file)} assigns ${match[1]}`);
        }
      }
    }

    // Guard self-check: the repo is full of `runner: "comfyui"`. Zero matches
    // would mean the pattern stopped matching, not that the repo got clean.
    expect(literalCount, "runner literal scan matched nothing").toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
