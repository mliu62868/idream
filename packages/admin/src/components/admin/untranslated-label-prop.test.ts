import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// SPEC: 接收文案 prop 的组件必须自己翻译它。
//
// INTENT: 这条守卫是从一次真实事故里长出来的。中文后台的账单页上曾同时露着
//   NET COINS (WINDOW) / status = active / Adjustment user ID / TOTAL DELTA 等八处英文。
//   根因不是调用点写了 <Metric label="Net coins (window)" /> —— 那是**对的**写法，
//   文案就该在一处集中定义；错的是接收方 function Metric({ label }) 直接 {label} 渲染。
//
// INTENT: 守卫的判据必须落在接收方，不能落在调用点。第一版我写反了：去查
//   `label="..."` 这类字面量，结果 227 处全部命中，而它们在运行时一个都不漏
//   （已逐条 curl 真实服务确认）。那样的守卫会把正确代码判成违规，逼后人做无意义的改动 ——
//   比没有守卫更糟。
//
// INTENT: 为什么别的守卫抓不到这类 bug —— i18n 完整性守卫查的是「JSX 英文字面量有没有包
//   t()」，而这些是 prop 值，不在它视野里；域字典互斥守卫查 key 冲突，这些 key 压根没进过
//   字典；类型系统更管不着，label 就是 string。只有真跑起来看渲染才发现。
const ROOTS = ["src/components/admin", "src/features"];
// caption 不在列：DataTable 内部会 t() 它，而且它是 sr-only 的表格说明，
// 不是运营看得见的文案 —— 放进来只会产生误报。
const COPY_PROPS = ["label", "meta", "hint", "purpose"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [path];
  });
}

/** 组件体：从 `function Name({ ... })` 到下一个顶层 `function` 或文件尾。 */
function componentBodies(source: string) {
  const bodies: Array<{ name: string; params: string; body: string }> = [];
  const pattern = /^(?:export )?function ([A-Z]\w*)\(\{([^}]*)\}/gm;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const nextIndex = source.slice(start + match[0].length).search(/^(?:export )?function /m);
    const end = nextIndex === -1 ? source.length : start + match[0].length + nextIndex;
    bodies.push({ name: match[1], params: match[2], body: source.slice(start, end) });
  }
  return bodies;
}

describe("接收文案 prop 的组件", () => {
  it("自己翻译，不把裸 prop 直接渲染出去", () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap(sourceFiles)) {
      const source = readFileSync(file, "utf8");
      for (const component of componentBodies(source)) {
        for (const prop of COPY_PROPS) {
          // 该组件收了这个 prop 吗（`label` 或 `label,` 或 `label:`）
          if (!new RegExp(`\\b${prop}\\b\\s*[,:}]`).test(component.params)) continue;
          // 渲染时把它裸着输出了吗：{label} 而不是 {t(label)} / {value(label)}。
          // INVARIANT: 排除 `prop={prop}` 这种转发写法 —— 那是把 prop 传给另一个组件，
          //   不是渲染。promo 的 Field 就是个纯转发壳，真正翻译发生在它转发到的 Input 里；
          //   不排除就会把「正确的转发」报成「裸渲染」。
          const bodyWithoutForwarding = component.body.replaceAll(
            new RegExp(`\\b\\w+=\\{\\s*${prop}\\s*\\}`, "g"),
            "",
          );
          if (!new RegExp(`\\{\\s*${prop}\\s*\\}`).test(bodyWithoutForwarding)) continue;
          // 组件内有没有把它过一遍翻译（t(label) / value(label) / format.* 都算）
          if (new RegExp(`(t|value|valueLabel)\\(\\s*${prop}\\b`).test(component.body)) continue;
          // 接收方不翻不一定是错 —— 调用点可能已经传了 t("…") 进来，那是同样正确的写法。
          // 只有「接收方不翻 且 同一文件里有调用点传裸字面量」才真的会漏英文。
          // INVARIANT: 必须同文件配对。跨文件按组件名匹配会误报 —— Field / Select 这类名字
          //   在七八个 workspace 里各有一份私有实现，A 文件的不翻不能栽到 B 文件头上。
          //   这个误报我实测栽过：守卫报 AccessWorkspace 漏英文，curl 真实服务是 0 处。
          const rawCall = new RegExp(`<${component.name}\\b[^>]*\\b${prop}="[A-Z][A-Za-z][^"]{2,}"`);
          if (!rawCall.test(source)) continue;
          offenders.push(
            `${file.replace("src/", "")} → ${component.name}({ ${prop} }) 不翻译，同文件里却有调用点传裸英文字面量`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
