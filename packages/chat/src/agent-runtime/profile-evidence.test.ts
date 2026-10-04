import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileLineKey } from "./resident-profile";
import {
  llmProfileClaimVerifier,
  readSupportedProfileLines,
  verifyProfileEvidence,
  type ProfileClaimVerifier,
} from "./profile-evidence";

// 样本取自 2026-10-04 审计的 b-1 × Sophie 关系：两条画像都引用用户的提问。
const fact = (value: string, quotes: string[], status = "active") => JSON.stringify({
  status,
  value,
  source_refs: quotes.map((quote) => ({ quote })),
});

describe("profile evidence gate", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "profile-evidence-"));
    await mkdir(join(root, "mem/bank/cards"), { recursive: true });
    await mkdir(join(root, "mem/.state"), { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const seed = (profile: string[], facts: string[]) => Promise.all([
    writeFile(join(root, "mem/bank/cards/profile.md"), ["# User Profile", "", ...profile.map((line) => `- ${line}`)].join("\n")),
    writeFile(join(root, "mem/.state/facts.jsonl"), `${facts.join("\n")}\n`),
  ]);

  it("keeps lines the user's own words support and records the rest as unsupported", async () => {
    await seed(
      ["The user's name is Sophie", "The user's name is Kai."],
      [
        fact("The user's name is Sophie", ["Hey, do you remember me? What's my name?"]),
        fact("The user's name is Kai", ["Okay let me correct you: my name is actually Kai"]),
      ],
    );
    const verify = vi.fn<ProfileClaimVerifier>(async (claim) => claim.includes("Kai"));
    await expect(verifyProfileEvidence(root, verify)).resolves.toEqual({ lines: 2, supported: 1, unverified: 0 });
    expect(verify).toHaveBeenCalledWith("The user's name is Sophie", ["Hey, do you remember me? What's my name?"], undefined);
    expect(await readSupportedProfileLines(root)).toEqual(new Set([profileLineKey("The user's name is Kai")]));
  });

  // INVARIANT: 判定按「行 + 引用」缓存；同一证据不重复调用模型，证据变了才重判。
  it("judges each line once per evidence", async () => {
    await seed(["Owns a cat named Pickles"], [fact("Owns a cat named Pickles", ["I have a cat called Pickles"])]);
    const verify = vi.fn<ProfileClaimVerifier>(async () => true);
    await verifyProfileEvidence(root, verify);
    await verifyProfileEvidence(root, verify);
    expect(verify).toHaveBeenCalledTimes(1);
    await writeFile(join(root, "mem/.state/facts.jsonl"), `${fact("Owns a cat named Pickles", ["I have a cat called Pickles", "Pickles is three"])}\n`);
    await verifyProfileEvidence(root, verify);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  // INVARIANT: fail closed —— 无事实、校验器不可用、预算用尽的行都不渲染。
  it("leaves lines without facts, without an answer, or past the budget unverified", async () => {
    await seed(
      ["Line without a fact", "Retracted line", "Verifier down"],
      [fact("Retracted line", ["I used to say this"], "retracted"), fact("Verifier down", ["I said so"])],
    );
    await expect(verifyProfileEvidence(root, async () => null)).resolves.toEqual({ lines: 3, supported: 0, unverified: 3 });
    expect(await readSupportedProfileLines(root)).toEqual(new Set());

    const verify = vi.fn<ProfileClaimVerifier>(async () => true);
    await expect(verifyProfileEvidence(root, verify, undefined, 0)).resolves.toMatchObject({ supported: 0, unverified: 3 });
    expect(verify).not.toHaveBeenCalled();
  });

  it("treats a workspace that was never verified as having no supported lines", async () => {
    expect(await readSupportedProfileLines(root)).toEqual(new Set());
  });

  it("sends only the user's quotes to the verifier model and reads its one-word verdict", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      expect(body.messages[1]!.content).toBe("The person's own words:\n- What's my name?\n\nClaim: The user's name is Sophie");
      return new Response(JSON.stringify({ choices: [{ message: { content: "UNSUPPORTED" } }] }));
    });
    const verify = llmProfileClaimVerifier({ url: "http://model.test/v1/", model: "m", apiKey: "k" }, fetchImpl as typeof fetch);
    await expect(verify("The user's name is Sophie", ["What's my name?"])).resolves.toBe(false);
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://model.test/v1/chat/completions");

    const sent: string[] = [];
    const capped = llmProfileClaimVerifier({ url: "http://model.test/v1", model: "m", apiKey: "k" },
      (async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push((JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[1]!.content);
        return new Response(JSON.stringify({ choices: [{ message: { content: "SUPPORTED" } }] }));
      }) as typeof fetch);
    await capped("Runs every morning", Array.from({ length: 20 }, (_, i) => `run ${i} ${"x".repeat(5_000)}`));
    expect(sent[0]!.match(/^- run/gmu)).toHaveLength(8);
    expect(sent[0]).toContain("- run 19 ");
    expect(sent[0]!.length).toBeLessThan(8 * 1_300);

    const garbled = llmProfileClaimVerifier({ url: "http://model.test/v1", model: "m", apiKey: "k" },
      (async () => new Response(JSON.stringify({ choices: [{ message: { content: "maybe" } }] }))) as typeof fetch);
    await expect(garbled("x", ["y"])).resolves.toBeNull();
  });
});
