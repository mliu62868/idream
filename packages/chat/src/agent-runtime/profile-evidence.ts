import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IgrepLlmConfig } from "./config";
import { profileLineKey, residentProfileFacts } from "./resident-profile";
import { logger } from "../logger";

/**
 * SPEC: after every maintain pass, check each user-profile line against the
 * user's own words alone and record which lines they actually support. Wake
 * renders only supported lines.
 *
 * INTENT: igrep's extractor reads the whole dialogue and its contract says
 * assistant rows are "interpretation context, never fact authority". In a
 * roleplay the Character constantly asserts things about the user in fiction
 * ("Your name's Marcus, right?"), and the maintenance model followed those
 * assertions: the 2026-10-04 user-view audit found 4 of 5 relationships with
 * false "user facts" — the Character's own name stored as the user's, the
 * Character's favourite season stored as the user's — all cited to user
 * questions such as "What's my name?". Rebuilding the same 22 relationships
 * with the 35B model still produced Character-derived lines, so a stronger
 * extractor is not the fix. The facts already carry their user-authored source
 * quotes; a question with no Character text beside it cannot imply an answer,
 * so a narrow entailment check on quote → claim removes exactly this class.
 *
 * INVARIANT: fail closed. A line without a matching fact, without a verdict,
 * or whose verifier call failed is not rendered. A missing fact only costs the
 * resident profile one line; dialogue recall still finds what the user said.
 * The check never runs on the reply path: Main projects memory after the Turn
 * commits, and the verdict file travels with the published projection.
 */

export const PROFILE_EVIDENCE_FILE = "idream-profile-evidence.json";

const VERIFIER_SYSTEM = [
  "You check memory claims about a person against that person's own words.",
  "The quotes are messages the person typed to an AI roleplay character; nothing the character said is included.",
  "Answer SUPPORTED only if the quotes themselves state or directly imply the claim about the person who wrote them.",
  "Questions, requests, and names of the characters they address are not evidence about the writer.",
  "Answer with exactly one word: SUPPORTED or UNSUPPORTED.",
].join(" ");

const VERIFIER_TIMEOUT_MS = 30_000;
// The rebuild budget leaves ~70 s past the 300 s maintain; lines left over keep
// their absence of a verdict and are judged by the next projection.
const VERIFY_BUDGET_MS = 60_000;
// A recurring fact can cite dozens of long messages. The newest few carry the
// claim; an unbounded prompt would only spend the budget above.
const MAX_QUOTES = 8;
const MAX_QUOTE_CHARS = 1_200;

interface EvidenceFile {
  schema: 1;
  /** profileLineKey(line) → digest of the claim and quotes it was judged on. */
  lines: Record<string, { evidence: string; supported: boolean }>;
}

interface FactRow {
  status?: unknown;
  value?: unknown;
  source_refs?: Array<{ quote?: unknown }>;
}

function evidencePath(igrepRoot: string): string {
  return join(igrepRoot, PROFILE_EVIDENCE_FILE);
}

async function readEvidence(igrepRoot: string): Promise<EvidenceFile["lines"]> {
  try {
    const parsed = JSON.parse(await readFile(evidencePath(igrepRoot), "utf8")) as Partial<EvidenceFile>;
    return parsed.schema === 1 && parsed.lines && typeof parsed.lines === "object" ? parsed.lines : {};
  } catch {
    return {};
  }
}

/** Lines of the current profile the user's own words support; empty when unverified. */
export async function readSupportedProfileLines(igrepRoot: string): Promise<Set<string>> {
  const lines = await readEvidence(igrepRoot);
  return new Set(Object.entries(lines).filter(([, verdict]) => verdict.supported).map(([key]) => key));
}

async function activeFactQuotes(igrepRoot: string): Promise<Map<string, string[]>> {
  const quotes = new Map<string, string[]>();
  let raw: string;
  try {
    raw = await readFile(join(igrepRoot, "mem/.state/facts.jsonl"), "utf8");
  } catch {
    return quotes;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: FactRow;
    try {
      row = JSON.parse(line) as FactRow;
    } catch {
      continue;
    }
    if (row.status !== "active" || typeof row.value !== "string") continue;
    const key = profileLineKey(row.value);
    const known = quotes.get(key) ?? [];
    for (const ref of row.source_refs ?? []) {
      if (typeof ref.quote === "string" && ref.quote.trim() && !known.includes(ref.quote)) known.push(ref.quote);
    }
    quotes.set(key, known);
  }
  return quotes;
}

export type ProfileClaimVerifier = (claim: string, quotes: string[], signal?: AbortSignal) => Promise<boolean | null>;

/** null means the verifier could not answer; the caller then leaves the line unverified. */
export function llmProfileClaimVerifier(
  config: IgrepLlmConfig,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): ProfileClaimVerifier {
  return async (claim, quotes, signal) => {
    const timeout = AbortSignal.timeout(VERIFIER_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${config.url.replace(/\/$/u, "")}/chat/completions`, {
        method: "POST",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          max_tokens: 8,
          chat_template_kwargs: { enable_thinking: false },
          messages: [
            { role: "system", content: VERIFIER_SYSTEM },
            {
              role: "user",
              content: `The person's own words:\n${quotes.slice(-MAX_QUOTES).map((quote) => `- ${quote.slice(0, MAX_QUOTE_CHARS)}`).join("\n")}\n\nClaim: ${claim}`,
            },
          ],
        }),
      });
      if (!response.ok) return null;
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const verdict = (payload.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
      if (verdict.startsWith("UNSUPPORTED")) return false;
      if (verdict.startsWith("SUPPORTED")) return true;
      return null;
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  };
}

/**
 * Judge every line of the freshly maintained profile. Verdicts are keyed by
 * the claim and its quotes, so an unchanged line is never sent twice and a
 * line whose evidence changed is judged again.
 */
export async function verifyProfileEvidence(
  igrepRoot: string,
  verify: ProfileClaimVerifier,
  signal?: AbortSignal,
  budgetMs = VERIFY_BUDGET_MS,
): Promise<{ lines: number; supported: number; unverified: number }> {
  const deadline = Date.now() + budgetMs;
  let profile = "";
  try {
    profile = await readFile(join(igrepRoot, "mem/bank/cards/profile.md"), "utf8");
  } catch {
    // No profile yet: nothing to render, nothing to verify.
  }
  const previous = await readEvidence(igrepRoot);
  const quotes = await activeFactQuotes(igrepRoot);
  const next: EvidenceFile["lines"] = {};
  let unverified = 0;
  const lines = residentProfileFacts(profile);
  for (const line of lines) {
    signal?.throwIfAborted();
    const key = profileLineKey(line);
    const evidence = quotes.get(key) ?? [];
    if (evidence.length === 0) {
      unverified += 1;
      continue;
    }
    const digest = createHash("sha256").update(JSON.stringify([key, evidence])).digest("hex");
    const cached = previous[key];
    if (cached?.evidence === digest) {
      next[key] = cached;
      continue;
    }
    const supported = Date.now() < deadline ? await verify(line, evidence, signal) : null;
    if (supported === null) {
      unverified += 1;
      continue;
    }
    next[key] = { evidence: digest, supported };
  }
  const file: EvidenceFile = { schema: 1, lines: next };
  const target = evidencePath(igrepRoot);
  await writeFile(`${target}.tmp`, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  await rename(`${target}.tmp`, target);
  const supported = Object.values(next).filter((verdict) => verdict.supported).length;
  if (unverified > 0) {
    logger.warn({ event: "companion_profile_evidence_unverified", lines: lines.length, unverified },
      "some profile lines could not be verified and stay hidden until the next projection");
  }
  return { lines: lines.length, supported, unverified };
}
