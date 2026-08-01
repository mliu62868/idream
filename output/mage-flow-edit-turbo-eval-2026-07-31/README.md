# Mage-Flow-Edit Turbo 本地验证

日期：2026-07-31

## 结论

`Mage-Flow-Edit-Turbo` 的 ComfyUI BF16 raw-weight 路径在本机 Apple M4 Max / MPS 上真实可运行，也真实支持成人裸体编辑：三个不同 seed 全部生成成功，没有拒绝、占位图或自动补衣。

它不是成人专项 checkpoint。三张成人输出都出现了原泳衣拉带手势被保留为“捏空气”的问题，皮肤偏磨皮，胸部细节略不稳定。普通背景编辑的指令遵循很好，但相对当前 Qwen v19，脸和身体比例有更多重新渲染与轻微漂移。

速度优势很大：800×992、4 steps、CFG 1 下，MageFlow 冷跑 15.22 秒，成人热跑中位数 9.79 秒；Qwen v19 同尺寸/步数普通冷跑 109.89 秒，成人热跑 98.37 秒。由于两者推荐 sampler 不同，这是一组实际工作流比较，不是纯 kernel 比较。

建议保留 Qwen v19 默认路由，将 MageFlow 作为独立 opt-in 候选继续做角色身份与复杂局部编辑 A/B。

## 运行表

| 模型 | 场景 | Seed | 用时 | 结果 |
| --- | --- | ---: | ---: | --- |
| MageFlow BF16 | 普通背景编辑，冷跑 | 4242 | 15.223 s | 成功 |
| MageFlow BF16 | 成人裸体编辑 | 4242 | 11.210 s | 成功 |
| MageFlow BF16 | 成人裸体编辑 | 4243 | 8.746 s | 成功 |
| MageFlow BF16 | 成人裸体编辑 | 4244 | 9.792 s | 成功 |
| Qwen v19 FP8→BF16 | 普通背景编辑，模型切换冷跑 | 4242 | 109.887 s | 成功 |
| Qwen v19 FP8→BF16 | 成人裸体编辑，热跑 | 4242 | 98.366 s | 成功 |

## 文件

- `cases.json`：固定 prompt、seed 与参数。
- `api-prompt-template.json`：MageFlow ComfyUI API prompt。
- `qwen-api-prompt-template.json`：当前 Qwen v19 对照 API prompt。
- `results.json`：权重 SHA、runtime、prompt id、缓存节点与精确用时。
- `source.webp`：统一 source image。
- `mage-*.png` / `qwen-*.png`：真实输出。

默认路由、seed 配置和 iDream workflow 均未修改。
