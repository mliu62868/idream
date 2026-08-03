import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { creatorLoadErrorMessage } from "./CreatorProfileClient";

function source(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

const COMPONENT_DIR = fileURLToPath(new URL(".", import.meta.url));
const LIB_DIR = fileURLToPath(new URL("../../lib/", import.meta.url));

/**
 * SPEC: 所有会走到公开页面的东西 —— 公开组件本身，加上喂给它们的数据模块。
 * INTENT: 身份声明那条断言此前只扫 4 个写死的 .tsx。但这类文案是**从数据来的**，
 *   页面只负责渲染 —— 守卫盯着渲染层，声明却住在数据层，等于没盯。守卫的形状和
 *   扫描域共同决定它能抓住什么（ADR-13 §3.1）：这里形状本来就对（这条不变量的
 *   主体确实是源文本），错的是域。改成目录遍历后，新增一个公开组件或数据模块
 *   自动被覆盖，不需要有人记得回来加一行。
 */
function publishableSources(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const [dir, matches] of [
    [COMPONENT_DIR, (n: string) => n.endsWith(".tsx")],
    [LIB_DIR, (n: string) => n.endsWith(".ts") || n.endsWith(".json")],
  ] as const) {
    for (const name of readdirSync(dir)) {
      if (name.includes(".test.")) continue;
      if (!matches(name)) continue;
      files.push({ path: name, text: readFileSync(join(dir, name), "utf8") });
    }
  }
  return files;
}

describe("truthful public UI states", () => {
  it("distinguishes creator auth, age, not-found, and dependency failures", () => {
    expect(creatorLoadErrorMessage(401)).toBe("Sign in to view this creator.");
    expect(creatorLoadErrorMessage(403)).toBe("Accept the age gate to view this creator.");
    expect(creatorLoadErrorMessage(404)).toBe("Creator not found or not public.");
    expect(creatorLoadErrorMessage(503)).toBe(
      "Creator is temporarily unavailable. Please try again.",
    );
    expect(creatorLoadErrorMessage(null)).toBe(
      "Creator is temporarily unavailable. Please try again.",
    );
  });

  it("does not turn an account-authority failure into anonymous Login calls to action", () => {
    const authNav = source("AuthNav.tsx");

    expect(authNav).toContain("Account unavailable");
    expect(authNav).toContain('if (!response.ok) throw new Error("Account authority unavailable")');
    expect(authNav).toContain('if (!response.ok) throw new Error("Logout failed")');
    expect(authNav).toContain("Log out failed. Try again.");
  });

  it("starts character creation empty and scopes browser drafts to the current viewer", () => {
    const createWorkspace = source("CreateWorkspace.tsx");

    expect(createWorkspace).not.toContain('name: "Nova Vale"');
    expect(createWorkspace).toContain(`${"${STORAGE_KEY_PREFIX}"}:${"${viewerScope}"}`);
    expect(createWorkspace).toContain(`user:${"${userId}"}`);
    expect(createWorkspace).toContain(`anonymous:${"${anonymousId}"}`);
    expect(createWorkspace).toContain('setViewerAuthorityState("error")');
    expect(createWorkspace).toContain('data-testid="create-viewer-authority-error"');
  });

  it("labels the last feed snapshot and rejects out-of-order refreshes", () => {
    const feed = source("FeedWorkspace.tsx");

    expect(feed).toContain("requestSerialRef");
    expect(feed).toContain("requestControllerRef.current?.abort()");
    expect(feed).toContain("requestSerial !== requestSerialRef.current");
    expect(feed).toContain("Showing the last loaded results.");
    expect(feed).toContain('data-stale={snapshotStale ? "true" : "false"}');
  });

  it("does not keep a dormant hard-coded public character catalog", () => {
    const catalogSource = readFileSync(
      new URL("../../lib/ourdream-data.ts", import.meta.url),
      "utf8",
    );

    expect(catalogSource).not.toContain("export const characterCards");
    expect(catalogSource).not.toContain('chats: "2.2M"');
  });

  it("rolls back or reloads optimistic follow and like state on network failure", () => {
    const community = source("CommunityWorkspace.tsx");
    const generator = source("GeneratorWorkspace.tsx");

    expect(community).toContain('setStatus("Could not update follow. Please try again.")');
    expect(generator).toContain('setStatus("Could not update like. Restoring the current gallery.")');
    // A retry that never reached a server status says so, rather than reusing
    // the server's own wording. The message moved with the write protocol.
    expect(
      readFileSync(
        new URL("../../lib/generation-request.ts", import.meta.url),
        "utf8",
      ),
    ).toContain('"Retry failed. Check your connection and try again."');
  });

  it("keeps server-rendered content in the tree while the age decision is pending", () => {
    const boundary = source("AgeGateBoundary.tsx");
    const explore = source("ExploreWorkspace.tsx");
    const generator = source("GeneratorWorkspace.tsx");
    const layout = readFileSync(
      new URL("../../app/layout.tsx", import.meta.url),
      "utf8",
    );

    expect(boundary).toContain("{children}");
    expect(boundary).toContain('state === "checking"');
    expect(boundary).not.toContain(
      'return <div className="min-h-screen bg-black" aria-hidden="true" />',
    );
    expect(layout).toContain('from "next/headers"');
    expect(layout).toContain("await cookies()");
    expect(layout).toContain("initialAccepted={ageGateAccepted}");
    expect(explore).toContain("if (!ageGateAccepted || !initialized) return");
    expect(generator).toContain("if (!ageGateAccepted) return");
    expect(boundary).toContain("usePathname");
    expect(source("AgeGate.tsx")).toContain('role="dialog"');
    expect(source("AgeGate.tsx")).toContain('aria-modal="true"');
  });

  // 参考站 ourdream.ai 的法人身份与联系渠道。它们是**那家公司**的事实，不是本产品的，
  // 所以任何会被渲染出去的地方都不该出现。
  const UNSUPPORTED_CLAIMS = [
    "Dream Studio USA, Inc.",
    "TEKTOPIA LTD",
    "discord.gg/P47YU7je5D",
    "trust@ourdream.ai",
    "help.ourdream.ai",
    "ourdreamaiaffiliate.com",
  ];

  // INTENT: 这份 69KB 的 JSON 是从参考站抓下来的安全文档全文，按 AGENTS.md「参考站点
  //   可参考学习」保留作素材。它**逐字包含** UNSUPPORTED_CLAIMS 里的法人名、通信地址
  //   和 trust@ 邮箱，所以它一旦被 import 进渲染路径，就是把另一家公司的法人身份当成
  //   自己的发出去。它现在零 importer —— 这条断言把「零 importer」从巧合变成不变量。
  const REFERENCE_CORPUS = "ourdream-safety-docs.json";

  it("扫描域真的覆盖到公开组件与数据模块，而不是空转", () => {
    // 守卫自检：通配符匹配不到东西时，下面两条断言会无声通过。
    const scanned = publishableSources();
    expect(scanned.filter((f) => f.path.endsWith(".tsx")).length).toBeGreaterThan(20);
    expect(scanned.some((f) => f.path === REFERENCE_CORPUS)).toBe(true);
  });

  it("does not publish unconfigured reference-site identity claims", () => {
    const violations: string[] = [];
    for (const file of publishableSources()) {
      if (file.path === REFERENCE_CORPUS) continue; // 由下一条断言单独看住
      for (const claim of UNSUPPORTED_CLAIMS) {
        if (file.text.includes(claim)) violations.push(`${file.path}: ${claim}`);
      }
    }
    expect(
      violations,
      `参考站身份声明出现在会被渲染的源里：\n  ${violations.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps the scraped reference corpus out of every render path", () => {
    const importers = publishableSources().filter(
      (file) => file.path !== REFERENCE_CORPUS && file.text.includes("ourdream-safety-docs"),
    );
    expect(
      importers.map((file) => file.path),
      `${REFERENCE_CORPUS} 含参考站法人身份，只能作素材，不能进渲染路径`,
    ).toEqual([]);
  });

  it("moves anonymous help-desk drafts into the signed-in owner scope once", () => {
    const helpDesk = source("HelpDeskWorkspace.tsx");

    expect(helpDesk).toContain("sourceScope: claimed.sourceScope");
    expect(helpDesk).toContain("if (saveSupportDraft(viewerScope, restoredSupport))");
    expect(helpDesk).toContain("clearSupportDraft(resumed.sourceScope)");
    expect(helpDesk).toContain("clearFeedbackDraft(resumed.sourceScope)");
    expect(helpDesk).toContain("clearAppealDraft(resumed.sourceScope)");
  });
});
