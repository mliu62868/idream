import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SPEC: 全后台只有一个 ToastProvider 挂载点。
// INTENT: useToast() 在 Provider 缺失时静默丢弃而不是抛错——那是为了不让一处布线错误
//         把整个控制台变成白屏。代价是漏挂了没人会发现：每一次写操作的成功和失败反馈
//         都会安静地消失，而所有 workspace 测试照样全绿。这条守卫就是那个代价的对冲。
const MOUNT_POINT = join(process.cwd(), "src", "app", "admin", "AdminConsoleClientOnly.tsx");

describe("toast provider wiring", () => {
  it("wraps the admin console in ToastProvider", () => {
    const source = readFileSync(MOUNT_POINT, "utf8");

    expect(source).toContain('from "@/components/admin/ui/Toast"');
    expect(source).toMatch(/<ToastProvider>[\s\S]*<AdminConsoleClient[\s\S]*<\/ToastProvider>/);
  });
});
