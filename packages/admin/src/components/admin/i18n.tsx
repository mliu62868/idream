"use client";

import { createContext, useContext, type ReactNode } from "react";
import { adminZhCoverageA } from "./i18n-zh-coverage-a";
import { adminZhCoverageB } from "./i18n-zh-coverage-b";
import { adminZhCoverageC } from "./i18n-zh-coverage-c";
import { adminZhCoverageD } from "./i18n-zh-coverage-d";
import { adminZhCoverageE } from "./i18n-zh-coverage-e";
import { adminZhCoverageF } from "./i18n-zh-coverage-f";
import { adminZhCoverageG } from "./i18n-zh-coverage-g";

export type AdminLocale = "en" | "zh";

const ADMIN_LOCALE_STORAGE_KEY = "idream.admin.locale";

const zh: Record<string, string> = {
  ...adminZhCoverageA,
  ...adminZhCoverageB,
  ...adminZhCoverageC,
  ...adminZhCoverageD,
  ...adminZhCoverageE,
  ...adminZhCoverageF,
  ...adminZhCoverageG,
  "Access denied": "访问被拒绝",
  "Active immediately": "立即启用",
  "Active sessions": "活跃会话",
  "Active subscriptions": "活跃订阅",
  Action: "处理",
  Adjust: "调整",
  "Admin access denied": "无后台访问权限",
  "{count} assets imported": "已导入 {count} 个资产",
  "{count} assets imported from server path":
    "已从服务端路径导入 {count} 个资产",
  Age: "年龄",
  "Age verification queue": "年龄验证队列",
  "Age verification updated.": "年龄验证已更新。",
  Analytics: "分析",
  Announcements: "公告",
  "Announcement action confirmation": "公告操作确认文本",
  "Announcement action reason": "公告操作原因",
  "Announcement create confirmation": "公告创建确认文本",
  All: "全部",
  Appeals: "申诉",
  Apply: "应用",
  "Apply Civitai config": "应用 Civitai 配置",
  Approve: "通过",
  Approvals: "审批",
  "Team Access": "团队访问",
  Archive: "归档",
  "Authority & usage": "权威与使用关系",
  "Review decisions are recorded in the immutable Creative Run history.":
    "审核决定记录在不可变的创意生产批次历史中。",
  "Open Creative Run review": "打开创意批次审核",
  "Current Character Release": "当前角色发布版本",
  "Scheduled Character Release": "预定角色发布版本",
  "Character primary image": "角色主图",
  "Character project draft": "角色项目草稿",
  "Active visual identity": "当前视觉身份",
  "Published character reference set": "已发布的角色参考集",
  "Active character generation job": "进行中的角色生成任务",
  "Active character look": "当前角色造型",
  "Creative Run asset in use": "创意生产批次正在使用",
  "Verified live campaign": "已验证的线上活动",
  "Campaign verification in progress": "活动验证进行中",
  "Open authority": "打开权威工作流",
  "Replace, roll back, or withdraw these usages before archiving the asset.":
    "归档素材前，请先替换、回滚或撤回这些使用关系。",
  "This asset is not referenced by an active production, Character, Release, or Campaign authority.":
    "该素材当前未被任何进行中的生产、角色、发布版本或活动权威引用。",
  Archived: "已归档",
  Audit: "审计",
  "Audit Log": "审计日志",
  "Audit reason (≥3)": "审计原因（≥3 字符）",
  Billing: "计费",
  Blocked: "已拦截",
  "Blocked Media": "已拦截媒体",
  Body: "正文",
  "Built-in generation template": "内置生成模板",
  "Built-in Presets": "内置预设",
  "Built-in template selected": "已选择内置模板",
  "CMS / SEO": "CMS / SEO",
  "CMS pages": "CMS 页面",
  "CMS page confirmation": "CMS 页面确认文本",
  "CMS publish confirmation": "CMS 发布确认文本",
  "CMS publish reason": "CMS 发布原因",
  Cancel: "取消",
  "Chat Ops": "聊天运维",
  "Chat Service is configured but unreachable.":
    "Chat Service 已配置但暂不可达。",
  "Chat Service is not connected.": "Chat Service 未连接。",
  "Chat Service is not connected: CHAT_SERVICE_URL is missing.":
    "Chat Service 未连接：缺少 CHAT_SERVICE_URL。",
  "Chat Service rejected the internal admin token.":
    "Chat Service 拒绝了内部 admin token。",
  "Chat Service responded, but the internal admin API returned invalid JSON.":
    "Chat Service 有响应，但内部 admin API 返回了无效 JSON。",
  "Chat Service status": "Chat Service 状态",
  "Chat Service internal admin API returned an error.":
    "Chat Service 内部 admin API 返回错误。",
  "Chat moderation events": "聊天审核事件",
  "Chat usage and quota": "聊天用量与额度",
  "Character ID": "角色 ID",
  CHAT_SERVICE_URL: "CHAT_SERVICE_URL",
  "Choose template": "选择模板",
  Close: "关闭",
  "Clipboard read failed. Paste manually.": "读取剪贴板失败，请手动粘贴。",
  "Clear LoRA": "清空 LoRA",
  Clean: "无举报",
  "Coin economy by reason": "金币经济按原因",
  Compliance: "合规",
  Confirm: "确认",
  "Confirm announcement activation": "确认启用公告",
  "Confirm announcement deactivation": "确认停用公告",
  "Confirm announcement delete": "确认删除公告",
  "Confirm age verification override": "确认年龄验证人工裁决",
  "Confirm CMS status change": "确认 CMS 状态变更",
  "Confirm configuration check": "确认配置检查",
  "Confirm dry-run": "确认试运行",
  "Confirm erase": "确认擦除",
  "Confirm erasure for": "确认擦除用户",
  "Confirm override": "确认裁决",
  "Confirm publish change": "确认发布变更",
  "Confirm rule key": "确认规则键",
  "Confirm save": "确认保存",
  "Confirm update": "确认更新",
  Confirmation: "确认文本",
  Content: "内容",
  "Consistency rate": "一致性比例",
  "Consistent samples": "一致样本数",
  Conversion: "转化率",
  "Converted Model": "转换后模型",
  "ComfyUI reference template": "ComfyUI 参考图模板",
  "Cost Multiplier": "成本倍率",
  "CVP identity prompt + stable seed. No reference image is sent.":
    "使用 CVP 身份描述和稳定 seed，不发送参考图。",
  "Base Cost (coins)": "基础费用（金币）",
  CFG: "CFG",
  "Civitai config paste": "粘贴 Civitai 配置",
  Create: "创建",
  "Create Draft": "创建草稿",
  "Create / overwrite page (draft)": "创建 / 覆盖页面（草稿）",
  "Create announcement": "创建公告",
  "Create character template": "创建角色模板",
  "Create Model Profile Draft": "创建模型配置草稿",
  "Create official character": "创建官方角色",
  "Create Prompt Recipe Draft": "创建提示词配方草稿",
  "Create Pricing Rule Draft": "创建定价规则草稿",
  "Create redeem code": "创建兑换码",
  "Configuration check": "配置检查",
  "Configuration check confirmation": "配置检查确认文本",
  "Configuration check failed": "配置检查失败",
  "Configuration check reason": "配置检查原因",
  "Configuration version": "配置版本",
  "Link URL (optional)": "链接 URL（可选）",
  "Currently featured": "当前推荐",
  Configured: "已配置",
  "Live featured": "实际上线推荐",
  "Configured · not live": "已配置 · 未上线",
  "Featured configuration saved": "推荐配置已保存",
  "Stored Featured configuration needs repair": "已存推荐配置需要修复",
  "The canonical preview below is safe and de-duplicated. Save it to repair the stored configuration.":
    "下方是已安全规范化并去重的预览。保存后即可修复历史配置。",
  "Another operator changed Featured before your save.":
    "另一位运营人员已先行修改推荐配置。",
  "Latest authority was refreshed. Your draft remains in the fields; review it and save again to apply it.":
    "已刷新到最新权威版本；你的草稿仍保留在输入框中。确认后再次保存即可应用。",
  "Current version": "当前版本",
  "Current configured IDs": "当前已配置 ID",
  "Skipped invalid character IDs": "已跳过无效角色 ID",
  "These characters were not found or cannot be configured, so they were not saved.":
    "这些角色不存在或不可配置，因此未保存。",
  "This order is the saved configuration. A character is live featured only while the public audience authority also passes, including its primary image, Character Release, qualification, and Serving state.":
    "这里显示的是已保存的推荐顺序。只有主图、角色发布版本、上线资格与 Serving 状态同时满足公开受众条件时，角色才会实际上线推荐。",
  "Featured configuration and live status": "推荐配置与实际上线状态",
  "No configured featured characters": "尚未配置推荐角色",
  "Runtime state": "实际上线状态",
  Blockers: "阻塞原因",
  Order: "顺序",
  Position: "位置",
  "Resolve blocker": "处理阻塞",
  None: "无",
  "character not operational": "角色不在运营清单",
  "setting not object": "历史配置不是对象",
  "character ids not array": "历史角色 ID 配置不是数组",
  "character id not string": "角色 ID 不是文本",
  "character id blank": "角色 ID 为空",
  "character id duplicate": "角色 ID 重复",
  "character id overflow": "角色 ID 超过 24 个上限",
  "character deleted": "角色已删除",
  "character not public": "角色未公开",
  "character not approved": "角色未通过",
  "creator not publicly eligible": "创作者不符合公开条件",
  "character source ineligible": "角色来源不符合条件",
  "avatar missing": "缺少主图",
  "avatar not image": "主素材不是图片",
  "avatar deleted": "主图已删除",
  "avatar not public": "主图未公开",
  "avatar not passed": "主图未通过审核",
  "avatar synthetic": "主图是测试合成资产",
  "avatar platform ineligible": "主图在图片库中不可用",
  "serving not live": "Serving 未上线",
  "current release missing": "缺少当前发布版本",
  "current release not published": "当前发布版本未发布",
  "current release not ready": "当前发布版本未就绪",
  "qualification missing": "缺少公开目录资格",
  "qualification revoked": "公开目录资格已撤销",
  "qualification invalid": "公开目录资格无效",
  "runtime audience ineligible": "不符合实时公开受众条件",
  "Character Serving is not live.": "角色 Serving 当前未上线。",
  "The current Character Release qualification is revoked.":
    "当前角色发布版本的公开目录资格已撤销。",
  "The primary character image is not public.": "角色主图当前未公开。",
  Dashboard: "仪表盘",
  "Dead-letter": "死信",
  "Dead-letter Queue": "死信队列",
  Delete: "删除",
  "Delete announcement": "删除公告",
  "Delete saved view {label}": "删除视图 {label}",
  Description: "描述",
  Delta: "变更量",
  Disable: "禁用",
  Discard: "丢弃",
  "Discard selected": "丢弃已选",
  "DSAR — export / erase": "DSAR - 导出 / 擦除",
  "Dry-run": "试运行",
  "Dry-run confirmation": "试运行确认文本",
  "Dry-run reason": "试运行原因",
  "Dry Run": "试运行",
  Dreamcoins: "Dreamcoins",
  Edit: "编辑",
  Empty: "暂无数据",
  Enable: "启用",
  Entitlement: "权益",
  Erase: "擦除",
  "Erase confirmation": "擦除确认文本",
  "Erase reason": "擦除原因",
  Escalate: "升级",
  Experiments: "实验",
  "Flag Monitoring": "功能开关监测",
  Today: "今日工作",
  "Character Studio": "角色工作室",
  "Operations status": "运营状态",
  Serving: "服务状态",
  not_live: "未上线",
  "Live release": "线上发布版本",
  "None published": "尚未发布",
  "Unpublished changes": "未发布改动",
  "Image pack": "图片资产包",
  "Live performance": "线上表现",
  "Needs attention": "需要处理",
  "No character needs attention right now": "当前没有角色需要处理",
  "Every live character has a complete image pack and is recording observations.":
    "所有线上角色的图片资产包都已补齐，且都有观测数据在进。",
  "No observations yet. The {window} window has not closed since publish.":
    "暂无观测，距发布还不满 {window} 观察窗口。",
  "No observations across a full {window} window. Check placement targeting and event delivery.":
    "整个 {window} 窗口零观测，请检查铺位定向与事件上报。",
  "Monitor refresh failed": "监控刷新失败",
  "route qualification": "图片线路资格",
  "refresh the active image route before the next Release": "在下个发布版本前刷新在用的图片线路",
  Ongoing: "持续进行",
  "Missing: {purposes}": "缺：{purposes}",
  "Live with an incomplete image pack": "线上运行中 · 图片资产包不完整",
  "What should we do with this Character based on current release evidence?":
    "基于当前发布版本的证据，这个角色应该怎么处理？",
  "Review the selected action at the next portfolio window": "在下个角色组合复盘窗口复查所选处理",
  "Do not regress qualified conversation or Same-character D7": "不得让合格对话或同角色 D7 退化",
  "Could not record portfolio decision": "无法记录角色组合决策",
  "Complete the image pack the live character is missing": "补齐线上角色缺失的图片资产",
  "Placements without an adopted asset fall back to the legacy portrait until the pack is complete.":
    "未采用资产的展示位会回退到旧版主图，直到资产包补齐。",
  Voice: "声音",
  english: "英语",
  "Voice control room": "角色声音控制台",
  "Shape the live character voice, review candidates, and control inherited defaults from one place.":
    "在一个页面中配置角色线上声音、审核候选声音，并管理系统继承设置。",
  "Current source": "当前来源",
  "Live voice": "线上声音",
  // SPEC: 声音面板的"演绎风格"必须用独立键。共用 "Performance" 会盖掉角色工作台
  // "Performance"（表现）tab 的译文——扁平词典没有命名空间，同名即冲突。
  "Voice delivery": "演绎风格",
  "Character override": "角色专属覆盖",
  "System inheritance": "系统继承",
  "Next action": "下一步操作",
  "Candidate awaiting review": "候选声音等待审核",
  "Current voice and one new candidate": "当前声音与一个新候选",
  "Current voice and runtime": "当前声音与运行线路",
  "Voice style and advanced settings": "演绎风格与高级设置",
  "Build a voice candidate": "创建声音候选",
  "Listen and activate voice version {version} when it matches the character.":
    "试听声音版本 {version}，确认符合角色后再启用。",
  "Create a reviewed candidate without changing the live voice.":
    "先创建可审核的候选声音，不会直接改变线上声音。",
  "Review candidate": "审核候选声音",
  "Build candidate": "创建候选声音",
  "Character voice": "角色声音",
  "Character-specific cloned voice": "角色专属克隆声音",
  "System default voice": "系统默认声音",
  "This character overrides the system default. New chat speech uses the active cloned voice.":
    "该角色已覆盖系统默认声音，新的聊天语音将使用当前克隆声音。",
  "This character has no voice override and inherits the configured system female identity and performance direction.":
    "该角色没有专属声音覆盖，将继承已配置的系统女性声音身份和演绎方向。",
  "inherits system default": "继承系统默认",
  "character override": "角色专属覆盖",
  "female character": "女性角色",
  "male character": "男性角色",
  "trans character": "跨性别角色",
  character: "角色",
  "New speech uses this system default. Existing cached clips remain unchanged.":
    "新的语音将使用这个系统默认声音；已缓存的历史语音不会改变。",
  "effective voice": "当前生效声音",
  "Reason for restoring system default": "恢复系统默认的原因",
  "Restoring system default…": "正在恢复系统默认…",
  "Use system default voice": "使用系统默认声音",
  "System voice defaults": "系统默认声音",
  "Current and draft assets": "线上与草稿资产",
  "Technical evidence": "技术证据",
  "Schedule and live operations": "定时与线上操作",
  "New portfolio decision": "新建运营决策",
  "Chat image": "聊天场景图",
  "Avatar / discovery": "头像 / 发现页",
  "This curated adult female identity applies to every character without a character-specific override.":
    "这一精选成年女性声音身份适用于所有没有角色专属覆盖的角色。",
  "System performance direction": "系统演绎方向",
  "Set the sensual character of every inherited voice. Identity and performance stay separate.":
    "设置所有继承声音的性感演绎方式；声音身份与演绎表现彼此独立。",
  "saved in Admin": "已保存到管理平台",
  "environment fallback": "环境配置兜底",
  "Global fallback": "全局兜底",
  "System female identity": "系统女性声音身份",
  "Female characters": "女性角色",
  "Male characters": "男性角色",
  "Trans characters": "跨性别角色",
  "Previewing {voice}": "正在试听 {voice}",
  "Preview {voice}": "试听 {voice}",
  "Listen before saving the default mapping.": "保存默认映射前请先试听。",
  "System voice preview": "系统声音试听",
  "System default change reason": "系统默认声音变更原因",
  "Saving defaults…": "正在保存默认设置…",
  "Save system defaults": "保存系统默认声音",
  "Read-only: generation.config.write is required to change system voice defaults.":
    "只读：修改系统默认声音需要 generation.config.write 权限。",
  "Female voices": "女声",
  "Male voices": "男声",
  "female voice": "女声",
  "male voice": "男声",
  "used here": "当前使用",
  "Rendering…": "正在生成…",
  Preview: "试听",
  "The saved system voice defaults were recovered.":
    "已恢复保存过的系统默认声音设置。",
  "System voice defaults were saved. New speech now uses this mapping.":
    "系统默认声音已保存，新的语音将使用这组映射。",
  "System voice defaults could not be saved": "无法保存系统默认声音",
  "The existing reset to system default was recovered.":
    "已恢复现有的系统默认声音重置结果。",
  "This character now inherits the system voice default.":
    "该角色现在继承系统默认声音。",
  "The character voice could not be reset": "无法将角色声音恢复为系统默认",
  "The system voice preview could not be rendered": "无法生成系统声音试听",
  "Active cloned voice": "当前克隆声音",
  "No cloned voice yet": "尚未克隆声音",
  "New chat speech uses this Pocket TTS voice. Existing cached clips remain unchanged.":
    "新的聊天语音将使用这个 Pocket TTS 声音；已缓存的历史语音不会改变。",
  "Upload one clean voice sample, verify the generated preview, and bind it to this character.":
    "上传一段干净的声音样本，验证生成的试听音频，再将其绑定到这个角色。",
  "clone ready": "可克隆",
  "clone service unavailable": "克隆服务不可用",
  "clone provider inactive": "克隆供应器未启用",
  "Pocket TTS voice cloning through oMLX is ready.":
    "通过 oMLX 运行的 Pocket TTS 声音克隆已就绪。",
  "Pocket TTS on oMLX is configured but unavailable. Verify oMLX, the pocket-tts-4bit model, and the voice adapter.":
    "Pocket TTS oMLX 线路已配置但当前不可用。请检查 oMLX、pocket-tts-4bit 模型和声音适配服务。",
  "Voice version {version}": "声音版本 {version}",
  "Active cloned voice preview": "当前克隆声音试听",
  "Candidate preview": "候选声音试听",
  "Review voice version {version}": "审核声音版本 {version}",
  "Listen to the preview before changing the live character voice. Creating a candidate never changes Character.voiceId.":
    "请先试听，再更改线上角色声音；创建候选声音绝不会修改 Character.voiceId。",
  "Candidate voice preview": "候选声音试听",
  "No preview is available for this candidate.":
    "这个候选声音暂时没有可用试听。",
  "Activation reason": "启用原因",
  "Activate reviewed voice": "启用已审核声音",
  "Activating reviewed voice…": "正在启用已审核声音…",
  "Read-only: character.release.publish is required to activate a voice.":
    "只读：启用声音需要 character.release.publish 权限。",
  "Pocket TTS must be the active voice provider before this candidate can be activated.":
    "启用此候选声音前，必须先将 Pocket TTS 设为当前声音供应器。",
  "Fish Audio must be the active voice provider before this candidate can be activated.":
    "启用此候选声音前，必须先将 Fish Audio 设为当前声音供应器。",
  "Replace voice candidate": "替换候选声音",
  "Create voice candidate": "创建候选声音",
  "Use a clean single-speaker recording. Pocket TTS on oMLX uses up to the first 30 seconds.":
    "请使用干净的单人录音；oMLX 上的 Pocket TTS 最多使用前 30 秒。",
  "Use a clean adult female single-speaker recording. Fish Audio uses up to the first 30 seconds.":
    "请使用干净的成年女性单人录音；Fish Audio 最多使用前 30 秒。",
  "Pocket TTS is not the active voice provider. Set VOICE_PROVIDER=pocket-tts and start the Pocket TTS process.":
    "Pocket TTS 当前不是生效的声音供应器。请设置 VOICE_PROVIDER=pocket-tts 并启动 Pocket TTS 进程。",
  "Voice reference audio": "声音参考音频",
  "Reference identity": "参考声音身份",
  "Upload the recording that defines the voice identity, then enter its exact transcript.":
    "上传决定声音身份的参考录音，然后填写录音中准确的转录文本。",
  "WAV, MP3, FLAC, or OGG · maximum 15 MB":
    "支持 WAV、MP3、FLAC 或 OGG · 最大 15 MB",
  "Reference transcript": "参考音频转录文本",
  "Reference transcript: {text}": "参考音频转录文本：{text}",
  "Enter the exact words spoken in the reference recording.":
    "请输入参考录音中实际说出的完整文字。",
  "This transcript is stored with the voice reference and sent to oMLX when synthesizing.":
    "转录文本会随声音参考一起保存，并在合成时发送给 oMLX。",
  "This transcript is stored with the voice reference and used by Fish Audio when synthesizing.":
    "转录文本会随声音参考一起保存，并在 Fish Audio 合成时使用。",
  "Character performance direction": "角色演绎方向",
  "Choose how this voice attracts and engages the listener. The reference recording still owns identity.":
    "选择声音吸引和调动听者的方式；参考录音仍然决定声音身份。",
  Sensual: "性感",
  Intimate: "亲密",
  Playful: "俏皮",
  Confident: "自信",
  Natural: "自然",
  "Low, breathy, magnetic": "低声、气声、富有吸引力",
  "Soft, private, close-mic": "柔和、私密、贴耳近讲",
  "Teasing, bright, lively": "撩人、明快、有活力",
  "Assured, poised, commanding": "笃定、从容、有掌控力",
  "Warm and conversational": "温暖、自然对话感",
  "Attraction intensity": "吸引力强度",
  "Speaking pace": "说话速度",
  "Advanced Fish sampling": "Fish 高级采样参数",
  Temperature: "温度",
  "Top P": "Top P",
  "Top K": "Top K",
  "Repetition penalty": "重复惩罚",
  "{value}% intensity": "强度 {value}%",
  Velvet: "丝绒",
  Whisper: "贴耳",
  Spark: "灵动",
  Siren: "魅惑",
  "System Female": "系统女性声音",
  "Curated adult female identity; delivery is configured separately":
    "精选成年女性声音身份；演绎方式单独配置",
  "Teasing, bright, playful": "撩人、明快、俏皮",
  "Fish Audio S2 Pro voice cloning through MLX is ready.":
    "通过 MLX 运行的 Fish Audio S2 Pro 声音克隆已就绪。",
  "Fish Audio is configured but unavailable. Verify the fish-audio-s2-pro-8bit model, resident MLX process, and system female reference.":
    "Fish Audio 已配置但当前不可用；请检查 fish-audio-s2-pro-8bit 模型、常驻 MLX 进程和系统女性声音参考。",
  "Fish Audio is not the active voice provider. Set VOICE_PROVIDER=fish-audio and start the Fish Audio process.":
    "Fish Audio 当前不是生效的声音供应器；请设置 VOICE_PROVIDER=fish-audio 并启动 Fish Audio 进程。",
  "Preview script": "试听文案",
  "Preview and audit": "试听与审计",
  "Write the line operators will hear, and record why this candidate was created.":
    "填写运营人员要试听的文案，并记录创建这个候选声音的原因。",
  "This reason is stored in the operator audit trail.":
    "该原因会写入运营审计记录。",
  "Candidate readiness": "候选创建准备度",
  "{done} of {total} required inputs ready": "必填内容已完成 {done}/{total}",
  Ready: "已完成",
  Required: "待填写",
  "Live voice configuration": "线上声音配置",
  "This is the authoritative voice used for new chat speech.":
    "这是新聊天语音当前实际使用的权威配置。",
  "Runtime route": "运行线路",
  Provider: "供应器",
  Engine: "运行引擎",
  "Fish Audio S2 Pro": "Fish Audio S2 Pro",
  "Controls every character without a voice override.":
    "控制所有没有角色专属声音覆盖的角色。",
  "Open system defaults": "展开系统默认配置",
  "Close system defaults": "收起系统默认配置",
  "Cloning and rendering preview…": "正在克隆并生成试听…",
  "Clone and render preview": "克隆并生成试听",
  "The existing voice candidate result was recovered.":
    "已恢复现有的候选声音结果。",
  "The voice candidate is ready. Review its preview before activation.":
    "候选声音已就绪，请先试听审核再启用。",
  "The existing voice activation result was recovered.":
    "已恢复现有的声音启用结果。",
  "The reviewed voice is now active for new chat speech.":
    "已审核声音现已用于新的聊天语音。",
  "Voice cloning failed": "声音克隆失败",
  "Voice activation failed": "声音启用失败",
  "Voice history": "声音历史",
  candidate: "候选",
  "First identity portrait": "第一张身份肖像",
  "Character asset pack": "角色图片资产包",
  "Establish the face customers will recognize": "建立用户能够识别的角色面孔",
  "Create the images customers will remember": "创建用户会记住的角色图片",
  "Generate the first portrait without references, review it as the identity definition, then commit it as identity version 1.":
    "先在没有参考图的情况下生成第一张肖像，将其作为身份定义审核，再提交为身份版本 1。",
  "Generate against the sealed identity reference set, compare real candidates in customer context, then make one clear decision.":
    "基于已封存的身份参考集生成，在真实用户场景中比较候选图，再做出一个明确选择。",
  "no reference input. The reviewed result becomes the reference authority.":
    "不输入参考图；审核通过的结果将成为参考权威。",
  "No active text-to-image bootstrap profile is available. Generation remains blocked until one is published.":
    "当前没有可用的文生图身份初始化配置；发布可用配置前无法生成。",
  "Generation needs a sealed identity, active references, and a reference-capable qualified route.":
    "生成需要已封存的身份、有效参考图，以及通过资格验证的参考图生成路线。",
  "Complete visual setup": "完成视觉身份设置",
  "Primary portrait": "主肖像",
  "Character hero": "角色主视觉",
  "Chat moments": "聊天场景图",
  Portrait: "肖像",
  Hero: "主视觉",
  Chat: "聊天场景",
  review: "待审核",
  "not started": "未开始",
  "not locked": "未锁定",
  "Approve current candidate": "批准当前候选图",
  Similar: "相似",
  "Attach or create the portrait that defines this character":
    "添加或创建一张能够定义该角色的肖像",
  "Complete the stable visual traits for this character":
    "补全该角色稳定的视觉特征",
  "Create a current, sealed visual identity version":
    "创建当前有效且已封存的视觉身份版本",
  "Publish the approved identity references": "发布已批准的身份参考图",
  "Publish a current, sealed identity reference set":
    "发布当前有效且已封存的身份参考集",
  "Replace unavailable identity reference images": "替换不可用的身份参考图",
  portraits: "张肖像",
  heroes: "张主视觉",
  "chat assets": "张聊天场景图",
  "locked until identity": "身份建立后解锁",
  "Creative Studio": "创意工作室",
  "Customer Operations": "客户运营",
  Growth: "增长",
  "Platform Operations": "平台运营",
  "Portfolio & Projects": "角色组合与项目",
  "Character Performance": "角色表现",
  Taxonomy: "分类体系",
  "Creative Runs": "创意生产批次",
  "Image creation": "图片创建",
  "Create campaign images": "创建运营图片",
  "Start from the intended use and a concrete brief. Creation does not publish anything.":
    "先明确图片用途和具体创意简报；创建图片不会直接发布。",
  "Creating Character images?": "要创建角色图片？",
  "Open Character Asset Studio": "打开角色图片工作台",
  "What are you making?": "这次要制作什么？",
  "Homepage feature": "首页主图",
  "Feed image": "信息流图片",
  "SEO image": "SEO 图片",
  "Create a reviewed campaign image that can be verified against the live campaign surface.":
    "创建可审核、并能在真实活动页面验证的活动图片。",
  "Create a homepage candidate for review and handoff. Live placement is not yet automated.":
    "创建首页候选图，用于审核和交付；当前尚不支持自动上线。",
  "Create a feed-ready image for review and downstream curation.":
    "创建适合信息流的候选图，用于审核和后续编排。",
  "Create a search or editorial image for review and downstream publishing.":
    "创建搜索或编辑用途的候选图，用于审核和后续发布。",
  "Create a reusable template cover for review and downstream adoption.":
    "创建可复用的模板封面，用于审核和后续采用。",
  "Describe the subject, setting, composition, mood, and what success looks like.":
    "描述主体、场景、构图、氛围，以及什么样的结果算成功。",
  "Advanced creation details": "高级创建设置",
  "Run title": "生产批次名称",
  "Image route": "图片生成路线",
  Canvas: "画布比例",
  Recommended: "推荐",
  "Checking available image routes…": "正在检查可用的图片生成路线…",
  "No compatible text-to-image route is currently available.":
    "当前没有可用的文生图路线。",
  "No active freeplay image recipe is currently available.":
    "当前没有可用的通用图片提示词配方。",
  "Add a concrete brief to make the Run ready.": "填写具体创意简报后即可创建。",
  "Ready to create. Destination is chosen only after review.":
    "已可创建；审核通过后再选择投放目标。",
  "Destination chosen after review": "审核后选择投放目标",
  "Creation options could not be loaded.": "无法加载图片创建选项。",
  "Create and launch": "创建并启动",
  "Create images": "创建图片",
  Candidate: "候选图",
  "Ready for a first run": "可以开始第一次生成",
  "The face customers recognize across discovery and the character profile.":
    "用于发现页与角色资料页、让用户能够识别角色的主面孔。",
  "A wider, expressive scene for the top of the character experience.":
    "用于角色体验顶部、画幅更宽且更有表现力的场景。",
  "Natural, conversational moments for the relationship experience.":
    "用于关系体验、自然且有交流感的聊天场景。",
  "Approved identity": "身份一致性已通过",
  "Approved first identity": "第一版身份已通过",
  "Ready to decide": "可以做出决定",
  "Preparing generation": "正在准备生成",
  "Waiting for generation capacity": "正在等待生成资源",
  Generating: "正在生成",
  "Finalizing asset": "正在完成素材",
  "Generation failed": "生成失败",
  "Generate a focused batch, then decide from real candidates here.":
    "先生成一组聚焦候选图，再在这里基于真实结果做决定。",
  "Generated candidates": "已生成候选图",
  "Select candidate": "选择候选图",
  "Batch candidates": "批次候选图",
  "View candidate {number}": "查看候选图 {number}",
  "{name} {purpose} candidate {number}": "{name} 的{purpose}候选图 {number}",
  "Draft slot": "已采用到草稿槽位",
  Approved: "已通过",
  Rejected: "已拒绝",
  "Current candidate": "当前候选图",
  "Comparison candidate": "对比候选图",
  "Remove candidate {number} from comparison": "从对比中移除候选图 {number}",
  "Compare candidate {number} with current candidate":
    "将候选图 {number} 与当前候选图对比",
  "Two-candidate comparison": "双候选图对比",
  "Compare the current decision without changing authority":
    "对比当前选择，不改变任何权威状态",
  "Back to batch": "返回候选批次",
  "{name} current candidate {number}": "{name} 的当前候选图 {number}",
  "{name} comparison candidate {number}": "{name} 的对比候选图 {number}",
  "Make current": "设为当前候选图",
  "Character asset pack progress": "角色资产包进度",
  "Scan the batch, compare two candidates when needed, then review and adopt one exact asset into the current draft slot.":
    "浏览整批候选图，需要时对比两张，再审核并将一张精确素材采用到当前草稿槽位。",
  "{count} candidates ready to compare": "{count} 张候选图可供比较",
  "Candidate {number} is the only active decision target.":
    "候选图 {number} 是当前唯一的决策目标。",
  "Current candidate decision inspector": "当前候选图决策检查器",
  "Review evidence": "审核证据",
  "Candidate {number}": "候选图 {number}",
  "Review actions apply only to the current candidate and stay separate from draft adoption.":
    "审核动作只作用于当前候选图，并与草稿采用保持分离。",
  "Current candidate actions": "当前候选图操作",
  "Current decision": "当前决策",
  "Candidate {number} · {state}": "候选图 {number} · {state}",
  "No active candidate": "当前没有候选图",
  "Reject current": "拒绝当前候选图",
  "Record the visible review evidence": "记录可见审核证据",
  "The earlier immutable decision is preserved, but it is missing required visible evidence. Record a superseding review to make this candidate actionable.":
    "之前的不可变审核决定会保留，但缺少必需的可见证据。请记录一条替代审核，使该候选图可以继续处理。",
  "This portrait defines identity, so identity consistency is intentionally unscored. Judge artifacts, subject count, composition, and customer intent.":
    "这张肖像用于定义身份，因此身份一致性有意不评分；请判断瑕疵、主体数量、构图和用户用途。",
  "Score the artifact and state identity consistency separately. A composition rejection does not automatically mean identity failed.":
    "请分别评价画面质量与身份一致性；构图不通过并不自动代表身份失败。",
  "Earlier decision": "之前的决定",
  "Required visible quality checks": "必需的可见质量检查",
  "No visible artifacts": "没有可见瑕疵",
  "Exactly one intended subject": "只有一个预期主体",
  "Composition matches the customer intent": "构图符合用户用途",
  "No visible text, watermark, or contact sheet": "没有可见文字、水印或拼图",
  Score: "评分",
  "Identity match score": "身份匹配分",
  "Required for every sample": "每个样本都必须填写",
  "Identity consistency": "身份一致性",
  "Unscored · defines identity": "不评分 · 用于定义身份",
  Passed: "通过",
  Unscored: "未评分",
  "Evidence and reason": "证据与理由",
  "Score identity match against the sealed Character references. Every evaluation sample requires an explicit pass or fail and a 0–100 score.":
    "对照已封存的角色参考图评估身份匹配。每个评测样本都必须明确选择通过或失败，并填写 0–100 分。",
  "Create the fixed 40-image identity matrix, review every image, then publish the measured route result. Character image production unlocks only after the evidence reaches the policy threshold.":
    "创建固定的 40 张身份评测矩阵，逐张审核后再发布实测路线结果。只有证据达到策略门槛，角色图片生产才会解锁。",
  "1. Create evaluation matrix": "1. 创建评测矩阵",
  "Candidate image route": "候选图片路线",
  "{count} fixed samples · evaluator {version}":
    "{count} 个固定样本 · 评测器 {version}",
  "Creating matrix…": "正在创建矩阵…",
  "Create 40-sample matrix": "创建 40 样本矩阵",
  "Review generated samples": "审核生成样本",
  "2. Publish measured result": "2. 发布实测结果",
  "Batch IDs are immutable Creative Run IDs. Every sample must have a completed generation and exact automatic or human identity evidence.":
    "批次 ID 是不可变的创意生产批次 ID。每个样本都必须已完成生成，并具备精确的自动或人工身份一致性证据。",
  "Route evaluation is not ready.": "路线评测尚未就绪。",
  "Create and seal a Visual Identity before evaluating an image route.":
    "评测图片路线前，请先创建并封存视觉身份。",
  "Publish a sealed Reference Set before evaluating an image route.":
    "评测图片路线前，请先发布已封存的参考集。",
  "No active reference-capable image profile can consume this Reference Set.":
    "当前没有可使用此参考集的启用中参考图图片配置。",
  "Create and qualify the platform image route": "创建并验证平台图片路线",
  "Refresh the platform image route qualification": "刷新平台图片路线资格",
  "The pinned generation route is not qualified.":
    "当前固定的图片生成路线尚未通过资格验证。",
  "The pinned generation route qualification is stale.":
    "当前固定的图片生成路线资格已失效，需要重新验证。",
  "Finish visual setup before generating": "完成视觉设置后再生成",
  "Image production is ready": "图片生产已就绪",
  "Not Started": "尚未开始",
  "Review the character's visual setup evidence": "检查角色的视觉设置证据",
  "Complete the Character image-readiness actions first.":
    "请先完成角色图片生产就绪步骤。",
  "Review candidate first": "请先审核候选图",
  "Generate {count} {assetType}": "生成 {count} {assetType}",
  "Identity, references, and route are protected for this batch.":
    "本批次已锁定角色身份、参考集和生成路线。",
  "Identity and references are locked; the generation route is not qualified yet.":
    "角色身份和参考集已锁定；图片生成线路尚未通过资格验证。",
  "Quality score": "画面质量评分",
  "Identity match score ({minimum}–100 required)":
    "身份匹配评分（必须达到 {minimum}–100）",
  "This batch will establish the first reviewed identity anchor.":
    "本批次将建立第一张经过审核的身份锚点。",
  "Visual authority must be repaired before production can continue.":
    "修复视觉权威后才能继续图片生产。",
  "{count} locked": "已锁定 {count} 张",
  "Customer context": "用户场景",
  "This preview uses the active candidate only in the current draft slot. Nothing live changes until a reviewed Release is published.":
    "此预览只会在当前草稿槽位使用当前候选图；只有经过审核的 Release 发布后，线上角色才会变化。",
  "Describe artifacts, subject count, identity markers, composition, and intended customer context":
    "描述瑕疵、主体数量、身份标记、构图和预期用户场景",
  "Record superseding approval": "记录替代通过决定",
  "Approve with evidence": "带证据通过",
  "Record superseding rejection": "记录替代拒绝决定",
  "Reject with reason": "填写理由后拒绝",
  identity: "身份",
  Supersedes: "替代",
  "Review and project-write grants control approval and primary image selection.":
    "审核权限与项目写权限共同控制通过决定和主图选择。",
  "Adjust the creative brief": "调整创意简报",
  "Keep intent human-readable. Identity, references, workflow, and route stay automatic.":
    "让用途保持清晰易读；身份、参考图、工作流和生成路线由系统自动处理。",
  "creative brief": "创意简报",
  "Recent runs and technical lineage": "最近批次与技术链路",
  "No production history for this character.": "该角色还没有图片生产历史。",
  "Generation profile": "生成配置",
  "Provider request / Comfy prompt": "供应商请求 / Comfy 提示任务",
  Pending: "待处理",
  generated: "已生成",
  approved: "已通过",
  "Decision context": "决策上下文",
  "Review against the brief": "对照创意简报审核",
  "The brief and generation route are frozen evidence for this Run.":
    "创意简报和生成路线是该批次不可变的审核依据。",
  "Intended use": "预期用途",
  "Reference images": "参考图片",
  "Review complete": "审核完成",
  "This intended use does not yet have a verified runtime destination. Approval is the terminal managed state; hand the reviewed asset to its downstream owner without marking it live here.":
    "该用途目前还没有可验证的线上投放目标。审核通过是当前管理流程的终点；请将已审核素材交付给下游负责人，不要在此标记为已上线。",
  "Placement & verification": "投放与验证",
  "Staging preserves the current live image. Verification activates this candidate only after the runtime surface renders the same reviewed asset.":
    "暂存不会替换当前线上图片；只有真实页面渲染了同一张已审核素材后，验证才会激活候选图。",
  Destination: "投放目标",
  "Campaign collection": "活动图片集合",
  "Campaign destination key": "活动目标标识",
  "Campaign eyebrow": "活动眉题",
  "Campaign title": "活动标题",
  "Campaign CTA label": "活动按钮文案",
  "Campaign CTA href": "活动按钮链接",
  "Explain why this reviewed asset should become the campaign candidate":
    "说明为什么这张已审核素材应成为活动候选图",
  "Stage campaign candidate": "暂存活动候选图",
  "Verify & activate": "验证并激活",
  "Immutable review decision": "不可变审核决定",
  "Terminal disposition": "终止处置",
  "If this approved candidate will not be activated, record a superseding rejection so every candidate has an explicit terminal outcome and the Run can close.":
    "如果这张已通过的候选图不会被启用，请记录替代拒绝决定，让每张候选图都有明确终态，并使批次可以关闭。",
  "Withdrawal reason": "撤回理由",
  "Explain why this approved candidate will not be used":
    "说明为什么不再使用这张已通过的候选图",
  "Withdraw approval": "撤回通过决定",
  "Use Withdraw staged placement below before superseding this approval.":
    "请先使用下方“撤回暂存投放”，再替代这条通过决定。",
  "This candidate is already active. Replace its live placement before superseding the approval.":
    "这张候选图已经在线上生效。请先用新的线上投放替换它，再替代这条通过决定。",
  "Withdraw staged placement": "撤回暂存投放",
  "1 approved asset is hidden because generation authority is incomplete or untrusted.":
    "有 1 个已通过素材因生成权威不完整或不可信而被隐藏。",
  "{count} approved assets are hidden because generation authority is incomplete or untrusted.":
    "有 {count} 个已通过素材因生成权威不完整或不可信而被隐藏。",
  "No customer-publishable approved assets are available. Repair generation authority in the Image Library or create a new reviewed asset.":
    "当前没有可面向用户发布的已通过素材。请在图片库修复生成权威，或创建并审核新素材。",
  "Use Refresh before another write.": "再次写入前请先刷新。",
  "Asset changes were committed, but the latest projection could not be refreshed:":
    "素材变更已提交，但无法刷新最新投影：",
  "Asset changes were committed, but the latest projection could not be refreshed. Use Refresh before another write.":
    "素材变更已提交，但无法刷新最新投影。再次写入前请先刷新。",
  "Asset archival was committed, but the latest projection could not be refreshed:":
    "素材归档已提交，但无法刷新最新投影：",
  "Asset archival was committed, but the latest projection could not be refreshed. Use Refresh before another write.":
    "素材归档已提交，但无法刷新最新投影。再次写入前请先刷新。",
  "Placement pause was committed, but the latest projection could not be refreshed:":
    "投放暂停已提交，但无法刷新最新投影：",
  "Placement pause was committed, but the latest projection could not be refreshed. Use Refresh before another write.":
    "投放暂停已提交，但无法刷新最新投影。再次写入前请先刷新。",
  "Placement archival was committed, but the latest projection could not be refreshed:":
    "投放归档已提交，但无法刷新最新投影：",
  "Placement archival was committed, but the latest projection could not be refreshed. Use Refresh before another write.":
    "投放归档已提交，但无法刷新最新投影。再次写入前请先刷新。",
  "A Creative publisher permission is required for activation.":
    "激活需要创意投放权限。",
  "This placement is managed by Creative Run verification and is read-only here.":
    "该投放由创意生产批次验证流程管理，此处仅供查看。",
  "Open Creative Run": "打开创意生产批次",
  "Standalone placements are draft records only. Customer-visible campaign activation happens from a verified Creative Run; Character images publish through a Character Release.":
    "独立投放记录只能保存为草稿。面向用户的活动图片必须从已验证的创意生产批次激活；角色图片必须通过角色发布版本上线。",
  Library: "素材库",
  "Moderation Cases": "审核工单",
  "Support Cases": "支持工单",
  "Risk Cases": "风险工单",
  Customers: "客户",
  "Billing Operations": "计费运营",
  "Account Requests": "账号请求",
  "Product Health": "产品健康",
  "Funnels & Retention": "漏斗与留存",
  "Featured Merchandising": "推荐位运营",
  Promotions: "促销",
  "Jobs & Incident Signals": "任务与事故信号",
  Providers: "服务提供方",
  "Backend Diagnostics": "后端诊断",
  "Generation Health": "生成健康",
  "Profiles & Rollout": "配置与灰度",
  "Workflow Diagnostics": "工作流诊断",
  "Chat Operations": "聊天运营",
  "CMS & SEO": "CMS 与 SEO",
  "Work mode": "工作模式",
  "Character producer": "角色制作",
  "Creative operator": "创意运营",
  "Platform ops": "平台运维",
  "Growth analyst": "增长分析",
  Export: "导出",
  "Export CSV": "导出 CSV",
  Fail: "标记失败",
  Failed: "失败",
  "Feature Flags": "功能开关",
  "Featured confirmation": "推荐位确认文本",
  "Featured curation": "推荐位编排",
  Filter: "筛选",
  Format: "格式",
  "Full runner control for model operations.":
    "给模型运维使用完整 runner 控制。",
  Grant: "授予",
  Generation: "生成",
  "Generation config": "生成配置",
  "Generation Config": "生成配置",
  "Drafts, tests, publish": "草稿、测试、发布",
  "Keep each configuration named, test it from the draft, then publish from the same workspace.":
    "给每个配置明确命名，在草稿上测试出图，再从同一个工作台发布。",
  "Generation profile setup": "生成配置设置",
  "Generation Jobs": "生成任务",
  Cases: "客户案件",
  Incidents: "运营事故",
  Generations: "生成量",
  "Generate with AI": "用 AI 生成",
  Health: "健康度",
  "HTTP status": "HTTP 状态",
  "Image consistency review": "图片一致性复核",
  Insights: "洞察",
  "Internal admin API is reachable.": "内部 admin API 可达。",
  Language: "语言",
  Label: "标签",
  Ledger: "账本",
  Loading: "加载中",
  "Loading…": "加载中…",
  "Add LoRA": "添加 LoRA",
  "Advanced custom profile": "高级自定义配置",
  "Advanced runner details": "高级运行器细节",
  "After creation, run Dry Run from Model Profiles before publishing.":
    "创建后先在模型配置列表执行试运行，再发布。",
  "After creation, the draft appears in Drafts for testing and publish.":
    "创建后草稿会出现在草稿列表，可直接测试出图并发布。",
  "Asset kind": "资产类型",
  Logout: "退出",
  "Attach optional style or character adapters without editing runner JSON.":
    "不用编辑运行器 JSON，也可以挂载可选风格或角色 LoRA。",
  "Attach LoRA": "挂载 LoRA",
  "Attach to profile": "挂到配置",
  "Asset unavailable": "资产不可用",
  "Complete required checks": "完成必要检查",
  "Checking asset": "检查资产中",
  "Configure profile": "配置模型",
  "Conversion target ready": "转换目标已就绪",
  "Conversion Type": "转换类型",
  "Convert Source": "转换来源",
  "Convert to GGUF": "转换为 GGUF",
  "Create and dry run": "创建并试运行",
  "Create draft": "创建草稿",
  "Current draft summary": "当前草稿摘要",
  Disabled: "已关闭",
  "Diffusion Model": "Diffusion 模型",
  "Draft can be created": "可创建草稿",
  "Draft is ready": "草稿已就绪",
  "Draft manager": "草稿管理",
  "Draft readiness": "草稿就绪度",
  Drafts: "草稿",
  "Every draft needs a clear name so operators can test the right configuration.":
    "每个草稿都需要清晰名称，运营才能测试正确的配置。",
  "Enable LoRA": "启用 LoRA",
  "Disable LoRA": "禁用 LoRA",
  "Generation defaults": "生成默认值",
  "Generation job detail": "生成任务详情",
  "GGUF target": "GGUF 目标",
  "Import asset": "导入资产",
  "Import model": "导入模型",
  "Import one checkpoint": "导入一个 checkpoint",
  "Import LoRA tags": "导入 LoRA 标签",
  "Import Path": "导入路径",
  "Import from server path": "从服务端路径导入",
  "Engineering diagnostics": "工程诊断",
  "Engineering-only model diagnostics. Operators use seeded profiles in Model Profiles.":
    "仅用于工程诊断。运营在 模型配置 中使用已 seed 的内置配置。",
  "Engineering imports are hidden diagnostics; default Admin uses seeded profiles.":
    "工程导入是隐藏诊断能力；默认后台使用已 seed 的内置配置。",
  "Imported model assets": "已导入模型资产",
  "Keep the common operating knobs visible; deeper runner details are below.":
    "保留常用运营参数；更深层运行器细节放在下方。",
  "Library root: {path}": "模型库根目录：{path}",
  "LLM and VAE configured": "LLM 与 VAE 已配置",
  "LLM Encoder": "LLM 编码器",
  "LoRA file path": "LoRA 文件路径",
  "LoRA JSON": "LoRA JSON",
  "LoRA JSON valid": "LoRA JSON 有效",
  "LoRA key": "LoRA 标识",
  "LoRA Models": "LoRA 模型",
  "LoRA import": "LoRA 导入",
  "LoRA optional": "LoRA 可选",
  "LoRA stack": "LoRA 叠加",
  "LoRA Stack": "LoRA 叠加",
  "Make private": "设为私密",
  "Main Models": "主模型",
  "Main model": "主模型",
  "Main model selected": "已选择主模型",
  "Max upload {size}": "最大上传 {size}",
  "Max upload": "最大上传",
  "Max Count": "最大数量",
  "Max uses (blank=∞)": "最大使用次数（空=∞）",
  "Manual adjust anomalies": "手动调整异常",
  Merge: "合并",
  "Merge tags": "合并标签",
  Mode: "模式",
  "Model components": "模型组件",
  "Model components and conversion": "模型组件与转换",
  "Model diagnostics library": "模型诊断库",
  "Model Profiles": "模型配置",
  "Model library not loaded": "模型库未加载",
  "Model name": "模型名",
  "Model verification": "模型验证",
  Moderation: "审核",
  "Moderation 24h": "24 小时审核",
  "Multi-account device clusters": "多账号设备聚类",
  "Negative Base": "负向基础词",
  "Net coins (window)": "窗口净金币",
  "No announcements.": "暂无公告。",
  "No CMS pages yet.": "暂无 CMS 页面。",
  "No cohorts in window.": "窗口内暂无 cohort。",
  "No dead-letter jobs": "暂无死信任务",
  "No feature flags.": "暂无功能开关。",
  "No generation records in window.": "窗口内无生成记录",
  "No LoRA": "无 LoRA",
  "No LoRA models added": "尚未添加 LoRA 模型",
  "No LoRA models added. This model will run without LoRA.":
    "尚未添加 LoRA。这个模型会以无 LoRA 方式运行。",
  "No diagnostic model assets available. Default Admin uses seeded profiles.":
    "暂无诊断模型资产。默认后台使用已 seed 的内置配置。",
  "No model asset selected": "尚未选择模型资产",
  "No model assets imported": "尚未导入模型资产",
  "No model profiles yet. Create a draft to start testing.":
    "暂无模型配置。先创建草稿再开始测试。",
  "No draft profiles yet.": "暂无草稿配置。",
  "No image generated: {status}": "没有生成图片：{status}",
  "No generated assets": "暂无生成资产",
  "No official characters yet.": "暂无官方角色。",
  "No records.": "暂无记录。",
  "No saved views.": "暂无已存视图。",
  "No submissions match filters": "没有符合筛选条件的提交",
  "No supported Civitai fields found.": "未找到可识别的 Civitai 字段。",
  "No tags.": "暂无标签。",
  "No templates yet.": "暂无模板。",
  "No timeline events": "暂无时间线事件",
  Offline: "下线",
  "Official Characters": "官方角色",
  "Official characters": "官方角色",
  "Open Model Profiles": "打开模型配置",
  "Open jobs": "打开任务",
  Path: "路径",
  Optional: "可选",
  "Paste Civitai config first.": "请先粘贴 Civitai 配置。",
  "Paste Civitai generation data or JSON here":
    "在这里粘贴 Civitai 生成参数或 JSON",
  "Paste Civitai metadata when you want to prefill generation defaults.":
    "需要预填生成默认参数时再粘贴 Civitai 元数据。",
  "Paste from clipboard": "从剪贴板粘贴",
  "Paste generation metadata copied from Civitai to prefill sampler, steps, CFG, size, model name, VAE, and LoRA weights.":
    "粘贴从 Civitai 复制的生成参数，自动填充采样器、步数、CFG、尺寸、模型名、VAE 和 LoRA 权重。",
  "Pending approvals": "待审批",
  "Pending submissions": "待审提交",
  "Permission effect": "权限操作",
  "Permission key": "权限键",
  "Permission override": "权限覆盖",
  "Permission user ID": "权限用户 ID",
  "Pipeline Model": "流水线模型",
  Pricing: "定价",
  "Pricing Rules": "定价规则",
  "Profile health + configuration check": "模型健康度 + 配置检查",
  "Profile health + dry-run": "模型健康度 + 试运行",
  Profile: "配置",
  "Profile Key": "配置键",
  "Profile identity": "配置身份",
  Promo: "推广",
  "Recipe drafts": "配方草稿",
  "Provider Health": "供应商健康",
  "Provider health & cost": "供应商健康与成本",
  Publish: "发布",
  "Publish needs at least 20 reviewed image samples and 80% identity consistency.":
    "发布至少需要复核 20 张图片样本，且角色身份一致性达到 80%。",
  "Publish test workspace": "发布前测试工作台",
  Published: "已发布",
  "Published profiles": "已发布配置",
  "Recent chat sessions (no plaintext)": "最近聊天会话（无明文）",
  "Redeem codes": "兑换码",
  "Referral farming (≥3 invites)": "邀请套利（≥3 次邀请）",
  Referrals: "邀请",
  Refresh: "刷新",
  "Refresh library": "刷新模型库",
  "Register server file": "登记服务端文件",
  Reject: "拒绝",
  Reload: "重新加载",
  Remove: "移除",
  "Remove LoRA": "移除 LoRA",
  "Reviewed samples": "已复核样本数",
  Reports: "举报",
  Reported: "有举报",
  "Report filter": "举报筛选",
  "Redeem code confirmation": "兑换码确认文本",
  "Reference-image candidate for sd.cpp-compatible runners; publish only after reference smoke.":
    "用于兼容 sd.cpp 运行器的参考图候选；必须通过 reference smoke 后才能发布。",
  "Reason (≥3)": "原因（≥3 字符）",
  "Reason (≥3 chars)": "原因（≥3 字符）",
  Reset: "重置",
  "Reset filters": "重置筛选",
  Restore: "恢复",
  "Register Path": "登记路径",
  "Retention cohorts (D1 / D7)": "留存 cohort（D1 / D7）",
  "Reconciliation by reason": "对账按原因",
  "Request failed": "请求失败",
  Requeue: "重新入队",
  "Requeue selected": "重新入队已选",
  "Review note (optional, shown to creator)": "审核备注（可选，展示给创建者）",
  "Review notes": "复核备注",
  "Review Queue": "审核队列",
  "Review URL": "复核链接",
  "Review configuration": "检查配置",
  "Reference identity template": "参考图身份模板",
  "Reference-image candidate for external ComfyUI workflows.":
    "用于外部 ComfyUI workflow 的参考图候选。",
  "Review the generated source paths and GGUF output before draft creation.":
    "创建草稿前检查生成的源路径和 GGUF 输出。",
  "Risk & Abuse": "风险与滥用",
  Rollback: "回滚",
  "Rule Key": "规则键",
  Runner: "运行器",
  "Runner Config": "运行器配置",
  "Runner components configured": "运行组件已配置",
  Sampler: "采样器",
  "Sampler was not recognized": "采样器未识别，请手动选择",
  Scheduler: "调度器",
  "Scheduler was not recognized": "调度器未识别，请手动选择",
  Save: "保存",
  "Save view": "保存视图",
  "Save featured": "保存推荐",
  "Saved view": "已存视图",
  "Saved view label": "视图名称",
  "Saved views": "已存视图",
  Search: "搜索",
  "Search review queue": "搜索审核队列",
  "sdcpp Model Import": "sdcpp 模型导入",
  "sdcpp operations": "sdcpp 运维",
  "Select from model library": "从模型库选择",
  Select: "选择",
  "Select model": "选择模型",
  "Selected profile": "已选配置",
  "Select model from library": "从模型库选择模型",
  "Select an imported model, tune generation defaults, then create a draft for dry run and publish.":
    "选择已导入模型，调整生成默认参数，然后创建草稿用于试运行和发布。",
  "Server file or directory path": "服务端文件或目录路径",
  "Server file path": "服务端文件路径",
  "Enter a server file path or a directory path. Directory import registers all supported files under that folder.":
    "输入服务端文件路径或目录路径。目录导入会登记该目录下所有支持的文件。",
  "/Users/kk/Downloads/models or /path/model.safetensors":
    "/Users/kk/Downloads/models 或 /path/model.safetensors",
  Size: "尺寸",
  "Signed-in internal roles only.": "仅限已登录的内部角色。",
  "Some LoRA names need matching local files":
    "部分 LoRA 名称还需要匹配本地文件",
  "Some LoRA tags need matching local files":
    "部分 LoRA 标签需要先匹配本地文件",
  "LoRA tags ignored by default": "默认已忽略 Civitai 中的 LoRA 标签",
  "Source and target must differ.": "来源和目标必须不同。",
  Source: "来源",
  "Source Model": "源模型",
  "Step 1": "步骤 1",
  "Start from the consistency path, then adjust only what this model needs.":
    "先选择一致性路径，再只调整该模型需要的配置。",
  "Step 2": "步骤 2",
  "Step 3": "步骤 3",
  "Step 4": "步骤 4",
  "Step 5": "步骤 5",
  Steps: "步数",
  Subscriptions: "订阅",
  Suspend: "封禁",
  "Tag edit confirmation": "标签编辑确认文本",
  "Tag taxonomy": "标签分类法",
  Tags: "标签",
  Templates: "模板",
  "Recipe Key": "配方键",
  "Text identity template": "文生图身份模板",
  "This is what operators will find later in dry run, publish, and rollback tables.":
    "后续试运行、发布和回滚列表都会用这组身份信息检索。",
  "Top events": "热门事件",
  "Test Image": "测试出图",
  "Test image failed": "测试出图失败",
  "Test image queued": "测试出图已排队",
  "Test image queued: {id}": "测试出图已排队：{id}",
  "Test prompt": "测试提示词",
  Unpublish: "取消发布",
  "Use Case": "用途",
  "Upload LoRA": "上传 LoRA",
  "Diagnostic import": "诊断导入",
  "Diagnostic model import": "诊断模型导入",
  "Upload diagnostic model": "上传诊断模型",
  "LoRA files are optional adapters. Import them here before attaching them to a profile.":
    "LoRA 是可选适配器。先在这里导入，之后再挂到生成配置。",
  "Upload from this computer": "从本机上传",
  Use: "使用",
  "Use existing library asset": "使用已有模型库资产",
  "User ID": "用户 ID",
  Users: "用户",
  Verify: "验证通过",
  "Override confirmation": "裁决确认文本",
  "Override reason": "裁决原因",
  "Waiting for main model": "等待主模型",
  Weight: "权重",
  Updated: "更新时间",
  "Active and archived": "已启用和已归档",
  "Name and configure": "命名并配置",
  Settings: "设置",
  "Test and publish": "测试和发布",
  "Test jobs": "测试任务",
  "ready to test": "待测试",
  "template records": "模板记录",
  Window: "窗口",
  "active subscriptions": "活跃订阅",
  "activity funnel": "活跃漏斗",
  configured: "已配置",
  entitlements: "权益",
  events: "事件",
  "free tier": "免费档",
  "generated ≥1": "生成 ≥1 次",
  "generation jobs": "生成任务",
  "Latest job": "最近任务",
  "Latest test image": "最近测试图",
  "last 24h": "最近 24 小时",
  "ledger entries": "账本条目",
  "local file upload": "本地文件上传",
  missing: "缺失",
  "new users": "新用户",
  "open reports": "待处理举报",
  "optional adapters": "可选适配器",
  "paying / signups": "付费 / 注册",
  sessions: "会话",
  "status = active": "status = active",
  subscribed: "已订阅",
  "quota ledger": "额度账本",
  "{count} ledger entries": "{count} 条账本记录",
  "{count} assets": "{count} 个资产",
  "{count} completed": "{count} 个已完成",
  "{count} fields applied": "已应用 {count} 个字段",
  "{count} granted": "{count} 个已发放",
  "{count} incomplete LoRA skipped": "已跳过 {count} 个不完整 LoRA",
  "{count} LoRA attached": "已挂载 {count} 个 LoRA",
  "{count} queued": "{count} 个排队中",
  "{count} selected": "已选 {count} 项",
  "{count} suspended": "{count} 个已封禁",
  "{count} total": "共 {count} 项",
  "{count} rows": "{count} 行",
  "No test image yet": "暂无测试图",
  "No test jobs": "暂无测试任务",
  "Output size": "输出尺寸",
  "Run Dry Run before publish": "发布前先跑试运行",
  "Generated asset": "生成资产",
  "Generated assets": "生成资产",
  "Job detail load failed": "任务详情加载失败",
  "Loading job detail": "加载任务详情",
  "Negative prompt": "负向提示词",
  Prompt: "提示词",
  "Provider error": "Provider 错误",
  "Publish blocked until dry run has no failureMode.":
    "发布已阻止：需要先得到没有 failureMode 的试运行结果。",
  "Publish blocked until model verification passes.":
    "发布已阻止：模型验证需要先通过。",
  "Publish blocked until required model components are available.":
    "发布已阻止：所需模型组件需要先就绪。",
  "Waiting for generated asset": "等待生成资产",
  "dry-run summary exists": "已有试运行摘要",
  "Code (≥4)": "兑换码（≥4）",
  "Coins net": "金币净值",
  Events: "事件",
  "Failure mode": "失败模式",
  Height: "高度",
  Details: "详情",
  "Dry run and test image": "试运行并测试出图",
  dreamcoins: "dreamcoins",
  "{count} components": "{count} 个组件",
  "{count} main models": "{count} 个主模型",
  "Messages 24h": "24 小时消息",
  "Messages used today": "今日已用消息",
  Multiplier: "倍率",
  Orientations: "方向",
  Paying: "付费",
  "Policy code": "策略代码",
  Signups: "注册",
  // pre-existing gap surfaced by the guided-nav i18n test (task 2): "support" is
  // one of the 7 pinned daily items and its label was never translated.
  "Support Requests": "支持工单",
  "Support category": "支持分类",
  "Support saved view label": "支持视图名称",
  "Support search": "支持搜索",
  "Support status": "支持状态",
  "Audit logged": "已写审计",
  Authorization: "授权",
  "Consent ticket ID": "授权工单 ID",
  "Fields available: {fields}": "可用字段：{fields}",
  "Generation job": "生成任务",
  "Legal hold ID": "法律保全 ID",
  "Media asset": "媒体资产",
  Owner: "所有者",
  "Plaintext access": "明文访问",
  "Plaintext access failed.": "明文访问失败。",
  "Plaintext access logged.": "明文访问已写审计。",
  "Plaintext confirmation": "明文确认文本",
  "Plaintext reason": "明文查看原因",
  "Plaintext target ID": "明文目标 ID",
  "Reason for audit": "审计原因",
  "Requires active support consent or legal hold.":
    "需要有效客服授权或法律保全。",
  "Target type": "目标类型",
  "Type target ID": "输入目标 ID",
  "Type code to confirm": "输入兑换码确认",
  "Type CLEAR": "输入 CLEAR",
  "Type the name to confirm": "输入名称以确认",
  "Type title to confirm": "输入标题确认",
  "Type profile ID": "输入 profile ID",
  "Type user ID": "输入用户 ID",
  "Type featured IDs": "输入推荐角色 ID",
  "Type verification ID": "输入验证 ID",
  "template ID": "模板 ID",
  "Type page path": "输入页面路径",
  "View plaintext": "查看明文",
  "Viewing…": "查看中…",
  "Target ID": "目标 ID",
  "Ticket, user, subject, or notes": "工单、用户、主题或备注",
  "Unlimited users": "无限消息用户",
  Verification: "验证",
  "{visible}/{total} requests": "{visible}/{total} 个请求",
  Width: "宽度",
  "Use defaults or register components": "使用默认组件或登记组件",
  "Use in profile": "用于配置",
  Activate: "启用",
  Actions: "操作",
  Activated: "已激活",
  "Active support": "进行中",
  "AI seed: 一句话灵感，如 “爱雨夜的害羞画家”":
    "AI 灵感：一句话灵感，如 “爱雨夜的害羞画家”",
  "AI seed: 一句话灵感 → 填充 Summary + Tags":
    "AI 灵感：一句话灵感 → 填充摘要 + 标签",
  "Age (≥18)": "年龄（≥18）",
  "Category (blank=none)": "分类（空=无）",
  Chats: "聊天数",
  Deactivate: "停用",
  "Description (1-1500)": "描述（1-1500）",
  "Edit template": "编辑模板",
  Gender: "性别",
  "Meta description": "Meta 描述",
  "Model profile id": "模型配置 ID",
  Name: "名称",
  "Name, description, or ID": "名称、描述或 ID",
  "Name (1-80)": "名称（1-80）",
  "Name (≥1)": "名称（≥1）",
  "Page title": "页面标题",
  Reason: "原因",
  "Reason (≥3, for audit)": "原因（≥3 字符，用于审计）",
  "Sort order": "排序",
  "Source tag…": "来源标签…",
  Status: "状态",
  Style: "风格",
  "Summary (≤200)": "摘要（≤200）",
  "Source tag": "源标签",
  "Target tag…": "目标标签…",
  "Target tag": "目标标签",
  "Tags (comma-sep)": "标签（逗号分隔）",
  "Tags (comma-separated, ≤12)": "标签（逗号分隔，≤12）",
  Title: "标题",
  "Type source:target IDs": "输入 source:target ID",
  "Type {token} to confirm": "输入 {token} 确认",
  "Configuration check {status}: {passed}/{total} configuration cases passed. No provider call was made.":
    "配置检查 {status}：{passed}/{total} 个配置用例通过，未调用生成供应商。",
  "Dry-run {status}: {passed}/{total} samples passed.":
    "试运行 {status}：{passed}/{total} 个样本通过。",
  "The configuration check validates deterministic profile and runtime fields only; it does not call a provider or generate media.":
    "配置检查仅验证确定性的模型配置与运行时字段；不会调用生成供应商，也不会生成媒体。",
  "Already erased (idempotent).": "已擦除（幂等）。",
  "Erasure requested.": "已请求擦除。",
  activated: "已激活",
  active: "启用",
  actions: "操作",
  category: "分类",
  characters: "角色数",
  cohort: "Cohort",
  description: "描述",
  enabled: "启用",
  flag: "开关",
  jurisdiction: "司法辖区",
  label: "标签",
  level: "级别",
  muted: "默认静音",
  name: "名称",
  no: "否",
  path: "路径",
  paying: "付费",
  provider: "供应商",
  reports: "举报数",
  "rollout %": "放量 %",
  scope: "范围",
  sensitive: "敏感",
  signups: "注册",
  size: "规模",
  slug: "Slug",
  sortOrder: "排序",
  status: "状态",
  submittedAt: "提交时间",
  tags: "标签",
  title: "标题",
  user: "用户",
  yes: "是",
  // redesigned admin nav — group headers
  Characters: "角色",
  Media: "图片",
  // guided nav — daily section header + folded group headers (task 2)
  Daily: "常用",
  CharacterConfig: "角色配置",
  GenerationConfig: "生成配置",
  Operations: "运营",
  GenerationOps: "运维",
  Business: "业务",
  Engineering: "工程诊断",
  System: "系统",
  // redesigned admin nav — item labels
  "Character Starters": "角色起始模板",
  "Character Review": "角色审核队列",
  "Prompt Recipes": "提示词配方",
  Presets: "预设",
  Workflows: "工作流",
  Backends: "后端",
  "Jobs & Incidents": "任务与事故",
  Metrics: "指标",
  "Image Production": "图片生产",
  "Image Library": "图片库",
  Placements: "铺位",
  Featured: "精选",
  // image production tabs
  "Batch production": "通用批量",
  "Generate for character": "为角色生成",
  Character: "角色",
  "Production steps": "图片生产步骤",
  "Creative brief": "创意简报",
  Directions: "创意方向",
  "Generate & review": "生成与审核",
  "Four creative directions are ready to edit.":
    "4 个创意方向已生成，可以继续编辑。",
  "Four starter directions are ready to edit.":
    "4 个起始创意方向已生成，可以继续编辑。",
  "Identity locked": "身份已锁定",
  "Identity not configured": "尚未配置视觉身份",
  sets: "组素材",
  "Use case": "使用场景",
  "Character cover": "角色封面",
  "Character chat": "角色聊天素材",
  Homepage: "首页",
  SEO: "SEO",
  "Template cover": "模板封面",
  Campaign: "活动",
  "e.g. Rainy night after work": "例如：雨夜下班后的自拍",
  "Scene prompt": "场景提示词",
  "Describe the moment, action, atmosphere, and camera story. The character identity is added automatically.":
    "描述这个时刻、动作、氛围和镜头故事；角色身份由系统自动加入。",
  Mood: "情绪",
  Setting: "场景",
  Outfit: "服装",
  Camera: "镜头",
  Lighting: "光线",
  Consistency: "一致性",
  Strict: "严格",
  Balanced: "平衡",
  Creative: "创意",
  References: "参考图",
  "Identity sources and recent approved images": "视觉身份来源和近期已通过素材",
  "No references yet": "暂无参考图",
  "Estimated cost": "预计费用",
  "Generate {count} selected directions": "生成已选的 {count} 个方向",
  "Generate directions": "生成创意方向",
  "No prompt needed — starter directions will use the character identity and references.":
    "无需填写提示词，系统会根据角色身份和参考图生成起始创意方向。",
  "Images per direction": "每个方向图片数",
  "images per direction": "张/方向",
  each: "每张",
  "Creative directions": "创意方向",
  "Edit the prompts, then select the directions worth producing.":
    "编辑提示词，然后选择值得正式生产的方向。",
  "Developing four visual stories…": "正在构思 4 个视觉故事…",
  "Start with the story, not the model": "先从故事开始，而不是先选模型",
  "Write a creative brief and scene prompt. The studio will turn them into four distinct camera and story directions.":
    "填写创意简报和场景提示词，工作台会把它们展开成 4 个不同的故事与镜头方向。",
  "Add a creative brief or scene prompt for more control, or generate starter directions from the locked identity and references.":
    "填写创意简报或场景提示词可获得更精确的控制，也可以直接根据已锁定身份和参考图生成起始方向。",
  "Select direction {title}": "选择创意方向 {title}",
  "Direction title": "方向标题",
  "Shot plan": "镜头方案",
  "Recent sets": "近期素材组",
  "No production sets for this character yet.": "这个角色还没有生产素材组。",
  Unreviewed: "待审核",
  Selected: "已选择",
  "Approve {count} selected": "通过已选的 {count} 项",
  Retry: "重试",
  "Image details": "图片详情",
  "More like this": "生成相似图",
  "More like this needs a compatible active Character identity route.":
    "生成相似图需要兼容且已启用的角色身份路由。",
  "More like this is unavailable because the active model profile cannot use the selected image as an init image.":
    "当前模型配置无法把所选图片作为初始图，因此不能生成相似图。",
  "More like this is unavailable because the active workflow does not accept a source image.":
    "当前工作流不接受来源图片，因此不能生成相似图。",
  "More like this is unavailable because the active workflow cannot combine a source image with the canonical identity references.":
    "当前工作流无法同时使用来源图片和角色标准身份参考，因此不能生成相似图。",
  "More like this is unavailable because the active workflow has no remaining reference capacity after the canonical identity references.":
    "当前工作流装入角色标准身份参考后已无剩余参考图容量，因此不能生成相似图。",
  "More like this is unavailable because the active workflow cannot map the canonical identity and source image into distinct semantic slots.":
    "当前工作流无法把角色标准身份与来源图片映射到不同输入位，因此不能生成相似图。",
  "Review generation route": "检查生成路由",
  "Approved for the character chat pool": "已进入角色聊天素材池",
  "Loading image production…": "正在加载图片生产工作台…",
  "Production started for {count} creative directions.":
    "已开始生产 {count} 个创意方向。",
  "Placement published.": "铺位已发布。",
  // character visual identity (was "Visual Passport")
  "Visual Identity": "视觉身份",
  // settings tab subtitle (Presets moved out of Settings in Task 2)
  "Feature flags": "功能开关",
  // guided Dashboard — attention panel + task launcher cards (task 3).
  "Needs your attention": "需要你处理的",
  "Common tasks": "常用任务",
  "Health overview": "健康概览",
  "Failed/blocked jobs": "失败/blocked 任务",
  "Open reports": "待处理举报",
  // "Pending submissions" reuses the existing key defined above (line ~280).
  "Open tickets": "待处理工单",
  "Add official character": "上架新角色",
  "Batch generate images": "生产一批图",
  "Go to review queue": "去审核",
  Handle: "去处理",
  // generation-group redesign (task 13 zh backfill) — FailureReason/EngineeringDetails/
  // ReadonlyOpsView primitives + failureReasons.ts titles/hints。
  // 下面 failureReasons 的 title/hint 只经 t(reason.title) 动态取值，i18n-completeness
  // 的 AST 扫描只看字面量实参，扫不到它们 —— 删掉不会红，只会静默退回英文。
  "Technical detail": "技术详情",
  "Engineering details": "工程详情",
  "Model files not ready": "模型文件未就绪",
  "Missing runtime components — needs engineering": "缺运行组件，需工程处理",
  "Generation timed out": "生成超时",
  "Safe to retry": "可重试",
  "Backend unreachable": "后端不可达",
  "Check backend health — needs engineering": "检查后端健康，需工程处理",
  "Unknown error": "未知错误",
  "Share the error code with engineering": "请把错误代码给工程",
  // BackendsView.tsx (task 12) — connection details fold + ReadonlyOpsView columns.
  "Connection details": "连接详情",
  Endpoint: "端点",
  "CLI Path": "CLI 路径",
  "No backends.": "暂无后端。",
  ok: "正常",
  fail: "异常",
  Backend: "后端",
  Kind: "类型",
  // shared ReadonlyOpsView column labels — Jobs (task 10) / Dead-letter (task 11) / Backends (task 12).
  "Failure reason": "失败原因",
  User: "用户",
  Created: "创建时间",
  Cost: "费用",
  "Select all": "全选",
  // DeadLetterView screen-reader aria-labels (fix wave 1, #5).
  "Select dead-letter job {id}": "选择死信任务 {id}",
  "Select dead-letter job": "选择死信任务",
  "Select all dead-letter jobs": "全选死信任务",
  // GenerationJobInspector — pre-existing detail drawer, now opened from the redesigned JobsView.
  Timeline: "时间线",
  // ConfigOverviewHeader / ConfigTabNav (task 7).
  "Test and publish generation profiles": "测试并发布生成配置",
  "Pick a profile to check readiness, then publish it. Model files and runner setup stay in engineering-owned config.":
    "选择一个配置检查就绪度，然后发布；模型文件与运行器设置归工程配置管理。",
  Profiles: "配置",
  // profileStateLabelKey / recipeStateLabelKey (tasks 7-8) — operator-facing state phrases;
  // "draft" is the raw-status fallback branch.
  "Blocked — needs engineering": "已阻止，需工程处理",
  "Needs testing": "待测试",
  "Ready to publish": "可发布",
  draft: "草稿",
  // ProfileDetail (task 7).
  "Select a profile to review its readiness and publish it.":
    "选择一个配置查看就绪度并发布。",
  "Generate test image": "生成测试图",
  "Model & workflow details": "模型与工作流详情",
  Workflow: "工作流",
  "(use pipelineModel)": "（使用 pipelineModel）",
  "(needs reference image — not for standard profiles)":
    "（需要参考图，标准配置不适用）",
  "Only draft profiles can change workflow routing.":
    "只有草稿配置可以修改工作流路由。",
  "Workflow saved": "工作流已保存",
  "Workflow save failed": "工作流保存失败",
  "Profile ID": "配置 ID",
  "Profile key": "配置键",
  Version: "版本",
  "Pipeline model": "流水线模型",
  "Model file": "模型文件",
  "Active workflow": "当前工作流",
  "Verification status": "验证状态",
  Rollout: "放量",
  "Required entitlement": "所需权益",
  // ProfileVerificationPanel — pre-existing, now folded inside ProfileDetail's EngineeringDetails;
  // only the fully-static status+componentMeta combinations are matchable (dynamic "N/M component
  // issues" counts can't be, by construction, keyed in a static dictionary).
  "No local model verification required · No component status recorded":
    "无需本地模型验证 · 无组件状态记录",
  "Verification status missing · No component status recorded":
    "验证状态缺失 · 无组件状态记录",
  "Model verification passed · No component status recorded":
    "模型验证已通过 · 无组件状态记录",
  // Recipe details/ID reused by the recipes trio (task 14); "Untitled recipe"/"Select a
  // recipe…"/"Recipe key" (lowercase) were task-8 PromptRecipesView-only copy, now dead —
  // removed with that view (task 14 slimming).
  "No prompt recipes yet.": "暂无提示词配方。",
  "Recipe details": "配方详情",
  "Recipe ID": "配方 ID",
  // Preset details/ID/type reused by the presets trio (task 15); "Untitled preset"/"Select a
  // preset to review it." were the old GenerationPresetsView/PresetDetail-only copy (task 9),
  // now dead — removed with that view (task 15 slimming).
  "No built-in presets are seeded yet.": "暂无内置预设。",
  "Preset details": "预设详情",
  "Preset ID": "预设 ID",
  "Preset type": "预设类型",
  "No built-in generation profiles are seeded yet.": "暂无内置生成配置。",
  // Official characters trio — OfficialListPage/OfficialDetailPage/OfficialNewPage (task 10-12).
  // "No official characters yet." already existed above (line ~259); not duplicated here.
  "Search by name": "按名字搜索",
  "reference images": "张参考图",
  "Create the first official character to get started.":
    "创建第一个官方角色，从这里开始。",
  "AI assist": "AI 辅助",
  "One-line inspiration — AI fills description and tags.":
    "一句话灵感——AI 自动填充描述与标签。",
  Inspiration: "灵感",
  "Basic info": "基本信息",
  "Description & tags": "描述与标签",
  "Character not found.": "未找到该角色。",
  "Edit profile": "编辑资料",
  "Save changes": "保存修改",
  // Starter templates trio — StartersListPage/StartersDetailPage/StartersNewPage (task 13).
  // "AI assist"/"Basic info"/"Description & tags"/"Save changes"/"Edit profile"/"Search by name"/
  // "Loading…"/"Request failed"/"Cancel"/"Publish"/"Offline"/"Character not found."/"All"/"Status"/
  // "Reason (≥3)"/"Name (≥1)"/"Gender"/"Style"/"Summary (≤200)"/"Tags (comma-separated, ≤12)"/
  // "Generate with AI"/"Inspiration"/"Sort order"/"One-line inspiration…"/"Create character template"
  // already exist above (shared trio/generic copy); not duplicated here.
  "New starter template": "新建角色模板",
  "Manage starter templates for user character creation.":
    "管理用户建角时的起步模板。",
  "Back to starter templates": "返回角色模板",
  "No starter templates yet.": "还没有角色模板。",
  "Create the first starter template to get started.":
    "创建第一个角色模板，从这里开始。",
  Inactive: "未上线",
  Scope: "范围",
  Category: "分类",
  "{count} tags": "{count} 个标签",
  // Prompt recipes trio — RecipesListPage/RecipesDetailPage/RecipesNewPage (task 14).
  // "Basic info"/"Recipe Key"/"Label"/"Mode"/"Use Case"/"Body"/"Negative Base"/"Version"/
  // "Recipe details"/"Recipe ID"/"Prompt Recipes"/"Search by name"/"All"/"Status"/"Loading…"/
  // "Request failed"/"Cancel"/"Save changes"/"Edit profile"/"Publish"/"Rollback"/"Create Draft"/
  // "No prompt recipes yet."/"Ready to publish"/"Published"/"Archived" already exist above; not
  // duplicated here.
  "New prompt recipe": "新建提示词配方",
  "Manage prompt recipes for image generation.": "管理生图提示词配方。",
  "Back to prompt recipes": "返回提示词配方",
  "Create the first prompt recipe to get started.":
    "创建第一个提示词配方，从这里开始。",
  "Recipe not found.": "未找到该配方。",
  "Only draft recipes can be edited.": "只有草稿状态可编辑。",
  "Publish recipe": "发布配方",
  "Rollback recipe": "回滚配方",
  // Generation presets trio — PresetsListPage/PresetsDetailPage/PresetsNewPage (task 15).
  // "Basic info"/"Label"/"Category"/"Search by name"/"All"/"Status"/"Loading…"/"Request failed"/
  // "Cancel"/"Save changes"/"Edit profile"/"Restore"/"Presets"/"No built-in presets are seeded
  // yet."/"Preset details"/"Preset ID"/"Preset type" already exist above; not duplicated here.
  "New preset": "新建预设",
  "Manage built-in generation presets.": "管理内置生成预设。",
  "Back to presets": "返回预设",
  "Create the first preset to get started.": "创建第一个预设，从这里开始。",
  "Preset not found.": "未找到该预设。",
  "Archive preset": "归档预设",
  "Controls (JSON)": "控制参数（JSON）",
  Type: "类型",
  Visibility: "可见性",
  "Create preset": "创建预设",
  // Image library grid + detail — AssetsListPage/AssetsDetailPage (task 16). "Image Library"/
  // "Status"/"All"/"Loading…"/"Request failed"/"Basic info"/"Description & tags"/"Target type"/
  // "Target ID"/"Size"/"Generation job"/"Profile"/"Media asset"/"Tags"/"Description"/"Approve"/
  // "Save"/"Reject"/"Archive"/"Source" already exist above; not duplicated here.
  "Browse and curate generated image assets.": "浏览与治理生成图片资产。",
  "Search by tag, description, or asset ID": "按标签、描述或资产 ID 搜索",
  Purpose: "用途",
  "No platform assets match these filters.": "没有符合筛选条件的平台资产。",
  "Bulk archive": "批量归档",
  "Select page": "选择本页",
  "Clear selection": "清空选择",
  "Archive selected": "归档已选",
  "Archive selected assets": "归档已选资产",
  "Archive only after every active usage has been replaced or withdrawn.":
    "仅在所有当前使用关系都已替换或撤回后归档。",
  "Select asset {id}": "选择资产 {id}",
  "Already archived": "已归档",
  "Checking dependencies…": "正在检查依赖关系…",
  "Could not check selected asset dependencies.":
    "无法检查所选资产的依赖关系。",
  "Bulk archive is atomic. If one asset is still in use, none of the selected assets will change.":
    "批量归档是原子操作。如果任一资产仍在使用，所有所选资产都不会改变。",
  "Preflight checked {count} assets. No active authority dependencies were found.":
    "预检了 {count} 个资产，未发现当前权威依赖。",
  "Dependency preflight failed for asset(s) {ids}: {message}":
    "资产 {ids} 的依赖预检失败：{message}",
  "Paste these exact asset IDs to confirm": "粘贴以下完整资产 ID 以确认",
  "Paste exact asset IDs to confirm": "粘贴完整资产 ID 以确认",
  "{count} selected assets have active authority dependencies.":
    "已选资产中有 {count} 个存在当前权威依赖。",
  "Repair each usage before archiving. No selected asset was changed.":
    "归档前请修复每个使用关系。所选资产均未改变。",
  "Archive blocked by a newer authority dependency. No selected asset was changed.":
    "新的权威依赖阻止了归档。所选资产均未改变。",
  "Missing selected assets: {ids}": "缺少所选资产：{ids}",
  "{count} assets archived. The selection was cleared.":
    "已归档 {count} 个资产，并已清空选择。",
  "Next page": "下一页",
  "Back to image library": "返回图片库",
  "Asset not found.": "未找到该资产。",
  "Assets have no name — type the first 8 characters of the ID to confirm.":
    "资产没有名称——请输入资产 ID 前 8 位以确认。",
  "Tags and descriptions make assets searchable for chat reuse.":
    "标签与描述让资产可以被检索并在聊天中复用。",
  "Asset details": "资产详情",
  Batch: "批次",
  // AssetImage primitive (ui/AssetImage.tsx, task 16) — failed-thumbnail fallback copy.
  Missing: "缺失",
  "Missing asset": "资产缺失",
  // Placements trio — PlacementsListPage/PlacementsDetailPage/PlacementsNewPage (task 17).
  // "All"/"Archive"/"Basic info"/"Loading…"/"Publish"/"Published"/"Reason (≥3)"/"Request failed"/
  // "Status"/"Target ID"/"Target type"/"Media asset"/"Placements" already exist above; not
  // duplicated here.
  Asset: "资产",
  "Back to placements": "返回铺位",
  "Create placement": "创建铺位",
  "Create the first placement to get started.": "创建第一个铺位，从这里开始。",
  "Manage where approved images are surfaced across the platform.":
    "管理已通过图片在平台各处的展示位置。",
  "New placement": "新建铺位",
  "No placements yet.": "暂无铺位。",
  Pause: "暂停",
  "Placement details": "铺位详情",
  "Placement ID": "铺位 ID",
  "Placement not found.": "未找到该铺位。",
  "Search by slot, target, or asset ID": "按位置、目标或资产 ID 搜索",
  Slot: "位置",
  Target: "目标",
  // Tags page — TagsView.tsx retrofit (task 17). "Cancel"/"Category (blank=none)"/"category"/
  // "characters"/"Edit"/"label"/"Label"/"Merge tags"/"Merge"/"muted"/"No tags."/"no"/"Refresh"/
  // "Save changes"/"sensitive"/"slug"/"Source and target must differ."/"Source tag"/"Source tag…"/
  // "Tag taxonomy"/"Tags"/"Target tag"/"Target tag…"/"yes" already exist above; not duplicated here.
  "Manage the tag vocabulary for characters.": "管理角色标签词表。",
  "Merged — moved {count} character link(s).":
    "已合并——迁移了 {count} 个角色关联。",
  "Move every character from the source tag to the target tag, then delete the source tag.":
    "将 source 标签下的角色全部迁移到 target 标签，然后删除 source 标签。",
  "Moves every character from {source} to {target}, then deletes {source}.":
    "会把 {source} 下的角色迁移到 {target}，随后删除 {source}。",
  // Official detail page — Stats/Image production linkout block (task 18 zh coverage sweep).
  // "Chats" already exists above (shared with dashboard "聊天数"); "Visibility" already exists
  // above (shared with presets). Rest of OFFICIAL_KEYS already covered by shared primitives.
  "Image production": "图片生产",
  Likes: "点赞数",
  "Open image production": "打开图片生产",
  "Publish character": "发布角色",
  Stats: "数据统计",
  "Unpublish character": "取消发布角色",
  Views: "浏览数",
  // VisualPassportPanel (task 18 zh coverage sweep) — embedded in OfficialDetailPage, never had
  // full zh coverage since it was built. "Loading…"/"Reason (≥3, for audit)"/"Refresh"/"Status"/
  // "Type {token} to confirm"/"Version"/"Visual Identity" already exist above; not duplicated
  // here. Face/Hair/Body/Signature trait labels use a "traits" suffix (see VISUAL_PASSPORT_KEYS
  // comment) to avoid colliding with unrelated existing keys of the same bare word.
  "Created from": "创建来源",
};

const zhValues: Record<string, string> = {
  // SPEC: 角色组合决策与线上表现的枚举值（Promote…/mature…/certified…/exact…）。
  // 走 zhValues 通道而不是 zh —— 它们是枚举，StatusBadge 与 <option> 共用同一份译文。
  Promote: "推广",
  Maintain: "维持",
  Improve: "改进",
  Retire: "下线",
  // maturity 是两个维度：immature 说的是观察窗口还没走完（时间），insufficient_data 才是
  // 窗口走完了但样本没达标（样本量）。译文混用"样本不足"会让运营把"再等等"当成"投放不够"。
  mature: "证据充分",
  immature: "观察期未到",
  "insufficient data": "样本不足",
  certified: "已核准",
  directional: "仅供参考",
  invalid: "口径异常",
  no_data: "暂无观测",
  "no data": "暂无观测",
  exact: "精确",
  partial: "部分",
  // 发布护栏状态与建议动作
  "not required": "无需处理",
  "action required": "需要处理",
  action_required: "需要处理",
  continue_monitoring: "继续观察",
  active: "启用",
  accepted: "已接受",
  actioned: "已处理",
  all: "全部",
  anime: "动漫",
  approved: "已通过",
  archived: "已归档",
  audit: "审计",
  available: "已就绪",
  blocked: "已拦截",
  built_in: "内置",
  character: "角色",
  comfyui: "ComfyUI",
  community: "社区",
  completed: "已完成",
  connected: "已连接",
  closed: "已关闭",
  configured: "已配置",
  disconnected: "未连接",
  detected: "已发现",
  development: "开发环境",
  draft: "草稿",
  due_today: "今日到期",
  due_soon: "即将超时",
  expired: "已过期",
  external: "外部",
  fail: "失败",
  failed: "失败",
  female: "女性",
  flagged: "已标记",
  freeplay: "自由玩法",
  generating: "生成中",
  grant: "授予",
  revoke: "撤销",
  clear: "清除",
  hybrid: "混合",
  high: "高",
  image: "图片",
  info: "信息",
  in_progress: "进行中",
  in_review: "审核中",
  input: "输入",
  internal: "内部",
  male: "男性",
  manual_passed: "人工通过",
  medium: "中",
  mitigating: "缓解中",
  mlx: "MLX",
  missing: "缺失",
  monitoring: "监控中",
  mine: "我的",
  new: "新建",
  negative: "负向",
  not_required: "无需验证",
  open: "打开",
  on_track: "正常",
  other: "其他",
  output: "输出",
  overdue: "已超时",
  pending: "待处理",
  paused: "已暂停",
  pass: "通过",
  passed: "已通过",
  pipeline: "流水线",
  promo: "推广",
  published: "已发布",
  queued: "排队中",
  recorded: "已记录",
  realistic: "写实",
  received: "已收到",
  refunded: "已退款",
  rejected: "已拒绝",
  removed: "已移除",
  required: "需要验证",
  resolved: "已解决",
  sent: "已发送",
  suspended: "已封禁",
  succeeded: "已成功",
  trans: "跨性别",
  unlimited: "无限",
  unsupported: "不支持",
  unknown: "未知",
  verified: "已验证",
  video: "视频",
  voice: "语音",
  warning: "警告",
  waiting_on_user: "等待用户",
  // generation-group redesign (task 13 zh backfill) — GenerationPreset.type / .visibility enums,
  // surfaced via value() by the presets trio (task 15).
  background: "背景",
  pose: "姿势",
  outfit: "服装",
  mode: "模式",
  private: "私密",
  public: "公开",
  unlisted: "不公开列出",
  // fix wave 1 (#1): GenerationJob.status + .ledgerState enum cells now render via value() on the
  // jobs/dead-letter ReadonlyOpsView tables. queued/completed/failed/blocked/refunded/image/video
  // already exist above; these are the remaining reachable values.
  running: "运行中",
  moderating_input: "输入审核中",
  moderating_output: "输出审核中",
  reserved: "已预留",
  staging: "预发布环境",
  test: "测试环境",
  triaged: "已分诊",
  upcoming: "即将到期",
  validating: "验证中",
  verifying: "验证中",
  waiting: "等待中",
  production: "生产环境",
  low: "低",
  critical: "严重",
  // Image library grid + detail (task 16) — MediaAsset.platformStatus "generated" (approved/
  // rejected/published/archived/draft already exist above), ContentProductionBatch.targetType
  // enum beyond "character" (already exists), and productionPurposeSchema (asset "purpose" +
  // list filter, ProductionStudioView's own local purposeOptions shares these same values).
  generated: "已生成",
  none: "无",
  route_page: "页面",
  template: "模板",
  campaign: "活动",
  character_cover: "角色封面",
  character_hero: "角色大图",
  character_chat: "角色聊天",
  feed: "信息流",
  homepage: "首页",
  seo: "SEO",
  template_cover: "模板封面",
  model_eval: "模型评测",
  // Placements trio (task 17) — placementSlotSchema slot values beyond the ones already covered
  // above (character_avatar/character_hero share the character_* purpose values; template_cover/
  // campaign are shared with productionPurposeSchema/targetType), plus placementStatusSchema's
  // "scheduled" (draft/published/paused/archived already exist above).
  character_avatar: "角色头像",
  feed_card: "信息流卡片",
  homepage_strip: "首页横条",
  seo_article: "SEO 文章",
  scheduled: "已排期",
};

type TranslationValues = Record<string, string | number>;

type AdminI18nContextValue = {
  locale: AdminLocale;
  t: (key: string, values?: TranslationValues) => string;
  value: (key: string) => string;
};

function interpolate(template: string, values?: TranslationValues) {
  if (!values) return template;
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function isAdminLocale(value: string | null): value is AdminLocale {
  return value === "en" || value === "zh";
}

export function getStoredAdminLocale(): AdminLocale {
  if (typeof window === "undefined") return "en";
  const value = window.localStorage.getItem(ADMIN_LOCALE_STORAGE_KEY);
  return isAdminLocale(value) ? value : "en";
}

export function storeAdminLocale(locale: AdminLocale) {
  window.localStorage.setItem(ADMIN_LOCALE_STORAGE_KEY, locale);
}

export function translateAdmin(
  locale: AdminLocale,
  key: string,
  values?: TranslationValues,
) {
  const template =
    locale === "zh"
      ? (zh[key] ?? zhValues[key] ?? translateDynamicAdminZh(key) ?? key)
      : key;
  return interpolate(template, values);
}

function translateDynamicAdminZh(key: string) {
  const characterCommand = /^character (.+) command is ([a-z_]+)$/i.exec(key);
  if (characterCommand) {
    const [, characterId, status] = characterCommand;
    return `角色 ${characterId} 的命令状态为 ${zhValues[status] ?? status}`;
  }

  const openSince = /^([a-z_]+) severity · open since (.+)$/i.exec(key);
  if (openSince) {
    const [, severity, since] = openSince;
    return `${zhValues[severity] ?? severity}严重程度 · 开始于 ${since}`;
  }

  return undefined;
}

// SPEC: does the Chinese locale have a real translation for `key`
// (dictionary text or a translated enum value, rather than falling back to English)?
// Used by tests to lock that a given nav/label key is actually translated, not just rendered.
export function hasAdminZh(key: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(zh, key) ||
    Object.prototype.hasOwnProperty.call(zhValues, key)
  );
}

export function adminValueLabel(locale: AdminLocale, key: string) {
  return locale === "zh" ? (zhValues[key] ?? key) : key;
}

export function adminDateLocale(locale: AdminLocale) {
  return locale === "zh" ? "zh-CN" : undefined;
}

const defaultContext: AdminI18nContextValue = {
  locale: "en",
  t: (key, values) => translateAdmin("en", key, values),
  value: (key) => adminValueLabel("en", key),
};

const AdminI18nContext = createContext<AdminI18nContextValue>(defaultContext);

export function AdminI18nProvider({
  children,
  locale,
}: {
  children: ReactNode;
  locale: AdminLocale;
}) {
  const value: AdminI18nContextValue = {
    locale,
    t: (key, values) => translateAdmin(locale, key, values),
    value: (key) => adminValueLabel(locale, key),
  };

  return <AdminI18nContext value={value}>{children}</AdminI18nContext>;
}

export function useAdminI18n() {
  return useContext(AdminI18nContext);
}

export function AdminText({ text }: { text: string }) {
  const { t } = useAdminI18n();
  return t(text);
}
