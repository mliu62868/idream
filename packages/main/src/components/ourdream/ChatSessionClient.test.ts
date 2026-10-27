import { describe, expect, it } from "vitest";
import {
  chatAttachmentCostLabel,
  chatUpgradeLinkLabel,
  chatViewPinAfterScroll,
} from "./ChatSessionClient";

describe("chat upgrade reason", () => {
  it("keeps the upgrade action aligned with the blocked capability", () => {
    expect(chatUpgradeLinkLabel("messages")).toBe(
      "Upgrade for unlimited messages",
    );
    expect(chatUpgradeLinkLabel("dreamcoins")).toBe("Get more dreamcoins");
  });
});

describe("chat auto-scroll anchoring", () => {
  const pin = (input: Partial<Parameters<typeof chatViewPinAfterScroll>[0]>) =>
    chatViewPinAfterScroll({ wasPinned: false, previousScrollY: 0, scrollY: 0, latestBelowViewportPx: 0, ...input });

  it("follows new tokens only while the reader is parked at the latest message", () => {
    expect(pin({ latestBelowViewportPx: -160 })).toBe(true);
    expect(pin({ latestBelowViewportPx: 120 })).toBe(true);
    expect(pin({ latestBelowViewportPx: 121 })).toBe(false);
  });

  it("keeps following while a follow-scroll trails newly appended messages", () => {
    // Messages landed mid-animation: the list end is far below while scrollY still moves down.
    expect(pin({ wasPinned: true, previousScrollY: 1_200, scrollY: 1_300, latestBelowViewportPx: 400 })).toBe(true);
    // The reader scrolling up is what releases the pin.
    expect(pin({ wasPinned: true, previousScrollY: 1_300, scrollY: 1_250, latestBelowViewportPx: 400 })).toBe(false);
    // Moving down short of the latest message does not re-pin a released reader.
    expect(pin({ wasPinned: false, previousScrollY: 1_000, scrollY: 1_300, latestBelowViewportPx: 400 })).toBe(false);
  });
});

describe("chat image charge disclosure", () => {
  it("names the charge while the image is still being made and after it lands", () => {
    expect(chatAttachmentCostLabel({ costDreamcoins: 8, status: "running" })).toBe("8 coins");
    expect(chatAttachmentCostLabel({ costDreamcoins: 8, status: "completed" })).toBe("8 coins");
    expect(chatAttachmentCostLabel({ costDreamcoins: 1, status: "completed" })).toBe("1 coin");
  });

  it("stays silent about a charge that may have been reversed", () => {
    for (const status of ["failed", "refunded", "blocked", "rejected", "proposed"]) {
      expect(chatAttachmentCostLabel({ costDreamcoins: 8, status })).toBeNull();
    }
  });

  it("invents nothing when the ledger amount is missing", () => {
    expect(chatAttachmentCostLabel({ status: "completed" })).toBeNull();
    expect(chatAttachmentCostLabel({ costDreamcoins: null, status: "completed" })).toBeNull();
    expect(chatAttachmentCostLabel({ costDreamcoins: 0, status: "completed" })).toBeNull();
  });
});
