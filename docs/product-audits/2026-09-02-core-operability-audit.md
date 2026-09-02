# 2026-09-02 核心产品与运营审计

本轮验证现有产品的用户任务和运营闭环，重点为 Chat、Create、图片、视频、角色管理及客服。基线为 `6139a4ae707a324e845849e6aa8921ef063654fc`。运行环境是本机真实 Main PostgreSQL、Chat/DSH、Ornith、Pocket TTS 和 ComfyUI；浏览器使用 Chrome 隔离测试账号。支付和年龄功能不在本轮范围。

代码、数据库、浏览器和运行证据必须分别判断。这里登记已经完成的真实旅程及修复范围；最终冻结版本、命令退出码、完整用例数量、重启和恢复结论统一见工作区 `.tmp/product-audit-20260902/FINAL_REPORT.md`。此文件不预先宣告公开部署成功。

## 已执行的真实任务

| 用户任务 | 结果与证据 |
| --- | --- |
| 注册并开始聊天 | 新测试账号，Melissa 会话 `b77d9d31-451c-401e-bb4b-0734f987e65a`；发送、历史刷新、编辑、停止、重生成、删除完整 Turn 均实际执行。 |
| 在聊天中要一张图片 | Qwen Job `cmtk3qp10000ikpl7v8pxaiou`，约 107 秒、8 coins；重生成复用同一 Job/Media/一次扣款。 |
| 根据原图修改 | Job `cmtk5bt320003xnl7q9s6fh56`，约 107 秒、8 coins；原脸、姿势和咖啡馆保持，开衫改为 navy。 |
| 自由生图 | Job `cmtk5id71000qxnl7g60fgxaf`，RedMix3、512×640、5 coins；真实图像交付并对账。 |
| 生成并播放默认视频 | RedGraft Job `cmtk4dzsr001pkpl7p1y1kzen`，768×1152、100 coins；耗时 832514 ms，Chrome duration=5.041667，实际播放结束。 |
| 生成并播放 H3 视频 | Job `cmtk5yv0l001rxnl7f6qqy6n4`，512×512、100 coins；含排队 1061811 ms，Chrome duration=5.167，实际播放结束。 |
| 创建完整自定义角色 | Leo `cmtk80uim008bxnl7vpt0fx08`，四张真实候选、确认、刷新恢复和私有保存；外观、Soul、开场、active VoiceProfile 全部落库。 |
| 新角色聊天及所选声音 | 会话 `272d873d-9650-4703-b61d-763d7ecfa609`，实际角色回答番茄问题；Marius/Pocket 开场音频 3.68 秒播放结束。 |
| 新角色延续身份生成 | Job `cmtk85bk7008wxnl7wh8zwt2g`，Qwen、832×1024、8 coins；同脸/发型/绿衫，屋顶花园持番茄，用户点击 Looks like them。 |
| 删除语音后重播 | 同聊天页保留缓存，My AI 删除 → Play 404 → 下一次显式 Play 201/206恢复；同请求/媒体、唯一原始用量事实、余额不变。 |
| 找回历史媒体 | 40 条临时分页夹具证明第二页可达，夹具已删；服务端 navy 搜索实际找到早前两张图；创建私有集合。 |
| 从运营创建可用角色 | Mira `682d1e44-7e6b-4139-ac05-c2c108d68be2`，生成、拒绝、重试、审核、三图采用、Preview、Release、Serving、用户发现与聊天。 |
| 发布新版本及回滚 | Mira Release 1 → Release 2 → pause/resume → rollback；旧会话 pin 不变，新会话 `f87cbd25-58c6-4667-8bdd-4a48ec6cb11c` 采用回滚版开场。 |
| 不上目录但链接可访问 | Alexa 保持 unlisted，非创建者直链详情、实际 Chat 回复、Generate 角色预选通过；Mara 发布新 Soul v3 保持 unlisted。 |
| 客服完整沟通 | `SUP-X4K1B1TX2U`：客户发起、分配/优先级、运营询问、客户回复、解决、重开、再回复、关闭；公开历史完整、内部原因不泄漏。 |
| 运营文字辅助 | 真实 Character Assist 与 4 个 Production Directions 返回 200；22.93 秒，Ornith/Pipeline 8061，单次探针登录会话已清理。 |

## 修复原则与覆盖

- 对真实行为补回归，保留既有目录/分层，不引入第二套状态权威。
- JSONB 比较使用语义相等；候选恢复绑定生成配方和真实输入，音色选择不改变视觉身份。
- 声音选择进入 active CharacterVoiceProfile；媒体失效只清对应缓存，用户再次播放才重交付。
- 图片生成必须获得当前用户明确请求或对紧邻图片提议的确认。摄影讨论误触发问题已复现并修复；Chat 工具暴露/执行和 Main 冻结 Turn 权威共同约束，引用命令、否定和编辑旧请求不能授权扣款。最终真实 Chrome 反例与正例结果仍以本轮最终报告为准。
- 确认图片提议时保留同条消息内的视觉场景；新动作不再以词汇相似的旧图冒充，已接受动作的重生成仍复用原结果。
- 准备失败确认未调用 provider 时，最后一次重试写入持久终态并只退款一次；存在调用记录则保留 unknown。历史队列耗尽且缺少可靠终态时停止自动重排，交运营核对，保留费用和调用证据。
- Generate、Chat 附件和 Create 预览把未知结果显示为需要核对，停止虚假的排队提示并提供客服入口；Create 再次检查保留原 previewJobId，不重复提交。
- 新设备恢复未知预览时只检查服务器已有任务，完成后恢复实际单张候选。Incident 的重试建议和预览复用正式 Request/Attempt 重试资格：未知结果先在 Jobs 核对失败并退款，再允许新 Attempt，不再推荐必然执行失败的快捷重试。
- Release 使用生成时固定的版本和审核证据；当前路由改变不追溯否定旧合法图像。发布保留运营开关与 public/unlisted 选择。
- 详情、聊天和明确角色的生成使用直接访问资格；Explore/Feed/排行仍使用目录资格。共享角色仍须经过现有发布链。
- 私有角色的视频报价、创建、派发和失败重试统一使用创建者或合格直链访问资格，保留角色锁和原图固定校验。Leo 原页面的报价从 404 恢复为 200/100 coins；真实隔离数据库验证了扣款、准备失败退款、原图变化拒绝重试、恢复后单次重试与幂等重放。他人的私有角色继续拒绝，最终真实视频交付另记。
- Case/Support 同事务同步；历史案件不能越过最新 episode 接收后续客户回复。
- My AI 的预设按名称展示和搜索，点击后从当前用户的预设列表应用到 Generate；不自动提交生成。Recent 直接打开记录的 Chat session，标签页与 URL、刷新和浏览器返回保持一致。真实 Chrome 已完成保存预设、检索、应用提示词、返回原标签和恢复 Mira 原会话，余额不变。
- 生成发布门按 Gen 的真实图片、普通视频和 H3 地址分别核对执行证据，保留各自运行时默认值；错误后端地址仍拒绝，不再把三个独立服务误当作同一个地址。
- 测试数据库、Redis、端口和构建目录使用隔离资源；全套测试/构建与浏览器测试串行。

## 证据位置

所有本轮原始日志与结构化报告位于 `.tmp/product-audit-20260902/`。关键文件：

- `runtime-evidence.json`：只读、带时间窗口的 Session/Turn/Job/Attempt/Transport/Artifact/Delivery/Settlement/Media/Voice/Ledger 对账。
- `create-voice-release-real-chrome.json`：Leo 创建、同页语音恢复、unlisted 和 rollback 的真实 Chrome 与 DB 记录。
- `support-lifecycle-real-chrome.json`、`profile-pagination-real-chrome.json`、`h3-real-chrome.json`：对应实际产品旅程。
- `image-main-persistence-iteration1.json`、`video-main-persistence-iteration1.json`、`h3-main-persistence-iteration1.json`、`leo-image-main-persistence-iteration1.json`：按 Job 读取完整落库链。
- `admin-text-iteration1.json` 与 `chat-full-ready-iteration3.json`：本轮中间运行证据；最终重启后证据须另行重跑，不能改写报告版本冒充新执行。
- `FINAL_REPORT.md`：最终代码冻结、测试/构建、Chrome 组合、恢复演练、运行状态及明确未完成项。

完整 OurDream 对标中仍未实现的能力继续由 `REMAINING_WORK_EXECUTION_PLAN.md` 跟踪。公开站点、对象存储、域名/HTTPS、环境密钥及观测配置也不能由本机验证推定为已部署。
