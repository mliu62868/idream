// SPEC: traits 是角色视觉身份的唯一真源；identityPrompt 是版本化派生缓存（P5 spec §2.2.1）。
//       assembleIdentityPrompt 把 5 组扁平 traits 记录（face/hair/body/signature/style）拼装成
//       与旧 ourdream/service.ts::buildCharacterIdentityPrompt 等价的自然语言 identity prompt。
// INTENT: 纯函数、零外部依赖（不 import service.ts，避免循环依赖；service.ts 反过来 import 本模块）。
//         v1 拼装规则忠实复刻旧实现的标题行（name/gender/age/style）与 details 列表（description +
//         逐条 "label key: value"），仅把"遍历原始 appearance/advancedDetails JSON"换成"遍历已抽取
//         好的扁平 traits 记录"——因此每组 traits 各自独立 cap 8 条（而非旧实现里 appearance 一次
//         性整体 cap 8），这是 v1 的既知、文档化的行为收窄，golden sample 测试选用条目数远低于 8
//         的样例以确保两者输出字节相同。
// INVARIANTS: 同 traits + 同 IDENTITY_ASSEMBLER_VERSION → 同 prompt 同 hash（纯函数）。
//             hash = FNV-1a hex，hash 前对象 key 递归排序以保证确定性（不依赖枚举顺序）。
// EXAMPLE: assembleIdentityPrompt({ style: { name: "Lyra Sol", gender: "female", age: "25",
//          style: "realistic" }, face: { eyes: "hazel" }, hair: {}, body: {}, signature: {} })
//          → { identityPrompt: "Lyra Sol, adult female companion; 25 years old; realistic visual
//          style; Appearance face eyes: hazel", traitsHash: "<8 hex chars>" }

export const IDENTITY_ASSEMBLER_VERSION = 1;

export type IdentityTraits = {
  face: Record<string, string>;
  hair: Record<string, string>;
  body: Record<string, string>;
  signature: Record<string, string>;
  style: Record<string, string>;
};

const MAX_DETAIL_LINES_PER_GROUP = 8;
const MAX_PROMPT_LENGTH = 900;

function clampPrompt(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3).trimEnd()}...`;
}

function cleanPromptText(value: string | null | undefined, max = 2_000): string {
  const cleaned = value?.replace(/\s+/g, " ").trim() ?? "";
  return clampPrompt(cleaned, max);
}

function traitDetailLine(label: string, key: string, rawValue: string): string | null {
  const cleanKey = cleanPromptText(`${label}.${key}`.replace(/[_.]+/g, " "), 80);
  const cleanValue = cleanPromptText(rawValue, 180);
  if (!cleanKey || !cleanValue) return null;
  if (/^https?:\/\//i.test(cleanValue) || cleanValue.startsWith("/")) return null;
  return `${cleanKey}: ${cleanValue}`;
}

function traitGroupDetails(label: string, record: Record<string, string>): string[] {
  return Object.entries(record)
    .map(([key, value]) => traitDetailLine(label, key, value))
    .filter((line): line is string => Boolean(line))
    .slice(0, MAX_DETAIL_LINES_PER_GROUP);
}

// 把任意（可能来自 admin 手填或旧 DB 行的非字符串）JSON 记录规整为扁平 Record<string,string>，
// 供 assembleIdentityPrompt/traitsHashOf 安全消费——数组 join(", ")，其余 String() 兜底。
export function toTraitRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, raw]) => [
      key,
      Array.isArray(raw) ? raw.map((item) => String(item)).join(", ") : String(raw),
    ]),
  );
}

export function assembleIdentityPrompt(traits: IdentityTraits): {
  identityPrompt: string;
  traitsHash: string;
} {
  const style = traits.style ?? {};
  const name = style.name ?? "";
  const age = style.age ?? "";
  const gender = style.gender ?? "";
  const styleName = style.style ?? "";
  const description = style.description ?? "";

  const details = [
    cleanPromptText(description, 360),
    ...traitGroupDetails("Appearance.face", traits.face ?? {}),
    ...traitGroupDetails("Appearance.hair", traits.hair ?? {}),
    ...traitGroupDetails("Appearance.body", traits.body ?? {}),
    ...traitGroupDetails("Character detail.signature", traits.signature ?? {}),
  ].filter(Boolean);

  const identityPrompt = clampPrompt(
    [
      `${cleanPromptText(name, 120)}, adult ${cleanPromptText(gender, 80)} companion`,
      `${age} years old`,
      `${cleanPromptText(styleName, 80)} visual style`,
      details.length ? details.join("; ") : null,
    ]
      .filter(Boolean)
      .join("; "),
    MAX_PROMPT_LENGTH,
  );

  return { identityPrompt, traitsHash: traitsHashOf(traits) };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function traitsHashOf(traits: IdentityTraits): string {
  const json = JSON.stringify(canonicalize(traits));
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
