# 核心体验质量样本

这个入口复用 Main 的正式 Chat/图片工具/Voice Clip API 和现有 probe 证据读取，支持固定角色版本、跨会话事实检查、原键重放、图片局部编辑、声音原资产重播与历史回访。它不参与角色发布，不修改 Soul、Release、视觉或声音配置，也不生成主观评分。

## 五个样板

| case | 现有角色 | 差异与范围 | 审计身份 |
| --- | --- | --- | --- |
| navigator | Mara Vale Launch，28 岁 | 沉稳航海向导；现代 Release、Fish 复制声 | seed-chat-probe-user |
| photographer | Mira Audit 20260902，28 岁 | 机智城市摄影师；现代 Release、系统默认声 | seed-chat-probe-user |
| social | Alexa Reeves，19 岁 | 自信社交角色；现代 Release、系统默认声 | seed-chat-probe-user |
| gardener | Leo Audit 20260902，29 岁 | 男性园艺伙伴；私有内容版本、Pocket 复制声 | 该角色现有 audit owner |
| creative | Audit Mira 0905，28 岁 | 水彩老师；私有内容版本、系统默认声 | 该角色现有 audit owner |

这组覆盖人格、任务、性别和两类声音权威；当前都是 realistic，不能声称已覆盖 anime。默认角色与 audit owner ID 在 `suite.ts`。Pin 时会重新核对年龄、内容、可访问性、视觉引用和声音权威；ID 失效会直接失败。换环境或替换库存时显式提供五个 `--characters` 及对应五个 `--actors`，不得将 customer/internal 账号改标为 audit 来通过检查。

## 运行

从仓库根目录执行。日志和媒体写入 gitignored `.tmp/character-quality/`，避免评估过程改变 source hash。

```sh
bun run --filter @idream/main quality:characters pin --manifest ../../.tmp/character-quality/baseline.json

bun run --filter @idream/main quality:characters run \
  --manifest ../../.tmp/character-quality/baseline.json \
  --output ../../.tmp/character-quality/navigator-text.json \
  --case navigator
```

`bun --filter` 的脚本工作目录是 `packages/main`，所以上面的输出路径带 `../../`。也可以从仓库根目录直接使用：

```sh
bun --env-file=packages/main/.env packages/main/src/scripts/character-quality/run.ts pin \
  --manifest .tmp/character-quality/baseline.json
```

- `pin` 只读取本地数据库及声音权威，保存完整 Soul/Opening/Appearance、Release、VisualProfile、ReferenceSet 与引用素材元数据，另记录当前 source revision。缺少能力不会被“可正常拒绝”算作完成。
- `run` 每次只选一个 case。按 navigator、photographer、social、gardener、creative 顺序串行，先跑文本样本，再选最低充分媒体样本。实际执行的 source revision 写在每份报告里。
- 文本模式运行初识、选择与事实写入、归档后新会话回忆，随后重放同一提交键并重新读取历史。随机标签使用现有 Gate-E 可观测的 `idreamrecall_` 加 32 位十六进制；必须完整逐字回忆，前缀和省略号不能通过。blue/window 是字面线索检查，语义正确性仍需审阅实际回复；回忆问题不带答案。另检查 Main 固定版本、终态、DSH 权威及记忆投影、原记忆证据和单次 Chat 额度事实。
- 加 `--media` 时，该次 run 继续请求一张图片、只改变笔记本颜色的编辑和初识回复的声音。记录成品文件、Job/profile/recipe、持久化证据、扣费、图片编辑来源与声音原资产重播。它实际消耗当前 audit 账号已有额度和模型资源；请与其他模型任务串行。
- 初始文本与媒体模式属于不同样本，使用不同输出文件。想跑完整样本，应从一开始就加 `--media`；不能把已完成的文本报告改成媒体模式以虚构同一次完整旅程。
- 已有普通 audit 对话会经正式 archive 留在历史中，原 ID 记在 `archivedPriorSessions`。正在生成的对话或其他 Quality run 不会被抢占。当前产品没有 unarchive 入口，因此清理后旧会话仍在历史中，不直接写 `activeKey`。
- 请求前保存逻辑步骤和原幂等键；未知结果/观察超时后用原命令加 `--resume`。已终态失败的 Turn 或 Voice request 不会自动重生成。媒体恢复会重新观察原 job、资产和账本；先等待最多 30 秒让 Main 持久化证据完成，仍未通过就停止，不能越过它消费下一阶段。Voice 若仍运行，只读观察原请求；缓存成功后比较重播前后用量事实保持不变。每次失败保存在 `failures`，恢复不会抹掉原失败或先前持久化观察。
- 报告包含受控提示词、完整实际回复与素材路径，不包含登录 token。只记录自动事实，主观 review 六个维度始终从 `pending` 开始。观看图片、听完整音频、走真实浏览器历史后，另记录审阅人、时间、具体证据和观察，不可根据非空回复或 HTTP 200 编造质量分。

同一角色/内容/引用/声音权威改变后，旧 manifest 会拒绝执行。重新 pin 并使用新报告，保留旧样本作为对照。报告不负责模型供应商版本准入或生产 launch gate。

`promptVersion=2` 修正了首轮 `idreamquality_` 标签与 Gate-E 指标不匹配的问题。缺少该版本的旧 manifest/report 不能直接恢复为新样本；重新 pin 到新文件并开始新报告。旧报告仍可按原归属清理。旧回忆被截断的实际失败继续保留，不能因为检测器修复改为通过。

每次 `--resume` 都追加实际 source revision，步骤保留首次提交的 source。跨代码版本恢复仍沿用原幂等键，但 `sourceRevisionConsistent=false`，不能成为冻结候选的完整体验证明；修复后的正式比较需要新报告。

Chat 的 `elapsedMs` 从该逻辑请求开始计到 Main 终态，`observedElapsedMs` 另含 SSE 与后台记忆投影观察等待。图片的 `jobWallMs` 包含排队和生成，`deliveryObservedElapsedMs` 还含下载与证据观察；它们不是纯 GPU 时间。Voice 的 `elapsedMs` 使用持久请求时间，交付观察另计，避免将重播/下载计为合成延迟。

## 清理和证据边界

```sh
bun run --filter @idream/main quality:characters cleanup \
  --output ../../.tmp/character-quality/navigator-text.json
```

清理只删除报告中有确切 actor/角色/Quality 标题归属的本次 Chat sessions，经正式 API 等待 Main 记忆重建并验证 404；保留被归档的旧对话、业务账本和生成历史。进行中的 Turn 会阻止清理，应先通过产品取消再重试。短期认证 Session 在每次命令退出时删除。

`summary.execution=completed` 只表示请求范围的自动事实成立。`scope=text-only` 时 `fullExperienceComplete=false`；媒体缺失、错误或事实失败不能通过。即使完整范围自动通过，`subjectiveReview=pending` 和 `productQualityApproved=false` 仍保留，自动技术检查不等于产品吸引力、跨日留存、浏览器体验或生产就绪。

该固定英文样本先形成可重跑的最小基线。中文自然度、真实跨日回访、长对话、多角色比较、anime、多规格视频与真实客户反馈需要另行采样，不能由此签发。

## 验证工具本身

```sh
bun run --filter @idream/main test:pure \
  src/scripts/character-quality/suite.test.ts \
  src/server/probe-chat-service.test.ts \
  src/server/probe-generation-persistence.test.ts
```

测试覆盖 Gate-E 标签契约、完整标签拒绝截断、旧样本版本隔离、媒体失败恢复前置条件、Voice 不隐式重试、持久化观察等待/超时、audit/owner 隔离、原 probe 身份限制，以及没有媒体时不能签发完整体验。实际模型输出和浏览器主观审阅始终由一次真实执行的报告证明。
