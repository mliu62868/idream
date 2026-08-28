# RedCraft H3 A2A-RED beta2 + LTX-2.5 2K on Mac M4

Date: 2026-08-27  
Status: research only; no model download, runtime route, or product profile change

## Conclusion

The linked Civitai version is not a self-contained 2K model. It is a two-stage recipe:

1. MiniMax H3 produces a low-resolution audio-video draft.
2. LTX-2.5 uses video/IC conditioning, distilled sampling, latent 2x upscaling, frame interpolation, and VSR to produce roughly 1440x2160 output.

The current iDream MacBook Pro (M4 Max, 128 GiB unified memory) is capable enough to evaluate this pipeline locally. It is not a drop-in replacement for the current LTX-2.3 route, however. The exact public Civitai version contains only one H3 INT8 diffusion checkpoint and does not publish the complete LTX-2.5 workflow or all of its dependent weights.

The immediate local blocker is storage, not unified memory: only about 73 GiB was free during this review, while the complete H3 plus official BF16 LTX-2.5 component set is about 106.5 GiB before RIFE/VSR models, caches, temporary frames, and outputs.

## What the Civitai version actually contains

Civitai model `958009`, version `3262321`, is named `H3 A2A-RED ( beta2 )` and is based on MiniMax H3. Its version API publishes exactly one file:

| File | Precision | Size |
| --- | --- | ---: |
| `redcraftREDMIXHybridA2A_h3A2AREDBeta2.safetensors` | INT8 SafeTensor | 20.97 GiB |

The author describes the full result as H3 draft generation followed by LTX-2.5 IC-guided V2V, approximately 8 distilled steps plus 3 latent-upscale steps, RIFE interpolation to 48 fps, and VSR to about 1440x2160. The reported 8-second timings are about 200 seconds on an A5000 24 GB and 120 seconds on a 5090D 24 GB. The same description calls 16 GB VRAM the intended floor, but that is a discrete-GPU statement and is not equivalent to a 16 GB unified-memory Mac.

Source: [Civitai version API](https://civitai.com/api/v1/model-versions/3262321), accessed 2026-08-27.

Evidence gap: the public version API exposes no workflow JSON and no LTX-2.5, IC-LoRA, RIFE, or VSR file manifest. The linked checkpoint alone cannot reproduce the advertised 2K pipeline.

## Memory and storage envelope

### Model storage

Sizes below use the exact published file sizes and the current local H3 dependencies.

| Component set | Approximate disk size |
| --- | ---: |
| H3 beta2 checkpoint | 20.97 GiB |
| Current H3 Qwen text encoder plus video/audio VAEs | 18.99 GiB |
| Complete H3 stage | 39.96 GiB |
| Official LTX-2.5 distilled BF16 transformer, BF16 Gemma 4 encoder, video/audio VAEs, spatial upscaler | 66.23 GiB |
| Official LTX-2.5 detailing IC-LoRA | 0.30 GiB |
| H3 plus BF16 LTX-2.5 and IC-LoRA | 106.49 GiB |

The official LTX-2 quick start independently describes its BF16 download as roughly 66 GiB and supports CPU/disk offload. Sources: [LTX-2 official repository](https://github.com/Lightricks/LTX-2), [LTX-2.5 file tree](https://huggingface.co/api/models/Lightricks/LTX-2.5/tree/main?recursive=true&expand=true), accessed 2026-08-27.

The INT8 ConvRot LTX-2.5 transformer and text encoder reduce the LTX component set to roughly 37.3 GiB, but that format is optimized for CUDA-style integer kernels. It is not the preferred Mac path without an exact end-to-end MPS validation.

Practical storage recommendation for the full experiment: keep 120-160 GiB free. This leaves room for the missing RIFE/VSR weights, model caches, decoded frames, temporary files, and output artifacts.

### Unified memory

Official LTX Desktop currently allows local Apple Silicon generation when at least 15 GB of RAM is free at process start, then streams model blocks from disk. This is a free-memory floor, not a total-memory recommendation. Its current runtime policy records a single validated streaming data point on an M4 Pro with 48 GB and describes an approximately 13 GB process RSS; the same source deliberately treats full-resident loading as a much larger and less-validated regime.

Sources: [LTX Desktop requirements](https://github.com/Lightricks/LTX-Desktop#local-vs-api-mode), [runtime policy source](https://github.com/Lightricks/LTX-Desktop/blob/main/backend/runtime_config/runtime_policy.py), accessed 2026-08-27.

For this combined H3 plus LTX workflow, the practical interpretation is:

| Mac unified memory | Assessment |
| --- | --- |
| 16 GB | Not suitable: it cannot realistically keep 15 GB free after macOS and the app start. |
| 24 GB | Technically possible only with aggressive streaming and a very idle host; not recommended for the combined workflow. |
| 32 GB | Experimental streaming tier; likely high swap pressure and long stalls. |
| 48 GB | Lowest practical tier with first-party LTX streaming evidence; still run H3 and LTX sequentially. |
| 64 GB | Reasonable local-development tier. |
| 96/128 GB | Preferred for this experiment. The current 128 GB M4 Max is suitable. |

These tiers are engineering recommendations, not official guarantees for the exact RedCraft graph, because the author has not published a matched Apple Silicon benchmark.

## Current local Mac evidence

Read-only checks on 2026-08-27 found:

- MacBook Pro `Mac16,6`, Apple M4 Max, 128 GiB unified memory.
- Active ComfyUI on `127.0.0.1:8188`: ComfyUI 0.33.0, Python 3.13.12, PyTorch 2.10.0, MPS.
- About 92 GiB of unified memory was free at the check.
- About 73 GiB of disk space was free.
- Native LTXAV nodes are present.
- `ComfyUI-AppleSilicon-FP8` commit `911294ca35093eef56f7f2695414ff8810e88e50` is loaded and patches generic FP8/INT8/ConvRot seams on MPS.
- Raw PyTorch `torch._int_mm` still raises `NotImplementedError` on MPS without that custom patch.
- The startup capability log reports that M4 lacks the newer cooperative TensorOps tier used by the custom node's native INT8 kernel, so the M4 path is a compatibility path rather than the author's CUDA acceleration path.

A previous, similar RedCraft H3 INT8 checkpoint already completed locally on this M4 Max: 512x512, 124 frames, 5.167 seconds of output, about 667 seconds end to end. The current LTX-2.3 INT4 route historically took about 624 seconds for 97 frames at 768x1152. These are separate historical probes and must not be added as a controlled LTX-2.5 benchmark, but they show why the author's 120-200 second CUDA timing must not be projected onto this Mac.

## Mac support routes

### 1. Recommended for initial feasibility: official LTX Desktop 1.2.7

LTX Desktop is first-party, supports local LTX-2.5 Fast on Apple Silicon/MPS, and exposes IC-LoRA. Release 1.2.7 specifically fixes a Mac LTX-2.5 denoise memory spike. This is the lowest-risk way to establish that the LTX-2.5 stage works on this Mac before integrating it into iDream.

Sources: [LTX Desktop](https://github.com/Lightricks/LTX-Desktop), [release 1.2.7](https://github.com/Lightricks/LTX-Desktop/releases/tag/v1.2.7), accessed 2026-08-27.

Limitation: it does not reproduce the author's unpublished ComfyUI graph automatically. The H3 MP4 must be passed into an appropriate LTX-2.5 IC-LoRA/V2V flow and compared against the author's intended parameters.

### 2. Recommended for an eventual iDream backend: official LTX-2 BF16/MPS pipeline

The current official LTX-2 repository selects MPS on Apple Silicon, includes an Apple-specific fused `mps-sdpa` attention path, supports block/disk streaming, and provides Distilled, DFR, and IC-LoRA pipelines. Use BF16 weights and explicit disk offload for a Mac candidate. Prefer the lighter convolutional video VAE for the first smoke test; move to the diffusion VAE only after the base route is stable.

Source: [LTX-2 official repository](https://github.com/Lightricks/LTX-2), accessed 2026-08-27.

This path is more suitable than a GUI dependency for product integration, but it still needs a local service adapter, a pinned revision, and real output validation.

### 3. Existing ComfyUI route: candidate only

ComfyUI 0.33.0 has the required LTXAV model family nodes, and the local Apple-Silicon patch makes INT8/ConvRot loading and execution more plausible than stock MPS. However:

- the exact LTX-2.5 INT8 checkpoint has not been downloaded or generated locally;
- the M4 path is not the native M5/Metal cooperative TensorOps path;
- the exact Civitai workflow is absent;
- ComfyUI has an open Apple Silicon report for intermittent BF16 LTX-2.x all-NaN attention and black videos.

Source: [ComfyUI issue 15804](https://github.com/Comfy-Org/ComfyUI/issues/15804), accessed 2026-08-27.

Therefore a model-visible load and one successful video are not enough. Require several fixed and varying seeds, finite-value checks, decoded-frame pixel sanity, memory/swap telemetry, and output playback validation before treating this route as usable.

### 4. CPU fallback for missing MPS integer ops: last resort

`PYTORCH_ENABLE_MPS_FALLBACK=1` can move unsupported operators to CPU. It is useful for diagnosis but is not a production solution for a 22B video transformer because repeated CPU/MPS fallback can turn a generation into a practical stall.

## Recommendation for iDream

Do not replace the current LTX-2.3 production route based on this page.

Treat `3262321` as a separate candidate and use this sequence:

1. Obtain the author's exact workflow JSON and dependency manifest, including the LTX-2.5 checkpoint, IC-LoRA, RIFE, VSR, node versions, and parameter values.
2. Prepare at least 120-160 GiB of free storage, preferably on a fast external SSD dedicated to model files and temporary frames.
3. Validate LTX-2.5 Fast first with official LTX Desktop 1.2.7 or the official BF16/MPS CLI.
4. Run one minimum-sufficient H3-to-LTX clip while recording peak unified memory, swap, stage timings, model hashes, and output integrity.
5. Only then test the ComfyUI INT8 path as a performance candidate and compare it against BF16 using the same input, seed, frame count, and output contract.
6. Keep any candidate isolated from the active `ltx23-gtanimation-i2v` profile until quality, latency, persistence, and recovery behavior are all proven.

