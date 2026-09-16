import { describe, expect, it, vi } from "vitest";
import { hasAdminZh } from "@/components/admin/i18n";
import { AdminV2RequestError, adminV2Request } from "@/lib/admin-v2-api";
import {
  OPERATOR_ERROR_COPY_KEYS,
  operatorErrorCopy,
  technicalDetailText,
} from "./request-error-copy";

describe("operatorErrorCopy", () => {
  it("does not infer a version race from a versioned request rejected by a business rule", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false, error: { code: "conflict", message: "Only a saved draft can be published" },
    }), { status: 409 }));
    try {
      const error = await adminV2Request("/api/admin-test", {
        method: "POST", ifMatch: 7, body: { entityVersion: 7 },
      }).catch((cause: unknown) => cause);
      expect(operatorErrorCopy(error).headline).toBe("The authority refused this action — a precondition was not met.");
    } finally { fetchMock.mockRestore(); }
  });

  it("keeps command blockers from the actual error envelope", async () => {
    const blockers = [{ code: "release_not_published", message: "Target Release is withdrawn" }];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false, error: { code: "invariant_failed", message: "Command rejected", requestId: "authority-request", blockers, repairDeepLink: "/admin/characters/project-1" },
    }), { status: 422 }));
    try {
      const error = await adminV2Request("/api/admin-test").catch((cause: unknown) => cause);
      const copy = operatorErrorCopy(error);
      expect(copy.technical.requestId).toBe("authority-request");
      expect(technicalDetailText(copy.technical)).toContain(JSON.stringify(blockers));
      expect(technicalDetailText(copy.technical)).toContain("/admin/characters/project-1");
    } finally { fetchMock.mockRestore(); }
  });

  it("retains the authoritative blocker and recovery instruction in copyable details", () => {
    const details = { blocker: "pinned_workflow_retired", requiredAction: "Discard the request to refund it" };
    const copy = operatorErrorCopy(new AdminV2RequestError("Request cannot be replayed", 409, "conflict", details));
    expect(technicalDetailText(copy.technical)).toContain(JSON.stringify(details));
    expect(copy.nextStep).not.toContain("override");
    expect(copy.nextStep).not.toContain("Nothing was written");
  });

  // SPEC: 只有权威明确返回版本不匹配，才提示刷新。
  it("maps a known authority code to operator copy and keeps the raw facts", () => {
    const copy = operatorErrorCopy(
      new AdminV2RequestError("Character version changed", 409, "conflict", { blocker: "version_mismatch" }, "req-1"),
    );

    expect(copy.headline).toBe("Someone changed this record before your action landed.");
    expect(copy.nextStep).toBe("Refresh to load the current version, then decide again.");
    expect(copy.technical).toEqual({
      code: "conflict",
      status: 409,
      requestId: "req-1",
      message: "Character version changed",
      details: { blocker: "version_mismatch" },
    });
  });

  // INVARIANT: 未分类的冲突不能猜测成版本竞争。
  it("does not invent a version race for a conflict that carried no version precondition", () => {
    const copy = operatorErrorCopy(
      new AdminV2RequestError("Only a saved draft can be published", 409, "conflict", undefined, "req-2"),
    );

    expect(copy.headline).toBe("The authority refused this action — a precondition was not met.");
    expect(copy.nextStep).toContain("open the technical details");
    // 权威原文一个字不改地留给工程。
    expect(copy.technical.message).toBe("Only a saved draft can be published");
  });

  // INVARIANT: 权威明说了 blocker 时，它比「可能有人改过」更具体，必须优先。
  it("prefers the authority's blocker over the version-race reading", () => {
    const copy = operatorErrorCopy(new AdminV2RequestError(
      "Appeal target could not be restored; the decision was not applied",
      409, "conflict", { blocker: "manual_followup_required" }, "req-3",
    ));

    expect(copy.headline).toBe("The authority refused this action: its precondition is not met.");
  });

  it("falls back to the HTTP status when the envelope carried no code", () => {
    const copy = operatorErrorCopy(new AdminV2RequestError("Gateway said no", 503));

    expect(copy.headline).toBe("The authority did not answer.");
    // INVARIANT: 没有 code 就不编一个出来——technical.code 保持 null。
    expect(copy.technical.code).toBeNull();
  });

  it("explains a terminal Case assignment conflict without inventing a version race", () => {
    const copy = operatorErrorCopy(new AdminV2RequestError(
      "Case cannot be assigned from its present state", 409, "conflict", { status: "resolved" }, "req-case-state",
    ));
    expect(copy.headline).toBe("This case is resolved or closed.");
    expect(copy.nextStep).toBe("Reopen this case before changing its assignment.");
    expect(copy.technical.message).toBe("Case cannot be assigned from its present state");
    expect(copy.technical.requestId).toBe("req-case-state");
  });

  it("directs a historical support Case reopen to the current Case", () => {
    const copy = operatorErrorCopy(new AdminV2RequestError(
      "A newer support Case owns this request; reopen that Case instead", 409, "conflict", { currentCaseId: "current-case-2" }, "req-history",
    ));
    expect(copy.headline).toBe("This request has a newer support case.");
    expect(copy.nextStep).toBe("Open case {caseId} and reopen it there. This historical case was not changed.");
    expect(copy.nextStepValues).toEqual({ caseId: "current-case-2" });
    expect(copy.technical.requestId).toBe("req-history");
  });

  // SPEC: authority 报了 blocker 的冲突不是版本竞争，不能把运营指去「刷新后重判」。
  // INTENT: 复核类工单点「从权威数据验证」实测就是这一条；刷新一万次也不会变。
  it("does not blame a concurrent edit when the authority named a blocker", () => {
    const copy = operatorErrorCopy(new AdminV2RequestError(
      "Case outcome is not proven by downstream authority",
      409,
      "conflict",
      {
        blocker: "case_action_outcome_authority_missing",
        requiredAction: "Record a supported downstream outcome or use an explicit audited override",
      },
      "req-blocker",
    ));

    expect(copy.headline).toBe("The authority refused this action: its precondition is not met.");
    expect(copy.nextStep).toContain("required action");
    expect(copy.technical.message).toBe("Case outcome is not proven by downstream authority");
  });

  // SPEC: 「假 reason 禁令」在错误文案上的落点。
  it("says the cause is unknown rather than inventing one for an unmapped failure", () => {
    const copy = operatorErrorCopy(
      new AdminV2RequestError("Teapot", 418, "brew_refused"),
    );

    expect(copy.headline).toBe("This action did not complete.");
    expect(copy.nextStep).toContain("The cause is not identified");
    expect(copy.technical.code).toBe("brew_refused");
  });

  it("separates a browser-side connection failure from an authority rejection", () => {
    expect(operatorErrorCopy(new TypeError("Failed to fetch")).headline).toBe(
      "The browser could not reach the admin authority.",
    );
  });

  it("still produces copy and a message for a non-Error rejection", () => {
    const copy = operatorErrorCopy(undefined);

    expect(copy.headline).toBe("This action did not complete.");
    expect(copy.technical.message).toBe("No error text was returned.");
  });

  it("omits absent identifiers from the text handed to engineering", () => {
    expect(
      technicalDetailText({ code: null, status: null, requestId: null, message: "boom" }),
    ).toBe("message: boom");
    expect(
      technicalDetailText({ code: "conflict", status: 409, requestId: "req-1", message: "boom" }),
    ).toBe("code: conflict\nstatus: 409\nrequestId: req-1\nmessage: boom");
  });

  // SPEC: 映射表返回的是 i18n key，而 t(变量) 逃得过 i18n-completeness 的字面量扫描。
  // INTENT: 少一条中文，运营在中文界面上就会被糊一句英文——正是这次要修掉的毛病。
  it("has a Chinese translation for every key the table can return", () => {
    expect(OPERATOR_ERROR_COPY_KEYS.filter((key) => !hasAdminZh(key))).toEqual([]);
  });
});
