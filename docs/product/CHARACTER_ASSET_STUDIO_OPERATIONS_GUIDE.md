# Character Asset Studio 运营手册

更新日期：2026-07-17  
适用角色：官方角色运营、创意审核、角色发布负责人  
入口：`/admin/characters/{characterId}?tab=assets`  
关联文档：[联合评审方案](./CHARACTER_ASSET_STUDIO_REVIEW.md) · [Authority 技术参考](../architecture/16-character-asset-studio-authority.md)

## 1. 完成标准

一个角色的图片资产生产只有在以下条件同时满足时才算完成：

- Primary portrait 已批准并采用；
- Character hero 已批准并采用；
- Chat moments 已批准并采用；
- Preview 中三类客户语境符合角色定位；
- 后续 Character Release 已完成独立审核、校验与发布。

前三项只完成**草稿资产包**，不会直接修改线上角色。

## 2. 开始前检查

从 Character Workspace 直接进入 `Assets`。先按页面显示的身份状态选择唯一正确的入口：

### 空白角色或可恢复的未锚定历史

页面会显示 `First identity portrait`、`Bootstrap route` 和 `Generate 4 portraits`。此时：

1. 不要先去 `Visual identity` 创建纯文字 identity；该入口会明确提示先完成 reviewed portrait，并禁用 `Create & activate version`。
2. 使用默认 brief 生成 4 张无参考首肖像。
3. 对合格候选执行 `Approve with evidence`。首张身份定义的 `identityConsistency` 保持 `unscored`，四项可观察质量证据必须全部通过。
4. 执行 `Set as identity anchor`。系统在一个事务中归档可恢复的空 candidate 历史，新建 `vN` reviewed-bootstrap identity、Reference Set rev1，并把精确候选写入 Primary portrait 草稿。
5. 工作台随后解锁 Character hero 与 Chat moments；不要手工重复建立锚点或参考集。

### 已有受审身份的角色

页面应显示：

- 左侧 canonical identity 为 `locked vN`；
- 至少一组可用 identity references；
- 页面没有 `Complete visual setup` 阻断提示；
- 你具有本次工作所需权限。

如果已有受审身份但生成仍不可用，再进入 `Visual identity`：发布并启用 Reference Set Revision，确认 Generation Route Qualification 为 qualified 且未 stale，并逐项解决 visual readiness blockers。不要用新建空 identity 绕过阻断。

## 3. 标准生产流程

### 步骤一：Primary portrait

空白/可恢复角色先按第 2 节的 4 张首肖像 bootstrap 完成 Primary portrait。以下 6 张流程用于已有受审身份与 Reference Set 的角色。

1. 选择 `Primary portrait`。
2. 先阅读默认 creative brief。只有当角色定位需要更具体的镜头、服装或情绪时，才展开 `Adjust the creative brief` 修改。
3. 点击 `Generate 6 portraits`。
4. 候选陆续完成后即可开始浏览，无需等待整批全部结束。
5. 对每个有潜力的候选按第 4 节标准判断。
6. 合格时先点 `Approve with evidence`，填写身份与质量证据并提交，确认状态变为 `Approved identity`。
7. 再点 `Select primary · next asset`，将它采用到角色草稿。

Primary portrait 应优先保证辨识度：脸部清晰、身份特征稳定、缩小为发现卡片或圆形头像后仍易识别。

### 步骤二：Character hero

1. 工作台会自动进入 `Character hero`；也可手动点击第二步。
2. 点击 `Generate 4 heroes`。
3. 在右侧 Character hero 预览中判断构图、空间和人物表达。
4. 先批准身份，再点 `Select hero · next asset`。

Hero 应表达角色人格与世界感，不应只是 Primary portrait 的横向裁切版。

### 步骤三：Chat moments

1. 进入 `Chat moments`。
2. 点击 `Generate 6 chat assets`。
3. 在 Chat header 与对话气泡语境中判断亲近感、自然度和聊天氛围。
4. 先批准身份，再点 `Select chat asset · preview`。
5. 工作台会进入 `Preview`，检查完整草稿体验。

Chat moment 应像关系中的自然瞬间，避免过度海报化或与 opening message 情绪冲突。

## 4. 候选判断标准

按以下顺序评估，不要先被画面华丽度影响：

1. **身份**：脸、年龄感、体型、肤色、发型和标志特征是否仍是同一个角色。
2. **用途**：画幅、主体位置、留白和信息密度是否适合当前客户表面。
3. **人格**：表情、姿态、服装和环境是否符合角色设定。
4. **自然度**：肢体、手部、视线、光影和背景是否可信。
5. **客户语境**：放入右侧真实语境后，是否仍然成立。

只有五项都可接受时才批准身份。`Approve with evidence` 代表该候选可以进入采用或变体阶段，不代表它已经上线。

## 5. 返工与变体

### 候选已达批准门槛，但希望探索更优版本

先完成 `Approve with evidence`，确认身份一致性与四项质量检查全部通过。只有当前 qualified route 明确支持“source image + canonical identity references”并容纳完整 Reference Set 时，`More like this` 才会启用；系统会把已批准候选作为额外 source reference，同时保留 canonical identity 与完整 Reference Set。当前路由不支持组合输入时，按钮会禁用并说明原因，服务端创建前与 worker dispatch 时也会用同一 `sourceVariationAuthority` 再次拒绝，绝不会静默丢掉 canonical references。

常见阻断含义：

- `No qualified route`：当前没有精确合格路线；
- `Profile cannot consume a source image`：profile 不支持 init/source image；
- `Workflow cannot consume a source image`：workflow 没有 source image 输入；
- `Workflow cannot combine source and identity`：workflow 不能同时使用变体源与身份参考；
- `Reference capacity is insufficient`：路线容量不足以容纳变体源和完整 Reference Set。

不要通过减少 canonical references 来绕过最后一项；应修复或更换生成路线。

适合使用变体的情况：

- 构图、身份与质量均已合格，但想比较更有表现力的表情或视线；
- 服装、场景和氛围已经可用，但希望探索更自然的版本；
- 当前候选可以采用，同时值得保留这一视觉方向继续探索。

只要身份或任一质量检查不通过，就不要把该候选作为变体源。

### 候选不合格

点击 `Reject with reason`。拒绝会记录明确的审核结果；继续选择其他候选，或先批准一个真正合格的候选，再从它发起变体。

当前已被项目采用的候选不能直接拒绝。若要替换，先批准并采用另一候选；发布校验始终以最新权威状态为准。

已批准但确定不采用的候选，应填写原因并执行 `Record superseding
rejection`。系统保留原批准决定的分数、identity 结果与四项质量证据，同时写入
新的终态决定，让 Run 可以完整收口。若按钮被 active Character Look 阻止，
先进入 `Visual identity` 的 Character Looks 区域处理 Look；不要删除或私有化
底层图片来规避依赖。

### 整批方向错误

修改 creative brief 后创建新 Run。不要用连续变体挽救一个根本错误的创意方向。

## 6. 历史与技术证据

日常操作不需要选择模型或 workflow。需要排查时，展开 `Recent runs and technical lineage`：

- Recent Runs：查看同一角色三类素材的历史批次、执行结果和批准数；
- Generation profile / Workflow：确认本次实际使用的合格路线；
- Request / Asset：定位生成请求和最终素材；
- Run ID：交给研发或 Incident 调查时使用。

角色 Assets 只展示 `targetType=character + targetId=当前角色` 的 Creative Runs，避免跨角色采用素材。

ComfyUI reference 输入由系统按 semantic role 绑定到 workflow image slot，
不依赖数组顺序。日常运营无需手工排列 reference；若 route 声称使用参考图但
workflow 没有 image slot，或某个 identity/source role 无法唯一匹配，生成会在
上传图片和提交 prompt 前失败。不要通过删除身份参考来绕过此阻断。

## 7. 响应丢失、刷新与多标签页恢复

生成、审核、采用和新建角色都可能出现“服务端已经提交，但浏览器没有收到
响应”。此时页面上的恢复卡片是权威入口：

1. 第一次提交前，浏览器会保存当前操作者、环境、业务范围、规范化请求正文和
   idempotency key。
2. 显示 `Resume` 时，只恢复同一份正文和同一个 key。不要改 brief、切候选后
   再把它当作原请求重试。
3. 显示 `Verify` 时，服务端已经返回 committed receipt；Verify 只读取 Run、
   Review Decision、Project 或 Character 投影，不会发送第二次写请求。
4. 同一操作者在第二个标签页发起同一范围的动作时，第二页会采用第一份未完成
   intent 并锁定冲突控件。完成或核实第一份 intent 后再继续。
5. 切换账号会重挂工作区，其他操作者的本地 receipt 不会被复用。Character
   Create 中显式打开的 `?draft={id}` 永远先恢复该服务端草稿，不会被另一个
   未完成的新建 intent 替换。

不要通过清除 localStorage、换 key 或在另一个标签页重复点击来“解锁”。如果
恢复卡片提示旧请求已超过 24 小时，或原始快照已不再可安全重放，使用
`Reconcile receipt`。页面会保留 receipt 与 idempotency key，并保持冲突控件
锁定，直到服务端完成对账：

- 若原写入已经提交，页面只在精确 Run、Character、Review Decision、
  Reference Set 或 draft selection 投影可见后解除 intent；
- 若原写入从未提交，服务端写入 cancelled tombstone，永久阻止同 key 的迟到
  writer 后再解除 intent；
- 若 receipt 仍为 pending 或 failed，页面继续锁定并给出调查状态，不会构造
  一个新请求或把失败显示成成功。

Character bootstrap 与 draft selection 对账必须携带当前页面可信的
`expectedCharacterId`。服务端先校验操作者对该角色的
`character.project.write`，已有 receipt 还必须把可信 target/result Character
重新绑定到同一角色并再次校验资源范围。bootstrap 只有在 exact active
identity、Reference Set、anchor、draft image 与 cover 都可见时解锁；selection
必须是 exact purpose slot + selected asset，同一素材出现在其他槽位不算成功。
旧 cancelled tombstone 如果最初猜错了 Character command type，页面会使用
服务端返回的可信类型再查一次；这个兼容流程不会重发领域写入。

对账只要求上述原动作资源权限，不额外要求 Dashboard 读取权限。需要升级调查
时，记录 Character/Run、操作者、动作、command id 和页面 receipt，再核对
服务端 idempotency ledger。

Reference Set 发布冲突同样不能靠重复点击解决。409 表示另一位操作者已经改变
active revision：刷新 Visual Identity，核对页面返回的 current active id 和
revision，再以新 authority 明确提交。数据库同时保证一个 Visual Identity
不可能存在两条 active Reference Set。

旧 `/api/v1` batch-create 与 Character pregen-create 已经退休，返回
`410 Gone` 和对应 v2 入口；旧 item approve/reject/regenerate 返回 `409` 和
canonical repair path。历史页面只可用于读取旧记录；任何新生成、审核、采用
和发布都必须从 Character Asset Studio / Creative Run / Character Release
完成。

## 8. Preview 与发布交接

完成三类采用后进入 `Preview`：

1. 检查角色名称、描述、开场和三类图片是否表达同一人格；
2. 确认 Feed 使用所选 Primary portrait；
3. 确认 Detail 使用所选 Character hero，并检查裁切和文字可读区域；
4. 确认 Chat 使用所选 Chat moment，并检查与 opening message 的情绪衔接；
5. 按既有 Character Release 流程创建 proposal、审核、校验并发布。

Preview token 固定三张不同素材，每个 slot 都会显示
`available`、`missing` 或 `unavailable`。系统不会再用 portrait 代替缺失的
Hero/Chat；只要任一 slot 缺失、不可用、重复或与草稿权威漂移，QA 都会被
阻止。先回到 Assets 修复对应 slot，再重新生成 Preview。

Live Preview 还固定当前 `CharacterServing.version`。暂停、恢复、rollback、
切换 Release 或任何 Serving version 变化都会永久撤销旧链接；即使旧 Release
之后重新成为 current，也必须从工作台获取新链接。不要把旧 Live Preview URL
当作长期书签或发布证明。

Release proposal 会固定当前三类采用素材及其 Run、Item、Review Decision、Asset lineage。若 proposal 之后素材的最新审核权威发生变化，发布校验会失败，必须重新处理而不能绕过。

已有 active candidate Release 时，工作台会拒绝替换草稿资产。先完成、取消或按 Release 流程处理当前 candidate，再继续修改资产包，防止发布快照漂移。

## 9. Character Look 与图片管理

Character Look 是角色视觉资产的正式使用关系，不是普通标签。

1. 在 `Visual identity` 展开 `Character Looks using role images`；
2. 核对 Look 的状态、底层图片与更新时间；
3. 只有确认该 Look 不再需要时，填写 operator reason；
4. 输入页面要求的精确 `ARCHIVE LOOK {lookId}`；
5. 执行 Archive。系统使用 Idempotency-Key 与 `expectedUpdatedAt` 防止重复写入和覆盖他人的更新；
6. 刷新后确认 Look 依赖消失，再处理候选终态或图片归档。

Image Library 和 Customer Gallery 都不能绕过角色权威。只要图片仍被
draft project、Visual Identity、Reference Set、Generation Job、active Look、
Creative Run、current/scheduled Release、Campaign 或 verification 使用，
归档、private/unlisted 或 delete 都会被拒绝，并返回应前往的修复入口。
批量归档只发送一次 POST preflight；服务端以固定九组批量查询检查完整选择，
并要求输入排序、去重后的精确 asset id 列表。归档时会取得 authority lock
后重新读取，因此 preflight 之后新出现的依赖、被删除的素材或 stale selection
都会让整批保持不变。归档只改变 lifecycle status，不会用旧页面覆盖别人刚
更新的 tags 或 description。

## 10. 推荐、复制与跨入口管理

### Featured 推荐

Featured 页面把“已配置顺序”和“实际上线”分开：

- paused、暂时资格失效或主图暂时不可公开的角色仍保留 configured；
- effective 使用与公开 Feed 相同的实时受众谓词，条件恢复后自动上线，无需再保存；
- 保存必须携带页面加载时的配置版本；若另一位操作者先保存，页面会显示 409
  冲突、刷新当前版本与 configured ids，同时保留你的 draft，供核对后重新提交；
- 页面显示的 duplicate、blank、non-string 或 overflow diagnostics 是历史配置
  需要修复的真实结果，不应静默忽略。

### Character duplicate

复制角色不会共享原角色的 MediaAsset 或 blob。副本图片归新角色/用户独立
所有，默认 private、`safetyStatus=unknown`，不会继承平台 approval 或 quality
权威；有原始 blob 时会复制成独立可读取字节。来源角色或图片以后归档/删除不
会让副本失效，但副本必须独立完成审核与发布。若 source archive/delete 已先
获得媒体锁，duplicate 会失败且不会留下半成品。

## 11. 常见问题

| 现象 | 原因 | 处理方式 |
| --- | --- | --- |
| 首肖像 Generate 不可点击 | 没有可用 bootstrap profile，或缺少创建权限 | 保持在 Assets，处理页面列出的 bootstrap profile 阻断，或联系权限管理员 |
| 已有身份但 Generate 不可点击 | identity/reference/route/readiness 未完成，或缺少创建权限 | 点击 `Complete visual setup`，完成 Reference Set / route readiness，或联系权限管理员 |
| 候选一直显示 pending/running | 异步生成仍在执行 | 等待自动刷新；必要时点 `Refresh` 并检查 Run lineage |
| 提交后提示结果未知 | POST 响应丢失，服务端是否提交尚待确认 | 使用恢复卡片的 `Resume`；系统会复用精确 body/key，不要创建新请求 |
| 页面显示 committed 但结果未出现 | receipt 已提交，读模型投影尚未追上 | 使用 `Verify`；它只做 GET，不会再次审核、采用或创建 |
| 另一个标签页突然锁定动作 | 同 actor/scope 已有 recoverable intent | 回到最先提交的标签页完成，或在当前页采用并核实该 intent；不要清 storage |
| Reference Set 发布返回 409 | active id/revision 已被其他操作者更新 | 刷新 Visual Identity，核对 current authority 后重新明确提交 |
| 只有部分图片完成 | 批次允许部分成功 | 直接审核已完成候选；失败项按 Run 故障流程处理 |
| Approve/Reject 不可点击 | 缺少 `creative.run.review`，候选无 Asset，或素材已被采用 | 检查权限与候选状态 |
| More like this 不可点击 | 精确路线不支持 source、source+identity 组合，或 reference 容量不足 | 阅读页面 blocker；修复 profile/workflow/route，不要减少 canonical references |
| Select 不可点击 | 尚未批准身份，或缺少 `character.project.write` | 先批准候选，再确认项目写权限 |
| Select 返回版本冲突 | 其他操作者已更新 Character Project | 刷新工作区，核对最新草稿后重新选择 |
| Select 被 active Release 阻止 | 当前已有候选发布快照 | 先处理 active Release，再修改草稿资产包 |
| Superseding rejection 被阻止 | 候选仍在 draft pack 或 active Character Look 中 | 先采用替代图片，或在 Visual identity 归档不再需要的 Look |
| Preview 某个 surface 显示 missing/unavailable | 精确三槽资产缺失、不可用、重复或已漂移 | 返回 Assets 修复指定 slot，重新生成 Preview；不能依赖 portrait fallback |
| 旧 Live Preview 链接突然不可用 | Serving 已暂停/恢复、rollback、切换 Release 或 version 变化 | 从 Character Workspace 获取新链接；旧 token 不会复活 |
| Preview 变了但线上没变 | 这是预期的草稿/Serving 分离 | 完成 Release 审核、校验与发布 |
| Library / Gallery 无法归档、私有或删除 | 图片仍被角色或投放 authority 使用 | 按依赖 deep link 先替换、撤回、归档 Look 或处理 Release/Campaign |
| 批量归档提示 stale/missing asset | preflight 后素材或依赖发生变化，或提交的 ID 不是 canonical 排序 | 刷新列表，重新选择并使用页面给出的精确排序 ID；整批不会部分写入 |
| Featured 保存出现 version conflict | 另一位操作者先更新了配置 | 核对页面刷新出的 current version/ids；你的 draft 仍在，确认后重新提交 |
| Duplicate 后不能直接公开 | 副本图片是独立 private/unknown-safety 资产，不继承原图审核 | 对副本建立独立身份、审核与 Release，不要复用来源 approval |
| Release validation 失败 | 素材不可用、角色/用途不匹配或最新审核不再通过 | 根据 validation evidence 定位具体 placement，重新批准/采用并提新 Release |

## 12. 班次交接

未完成角色交接时至少记录：

- Character ID 与 Assets deep link；
- 已完成到哪一个资产类型；
- 当前推荐候选对应的 Run ID；
- 等待中的生成或阻断项；
- 是否存在 active/needs-rebase Character Look；
- 是否存在 active candidate Release；
- 是否存在等待 Resume/Verify 的 durable intent，以及对应动作和 idempotency receipt；
- 是否存在 Reference Set version conflict，以及页面返回的 current active id/revision；
- Featured 是否有未解决的 version conflict 或 dirty-history diagnostics；
- 下一位操作者应执行的一个明确动作。

不要只写“图片还没好”；交接必须让下一位操作者无需重新探索即可继续决策。

## 13. 运营复盘

每日关注：待完成资产包、生成失败 Run、版本冲突和 Release 素材校验失败。  
每周关注：完成时长、批准率、变体挽救率、单个采用素材成本，并按角色风格与 Generation Route 分层找出系统性问题。
