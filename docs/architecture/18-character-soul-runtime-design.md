# Character Soul Runtime

状态：已实现（schema v2）
权威：Shared 编译器 + 不可变 `CharacterContentVersion` + Release / Serving pin

## 1. 产品结论

Soul 只解决一件事：让模型稳定地知道“这个角色是谁”。

创建者只需要填写：

1. 名字
2. 年龄
3. 性别
4. 与用户的关系
5. 角色承诺
6. 扩展信息（可选 Markdown）

开场白独立保存，因为它是会话入口，不是角色人格正文。外观、场景、用户关系、用户记忆和运行时策略也不属于 Soul。

不再为性格、价值观、欲望、恐惧、矛盾、语气、节奏、词汇、互动策略、Canon、正反例对话分别建立字段。需要这些内容时，作者直接写进扩展 Markdown。

## 2. 当前契约

```ts
interface CharacterSoul {
  name: string;
  age: number; // 18...120
  gender: "female" | "male" | "trans";
  relationshipArchetype: string;
  characterPromise: string;
  detailsMarkdown: string; // optional; empty string means absent
}
```

当前快照：

```ts
interface CharacterSoulSnapshot {
  schemaVersion: 2;
  soul: CharacterSoul;
  compiled: {
    compilerVersion: "character-soul-2";
    systemPrompt: string;
    fingerprint: string;
    estimatedTokens: number;
  };
}
```

编译器不补写默认人格，不从旧字段猜测新内容。基本信息缺失时直接返回 diagnostics。

## 3. SOUL.md 与 Agent 输入

基本信息会被确定性渲染为 Markdown，扩展信息原样附加：

```md
# Mara — Character Soul

You are Mara. Speak and act consistently with this character.

## Basic information
- Age: 31
- Gender: female
- Relationship: old friend
- Character: A precise confidante who notices what others miss.

## Additional details

## Voice
Dry warmth and concise questions.
```

核心不变量：

```text
rendered SOUL.md == compiled.systemPrompt == Chat 使用的固定 Soul 文本
```

Chat 可以在外层添加更高优先级的运行时策略、用户边界和逐轮状态，但不得重写 Soul。Agent 的 `PreparedTurn` 直接携带该固定文本。

不再从 Soul 复制 `canon.md` 或其他 knowledge 文件。复制会产生第二份提示词权威，也会让同一事实被重复注入。

## 4. 权威与存储

```text
用户/Admin 表单
  -> Shared compileCharacterSoul
  -> immutable CharacterContentVersion
       personaSnapshot  = schema v2 Soul + compiled bytes
       openingSnapshot  = firstMessage
       appearanceSnapshot = visual identity
  -> CharacterRevision
  -> QA
  -> Release
  -> Serving
  -> Chat session/message pin
  -> PreparedTurn
```

`SOUL.md` 是不可变快照的确定性渲染结果，不是另一份数据库权威，也不是用户会话记忆。

`Character` 表只保留目录与 Serving 投影。新的 `advancedDetails` 只保存必要的轻量投影，例如：

```json
{
  "relationshipArchetype": "old friend",
  "detailsMarkdown": "## Voice\nDry warmth.",
  "firstMessage": "You took your time.",
  "soulFingerprint": "...",
  "compilerVersion": "character-soul-2"
}
```

数据库已有 JSON 列足够承载该结构，不新增表、不新增字段、不做双写。

## 5. 页面与后台

用户创建页和 Admin Soul 编辑器使用同一心智模型：

- 基本信息：短字段，直接填写。
- 开场白：独立文本框。
- 扩展信息：一个 Markdown 文本框，选填。
- 预览：展示最终 `SOUL.md` 和 Agent system prompt；二者内容一致。

Starter 模板和“一句话生成角色”也只产出 `detailsMarkdown`，不再重新制造拆分字段。

## 6. 历史数据

schema v0/v1 只保留读取适配器：

- 已固定会话继续使用历史快照中原有的 `compiled.systemPrompt` 字节。
- Admin 打开历史版本时，旧人格维度会合并成一段 `detailsMarkdown` 供编辑。
- 一旦保存新版本，只写 schema v2。
- 新接口严格拒绝已删除的旧字段，避免旧结构继续扩散。

这不是双写兼容；它只是不可变历史的读取责任。

## 7. Release 与验证

发布必须验证：

- Soul 基本信息完整且年龄有效。
- schema v2 的 compiler 版本、渲染文本和 fingerprint 一致。
- 开场白存在。
- QA / canary 证据绑定相同的 ContentVersion、fingerprint 和 compilerVersion。
- Serving 与 Chat 固定到同一 Release / ContentVersion。

扩展 Markdown 超过提示词预算时编译器给出 warning，Release 拒绝带 warning 的版本；作者缩短文本后重新创建版本。

## 8. 明确不做

- 不恢复旧的多维人格表单。
- 不建立可视化 Soul DSL 或字段编排器。
- 不让模型自动补齐缺失基本事实。
- 不从 mutable `Character` 覆盖已固定 Soul。
- 不把外观、Scene、Relationship 或用户 Memory 塞进 Soul。
- 不为可能的未来扩展预留插件层。

当产品真的需要一个新的独立权威时，先证明它有不同生命周期和不同消费者；否则继续写进 `detailsMarkdown`。
