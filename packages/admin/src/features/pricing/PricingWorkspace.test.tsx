import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PricingWorkspace, replacedVersionNote } from "./PricingWorkspace";

const echo = (key: string, values?: Record<string, string | number>) =>
  Object.entries(values ?? {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    key,
  );

describe("pricing publish impact", () => {
  const rows = [
    { id: "a", ruleKey: "image.standard", status: "active", version: 3, baseCost: 12, multiplier: 1 },
    { id: "b", ruleKey: "image.standard", status: "draft", version: 4, baseCost: 18, multiplier: 1 },
    { id: "c", ruleKey: "video.standard", status: "draft", version: 1, baseCost: 90, multiplier: 2 },
  ];

  it("names the live version and price a publish will replace", () => {
    expect(replacedVersionNote(rows, rows[1]!, "publish", echo)).toBe(
      "Replaces the live version 3, priced at 12 base Dreamcoins × 1.",
    );
  });

  // INVARIANT: 找不到在售版本时说「未知」，不能说「没有」—— 它可能只是不在当前这一页。
  it("says the replaced price is unknown rather than implying none exists", () => {
    expect(replacedVersionNote(rows, rows[2]!, "publish", echo)).toContain("unknown");
    expect(replacedVersionNote(null, rows[1]!, "publish", echo)).toContain("unknown");
  });

  // INTENT: 回滚目标由服务端决定，页面不知道，所以一个字都不许猜。
  it("does not guess which version a rollback restores", () => {
    const note = replacedVersionNote(rows, rows[0]!, "rollback", echo);
    expect(note).toContain("decided by the authority");
    expect(note).not.toContain("version 3");
  });
});

describe("Pricing workspace permission surface", () => {
  it("keeps authority search visible but hides every write control without config.pricing.write", () => {
    const html = renderToStaticMarkup(<PricingWorkspace canWrite={false} />);
    expect(html).toContain("Pricing");
    expect(html).toContain("Search prices");
    expect(html).not.toContain("Create Pricing Rule Draft");
    expect(html).toContain("Publishing and rolling back prices is unavailable");
    expect(html).not.toContain("is not granted");
  });
});
