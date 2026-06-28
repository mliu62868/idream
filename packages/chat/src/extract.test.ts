import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveCandidates, extractCandidates } from "./extract.js";

let dir: string;
const SRC = "msg_user_1";
const BASE = { sourceMessageId: SRC, userId: "u1", characterId: "c1" };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "extract-"));
  delete process.env.CHAT_MEMORY_EXTRACT;
  delete process.env.IGREP_BIN;
  delete process.env.CHAT_MEMORY_EXTRACT_TIMEOUT_MS;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.CHAT_MEMORY_EXTRACT;
  delete process.env.IGREP_BIN;
  delete process.env.CHAT_MEMORY_EXTRACT_TIMEOUT_MS;
});

/** Write an executable fake `igrep` that prints `stdout` (after an optional sleep). */
async function fakeIgrep(stdout: string, sleepSec = 0): Promise<string> {
  const bin = path.join(dir, "fake-igrep.sh");
  const body = stdout.replace(/'/g, "'\\''");
  await writeFile(bin, `#!/bin/sh\n${sleepSec ? `sleep ${sleepSec}\n` : ""}printf '%s' '${body}'\n`, "utf8");
  await chmod(bin, 0o755);
  return bin;
}

/** Shape a fake `igrep mem derive --dry-run` JSON payload. */
function deriveJson(
  observations: Array<{ kind: string; content: string; confidence?: number }>,
  succeeded = observations.length,
): string {
  return JSON.stringify({
    provider: "igrep",
    action: "derive",
    observations: observations.map((o) => ({ level: "explicit", source_role: "user", ...o })),
    llmExtraction: { enabled: true, succeeded },
  });
}

describe("deriveCandidates (deterministic regex floor)", () => {
  it("extracts nickname, like and boundary (EN)", () => {
    const c = deriveCandidates("Call me Mei. I like jazz. Don't talk about work.", SRC);
    expect(c.map((x) => x.type).sort()).toEqual(["boundary", "preference", "preference"]);
    expect(c.find((x) => x.type === "boundary")?.scope).toBe("global");
    expect(c.every((x) => x.sourceMessageIds[0] === SRC)).toBe(true);
  });
});

describe("extractCandidates: heuristic mode (default)", () => {
  it("uses the regex extractor when CHAT_MEMORY_EXTRACT is unset", async () => {
    const c = await extractCandidates({ ...BASE, userText: "Call me Mei. I like jazz." });
    expect(c.map((x) => x.text)).toEqual(["User likes being called Mei.", "User likes jazz."]);
  });
});

describe("extractCandidates: igrep mode", () => {
  it("maps granular LLM observations to candidates (preference + user_fact)", async () => {
    process.env.CHAT_MEMORY_EXTRACT = "igrep";
    process.env.IGREP_BIN = await fakeIgrep(
      deriveJson([
        { kind: "preference", content: "User loves late-night horror movies.", confidence: 0.82 },
        { kind: "entity", content: "User is a nurse in Seattle.", confidence: 0.7 },
      ]),
    );
    const c = await extractCandidates({ ...BASE, userText: "I love late-night horror and I'm a nurse in Seattle." });
    expect(c).toEqual([
      { scope: "character", type: "preference", text: "User loves late-night horror movies.", confidence: 0.82, sourceMessageIds: [SRC] },
      { scope: "character", type: "user_fact", text: "User is a nurse in Seattle.", confidence: 0.7, sourceMessageIds: [SRC] },
    ]);
  });

  it("ALWAYS keeps the regex boundary even when igrep surfaces none (safety floor)", async () => {
    process.env.CHAT_MEMORY_EXTRACT = "igrep";
    process.env.IGREP_BIN = await fakeIgrep(
      deriveJson([{ kind: "preference", content: "User loves horror movies.", confidence: 0.8 }]),
    );
    const c = await extractCandidates({ ...BASE, userText: "I love horror. Don't talk about my ex." });
    const boundary = c.find((x) => x.type === "boundary");
    expect(boundary).toBeDefined();
    expect(boundary?.scope).toBe("global");
    expect(c.some((x) => x.type === "preference" && x.text === "User loves horror movies.")).toBe(true);
  });

  it("drops degenerate junk observations from a weak model, keeps the real one", async () => {
    process.env.CHAT_MEMORY_EXTRACT = "igrep";
    process.env.IGREP_BIN = await fakeIgrep(
      deriveJson([
        { kind: "action", content: "...", confidence: 0 },
        { kind: "preference", content: "User loves hiking on weekends.", confidence: 0.71 },
      ]),
    );
    const c = await extractCandidates({ ...BASE, userText: "I hike every weekend." });
    expect(c.map((x) => x.text)).toEqual(["User loves hiking on weekends."]);
  });

  it("ignores the deterministic whole-turn echo and falls back to regex", async () => {
    process.env.CHAT_MEMORY_EXTRACT = "igrep";
    const userText = "Call me Mei. I like jazz.";
    // igrep's deterministic (no-LLM) path echoes the whole turn as ONE observation.
    process.env.IGREP_BIN = await fakeIgrep(deriveJson([{ kind: "preference", content: userText, confidence: 0.78 }], 0));
    const c = await extractCandidates({ ...BASE, userText });
    // echo dropped → regex floor owns the result
    expect(c.map((x) => x.text)).toEqual(["User likes being called Mei.", "User likes jazz."]);
  });

  it("igrep timeout → full regex fallback", async () => {
    process.env.CHAT_MEMORY_EXTRACT = "igrep";
    process.env.CHAT_MEMORY_EXTRACT_TIMEOUT_MS = "150";
    process.env.IGREP_BIN = await fakeIgrep(deriveJson([{ kind: "preference", content: "x", confidence: 0.9 }]), 2);
    const c = await extractCandidates({ ...BASE, userText: "Call me Mei." });
    expect(c.map((x) => x.text)).toEqual(["User likes being called Mei."]);
  });

  it("igrep garbage / non-json → full regex fallback", async () => {
    process.env.CHAT_MEMORY_EXTRACT = "igrep";
    process.env.IGREP_BIN = await fakeIgrep("not json at all\n");
    const c = await extractCandidates({ ...BASE, userText: "I like jazz." });
    expect(c.map((x) => x.text)).toEqual(["User likes jazz."]);
  });

  it("igrep empty observations → full regex fallback", async () => {
    process.env.CHAT_MEMORY_EXTRACT = "igrep";
    process.env.IGREP_BIN = await fakeIgrep(deriveJson([]));
    const c = await extractCandidates({ ...BASE, userText: "I like jazz." });
    expect(c.map((x) => x.text)).toEqual(["User likes jazz."]);
  });
});
