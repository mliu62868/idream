import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMFYUI_MODALITY_DEFAULT_ENDPOINTS,
  comfyUiEndpoint,
} from "@idream/shared/env";

// SPEC: 每个生成模态的 ComfyUI 端点只有一处推导，字面量只有一处定义。
//
// INTENT: 这条回退链此前存在三份 —— gen 自己的 `env.ts`、Main 的
// `recovery-service-environment.ts`、以及 launch gate 的 `genComfyUiAuthority`。
// Main 刻意不依赖 gen（web 层不依赖 worker），所以「保持同步」就是全部机制，
// recovery 那份还把它写成了注释：`INVARIANT: match Gen's modality-specific
// runtime fallbacks`。靠人记得维护的不变式正是这个仓库已经被咬过两次的形状 ——
// 两次都是探针解析出的端点与它所担保的 worker 不是同一个。
//
// INVARIANT: 下面第二条是集合断言，不是「别写这个字符串」。端口号在配置文件、
// 文档和 .env 模板里出现是正常的；它只禁止**源码**里出现第二处推导。
const REPO_ROOT = path.resolve(process.cwd(), "../..");
const SOURCE_ROOTS = [
  "packages/gen/src",
  "packages/main/src",
  "packages/chat/src",
  "packages/shared/src",
];

// 唯一允许声明这些字面量的文件：契约本身。
const DECLARING_FILE = "packages/shared/src/contracts/env.ts";

async function sourceFiles(root: string): Promise<string[]> {
  const absolute = path.join(REPO_ROOT, root);
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(absolute, entry.name);
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory()) return sourceFiles(path.join(root, entry.name));
      return /\.tsx?$/.test(entry.name) ? [path.join(root, entry.name)] : [];
    }),
  );
  return nested.flat();
}

describe("ComfyUI endpoint authority", () => {
  it("falls back from modality-specific to the shared legacy endpoint", () => {
    expect(comfyUiEndpoint({ COMFYUI_IMAGE_API_URL: "http://pinned" }, "image"))
      .toBe("http://pinned");
    expect(comfyUiEndpoint({ COMFYUI_API_URL: "http://legacy" }, "image"))
      .toBe("http://legacy");
    expect(comfyUiEndpoint({ COMFYUI_API_URL: "http://legacy" }, "video"))
      .toBe("http://legacy");
    expect(comfyUiEndpoint({}, "image")).toBe(COMFYUI_MODALITY_DEFAULT_ENDPOINTS.image);
    expect(comfyUiEndpoint({}, "video")).toBe(COMFYUI_MODALITY_DEFAULT_ENDPOINTS.video);
  });

  // INVARIANT: H3 runs its own listener. Inheriting the legacy shared endpoint
  // would point a launch check at a process that is not serving H3 at all.
  it("never lets H3 inherit the legacy shared endpoint", () => {
    expect(comfyUiEndpoint({ COMFYUI_API_URL: "http://legacy" }, "h3"))
      .toBe(COMFYUI_MODALITY_DEFAULT_ENDPOINTS.h3);
    expect(comfyUiEndpoint({ COMFYUI_H3_API_URL: "http://h3" }, "h3"))
      .toBe("http://h3");
  });

  it("declares each default endpoint in exactly one source file", async () => {
    const files = (await Promise.all(SOURCE_ROOTS.map(sourceFiles))).flat();
    // 守卫自检：扫描面变空会让下面每条断言退化成恒真。
    expect(files.length, "source scan found no files").toBeGreaterThan(500);

    for (const [modality, endpoint] of Object.entries(
      COMFYUI_MODALITY_DEFAULT_ENDPOINTS,
    )) {
      const port = new URL(endpoint).port;
      const declaring: string[] = [];
      for (const file of files) {
        if (/\.(?:test|spec)\.tsx?$/.test(file)) continue;
        const source = await readFile(path.join(REPO_ROOT, file), "utf8");
        if (source.includes(`127.0.0.1:${port}`)) declaring.push(file);
      }
      expect(declaring, `${modality} endpoint (${endpoint}) is declared more than once`)
        .toEqual([DECLARING_FILE]);
    }
  });
});
