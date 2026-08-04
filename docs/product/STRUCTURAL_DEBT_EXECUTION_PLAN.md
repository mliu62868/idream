# 结构债执行计划

Updated: 2026-08-03 · 基线 commit `3c6e88687`

## 这份文档管什么

第 5、6 波「同一个事实在多处解析、副本互相分歧」清理之后剩下的账。**只记还没做的**，已完成的部分在 `docs/product/DEEP_MODULE_AUTHORITY_EXECUTION_PLAN.md` 与 `docs/architecture/17-deep-module-authority-boundaries.md`（ADR-13）。

不管产品范围与上线门禁 —— 那是 `REMAINING_WORK_EXECUTION_PLAN.md`；不管实现状态 —— 那是 `CURRENT_FUNCTIONAL_COVERAGE.md`。

三节各自的性质不同：§1 只有用户能做，§2/§3 agent 可以开工。**§1 是 §2 的前置**（有一项代码删除等着数据库约束落地）。

---

## §1 阻塞在用户身上

### 1.1 dev 库：活跃身份键 CHECK 约束

- **执行**：`db/sql/2026-08-03-invariant-collapse-check-constraints.sql`（目标 `postgresql://kk@localhost:5432/idream`）
- **状态**：文件里第 0 步的四条只读预检**已跑，全部零行**，约束可以干净落地。写入被权限分类器拦下，需要用户执行或放开一条 Bash 权限规则。
- **落地后才能做**（这是 §2 的一部分，但被这条卡着）：删掉 `packages/main/src/server/modules/admin-v2/reconciliation/invariants.ts` 的三条离线检查 —— `duplicate_active_case`（:615）、`active_case_missing_active_key`（:628）、`terminal_case_retains_active_key`（:639）。约束加上之后它们守的状态在数据库层面不可表示。
  - `duplicate_active_case` 现在还额外有害：它把 `activeKey` 的推导公式抄了第二遍（`GROUP BY` 那四列），公式一改就开始报假阳性，而它并不拥有那个公式。
  - `terminal_incident_retains_active_correlation_key`（:666）**保留** —— SQL 里对 `ops_incidents` 只搬了「终态必须释放」这一个方向，与它逐字等价，删不掉也不该删。
- **验收**：约束存在（`SELECT conname FROM pg_constraint WHERE conrelid IN ('public.admin_cases'::regclass,'public.ops_incidents'::regclass) AND contype='c'` 非空）+ `bun run check` 绿。
- **顺序硬约束**：约束没落地就别删那三条检查。**这是唯一一处删除依赖外部执行的地方。**

### 1.2 生产库三项

dev 库已经是目标状态，以下只对生产：

| 项 | 文件 / migration | 顺序约束 |
|---|---|---|
| artifact 状态合并 | `db/sql/2026-08-02-generation-artifact-late-after-cancel-merge.sql` | **必须在新代码激活之前跑**。残留的 `late_after_cancel` 行在新代码下会解析失败 |
| 两条 prisma migration | `20260801201500_voice_clip_authority`、`20260801203000_generation_terminal_record_authority` | 常规 `prisma migrate deploy`；dev 已 applied |
| runner 退役 sd_cpp | `db/sql/2026-08-03-generation-model-profile-runner-retire-sd-cpp.sql` | 无序。dev 命中 0 行（11 comfyui + 1 pipeline），跑它是为了让结果无条件成立，不是因为已知有行需要改 |

按 CLAUDE.md：**agent 不连生产库**，只产出 SQL。

### 1.3 认证后的手工验证

我的硬禁区是输密码认证，以下两处只能由用户过：

- **`/generate` 生成页** —— 第 6 波修的 `cancelled` 终态就在这里（此前 cancelled 的任务会永久轮询、余额不刷新）。
- **Admin console** —— 第 5、6 波改了 93 个路由的响应接缝、Creative 拆分、Today 的 severity 排序。表现层没有自动化 E2E 覆盖到的部分需要人眼。

---

## §2 结构债

按「切一刀的收益 / 风险」排序。每一刀都必须能单独合入并跑绿 `bun run check`。

### 2.1 `ourdream/service.ts` 8842 行 —— 台账已建，按台账拆

反向 import 台账在 `packages/main/src/server/modules/ourdream/architecture-boundaries.test.ts`，逐文件逐符号**集合相等**：多一个符号说明新债没记账，少一个说明台账陈旧。四个欠债模块各自写明了阻塞约束。按可动性排：

**（a）HTTP/JSON 原语搬去 `lib/` —— 立刻能做，无阻塞**

`bodyText` / `jsonBody` / `parseJsonText` / `isRecord` / `toInputJson` 现在住在 `service.ts`，被 `billing-checkout.ts` 反向 import。它们是通用原语，和 v1 路由表没有关系。搬完更新台账。

风险：低。纯位移，无行为变化。

**（b）feed item id 编解码抽独立模块 → 解开 submitReport 的环 —— 第一刀应该切这里**

现状是个环：`discovery.ts` 反向 import `service.submitReport` → `submitReport` 依赖 `service.applyModerationAction` → 后者依赖 `discovery.feedCharacterId` / `feedCollectionId`。直接把 `submitReport` 搬进 discovery 只是把环换个方向重建。

先把 feed item id 的编解码抽成独立模块（两个函数，无状态），环就断了，举报受理才能落地成自己的模块。

风险：低-中。编解码是纯函数；`applyModerationAction` 本身不动。

**（c）结算段搬家 —— `billing-checkout.ts` 与 `subscription-lifecycle.ts` 是同一刀**

两者共享 `lockUserLedger` / `publicFeatureProjection` / `publicOfferAvailability` / `toInputJson`，`billing-checkout` 另有 `lockCheckoutSession` / `lockProviderEvent`。权益投影与账本锁都还住在 `service.ts` 的订阅结算段里，要搬就一起搬，分两次搬会中途留下一个更难描述的中间态。

风险：中。碰账本锁，但不碰生成写路径。

**（d）生成请求输入解析整段抽出 —— 独立开一轮，别塞进结构轮**

`generation-quote.ts` 反向 import 了 12 个符号（`GenerationCreateBody` / `selectGenerationProfile` / `selectRecipe` / `resolveGenerationLook` / `resolveGenerationVisualProfile` / `assertGenerationProfileCanDispatchReferences` …），权威全在 `service.ts` 的生成段里。

**这块坐在生成写路径上，有锁和事务。** 第 6 波负责 service 瘦身的 agent 明确判断它的风险与「纯结构轮」不匹配，建议单独开一轮 —— 采纳这个判断。开这一轮时先建基线数字（见 `docs/agents/` 与 worktree 陷阱记录），改动配套集成测试。

### 2.2 其余大文件

没有台账，先量再切。切之前先回答「删掉它复杂度会消失，还是会散到 N 个调用点」（deletion test）—— 答案是「消失」的就别拆。

| 文件 | 行数 | 备注 |
|---|---|---|
| `admin/src/features/characters/CharacterWorkspace.tsx` | 5641 | 表现层；第 6 波已抽出 `character-command-journal.ts`（944 行）把可靠性协议拿走了 |
| `main/src/components/ourdream/GeneratorWorkspace.tsx` | 3734 | 表现层；与 §3.1 的组件接缝抽取是同一件事 |
| `admin/src/features/characters/CharacterAssetStudio.tsx` | 3280 | 表现层 |
| `main/src/server/modules/admin-v2/characters/release-executor.ts` | 1927 | 服务端；Release/Serving 生命周期 |
| `main/src/server/modules/admin-v2/creative/run-create.ts` | 1779 | 服务端；第 6 波已把 `workflow.ts`(2087) 拆成 8 个模块，这个是同族剩下的 |
| `main/src/server/modules/admin-v2/cases/service.ts` | 1302 | 服务端 |

### 2.3 v1 asset 生命周期还没有 v2 面

v1 资产生命周期仍只有 `app/api/v1/[...resource]` 这一个 catch-all 出口，没有对应的 v2 路由与 manifest 条目。第 5 波把 93 个 v2 路由全部收进了 manifest 键控的响应接缝（`ROUTE_SEAM_DEBT` 已清空），v1 这块是唯一还没进这套体系的。

做之前先确认它值不值得做 —— 如果 v1 asset 面在受控 beta 里没有真实调用方，YAGNI，不做，把这条从计划里删掉即可。

---

## §3 测试装置

### 3.1 `truthful-ui-states.test.ts` 的正向源码文本断言

- **现状**：11 个 `it`，27 条正向 `toContain` 钉源码字面量（`expect(feed).toContain("requestSerialRef")` 这种），4 条 `not.toContain`。
- **4 条负向断言是有效的、不要动** —— 它们守「假数据不出现在任何渲染路径」，第 6 波已经把扫描域从 4 个硬编码文件扩到 `components/ourdream/*.tsx` + `lib/*.{ts,json}` 目录遍历，并加了自检（`.tsx` 数 > 20）。守卫的扫描域比形状更重要：硬编码文件清单只能抓清单内的漂移。
- **27 条正向断言要改成行为断言**。它们现在钉的是实现细节：改个变量名测试就红，而真正的行为回归它们抓不到。
- **做法**：把组件里的判断抽成可测的纯函数接缝，测函数不测源码文本。`creatorLoadErrorMessage` 已经是这个形状，照抄它。**这需要重构组件，是独立一轮的活**，不是顺手能改的。

### 3.2 `remaining-canonical-lists.test.ts` 的 10 条 `toContain`

同类问题。第 6 波已经给负向断言加了 `allFeatureSources()` 目录遍历 + 自检（≥ 18 个 feature）；正向那 10 条钉的是 blob 拼接后的字面量，扩域改不动它们的形状，同样要靠抽接缝。

### 3.3 `packages/main` 全量测试的间歇性失败

- **`packages/main` 没有配 `testTimeout`** —— 一堆真连库的集成测试跑在 vitest 给单测的 5s 默认预算上。这是隐患，但**要改需要多次观测支撑**：盲目放大会掩盖真正卡死的用例。
- 已实测两例（2026-08-03，均单独跑必过）：
  1. `admin/generation/inventory-provenance.integration.test.ts` —— 5009ms 超时。成因已查清（v1 `listGenerationJobs` 不支持 `search`，只能拉未过滤的 100 行带两个 `include`，成本随 `GenerationJob` 表在套件里累积增长），已就地加 20s 显式超时并写明理由。**不缩小 limit** —— 那会让 fixture/audit 有可能因为落在窗口外而「看起来被正确排除」，assertion 名存实亡。
  2. `ai/generation-transport-execution.integration.test.ts` —— "rejects the pre-provider running handshake…" **8ms 断言失败**。未修，根因未查。
- **8ms 是断言失败不是超时**，在共享 `idream_test` 库上通常意味着用例之间有共享状态泄漏。这是关于测试隔离的真实信号，值得单独查一轮。
- **实践**：全量跑挂一条时先 `bunx vitest run <那个文件>` 单独重跑再下结论，别当成刚合并的分支互相干扰。

---

## §4 明确不做

写在这里是为了下一轮不要重新捡起来讨论。

- **内容审核 / safety gateway 的松紧、合规论证** —— 既定产品决策（见 AGENTS.md）。`MODERATION_PROVIDER=mock`、`safety-gateway` 分支保留不启用是有意的，不是缺口。mock provider 里的未成年拦截与角色 `age≥18` 是保留的硬底线，保持现状。
- **`CharacterTemplate` 数据模型** —— 上一轮数据模型精简明确决定保持现状。
- **`docs/design-references/ourdream-safety-docs.json`（69KB 抓取语料）** —— 不删。AGENTS.md 说参考站点有研究价值。第 6 波加的断言是保证它不进任何渲染路径，不是要清掉它。
- **给 `pipeline@8091` 的 legacy 图像检查开绿灯** —— `launch:probe:pipeline` 诚实地是 `6/7`，那个网关没运行。当前用的是 workflow-native backend，这条失败不代表它坏了，但**也不能把 pipeline 套件叫做 passing**。
- **视频生成第一期** —— 已延后到 V1.1，video 恒 mock 是设计内行为。

---

## 建议的执行顺序

1. **用户跑 §1.1**（dev CHECK 约束）→ agent 删 invariants.ts 三条检查。这条链最短、收益明确、且是唯一被外部执行卡住的删除。
2. **§2.1(a)** HTTP/JSON 原语搬 `lib/` —— 纯位移，热身。
3. **§2.1(b)** feed item id 编解码抽出，解开 submitReport 的环 —— service.ts 拆解的真正第一刀。
4. **§2.1(c)** 结算段搬家。
5. 到这里 `service.ts` 的台账应该只剩 `generation-quote.ts` 一条。**§2.1(d) 单独开一轮**，配套集成测试。
6. §3.1 / §3.2 的接缝抽取再单独一轮（碰组件，和上面几刀是不同的风险面）。
7. §3.3 的隔离问题需要先多观测几次，不要在没有第三例之前动整套验证装置。

§1.2 / §1.3 与上述并行，随用户方便。
