# Chat Agent Companion Audit — 2026-08-24

> **历史审计证据（非当前规范）**：本文记录 2026-08-24 的代码与运行结果。当前 Chat 产品契约以 [`CHAT_SERVICE_PRD.md`](CHAT_SERVICE_PRD.md) 为准，执行边界以 [`../architecture/21-companion-chat-deep-runtime.md`](../architecture/21-companion-chat-deep-runtime.md) 为准。

> 范围：`packages/chat-agent`（DSH sidecar）、`packages/chat` 的 PreparedTurn / prompt / generate 收尾、igrep 记忆链路。
> 方法：读源码 + 抓取模型真实收到的 prompt（真实 igrep 插件 + 假 adapter）+ 直接实测 igrep / oMLX + 查 `chat.messages.runtime_trace` 近 3 天遥测 + 真实 signed probe。
> 出发点：陪伴产品。一个"陪伴"要成立，agent 必须：记得对的事并主动带出、有时间感、人格稳定且有变化、首 token 快、不出戏。下面每条发现都对着这五件事。

## 结论

DSH + 官方 igrep 的骨架（终态 CAS、commit-before-ingest、隔离 workspace、幂等工具桥）是对的，但**陪伴层**有六个实打实的缺陷，其中三个是 bug 而不是取舍。本轮全部修复并验证；另有四项明确不做，列在末尾。

## 实测证据（改前）

| 项目 | 数字 | 来源 |
|---|---|---|
| 首 token（35B-A3B，prompt ≈2.2k tokens） | 2.1–2.6 s；oMLX 裸调 2.2 s，前缀缓存命中后 0.45 s | DB 遥测 / 直连 oMLX |
| oMLX 前缀缓存 | 以 **2048 token 为块**，稳定前缀不足一块完全不命中 | 直连实测 |
| 每轮 prompt 组成 | Soul 400 tok + 策略/JSON 状态块 + **igrep 的 coding-agent 指引 ≈250 tok** + 4 个工具 schema 2.6k 字符 | 抓包 |
| 采样温度 | 正常模式**每一轮都是 0.2**（adapter 见到 tools 就切 structuredTemperature；memory_search 永远在） | 源码 |
| `memory_search`（插件默认 ultra） | 37 s / 4.5 s，内部 LLM evidence controller 3.85 s 超时 | 直接调 igrep |
| `memory-search` fast | 0.7 s，命中 profile + 对话行 | 同上 |
| `mem wake` | 0.24 s | 同上 |
| `mem maintain`（每轮，2 次 LLM 调用） | 1.7–3.3 s；GPU 争用时 5–6 s | 同上 + DB settleLag |
| sidecar 等 maintain 的超时 | **5 s** | `workspace.ts` |
| 近 3 天正常记忆 turn | 44 条：32 ingested（settle 均 2.5 s、最长 5.6 s）、**11 条 (25%) ingested_rebuilt（settle 均 17.7 s、最长 59 s）** | DB |
| sidecar `memory_commit_failed` | 11 次 | pm2 日志 |
| SSE `done` 时机 | 在 sidecar 完成 ingest + maintain 之后（≈3 s，重建时 30–60 s），期间前端"正在输入" | `generate.ts` |
| igrep 同 session 重 ingest | **替换**该 session 文件，并把 profile 全部行置回 pending | 直接调 igrep |

## 发现与修复

### 1. 温度常驻 0.2（bug）
`openai-adapter.ts` 在 `options.tools.length > 0` 时用 `structuredTemperature`。旧原生 planner 才需要；DSH 正常模式永远暴露 `memory_search`，所以每条陪伴回复都是 0.2——扁平、重复、没有声音。
**修**：采样只用 `sampling.temperature`；删掉 wire 上的 `structuredTemperature`（model-profile 里的字段留给 shared 客户端的 `complete()`）。

### 2. Coding-agent 提示词与冗余工具
真实 prompt 里含 "Use igrep_search before grep, glob, or bash … working-tree questions about behavior, intent, architecture, unfamiliar code…" 与 "Before answering about prior work, dates, decisions, people, preferences, or todos, use memory_search…"。`igrep_search` 唯一能搜的 `knowledge/canon.md` 就是 Soul 里已有的 canon。
**修**：normal profile `search: false`（工具、指引、routing skill、失败提醒一起消失）；`tool:memory_search` 段在 agent scope 用同名 section 遮蔽为陪伴口吻；`{{igrep_memory_profile}}` 变量在 agent scope 用本轮 **已 await** 的 wake 结果遮蔽（原来靠插件异步刷新缓存，profile 可能缺席一轮）。插件不 fork。

### 3. 记忆从"拉"改成"推"
原设计只有 wake profile 常驻，对话记忆要模型自己调 `memory_search`（多一步 = 多一次完整模型往返，且 ultra 模式 4–40 s）。
**修**：`recallIgrepMemory`：用当前用户消息跑 `mem-api memory-search`（fast），与 wake 并行（实测 run→模型请求 0.77 s），命中作为 plugin-sourced 用户消息插在当前消息之前；失败只记 `igrep_observation: failure`，不拖垮回合；<8 字符消息不搜。`memory_search` 工具保留给显式追问，profile 改 `memorySearchMode: fast`、`timeoutMs: 10 s`。真实 probe 中"未来场景"那一轮的 Gate E marker 由 pre-recall 命中（`memorySearchEvidenceMatches: 1`），模型没有调工具。

### 4. 5 s settle 超时 → 25% 全量重建
maintain 本身 1.7–3.3 s，5 s 超时落在正常分布尾部：超时 → `memory_commit_failed` → reconciler 用 PG 全量重建关系 workspace（ingest 全部 session + `maintain --rebuild`）13–59 s，期间该关系被锁 → 下一轮首 token 30 s+、`relationship_busy` 409。
**修（第一刀）**：`verificationTimeoutMs` 5 s→30 s。改后 21 轮里 1 轮重建。
**修（第二刀，协作会话 burn 复测后）**：6 个关系并发时 settle 分布 p50 3.4 s / p90 14.5 s / max 27 s，尾巴仍顶到 30 s，20:50–20:54 又有 5 次 `memory_commit_failed`→重建→`relationship_busy` 级联（前三轮全通、第四轮爆发 = 第 2–3 轮失败 + 30 s reconcile 周期）。于是：① settle 预算 120 s（插件自身 300 s 才杀 maintain）；② maintain **完成但留 pending 行**不再当失败——下轮 maintain 会继续处理，而重建只是在同样的 GPU 压力下重跑同一批 LLM 调用；rename 仍以 memory-status 证明 pass 已结束为前提，绝不在 pass 运行中改名；③ 已 dispose agent、只在等 settle 的 invocation 不再占 DSH agent pool 名额（此前 4 个名额被 settle 尾巴占满就报 `dsh_runtime_error`）。
**复测**（同一 burn2.py、同 6 个关系、且已累积 5 轮以上历史）：改前 `relationship_busy` 12/30 (40%)，第一刀后 11/30 (37%)，第二刀后 **0/30，30/30 ok**，首 token p50 5.8 s / max 14.6 s（6 关系并发挤 2 个 worker 槽的排队；单线程 probe 为 1.7–2.5 s）。

### 5. SSE `done` 提前到 terminal CAS
`done` 原来等 sidecar 流结束（含 maintain）。**修**：commit 端 finalize 成功后立即发 `done`；记忆 settle 结果照旧落 trace。`probe-chat-service` 的 DSH evidence 改为轮询到 `memoryOutcome` 离开 `pending`（与它等 Scene 派生的方式一致）。

### 6. Prompt 分层 / 前缀缓存 / 时间感 / 开场白
- 系统提示词只留稳定层：policy + Soul + boundaries。Scene/关系/时间作为 **per-turn state**（plugin-sourced 用户消息）放在当前消息之前：既给模型 recency，又让 system + tools + 历史成为可缓存前缀。
- 状态块从 pretty JSON 改为紧凑行，空字段不出现（原来模型会读到 `"location": null`）。
- 新增 `Time now` 与 `Since your last exchange`（原来模型完全没有时间感，profile 里 "Since 2026-08-31…" 无从解释）。
- 开场白（session 第一条 assistant 消息）过去从第二轮起被"孤儿 assistant"规则删掉，角色从第二轮就忘了戏怎么开的；现在按 `runtimeTrace.messageKind === "opening"` 保留。
- `buildCharacterRuntimePolicy` 的"context-data JSON"措辞改为"Context data"。

## 明确不做（本轮）

- **Scene / 关系证据仍是正则**：`"falling in love"` 会抽出 location=`love`。正确做法是 memory.extract 里加一次异步 LLM 结构化抽取（ADR-18 §5.1 允许），本轮未做——它在 Chat 派生链，不在 agent 热路径。
- **regenerate = 关系 workspace 全量重建**：想改成按 session 重 ingest，但 igrep 0.1.132 同 session 重 ingest 是替换语义并重置 profile pending 行（实测），需要先在 rebuild 路径也物化插件 transcript；本轮不动。
- **`releasedKnowledge` / `knowledge/canon.md`**：`igrep_search` 关掉后没有任何读者，是横跨 shared/chat/chat-agent/gate 的死重量，单独一刀。
- **DSH transcript 每 attempt 一个文件**：与 rebuild 的"每 chat session 一个文件"布局不一致；改 session id 会撞上上面的替换语义，先不动。

## 与本轮无关但必须报的：聊天模型漂移

08-24 19:53–20:05 有人（不是本会话，也不是协作会话 idream-15）把 `packages/chat/.env` 的 `CHAT_MODEL_NAME` 与 `packages/chat-agent/.env` 的 `DSH_READY_MODEL` 改成 `Qwen3.8-27B-MLX-4bit`（20:42 又被改回 35B-A3B），期间 `IGREP_LLM_MODEL` 仍是 35B-A3B、`packages/main/.env` 也仍写 35B。实测 27B dense：2.2k prompt 冷 32 s 首 token、缓存后 12 s、生成 **2.5–3.6 tok/s**；且 chat/maintain 两个模型在 oMLX 里互相换入换出，每轮多 20–30 s，settle 最长 48 s——那个窗口内的 probe 首 token 12–35 s 全是它。本轮没有碰 `.env`（运行时选型归用户）；结论：这台机器上 27B dense 不能做实时聊天模型，chat 与 igrep maintain 必须用同一个模型，否则每轮都在换模型。

## 验证

- `packages/chat-agent`：vitest 9 files / 80 tests 全绿（含 2 个新用例：prompt 遮蔽 + profile + recall 消息 + wire 无内容；recall 失败降级 + 短消息不搜）；typecheck 过。
- `packages/chat`：vitest 50 files / 368 tests 全绿（含 prompt/prepared-turn/context 新用例）；typecheck 过。
- `packages/shared`：chat 目录 41 tests 全绿。
- `packages/main`：`probe-chat-service.test.ts` 25 tests 全绿（含 settlement 轮询）；typecheck 过。
- `scripts/setup-dsh-companion.test.mjs` 18/18；`bun run dsh-companion:setup && :check` 通过，profile overlay 已重写，sidecar `/readyz?full=1` ready，chat `/readyz` warmed 到同一 composition digest。
- 真实 signed `probe:chat-service`（35B-A3B，重启后）：**`ok: true`，46.6 s**——health / signed / unsigned 401 / normal turn（ingested，settle 2.5 s）/ future-scene + regenerate（两轮 pre-recall 均命中 Gate E marker，`memorySearchHits 1 / evidenceMatches 1`，regenerate 的 rebuild 走通）/ no-memory（wake 0、search 0、disabled）/ blocked input / Gate R rollout evidence / cleanup 全过。报告：scratchpad `probe-after6.json`。
- 期间发现并修的两个 probe 竞态：evidence 要等 `memoryOutcome` 离开 `pending`（done 提前后必须轮询）；`sseTerminal: "done"` 现在在发出 `done` 后立刻落 trace，而不是等 sidecar 记忆 settle 之后。
- 第 3 次 probe 出现过一次 regenerate → sidecar rebuild prepare HTTP 400 → Chat 500（同一时段有其他会话对 chat 做 burn 测试与消息删除）；之后两次未再现。Chat 现在把 sidecar 的 rebuild 错误摘要（结构性文本，无内容）带进异常，下次出现可直接定位。
