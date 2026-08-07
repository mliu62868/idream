# ADR-14：Character Soul 与 Chat Runtime 权威设计

更新日期：2026-08-05

状态：Proposed；仅完成设计，尚未实施。实现状态仍以
[`CURRENT_FUNCTIONAL_COVERAGE.md`](../product/CURRENT_FUNCTIONAL_COVERAGE.md) 为唯一事实来源。

深化自：[ADR-13](./17-deep-module-authority-boundaries.md)

关联文档：

- 产品语义与 Chat 领域归属：[`CHAT_SERVICE_PRD.md`](../product/CHAT_SERVICE_PRD.md)
- Chat 物理拓扑、存储与热路径：[`14-chat-service-tech-design.md`](./14-chat-service-tech-design.md)
- Character Release 与 Serving 权威：[`15-admin-operating-system-authority-adr.md`](./15-admin-operating-system-authority-adr.md)
- Character Asset 发布旅程：[`16-character-asset-studio-authority.md`](./16-character-asset-studio-authority.md)
- 用户角色 pin 语义既有结论：[`ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN.md`](../product/ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN.md)

## 1. Context

Chat Service 已经不是简单的 LLM proxy。当前权威链为：

```text
Admin Persona authoring
  -> CharacterContentVersion(persona/opening/appearance snapshots)
  -> CharacterRelease
  -> CharacterServing
  -> Chat Session / Message pin
  -> immutable persona resolution
  -> prompt assembly
  -> ChatModel
```

这条链已经具备正确的工程地基：

- Main 拥有 Character、Content Version、Release 与 Serving；Chat 只读角色投影；
- 新会话固定当时 serving 的 `CharacterContentVersion + CharacterRelease`；
- 历史消息优先使用 message pin，其次使用 session pin；
- pinned snapshot 不完整时 fail closed，不从 mutable Character 补人格字段；
- runtime rules、persona 和 memory/relationship data 已经分层；
- no-memory turn 不读取、不派生长期记忆或关系状态；
- relationship 的 turns 与 warmth/familiarity 已分开，消息数量本身不升级关系。

当前不足不是缺少一个 Markdown 文件，而是“角色灵魂”仍然是隐式概念（以下均为已核实现状，非推测）：

1. Admin 的 `personality`、`tone`、`backstory`、`exampleDialogue` 以结构化字段存进了 personaSnapshot，但运行时只消费同时写入的压扁 `systemPrompt`；压扁本身有损（exampleDialogue 只取前 5 条、整段 6000 字符截断，而单个 backstory 字段就允许 8000 字符），结构化字段“存了但死”；
2. 用户创建角色完全绕开这条链：不产生 `CharacterContentVersion`，会话 pin 为 null，运行时直接读可变的 `Character.systemPrompt`——编辑用户角色会追溯改变其全部历史会话，而用户角色是 P0 正式功能，不是边缘情况；
3. Chat 正式解析的 persona snapshot 只有 `name/age/description/systemPrompt/relationship`，运行时无法按领域语义验证、测试或演进；tool planner 还在 `agent-tools` 内自拼第二版 system prompt；
4. Release 的 `persona_complete` 名义上是 `systemPrompt || description`，实际对 admin 链路恒真——compiler 的硬编码骨架保证 systemPrompt 永不为空，它只验证“内容版本存在”，与 Chat 的三字段 fail-closed 解析不是同一个 Interface；
5. pinned persona 仍通过 `current Character view + 少数字段覆盖` 形成运行时对象，视觉身份等 mutable 字段的兼容语义不够显式；
6. `openingSnapshot` 已随版本不可变存储，但 Chat 从未读取它，first message 仍由 main 的可变 `advancedDetails` 提供；
7. relationship 依赖正则命中和累计分数，缺少可重建的语义证据；
8. `memorySummary` 只是一段 900 字符的滚动对话尾巴；地点、参与者、未完成剧情当前没有任何载体，只会偶然混进这段 prose；
9. Chat 模型配置在生产 env、model probe、launch readiness、probe runner 四处各自解析，且已产生真实分歧：探针加载不到 chat 的 `.env`、超时语义相反（总时长 vs 空闲）、runner 把 provider 写死为 `pipeline` 而生产是 `openai`；
10. 进程 health 无条件返回 200，无 readiness 区分、无预热；45s 模型预算实际是“加载 + 首 token”的合并预算，冷启动的第一轮会产出一条空 assistant 消息。

本 ADR 不重写 Chat，也不增加第二套角色权威。它深化现有 persona、context、prompt、relationship 模块，让复杂性集中在少量稳定 Interface 后面。

## 2. 第一性不变量

### 2.1 角色灵魂是长期身份资产，不是 prompt

`Character Soul` 描述角色是谁、为何这样行动、如何说话和如何建立关系。
`systemPrompt` 只是由 Soul 编译出的模型输入产物。

因此：

- 运营人员编辑 Soul，不直接编辑生产 `systemPrompt`；
- Provider、模型或 prompt syntax 变化不改写 Soul；
- 同一 Soul snapshot 和 compiler version 必须产生逐字节一致的 compiled prompt；
- 运行时不得把用户记忆、关系状态或当前场景写回 Soul。

### 2.2 静态事实与动态事实分开

| 事实 | 权威拥有者 | 生命周期 |
| --- | --- | --- |
| Soul draft | Main / Character Admin | 可变、不可 serving |
| Soul snapshot | Main / `CharacterContentVersion` | 不可变、可 serving |
| Opening snapshot | Main / `CharacterContentVersion` | 不可变，只用于开场 |
| Appearance snapshot | Main / `CharacterContentVersion` + Visual Identity | 不可变版本、独立演进 |
| Release / Serving | Main | 决定哪组不可变版本在线 |
| 用户角色当前内容指针 | Main / Character | 可变指针，只允许指向该角色的不可变版本 |
| Session / Message pin | Chat | 决定某轮使用哪个 Release/Soul |
| Scene state | Chat session | 会话内演进 |
| User memory | Chat user/character | 跨会话演进 |
| Relationship evidence/state | Chat user/character | 跨会话演进 |
| Runtime policy | Chat deployment/product policy | 随部署版本演进 |
| Provider wire format | ChatModel adapter | 可替换实现细节 |

任何字段如果无法明确放进上述一行，就不能进入生产契约。

### 2.3 发布验证与运行时消费必须是同一条 Interface

Main Release 和 Chat Runtime 不能分别判断“persona 是否完整”。两者必须调用同一个 shared Module 的两个入口、一套内部校验：

```ts
compileCharacterSoul(draft: unknown): CharacterSoulResult;       // authoring/Release：编译草稿，产出 snapshot + compiled artifact
loadCharacterSoulSnapshot(stored: unknown): CharacterSoulResult; // runtime：完整性校验并解码不可变 snapshot，不重编译
```

拆成两个入口是因为两侧做的本来就是两件事：Release 在编译，Runtime 在解码。运行进程可能携带比 snapshot 更新的 compiler，按字节稳定性约束它不能重编译历史 snapshot，所以 runtime 校验是 fingerprint 完整性校验，不是重编译对比。

“同一条 Interface”的精确含义是：compile 成功产出的 snapshot 永远 load 成功——由构造保证（fingerprint + append-only schema 演进：收紧校验规则必须伴随 schemaVersion 递增，已发布 snapshot 永远可解码），而不是两端重复跑同一批检查。不存在“Release 通过但 Chat 运行时报另一套字段错误”的合法状态。

### 2.4 历史人格不可被当前编辑污染

- 修改 Soul 必须创建新的 `CharacterContentVersion`；
- 新 Release 引用确切 Content Version；
- 新会话使用当前 Serving；
- 已有会话默认保持原 pin；
- 会话迁移只能走现有高风险 migration command，并携带 compatibility QA；
- 不允许使用当前 Character projection 静默补全历史 Soul；
- 用户角色的编辑同样只能通过新 Content Version 表达（§3.5），不再写活列；
- Appearance 如果允许独立使用“当前视觉身份”，必须以显式版本字段表达，不能靠对象 spread 混入。

### 2.5 动态状态必须可解释、可重建

Relationship stage 不是模型直接写入的自由文本，也不是消息数量的别名。每次变化必须能回答：

- 哪一轮对话产生了什么证据；
- 哪个 extractor/version 产生；
- reducer 如何从证据得到当前 state；
- 删除、no-memory、重建时为何保留或移除。

### 2.6 运行时行为不依赖某个具体模型

Soul 定义角色行为契约；ChatModel adapter 只负责把 `PreparedTurn` 转成 provider wire 并流式返回。不得在 Character 内容里写某个 Provider 专属格式或模型名称。

## 3. Decision

### 3.1 不创建 `SOUL.md` 权威文件

生产权威继续是数据库中的不可变 `CharacterContentVersion.personaSnapshot`。

三种表示的关系固定为：

```text
CharacterSoulSnapshot JSON   = canonical authority
SOUL.md                      = deterministic operator view
compiled system prompt       = deterministic runtime artifact
```

`SOUL.md` 可以在 Admin 中预览、导出或用于代码评审，但不能独立保存、独立修改或被 Chat 直接读取。否则 JSON、Markdown、prompt 会立刻形成三个可漂移的权威。

### 3.2 复用 `CharacterContentVersion`，不新增 Soul 表

现有模型已经提供：

- `personaSnapshot`；
- `openingSnapshot`；
- `appearanceSnapshot`；
- `(characterId, version)` 唯一版本；
- `(characterId, contentHash)` 内容去重；
- Release、Revision、Serving 和 Chat pin 引用。

第一阶段只升级 `personaSnapshot` 的 JSON contract，不增加数据库实体。这样保留现有发布、回滚、迁移和归因能力，也避免建设一套平行生命周期。

### 3.3 `CharacterSoulSnapshot` contract

目标 canonical shape：

```ts
type CharacterSoulSnapshot = {
  schemaVersion: 1;

  soul: {
    identity: {
      name: string;
      age: number;
      gender: "female" | "male" | "trans";
      relationshipArchetype: string;
      characterPromise: string;
    };

    innerLife: {
      personality: string;
      values: string[];
      wants: string[];
      fears: string[];
      contradictions: string[];
      backstory: string;
    };

    voice: {
      tone: string;
      cadence: string;
      vocabulary: string[];
      habits: string[];
      avoid: string[];
    };

    interaction: {
      initiative: string;
      curiosity: string;
      pacing: string;
      affection: string;
      conflict: string;
      repair: string;
    };

    canon: {
      facts: string[];
      unknowns: string[];
    };

    dialogue: {
      positive: Array<{
        context: string | null;
        user: string | null; // null = assistant-only 示例，容纳存量 exampleDialogue 字符串
        assistant: string;
        demonstrates: string[];
      }>;
      negative: Array<{
        assistant: string;
        reason: string;
      }>;
    };
  };

  compiled: {
    compilerVersion: string;
    systemPrompt: string;
    fingerprint: string;
    estimatedTokens: number;
  };
};
```

设计理由：

- `identity` 回答角色是谁和向用户承诺什么；
- `innerLife` 提供驱动力，而不是继续堆“温柔、聪明”等形容词；
- `voice` 约束语言表面；
- `interaction` 约束主动性、节奏、冲突和修复；
- `canon` 把确定事实与有意留白分开，降低模型自行补设定；
- `dialogue.positive` 展示目标行为，`negative` 明确反例；
- `compiled` 随不可变 snapshot 保存，保证 compiler 升级后历史会话仍使用原始产物；
- `fingerprint` 覆盖 canonical soul、compilerVersion 与 systemPrompt，用于 Release/runtime 完整性校验；
- `gender` 取值引用 shared catalog 的 `GENDERS`，不在 Soul schema 里另设第二份枚举；
- `contentHash`（现有 `(characterId, contentHash)` 去重唯一键）覆盖三个 canonical snapshot 加 `compilerVersion`，不含 compiled 字节——compiled 是决定论派生物；compiler 升级后同一 soul 可生成新版本，而把内容改回历史值会命中去重，此时正确动作是回滚指向旧版本（与 §7.3 一致），不是绕开唯一键；
- compiler 不做静默截断：示例条数、超长字段超出预算时以 diagnostics 报告，由 Release policy 决定是否阻断，不复制现状“取前 5 条 / 6000 字符砍断”的隐式丢失。

不进入 Soul 的字段：

- `firstMessage`：属于 `openingSnapshot`；
- appearance、服装、镜头、图片风格：属于视觉身份/`appearanceSnapshot`；
- 当前用户姓名、偏好、边界、共同经历：属于 Chat memory；
- 当前关系阶段：属于 Relationship State；
- 当前地点、时间、剧情节点：属于 Scene State；
- token budget、tool availability、entitlement：属于 Runtime Policy。

### 3.4 Draft、Release 与 Runtime 的完整性等级

同一个 schema 支持草稿保存和生产发布，但验证结果有严重级别：

```ts
type SoulDiagnostic = {
  code: string;
  path: string[];
  severity: "error" | "warning";
  message: string;
};
```

- Draft 可以保存有 warning 的内容；
- 无法编译、缺少身份、年龄无效、compiled fingerprint 不一致是 error；
- 过度通用、缺少反例、角色间区分度不足是 warning 或具体 Release route 的阻断项；
- Release policy 决定哪些 warning 在该 placement 上升级为 blocking；
- Chat 只接受 `loadCharacterSoulSnapshot` 成功且 fingerprint 一致的 pinned snapshot。

不得通过填充通用默认话术消除 warning。运营未提供的角色事实保持明确为空或进入 `unknowns`，不能伪造成已完成内容。

error 级最小集固定为：identity 完整、age 合法、至少一个行为维度（`innerLife.personality` 或 `voice.tone`）非空、可编译。把 admin 与用户两条 authoring contract 的现有字段映射进 schema 是 authoring adapter 的职责（例如用户流程的 `description`/`relationship` 映射到 `characterPromise`/`relationshipArchetype`，存量 `exampleDialogue` 字符串折叠为 assistant-only 示例）；映射不到的维度保持为空或落 `unknowns` 并产生 warning，不伪造。其余维度全部是 warning 级：官方 Release policy 可升级为阻断，用户角色发布不升级。

### 3.5 用户创建角色进入同一条不可变链

用户角色（PRD CR-01~CR-09，P0 正式功能）当前完全绕开 Release/Serving：`submitDraft`/`updateCharacter` 把 `buildCharacterSystemPrompt` 产物直接写进可变列 `Character.systemPrompt`，chat view 的 serving LEFT JOIN 落空，会话 pin 为 null，运行时读活列。本 ADR 的不变量若只覆盖官方角色，就漏掉整类角色。

决定（与 `ADMIN_CONSOLE_FIRST_PRINCIPLES_REMEDIATION_PLAN` 既有结论一致：用户会话固定 `characterContentVersionId`、`characterReleaseId = null`）：

- 用户角色的创建/编辑同样经 `compileCharacterSoul` 物化 `CharacterContentVersion`（`sourceType: "user"`），只要求 error 级最小集通过，warning 不阻断；
- Character 增加当前内容版本指针；chat read view 的 pin 解析改为 `COALESCE(官方 serving 指针, 用户角色当前指针)`，分叉从隐式的 LEFT JOIN 落空变成显式规则；
- 新会话 pin content version，`releaseId = null`；已有会话保持原 pin；编辑产生新版本并更新指针，历史会话不受影响；
- 用户角色不进入 Release、Serving 状态机、behavior evaluation 和 live canary——那些是官方运营门；用户角色只需要不可变、可归因、可校验；
- 迁移窗口内，存量 null-pin 用户会话按 §4.2 的显式 legacy 路径继续读活列并输出指标；存量用户角色在首次编辑或批量物化时获得首个 Content Version；该 legacy 路径随 null-pin 会话清零后删除。

## 4. 深 Module 与 Interface

### 4.1 `CharacterSoul` Module

深化现有 `packages/shared/src/chat/persona.ts`，不创建 `persona-v2.ts`、`soul-new.ts` 或第二套 compiler。

公开 Interface 只有一对入口、一个结果类型：

```ts
type CharacterSoulResult =
  | {
      ok: true;
      snapshot: CharacterSoulSnapshot;
      renderedMarkdown: string;
      diagnostics: SoulDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: SoulDiagnostic[];
    };

function compileCharacterSoul(draft: unknown): CharacterSoulResult;
function loadCharacterSoulSnapshot(stored: unknown): CharacterSoulResult;
```

Module 内部隐藏：

- schema parse；
- normalization；
- prompt section ordering；
- canonical serialization；
- token estimate；
- fingerprint；
- Markdown rendering；
- legacy snapshot decode；
- diagnostics。

调用方只关心成功产物或结构化错误，不理解 compiler 细节。

现有 `buildCharacterSystemPrompt` 和 `resolveCharacterPersonaSnapshot` 被这对入口取代；调用方一并收敛——admin 的 `characterDraftSnapshots` 与用户侧的 `submitDraft`/`duplicateCharacter`/`updateCharacter` 都改走 `compileCharacterSoul`，不留第四处拼 prompt 的地方。旧测试在新 Interface 测试覆盖后删除，不叠加两套同义测试。

### 4.2 Legacy snapshot 是显式兼容 adapter，不是 fallback

现有 pinned session 仍可能引用没有 `schemaVersion` 的不可变 snapshot。不能修改旧 Content Version，也不能从 mutable Character 补字段。

迁移窗口内，`CharacterSoul` Module 内部允许一个显式 legacy decoder：

- 只接受当前已知且完整的旧 snapshot shape；
- 输出 `sourceSchemaVersion: 0` 诊断/指标；
- 缺字段时 fail closed；
- 只用于已有 pinned session；
- 新 CharacterContentVersion 和新 Release 必须是 schemaVersion 1；
- `CharacterRelease.legacy` 仍只是编辑导入/来源判别，不作为 serving fallback 开关；
- 退役不靠等待自然清零：schemaVersion 0 pinned sessions 与既有会话归档/删除政策绑定，超过保留期的不活跃旧会话按政策归档后，decoder 与对应测试删除；
- 用户角色的活列读取路径是第二个显式 legacy adapter（§3.5），同样输出指标、同样有退役条件。

### 4.3 `CompanionTurn` Module

深化现有 `packages/chat/src/context.ts` + `prompt.ts` 集群，对 generation worker 暴露一个运行时 Interface：

```ts
type PreparedTurn = {
  messages: ModelMessage[];
  tools: ToolDefinition[];
  budget: {
    maxInputTokens: number;
    usedInputTokens: number;
    dropped: Array<"memory" | "summary" | "transcript">;
  };
  trace: {
    characterContentVersionId: string;
    characterReleaseId: string | null;
    soulFingerprint: string;
    compilerVersion: string;
    sceneVersion: number;
    relationshipVersion: number | null;
    fileContextRevision: string;
  };
};

function prepareCompanionTurn(input: PrepareCompanionTurnInput): Promise<PreparedTurn>;
```

Module 内部拥有：

- exact pinned snapshot resolution；
- entitlement/policy resolution；
- recent transcript anchoring；
- boundary 的 fail-closed read；
- memory/relationship 的可降级 read；
- scene resolution；
- prompt section ordering；
- data/instruction encoding；
- token budget 与裁剪；
- tool contract；
- tool planner prompt（收编 `agent-tools` 现在自拼的第二版 system prompt）；
- runtime trace。

generation worker 不再分别调用 context builder、prompt builder、tool prompt helper 并理解它们的顺序约束。`PreparedTurn` 是 ChatModel adapter 的唯一输入。

`budget` 的计量实现可先由现有字符预算映射为 token 估算，不阻塞在精确 tokenizer 上；关键是 `dropped` 必须如实记录，不允许静默丢弃。

`ChatModel` seam 已有真实的生产 adapter 与测试 adapter，因此保留；Soul compiler 是纯计算，不为它增加 repository/provider port。

### 4.4 Prompt 层次与信任级别

组装顺序固定为：

1. Runtime policy；
2. immutable compiled Soul；
3. session Scene State；
4. Relationship State；
5. user boundaries；
6. long-term memories；
7. recent transcript；
8. tool contract。

信任规则：

- Runtime policy 是最高优先级指令；
- compiled Soul 是受信任的角色指令，但不能覆盖 Runtime policy；
- Scene、Relationship、boundaries、memories 是结构化 context data；
- context data 中出现的命令句仍然是数据，不升级为指令；
- recent transcript 是对话内容，不得重新定义 Soul；
- opening 只在创建会话/首轮时使用，不每轮重复注入；opening 取自 pinned `openingSnapshot`，不再读 mutable `advancedDetails`；
- tool planner 与主生成消费同一 compiled Soul 与同一信任编码，不存在第二版 system prompt；
- Provider adapter 只做 wire conversion，不重新拼另一版 system prompt。

## 5. Relationship：证据与状态分离

### 5.1 保留确定性 reducer，替换不可解释的输入信号

当前 warmth/familiarity 正则是保守基线，但语义覆盖有限。目标形态：

```ts
type RelationshipEvidenceKind =
  | "self_disclosure"
  | "trust"
  | "affection"
  | "shared_plan"
  | "conflict"
  | "repair"
  | "boundary_respected";

type RelationshipEvidence = {
  sourceAssistantMessageId: string;
  sourceUserMessageId: string;
  kind: RelationshipEvidenceKind;
  confidence: number; // [0, 1]
  extractorVersion: string;
};
// evidence 身份键 = sourceAssistantMessageId + kind + extractorVersion，job 重试不双记

function reduceRelationship(
  previous: RelationshipState,
  evidence: RelationshipEvidence[],
): RelationshipState;
```

模型可以作为 evidence extractor，但不能直接写 `stage`、计数或 narrative summary。Reducer 是纯函数，负责：

- idempotency（按 evidence 身份键去重）；
- 每类证据的权重与上限；
- stage 投影；
- 单轮不可跨多级；
- 晋升和回落使用不同阈值，避免抖动；
- conflict 与 repair 的组合语义；
- 定性 summary；
- version 增长。

### 5.2 Evidence 必须先持久化，再投影文件状态

durable intent kind 是 `memory_extract`（`chat.memory.extract` 是投递它的队列名）。扩展其 payload，携带经过校验的 `relationshipEvidence[]`。

但 ledger 本身不能充当 evidence 的长期存储：`chat_file_mutations` 的隐私姿态是 payload 在 apply 后覆写为 identity-only receipt（`relationship_set` 是当前唯一例外）。持久化归属定为文件层——projector 在更新 `relationship.md` 之前，先把 evidence 以 append-only 记录写入同目录的 evidence log，再投影状态。文件层本来就是 memory/relationship 的 durable authority，账号/会话擦除沿既有路径连带删除。

重建时使用文件层的原始 evidence，不用新模型重新解释旧消息。删除消息、账户擦除、relationship rebuild 通过 source message linkage 精确扣除后重新 reduce。存量 relationship 不重放历史消息迁移：以当前 state 记一条无 source 的 baseline，此前贡献不可追溯扣除（它们本来就没有证据），baseline 之后的一切变化都走 evidence。

不新增通用 Event Store；`chat_file_mutations` 保持 transport + receipt 职责，不为 evidence 改变隐私姿态。

### 5.3 No-memory 不变量

- no-memory turn 不生成 relationship evidence；
- 不增加 turns；
- 不更新 summary；
- 不写 memory candidate；
- finalize 和 projector 都重新校验 turn authority，不能只信 job payload。

## 6. Memory 与 Scene 分离

现有长期记忆类别继续保留：`user_fact`、`preference`、`boundary`、`shared_event`。

新增 typed Scene State，归 Chat session 所有：

```ts
type SceneState = {
  schemaVersion: 1;
  version: number;
  location: string | null;
  time: string | null;
  participants: string[];
  emotionalBeat: string | null;
  unresolvedThreads: string[];
};
```

现状没有任何场景载体：`memorySummary` 只是一段 900 字符的滚动对话尾巴，没有结构、没有除原样注入外的消费方，地点和剧情只是偶然混在 prose 里。Scene State 补上这个缺失的载体：

- 只描述当前会话连续性；
- 不作为长期用户事实；
- 可被下一轮 prompt、图片工具和语音表现共同消费；
- regenerate older turn 时按 anchor 读取对应版本，不能看到未来 scene；
- scene 属于会话内连续性，与跨会话抽取分属两个门：no-memory turn 照常更新 Scene（它不出会话、随会话删除），但不产生 memory candidate 与 relationship evidence——§5.3 约束的是后两者；
- scene 更新必须在 assistant finalize 后基于 exact turn 派生；memory candidates、relationship evidence、scene delta 由同一次抽取调用产出（抽取模型与主生成共享本地算力，一轮至多一次抽取调用），按 `memoryAuthority` 分别落闸，负载高峰可降级延后——抽取是异步 durable intent，延后不影响已完成的 turn。

regenerate 按 anchor 读历史版本，意味着 scene 必须保留版本历史，单个 `sceneSnapshot Json?` 列承载不了。首次实施即建 scene revision 权威（`sessionId + version` 唯一、记录 `sourceAssistantMessageId`），turn 的 user message 行记录 anchor 时刻的 `sceneVersion`——与 release pin 同款语义；不把 JSON 编码进现有 `memorySummary String?`。数据库迁移由迁移脚本描述并由用户执行；不由 agent 直接连库改表。

## 7. Release、Serving 与会话迁移

### 7.1 Authoring 到 Serving

```text
Character Project Draft
  -> compileCharacterSoul
  -> CharacterContentVersion(schemaVersion=1, compiled artifact)
  -> CharacterRevision
  -> CharacterRelease validation
  -> explicit publish
  -> CharacterServing
  -> new Chat Session pin
```

`characterDraftSnapshots` 必须调用 `compileCharacterSoul`，不能自己再拼 `personaSnapshot`。Content hash 覆盖三个 canonical snapshot 加 `compilerVersion`（§3.3）。用户角色走同一 compile 与 Content Version 物化，跳过 Release/Serving（§3.5）。

### 7.2 Release validation

当前恒真的 `persona_complete` 被替换为同一个 compile result，并至少记录：

- schemaVersion；
- compilerVersion；
- soul fingerprint；
- token estimate；
- error/warning diagnostics；
- behavior evaluation suite/version；
- exact production ChatModel profile（分档 free/premium/deluxe 解析出的每个不同模型，相同者去重）；
- live canary result。

Release 验证成功只说明该 snapshot 可以 serving，不自动 Publish。Approval、Release、Serving 继续是三个不同动作。

### 7.3 Existing sessions

- 默认：继续使用旧 pin；
- 新 Release 不静默改变既有会话；
- 运营选择迁移时，复用现有 `chat.session_release.migrate` durable command；
- compatibility QA 至少覆盖身份、声音、共同历史引用和 opening 变化；
- 下一 turn 原子换绑，记录 old/new release、reason、operator 和验证证据；
- rollback 创建/选择旧 Release，不修改 Content Version。

## 8. Admin 运营界面

Character Workspace 的 Persona 工作区应提供：

1. 结构化 Soul 编辑；
2. 自动生成的 `SOUL.md` 只读预览；
3. compiled prompt 高级只读预览；
4. 当前 draft 与目标 Release 的字段级 diff；
5. diagnostics 和具体修复位置；
6. behavior evaluation cases/results；
7. exact model live canary；
8. 创建新 Content Version；
9. QA；
10. 独立的 Release 与 Publish 操作。

运营界面不提供“直接改线上 system prompt”的逃生口。紧急修复也创建新不可变版本并走最小 Release/rollback 路径。

## 9. Behavior Evaluation

### 9.1 确定性 contract tests

以三个深 Module 的 Interface 为测试面：

- `compileCharacterSoul` / `loadCharacterSoulSnapshot`：schema、normalization、compile、fingerprint、legacy decode、Markdown、compile⟹load 构造性保证；
- `prepareCompanionTurn`：pin、context order、trust encoding、budget、degrade、anchor、trace；
- `reduceRelationship`：evidence、幂等、阈值、回落、删除/rebuild、no-memory。

新 Interface 测试覆盖后，删除只验证旧 helper 内部拼接细节的重复测试。测试不穿透 Interface 断言内部函数调用顺序。

### 9.2 行为评测矩阵

矩阵只应用于官方角色 Release；用户角色只过 compile 校验（§3.5）。每个官方 Release 至少执行以下场景：

| 场景 | 断言 |
| --- | --- |
| 初次见面 | 呈现 character promise，不声称虚假共同历史 |
| 用户低落 | voice 一致，不退化为通用客服模板 |
| 用户主动调情 | 符合 interaction pacing，不跳过关系阶段 |
| 用户挑战角色观点 | values/contradictions 可见，能自然冲突和修复 |
| Canon 追问 | 不改写确定事实，不把 unknown 伪造成事实 |
| Memory 缺失 | 不声称记得未提供内容 |
| Context injection | context data 中的指令不覆盖 runtime/Soul |
| Tool request | 人格持续存在，工具调用不误升级关系 |
| Regenerate old turn | 不读取该 turn 之后的 summary/scene/memory |
| No-memory | 不产生跨会话记忆和关系证据 |

评测不比较完整回复字符串。它记录 rubric 维度、判定证据和 evaluator version（带版本的 LLM judge + 人工抽查）。矩阵分两层：确定性可判的场景（Context injection、Memory 缺失、No-memory、Regenerate old turn）是阻断层；其余 rubric 场景是 advisory 层，记录趋势，由 Release policy 决定是否升级为阻断。

### 9.3 角色区分度

对当前官方角色使用相同的 8–12 个输入做 pairwise evaluation：

- voice/cadence 是否可区分；
- initiative/curiosity 是否可区分；
- conflict/repair 是否可区分；
- values 和 character promise 是否可区分；
- 是否大量共享通用句式。

区分度失败属于 Soul authoring 问题，不通过随机 temperature 掩盖。

### 9.4 Live gate

发布闭环必须使用 exact production profile：

```text
focused contract tests
  -> shared/main/chat typecheck
  -> full Main + Chat tests
  -> SQL role boundary
  -> production build
  -> exact model warmup/readiness
  -> signed BFF session create/send
  -> SSE start/delta/done
  -> persistence + pin + no-memory + relationship assertions
  -> cleanup
```

Mock ChatModel 证明协议，不证明生产角色行为。Live canary 必须记录 model id、adapter、compilerVersion、soul fingerprint、首 token/总耗时和是否冷启动；分档模型逐一覆盖（相同模型去重）。

## 10. Runtime 拓扑与启动门禁

### 10.1 Character read model 只能有一种权威协议

声明拓扑继续采用 `14-chat-service-tech-design.md`：同一 PostgreSQL cluster，Main/Chat 使用不同 schema 和 role；Chat 通过最小只读 view 读取 Character/Release/Entitlement/Eligibility。

如果未来使用独立 Chat database，必须先具备：

- Main outbox / CDC 到 Chat read model；
- exact contentVersionId/releaseId projection；
- durable inbox ACK；
- projection freshness watermark；
- 缺少 pinned version 时 fail closed；
- launch probe 证明 Main Serving 与 Chat read model 一致。

不能把“两个数据库里恰好存在同名表和相似数据”当成同步协议。

启动门禁应验证当前环境到底属于上述哪一种拓扑；既非同 cluster read view、又无 durable projection watermark 时拒绝 ready。

### 10.2 模型配置只有一个 resolver，且共享同一 client 实现

现状 chat 模型配置在四处各自解析（chat env、model probe、launch readiness、probe runner），且已产生真实分歧：探针加载不到 chat 的 `.env` 而探到 mock、探针超时是总时长而生产是空闲超时、runner 把 provider 写死为 `pipeline` 而生产是 `openai`（差 function-calling 路径）。历史已证明“数值统一了、施加语义没统一”仍然漂移，所以只统一 env 解析不够：

- 只有一个 model profile resolver：输入 tier，输出 provider/model/base url/timeout/max tokens；chat 进程、readiness、launch probe、运营 live canary 都消费它；
- 探针复用 chat 包的 ChatModel adapter 实现，不再重写 client——超时语义（空闲 vs 总时长）、请求体、能力开关只存在一份；
- resolver 覆盖全部模型面：分档对话模型与 memory extract 模型；
- 每个 assistant turn 的 trace 记录 resolver 解析结果（provider、model id、tier），支撑 §14 的按 turn 追溯。

### 10.3 Cold start 属于 readiness

`live` 只表示进程存活；`ready` 表示 exact model + tool schema 已完成最小预热并能开始真实 turn。

- 启动时执行最小 deterministic warmup；
- warmup 未完成时不接真实生成；
- 单独记录 model load timeout、first-token timeout 和 stream idle timeout（现状 45s 空闲超时从 fetch 前起表，冷启动时是“加载 + 首 token”的合并预算）；
- 不用两个串行长 timeout 掩盖同一次冷启动；
- `ready` 检查覆盖 DB、队列与模型可达性，不以“端口在听”代表就绪；
- 部署重启优雅排水：配置 kill timeout，SIGTERM 后停接新 turn，流式中的 turn 完成或干净中止并落库，不留半条 assistant 消息；
- keep-warm 是运行策略，不写进 Soul 或 Character Release。

## 11. 实施顺序

### Phase 0：收拢运行权威

目标：先保证测试和 live probe 指向同一真实系统。

- 校验 Main/Chat database topology，并校验 `db/sql/` 基线文件与已应用迁移的一致性（现状基线 view 存在被后续迁移取代的 NULL 占位列）；
- 增加 read model parity/freshness launch gate；
- 统一 Chat model config resolver，探针改为复用 chat 的 ChatModel adapter（§10.2）；
- 增加 exact model warm readiness；chat 进程补 readiness 门与优雅排水（kill timeout）；
- 清理会污染自动 probe 选角的非正式公开 fixture；
- 记录当前官方 Release、Content Version 和 pinned session 基线，以及 null-pin 用户会话基数。

完成标准：冷、暖两次 signed live probe 都能说明使用了哪个数据库 read model、哪个 Release、哪个 Soul fingerprint 和哪个模型。

### Phase 1：CharacterSoul 深 Module

目标：发布与运行时共用一个 persona Interface。

- 在现有 shared persona authority 中定义 schema 和 `compileCharacterSoul` / `loadCharacterSoulSnapshot`；
- 生成 compiled prompt、fingerprint、diagnostics、SOUL.md view；
- admin 的 `characterDraftSnapshots` 改走 compile 入口；
- Release validation 使用同一结果；
- Chat pinned snapshot 使用 load 入口；
- 保留显式 legacy decoder，只服务已有 pin；
- 删除旧的平行拼接和重复测试。

完成标准：构造一个 Release 通过后，Chat 对同一 snapshot 不会出现第二套完整性判断；修改 compiler 不改变历史 snapshot 的 compiled prompt；上线前对全部 serving Content Version 与存量 pinned snapshot 跑 load 审计，零意外 fail closed——新校验不能把在线角色打下线。

### Phase 2：用户角色纳入不可变链

目标：编辑用户角色不再追溯改变历史会话。

- `submitDraft` / `updateCharacter` / `duplicateCharacter` 改为经 `compileCharacterSoul` 物化 Content Version；
- Character 当前内容版本指针 + chat read view 的 COALESCE pin 解析（§3.5）；
- 新会话 pin content version，`releaseId = null`；
- 存量用户角色批量物化或首次编辑时物化；
- 存量 null-pin 会话走显式 legacy 活列路径并输出 drain 指标。

完成标准：新建/编辑用户角色产生不可变版本；新会话 pin 非空；编辑用户角色不改变其历史会话行为。

### Phase 3：结构化内容迁移

目标：所有新 Release 使用 schemaVersion 1。

- 盘点当前正式 Content Versions 和 pinned sessions；
- 为官方角色补齐 values/wants/fears/contradictions/voice/interaction/examples；
- authoring 不依赖 Phase 4 的编辑器：官方 Soul 以仓库内 JSON 经 review 后由导入命令走 `compileCharacterSoul` 物化；
- 不用通用模板自动伪造缺失内容；
- 生成新的 Content Version、Revision、Release；
- 跑角色区分度和 exact model live canary；
- 显式 Publish；
- 老会话保持旧 pin，按 compatibility QA 决定是否迁移。

完成标准：Serving 中不存在新建的 schemaVersion 0 Release；旧 pin 数量有可观测 drain 指标。

### Phase 4：Admin Soul 工作区

目标：运营人员不接触底层 prompt 也能安全迭代角色。

- 结构化编辑；
- SOUL.md/compiled prompt 只读预览；
- snapshot diff；
- diagnostics；
- behavior evaluation；
- live canary；
- Create Version -> QA -> Release -> Publish 完整旅程。

完成标准：浏览器从 Character Workspace 完成一次 Soul 修改、审核、发布；老会话 pin 不变，新会话使用新 fingerprint。

### Phase 5：Relationship evidence

目标：关系变化可解释、可重建、不可刷消息量。

- 定义 evidence schema；
- 扩展 `memory_extract` durable intent payload，evidence 落文件层 append-only log（§5.2）；
- 引入 deterministic reducer；
- 增加 stage hysteresis；
- 存量 relationship 以无 source 的 baseline 记录起账，不重放历史消息；
- 保持用户只看到定性 stage，不展示数字信号。

完成标准：任一 relationship state 都能从 canonical evidence 重建；删除 source message 后重建结果正确。

### Phase 6：Typed Scene State

目标：把会话剧情连续性从字符串 summary 中分离。

- 增加 Chat schema migration（scene revision 权威 + user message 行 `sceneVersion`）；
- exact-turn scene extraction，与 memory/relationship 抽取合并为同一次调用、按 `memoryAuthority` 落闸；
- regenerate anchor；
- prompt data injection；
- 图片/语音工具读取同一 Scene State；
- browser 端到端验证连续对话和场景图片。

完成标准：地点、参与者、未完成剧情在多轮中连续，旧 turn regenerate 不读取未来 scene。

## 12. 主要文件落点

| 范围 | 权威文件/目录 | 预期改造 |
| --- | --- | --- |
| Soul contract/compiler | `packages/shared/src/chat/persona.ts` | 就地深化为 `compileCharacterSoul` / `loadCharacterSoulSnapshot`，不建 v2 副本 |
| Admin draft contract | `packages/shared/src/admin/contracts/characters-create.ts` | 增加结构化 Soul authoring fields |
| Content snapshot | `packages/main/src/server/modules/admin-v2/characters/draft-content.ts` | 只调用 shared Module |
| 用户角色链 | `packages/main/src/server/modules/ourdream/service.ts` | submitDraft/update/duplicate 改走 shared compile 并物化 Content Version（§3.5） |
| Release gate | `packages/main/src/server/modules/admin-v2/characters/release-validation.ts` | 用 compile diagnostics 替换恒真 persona_complete |
| Immutable storage | `packages/main/prisma/schema.prisma` | 继续使用 CharacterContentVersion JSON，不新增 Soul 表；Character 加当前内容版本指针 |
| Chat read view | Main canonical SQL + `packages/chat/prisma/schema.prisma` | 投影 exact snapshot/release/fingerprint；pin 解析 COALESCE 官方 serving 与用户角色指针；基线 SQL 与迁移对齐 |
| Turn preparation | `packages/chat/src/context.ts`、`prompt.ts`、`agent-tools.ts` | 深化为 `prepareCompanionTurn` Interface，收编 tool planner 第二版 prompt |
| Generation | `packages/chat/src/generate.ts` | 只消费 PreparedTurn |
| Relationship | `packages/chat/src/relationship.ts` | evidence reducer，保留文件层 authority |
| Durable evidence | `packages/chat/src/file-mutations.ts` + 文件层 evidence log | `memory_extract` payload 扩展；evidence 落 append-only log；ledger 保持 receipt 隐私姿态 |
| Scene | `packages/chat/prisma/schema.prisma` + `db/sql/` | scene revision 权威 + user message 行 `sceneVersion` migration |
| Runtime config | `packages/chat/src/env.ts`、`providers.ts`、main 侧 probe/launch-readiness、probe runner | 统一 resolver + 共享 ChatModel adapter、topology/warm readiness、优雅排水 |
| Admin UI | Character Workspace / Persona surface | Soul editor、diff、QA、Release journey |

任何 DB 模式变更只提交 Prisma/SQL 迁移与验证脚本，由用户在目标数据库执行。

## 13. 不做什么

- 不把 `SOUL.md` 变成运行时文件权威；
- 不新增 `CharacterSoul` 数据表；
- 不创建 `persona-v2` 或双 compiler；
- 不让模型直接写 relationship stage；
- 不用消息数量自动提升关系；
- 不把 memory、relationship、scene 混入 persona snapshot；
- 不为用户角色引入 Release/评测矩阵/live canary——它们只需要不可变版本与 pin；
- 不为 evidence 改变 `chat_file_mutations` 的 receipt 隐私姿态——evidence 的长期家在文件层；
- 不让 Provider 专属 prompt 进入 Character 内容；
- 不为文件层再造通用 storage abstraction；
- 不在本 ADR 顺手重写完整 Chat Service；
- 不把单测、mock probe 或一次 warm response 当成生产闭环。

## 14. 最终验收不变量

实施完成后，以下断言必须同时成立：

1. 每个官方 serving Release 与每个用户角色的当前内容指针都引用不可变、可校验的 Character Soul snapshot；
2. Release validation 与 Chat runtime 通过同一个 shared Module 解释该 snapshot（compile⟹load 构造性保证）；
3. `SOUL.md` 和 system prompt 都能从 canonical snapshot 确定性产生；
4. 历史 session/message pin 不受当前 Character 编辑影响——官方与用户角色同样成立；
5. Soul、opening、appearance、scene、memory、relationship、runtime policy 各有唯一权威；
6. Relationship 可从 source-linked evidence 确定性重建；
7. no-memory turn 不产生跨会话记忆或关系证据；
8. exact model/profile（含 tier 解析）、compilerVersion、soul fingerprint 可从任一 assistant turn 追溯；
9. 冷启动未完成时 Chat 不报告 ready；
10. 浏览器真实运营旅程和 signed BFF -> SSE -> persistence -> pin 链路都有证据。
