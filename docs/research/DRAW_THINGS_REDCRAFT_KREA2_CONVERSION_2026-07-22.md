# RedCraft KREA2 RedMix Draw Things conversion

Date: 2026-07-22

## Outcome

The existing ComfyUI RedCraft KREA2 RedMix 1.1 BF16 checkpoint was imported as an
independent Draw Things candidate. The ComfyUI source file and production route
were not changed.

- iDream model id: `redcraft-krea2-drawthings`
- Draw Things model: `redcraftkrea2redmix_krea2edition_bf16_f16.ckpt`
- Backend: `drawthings`
- Default generation: 832x1216, 10 steps, CFG 1
- Identity references: intentionally unsupported until a separate controlled test

## Compatibility boundary

The installed Draw Things app release (`1.20260716.0`) predates the completed Krea
importer. Conversion therefore used the official Draw Things CLI at upstream HEAD
`ca4978d483bc`, which includes commit `12be7770caf0` ("Support importing Krea
models", 2026-07-20). The CLI is installed with:

```bash
brew install --HEAD drawthingsai/draw-things/draw-things-cli
```

Do not replace this with the older stable Homebrew formula until its release
includes the Krea importer.

## Assets

Source checkpoint:

```text
/Users/kk/ComfyUI-Shared/models/diffusion_models/redcraftKREA2RedMix_krea2Edition-bf16.safetensors
```

Draw Things model directory:

```text
/Users/kk/Library/Containers/com.liuliu.draw-things/Data/Documents/Models
```

Imported files:

| File | Bytes | Role |
| --- | ---: | --- |
| `redcraftkrea2redmix_krea2edition_bf16_f16.ckpt` | 25,696,841,728 | diffusion model |
| `qwen_3_vl_4b_q8p.ckpt` | 4,526,047,232 | text encoder |
| `qwen_image_vae_f16.ckpt` | 254,500,864 | autoencoder |

The pre-import `custom.json` was preserved at:

```text
/Users/kk/Library/Containers/com.liuliu.draw-things/Data/Documents/Models/custom.json.backup-20260722-before-redcraft-krea2-import
```

## Repeatable verification

Draw Things' own dependency resolver checks the main model and every declared
encoder/autoencoder without downloading:

```bash
draw-things-cli models ensure \
  --model redcraftkrea2redmix_krea2edition_bf16_f16.ckpt \
  --models-dir "/Users/kk/Library/Containers/com.liuliu.draw-things/Data/Documents/Models" \
  --offline
```

The iDream backend performs this check once per model before its first generation
and caches the successful result for the worker lifetime. A missing companion file
therefore fails before generation instead of leaving a descriptor-only false green.

Fixed-seed validation completed on the M4 Max 40-core / 128 GB host:

| Path | Size | Steps | Seed | Observed time |
| --- | ---: | ---: | ---: | ---: |
| Draw Things CLI | 512x512 | 4 | 42 | 16.67 s including model load |
| iDream backend seam | 832x1024 | 4 | 42 | 38.247 s |
| Draw Things CLI | 832x1216 | 10 | 42 | 102.36 s including model load |
| iDream backend, Homebrew CLI on default PATH | 832x1024 | 2 | 43 | 25.301 s |

The 10-step BF16 result proves compatibility but is not a controlled same-prompt
speed win over ComfyUI. Keep this model opt-in until a warm-run A/B compares the
same prompt, seed, sampler, dimensions, and quality threshold.

## Q8P experiment

Draw Things `models import` always emits an F16 main checkpoint and exposes no
quantization flag. The official upstream `ModelQuantizer` at `ca4978d483bc` was
therefore built as a local SwiftPM executable and its Krea2 branch was configured
to write multidimensional weights with the Draw Things `q8p` codec. Embeddings and
small scalar/vector tensors retain the higher-precision codecs selected by the
upstream recipe. This is a mixed-precision Q8P checkpoint, not Draw Things' distinct
`i8x` (8-bit S) format.

The exact source patch is committed at
`packages/gen/scripts/drawthings-krea2-q8p.patch`. Rebuild and rerun from a clean
official checkout with:

```bash
git clone https://github.com/drawthingsai/draw-things-community.git /tmp/draw-things-q8p
git -C /tmp/draw-things-q8p checkout ca4978d483bcd017d75e6fd20f79ec4fd1f05c2f
git -C /tmp/draw-things-q8p apply \
  /Users/kk/code/idream/packages/gen/scripts/drawthings-krea2-q8p.patch
swift build --package-path /tmp/draw-things-q8p -c release --product model-quantizer
/tmp/draw-things-q8p/.build/release/model-quantizer \
  --input-file "/Users/kk/Library/Containers/com.liuliu.draw-things/Data/Documents/Models/redcraftkrea2redmix_krea2edition_bf16_f16.ckpt" \
  --model-version krea_2 \
  --output-file "/Users/kk/Library/Containers/com.liuliu.draw-things/Data/Documents/Models/redcraftkrea2redmix_krea2edition_bf16_q8p.ckpt"
```

The Draw Things `custom.json` registration added after integrity validation is:

```json
{
  "upcast_attention": false,
  "version": "krea_2",
  "prefix": "",
  "default_scale": 16,
  "name": "RedCraft KREA2 RedMix 1.1 Q8P",
  "autoencoder": "qwen_image_vae_f16.ckpt",
  "modifier": "none",
  "text_encoder": "qwen_3_vl_4b_q8p.ckpt",
  "clip_encoder": "redcraftkrea2redmix_krea2edition_bf16_q8p.ckpt",
  "file": "redcraftkrea2redmix_krea2edition_bf16_q8p.ckpt"
}
```

- iDream model id: `redcraft-krea2-drawthings-q8p`
- Draw Things model: `redcraftkrea2redmix_krea2edition_bf16_q8p.ckpt`
- Size: 13,250,596,864 bytes, 48.4% smaller than the F16 main checkpoint
- Integrity: 581/581 tensors and SQLite `PRAGMA quick_check` returned `ok`
- Dependencies: offline `models ensure` returned `Model ready`

The model registration backup is:

```text
/Users/kk/Library/Containers/com.liuliu.draw-things/Data/Documents/Models/custom.json.backup-20260722-before-redcraft-krea2-q8p-register
```

Controlled A/B used the same prompt, seed 42, dimensions, steps, CFG 1, CLI build,
and one-shot process shape:

| Size | Steps | Q8P total | F16 total | Q8P sampling avg | F16 sampling avg |
| --- | ---: | ---: | ---: | ---: | ---: |
| 512x512 | 4 | 13.96 s | 13.62 s | 2.19 s | 2.57 s |
| 832x1024 | 4 | 35.63 s | 36.35 s | 6.38 s | 6.71 s |
| 832x1216 | 10 | 108.27 s | 113.09 s | 9.52 s | 10.10 s |

Decoded-image similarity between Q8P and F16:

| Size / steps | SSIM | PSNR |
| --- | ---: | ---: |
| 512x512 / 4 | 0.988363 | 39.99 dB |
| 832x1024 / 4 | 0.992904 | 42.21 dB |
| 832x1216 / 10 | 0.980657 | 35.53 dB |

The real iDream provider seam also completed a 832x1024, 2-step, seed-43 Q8P
generation in 20.614 seconds. Q8P materially reduces storage and model I/O, while
the controlled generation speed gain is only about 2-4% total and 5-6% in sampling
at useful resolutions. Keep both F16 and Q8P opt-in; do not replace the production
ComfyUI route based on this result alone.

## Rollback

Either candidate can be removed from iDream by deleting its workflow descriptor.
The converted Draw Things files can then be removed independently. Neither action
requires changing or reconverting the ComfyUI source checkpoint.
