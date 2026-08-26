// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminV2RequestError } from "@/lib/admin-v2-api";
import { AdminI18nProvider } from "@/components/admin/i18n";
import { translateAdmin } from "@/components/admin/i18n-dictionary";
import { ConfirmDialog, type ConfirmSpec } from "./ConfirmDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseSpec: ConfirmSpec = {
  title: "Refund subscription sub-1",
  destructive: { expectedName: "refund:sub-1" },
  submitLabel: "Issue full refund",
  onSubmit: async () => undefined,
};

describe("ConfirmDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  // SPEC: 文案类字段在这里过 t()，确认串不过。
  // INTENT: reasonLabel / inputLabel / submitLabel / title 是对象属性而不是 JSX 属性，
  //         i18n-completeness 的审计结构上扫不到它们——moderation / config / support / pricing
  //         四处因此一路传裸英文，中文界面的确认框写着「Reason」「Confirmation」「Confirm」。
  //         收口在这里之后调用点默认正确；这条用例保证以后不会又被拆开。
  it("translates its copy but never the confirmation string", async () => {
    // 确认串刻意取成一个**字典里有中文的**词，这样一旦哪天有人把它也翻了，这条会立刻红。
    await act(async () => {
      root.render(
        <AdminI18nProvider locale="zh">
          <ConfirmDialog
            onClose={() => undefined}
            spec={{
              ...baseSpec,
              title: "Reason",
              reasonLabel: "Reason",
              submitLabel: "Confirm",
              destructive: { expectedName: "Reason", inputLabel: "Confirmation" },
              consequence: { effect: "Cancel", reversible: true },
            }}
          />
        </AdminI18nProvider>,
      );
    });

    const zh = (key: string) => translateAdmin("zh", key);
    expect(zh("Reason")).not.toBe("Reason");

    // 标题、原因标签、提交按钮、后果文案都翻了。
    const text = dialog().textContent ?? "";
    expect(text).toContain(zh("Reason"));
    expect(text).toContain(zh("Confirm"));
    expect(text).toContain(zh("Cancel"));

    // 确认串必须原样出现在 placeholder 里 —— 它要逐字符比对，翻译等于把功能改坏。
    const nameInput = [...dialog().querySelectorAll<HTMLInputElement>("input")]
      .find((input) => input.placeholder.includes(zh("Confirmation")));
    expect(nameInput?.placeholder).toBe(`${zh("Confirmation")}: Reason`);
  });

  it("blocks submission until the operator types the exact confirmation string", async () => {
    const onSubmit = vi.fn(async () => undefined);
    await render({ ...baseSpec, onSubmit });

    expect(submit()?.disabled).toBe(true);
    await type("Reason (≥3)", "Chargeback avoidance");
    expect(submit()?.disabled).toBe(true);

    await type("Type the name to confirm", "refund:sub-2");
    expect(submit()?.disabled).toBe(true);

    await type("Type the name to confirm", "refund:sub-1");
    expect(submit()?.disabled).toBe(false);
    await click(submit());
    expect(onSubmit).toHaveBeenCalledWith("Chargeback avoidance");
  });

  it("states up front that an irreversible action cannot be undone", async () => {
    await render({
      ...baseSpec,
      consequence: { effect: "Money leaves the provider account.", reversible: false },
    });

    expect(dialog().textContent).toContain("This cannot be undone.");
    expect(dialog().textContent).toContain("Money leaves the provider account.");
  });

  it("marks a recoverable action as recoverable", async () => {
    await render({
      ...baseSpec,
      consequence: { effect: "The opposite adjustment reverses it.", reversible: true },
    });

    expect(dialog().textContent).toContain("This can be undone later.");
    expect(dialog().textContent).not.toContain("This cannot be undone.");
  });

  // SPEC: 提交失败不关框、不清输入——运营重试只差再点一次。
  it("keeps the operator's input and explains a failure in plain language", async () => {
    const onClose = vi.fn();
    await render(
      {
        ...baseSpec,
        onSubmit: async () => {
          throw new AdminV2RequestError("Subscription already refunded", 409, "conflict", undefined, "req-7");
        },
      },
      onClose,
    );

    await type("Reason (≥3)", "Duplicate charge");
    await type("Type the name to confirm", "refund:sub-1");
    await click(submit());

    const alert = dialog().querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Someone changed this record before your action landed.");
    expect(alert?.textContent).toContain("Refresh to load the current version, then decide again.");
    // 原文和 requestId 折在技术详情里，一个字都没丢。
    expect(alert?.textContent).toContain("Subscription already refunded");
    expect(alert?.textContent).toContain("req-7");

    expect(onClose).not.toHaveBeenCalled();
    expect(input("Reason (≥3)")?.value).toBe("Duplicate charge");
    expect(input("Type the name to confirm")?.value).toBe("refund:sub-1");
  });

  it("does not ask for a reason the backend contract would discard", async () => {
    const onSubmit = vi.fn(async () => undefined);
    await render({ ...baseSpec, requireReason: false, onSubmit });

    expect(input("Reason (≥3)")).toBeNull();
    await type("Type the name to confirm", "refund:sub-1");
    await click(submit());
    expect(onSubmit).toHaveBeenCalledWith("");
  });

  async function render(spec: ConfirmSpec, onClose: () => void = () => undefined) {
    await act(async () => {
      root.render(<ConfirmDialog onClose={onClose} spec={spec} />);
    });
  }
});

function dialog() {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error("ConfirmDialog did not mount");
  return found;
}

function submit() {
  return [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.includes("Issue full refund"),
  );
}

function input(label: string) {
  return dialog().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}

async function type(label: string, value: string) {
  const field = input(label);
  expect(field, `no field labelled ${label}`).toBeTruthy();
  await act(async () => {
    if (!field) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: HTMLElement | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}
