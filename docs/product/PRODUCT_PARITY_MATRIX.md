# iDream 产品对标与验收矩阵

更新日期：2026-10-02

本表把目标功能映射到用户故事、已有证据入口与后续验收。目标来自 [PRD](PRD.md)、[功能地图](ProductFeatureMap.md)、[9 月 1 日公开快照](../research/OURDREAM_PRODUCT_PARITY_SNAPSHOT_2026-09-01.md) 及 [9 月 5 日复核](../research/OURDREAM_PRODUCT_REVIEW_2026-09-05.md)。当前状态按 2026-10-02 的 canonical 与本机报告更新，详见 [覆盖记录](CURRENT_FUNCTIONAL_COVERAGE.md) 和 [剩余工作](REMAINING_WORK_EXECUTION_PLAN.md)；历史报告保留原日期/版本。已有真实 Chrome 单域闭环，但当前源码又有变化，最终全仓检查/构建、fixture E2E 与真实产品资格尚待统一 source，不能继承旧 `57adf7f…` 媒体签发。

本轮支付、年龄检查、合规及 AF-03 排除。目标环境尚未提供，先完成本机与部署材料；109 migration/checksum、28 项新增表 CRUD 已核对，完整同 quiesced 边界恢复材料 ready、尚未 execute。这些范围不删除完整产品目标，也不代表公开运营已认证。

## 判定规则

对标关系与交付状态是两个维度：

- `matched`：观察范围内的能力与任务结果匹配；`equivalent`：组织不同，但有逐项等价证据；`intentional_divergence`：已明确记录的自主产品选择；`pending`：仍有差距或证据不足。前三项不能替代交付状态。
- 交付状态按能力记录：未实现、部分实现、受控本地验证、受条件限制、公开生产认证、未复核。每条认证注明范围、source revision、日期、环境与证据；不为混合域强贴单一“已完成”。
- 下面是域级验收入口，不是每个按钮和 Catalog 项的最终签发。实施时在对应域下追加具体 PRD/故事 ID、代码位置、浏览器/运行报告与判定。现有各域整体均为 `pending`；支付方式、资产到期权利等已定偏离单独记录，不能用偏离掩盖未交付能力。

## 范围、证据与退出条件

下表分开记录当前实现与历史资格；已有实现不等于目标环境已发布，也不自动继承旧版本运行结果。

| 域 / 阶段 | PRD → 故事 | 已有记录与待验收差距 | 域的退出条件 |
| --- | --- | --- | --- |
| 账号与访问 A | AG、AC → US-AG、US-AC | 支付/年龄完整流程未包含在前轮核心审计；新增恢复和删除故事待逐项复核 | 年龄门槛、注册、恢复、退出、删除和跨账号隔离；深链与草稿恢复 |
| 发现 A | EX → US-EX | 有角色发现、作者分页等记录；完整筛选、排序与内容类型须按故事复核 | 组合筛选/无结果/分页/详情/登录后原任务均可用；不出现假入口 |
| 角色创建 A/B | CR → US-CR | 五步创建、视觉/声音与恢复已有证据；本轮两标签 CAS 已真实 Chrome 验证。六类任务和目录语义尚需逐项等价判定 | 全字段、回退、刷新、候选失败、私有使用与显式发布；数量不能代替语义 |
| 单角色 Chat A/B | CH-01～12、15/16 → US-CH-01～11、14 | CH-16 Catalog/偏好冻结已实施；opt-in 主动消息已有实现，完整权限/调度/质量待验。Scene policy 14 canonical/173 纯测试绿，但实际 13-case screen 仅执行 2 case/3 requests、1 pass/1 fail，Lila 句误完成 `call the hotel`；7 个 component SHA 全同当前，未取得 whole-source 新 PM2 资格，已停止继续消费。原 47 的 40 pass/7 fail 与较早 screen 保留，新 7 封存未消费。CH-15 ASR 有受控链路，欧洲 25 语质量未合格 | 编辑/重生成/跨日恢复、上下文控制、角色身份及一次交付/扣费一致 |
| 图片 A/B | GN → US-GN-01～13 | Create/Edit/Enhance、Advanced seed/model 与冻结 Chat context 已实施。本轮默认 5 coin 图技术 PASS、像素 FAIL；单源 edit 与 2-reference identity 真像素 PASS。保留各样本 source，尚缺新统一版本与广度资格 | 报价→生成→交付→保存/下载，含来源、身份、失败/未知/部分交付和重复提交 |
| 视频 B | GN、CH-06/07 → US-GN-01/02/08/14、US-CH-06 | GN-19 109 已实施 1–3 scenes、时长/比例/质量、可选英文 voice 与 composition lease；v3 disabled draft 无 native provider 资格。默认 RedGraft 100 coin 视频跨 07:03 merge、像素 FAIL，原结果保留；H3 仍禁用 | 质量与身份一致、可播放下载、精确可用参数；Chat 内视频独立验收；历史仍可访问 |
| Voice Clip / Call B | CH-07/14 → US-CH-06/13、Journey H | Voice Call 106 已实施；本机 English recorded upload→ASR→Ornith→Pocket、播放/持久化、expired quote/resume 有真实证据。physical mic、设备广度与欧洲 25 语未 qualified；不能用片段播放替代通话资格 | 分别验收片段与通话，覆盖权限、声音身份、中断/结束、时长用量与恢复 |
| 个人资产 A/B | PF-01～04、09/10 → US-PF-01～04、09/10 | 有媒体分页、筛选、预设应用和历史恢复记录；账号删除等边界须专项核对 | 各资产面真实可达，搜索分页完整；删除说明、归属与到期访问一致 |
| 社区与创作者 B | PF-05～07、11/13 → US-PF-05～08、11、13/14 | 作者页、合集与发布已实施；本轮合集撤回与私有成果保留有 Chrome 单域证据。Feed、Creator levels/Studio 完整资格与收益链尚未签发 | 发布→发现→互动→回访；Remix 来源授权、撤下与隐私；收益可对账 |
| Group Chat B | CH-13/15、PF-08 → US-CH-12 | 2–12 角色、成员管理、指定回复者和 Main 历史链已实现，profile 偏好保存有 Chrome 记录；完整同版身份/记忆/媒体/恢复资格待验证 | 最多 12 角色目标，参与者权限、指定回复者、历史、记忆、媒体和计费一致 |
| Packs / Comics B | PF-08/12/14 → US-PF-12/15 | 免费 Pack 108 的实体/private Blob copy/immutable Grant、领取下载播放、撤下保留与 block 拒绝内容已有原生闭环；不证明购买。Comics 发布→游客完整阅读→真实 Remix→撤下有单域证据，整轮新 source 尚待验收 | Pack 免费领取与购买分别记录权利；Comic 连续阅读/来源/Chat 或 Remix；不能用普通图库替代 |
| 预付访问 / Coin Store A/B | UP → US-UP | 预付访问及独立 Coin Store 的 offer/checkout/确认后幂等入账/历史/恢复已有实现，仍缺真实支付与完整旅程资格；测试加币不证明充值闭环 | 真实支付确认→权益/入账→原任务→到期/重新购买；延迟、取消、失败和重复通知 |
| Affiliate B | AF → US-AF、US-SE-05 | AF-02 107 不可变归因、材料、撤销/运营已实施；原独立 Chrome E RED 不变，修复后 F 原生 landing/signup/recovery ack/Continue、PG exact 1 归因与唯一 signup_bonus 绿，A 刷新 2 visits/2 signups/F Valid。4 文件 SHA 与 19/19 green 全同，属旧 `57adf7f…` PM2 env/HMR 的 native scoped proof，新 whole-source wrapper 资格尚待。AF-03 排除本轮 | 申请→链接→有效转化与运营排障；收益/结算另行取得资格，与用户邀请奖励分开 |
| 帮助与支持 A/B | SF、AC → US-SF、US-AC | Help Desk resolve 与 Case→Support 迟到导航修复有真实 Chrome 单域证据；完整帮助分类、其他案件和新统一 source 仍待核对 | 帮助→工单→补充→结果/继续跟进；客户与内部信息隔离，举报申诉可追踪 |
| 公开内容 B | SE → US-SE-01～04、06 | Images/Videos/Glossary/Authors 四族 10 个实际发布路由及 index/detail/CTA 已有真实 Chrome 证据；完整目标库存和新 source 尚未整体签发 | 内容有实际用途，导航/CTA/分页可用；索引仅含发布内容 |
| 移动与跨域 A/B | PRD §11 → US-MB、UserStory §3.1 | 有历史窄屏证据；新增故事组合未复验 | 输入法、滚动、播放器和关键操作可达；刷新/断网/换号不破坏任务与权限 |

## 已明确的自主选择

| 项目 | 判定 | iDream 决策与理由 |
| --- | --- | --- |
| 支付方式与续期 | intentional_divergence（产品决策，交付待验收） | 加密货币、一次性预付周期访问；按自身支付能力提供透明续购，避免伪造自动续订 |
| 到期后的历史与资产 | intentional_divergence（产品决策，逐路径验收） | 保留已交付/已购资产访问；不通过锁回用户作品促进续购 |
| 套餐与角色身份 | intentional_divergence（产品决策，逐能力验收） | 套餐购买资源与高级能力，基础人格和记忆质量保持一致 |
| 创建分步与目录 | pending equivalent | 五步可承载六类任务，但仍需逐项字段和恢复验收；不要求仅为外观相似拆成六页 |
| 日常发布 | intentional_divergence（产品决策，运行证据见覆盖记录） | 基础自动检查后准备并显式发布，无日常人工批准；保留异常、举报和申诉处理 |

## 下一轮取证

先处理媒体/Scene 质量与 GN-19 draft 资格；policy 14 的失败 screen 已停止，不继续同失败消费。AF F 已有组件范围原生 proof，仍须随最终 source 完成统一 wrapper 验证。冻结后执行全仓验证、真实产品链路及本机完整恢复；支付/年龄/合规/AF-03 本轮排除，目标环境未提供时先完成可执行部署材料，不能放宽 launch gate 宣称上线。新增竞品线索（七种聊天模型、Fusion）须核实实际入口、任务、资格和费用后再进入需求变更。每项退出以用户任务、异常恢复和权利/账本一致为证据；组件 SHA 相同、模型跑通、页面存在或材料齐全均不签发整个产品。
