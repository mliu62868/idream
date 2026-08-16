import { describe, expect, it } from "vitest";
import { hasAdminZh } from "@/components/admin/i18n";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import {
  OPERATOR_ERROR_COPY_KEYS,
  operatorErrorCopy,
  technicalDetailText,
} from "./request-error-copy";

describe("operatorErrorCopy", () => {
  it("maps a known authority code to operator copy and keeps the raw facts", () => {
    const copy = operatorErrorCopy(
      new AdminV2RequestError("Character version changed", 409, "conflict", undefined, "req-1"),
    );

    expect(copy.headline).toBe("Someone changed this record before your action landed.");
    expect(copy.nextStep).toBe("Refresh to load the current version, then decide again.");
    expect(copy.technical).toEqual({
      code: "conflict",
      status: 409,
      requestId: "req-1",
      message: "Character version changed",
    });
  });

  it("falls back to the HTTP status when the envelope carried no code", () => {
    const copy = operatorErrorCopy(new AdminV2RequestError("Gateway said no", 503));

    expect(copy.headline).toBe("The authority did not answer.");
    // INVARIANT: 没有 code 就不编一个出来——technical.code 保持 null。
    expect(copy.technical.code).toBeNull();
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
