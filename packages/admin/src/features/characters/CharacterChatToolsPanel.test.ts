import { describe, expect, it } from "vitest";
import { chatImageToolEnabledOf } from "./CharacterChatToolsPanel";

// SPEC: 未设置 = 开。与后端 `chatImageToolEnabled()`（merchandising.ts:256）同口径。
// INTENT: 后端是 `=== false ? false : true`。前端若写成 `=== true`，一个从没配过这个开关的
//         角色（绝大多数）会在界面上显示成"已关闭"——一个和运行时行为相反的结论。
describe("in-chat image tool state", () => {
  it("treats an unset value as enabled", () => {
    expect(chatImageToolEnabledOf({})).toBe(true);
    expect(chatImageToolEnabledOf(null)).toBe(true);
    expect(chatImageToolEnabledOf(undefined)).toBe(true);
    expect(chatImageToolEnabledOf({ chatImageToolEnabled: undefined })).toBe(true);
  });

  it("only reports disabled when the authority said exactly false", () => {
    expect(chatImageToolEnabledOf({ chatImageToolEnabled: false })).toBe(false);
    expect(chatImageToolEnabledOf({ chatImageToolEnabled: true })).toBe(true);
    // 非布尔的脏值不该被读成"已关闭"——后端也不会那么读。
    expect(chatImageToolEnabledOf({ chatImageToolEnabled: 0 })).toBe(true);
    expect(chatImageToolEnabledOf({ chatImageToolEnabled: "false" })).toBe(true);
  });
});
