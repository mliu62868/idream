# H3 NSFW 与 LoRA 实验证据（2026-09-29）

完整解释见上级 [研究记录](../../MINIMAX_H3_TURBO_LORA_CLAIM_VERIFICATION_2026-09-29.md)。

- `experiment-summary.json`：机器、固定源码、原生运行命令/退出码/耗时和视频验证。
- `checkpoint-provenance.json`：当前 NSFW 文件保存的基础模型、融合 LoRA 和量化参数。
- `verification.json`：真实新 Turbo 对四个 BF16 矩阵的抽样 CPU oracle 比较；不是全 INT8 模型运行时叠加证明。
- `convrot-json-whitespace.patch` 与 red/green logs：隔离 native clone 的真实 loader 修复。
- native/conditioning logs：原始运行证据；`missing-config` 为保留的失败尝试。
- Python/TypeScript 文件：实验脚本快照。执行位置仍是 `/Users/kk/code/idream/.scratch/h3-lora-20260929/`，其中有完整 clone、权重 symlink 与 adapter；此目录未复制大权重、fixture、二进制或视频。

复跑只使用本机现有 NSFW checkpoint 和 VAE。先将已保存的 patch 应用到固定 maderix revision 并编译，在原 `.scratch` 位置通过 `bun .scratch/h3-lora-20260929/lease-runner.ts` 的 `conditioning`、`render4`、`render8` 模式获得统一 GPU 租约。所保存 runner 的相对 import 以原 `.scratch` 位置为准；证据目录的快照不是独立安装包。

读取视频容器与完整解码可运行原位置的 `inspect_videos.py`。本轮已经完成验证；实验日志保留原始内容，未筛掉失败路径。
