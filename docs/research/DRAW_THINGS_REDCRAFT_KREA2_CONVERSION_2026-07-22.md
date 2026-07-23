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

## I8X (8-bit S) experiment

The follow-up experiment used Draw Things' actual `i8x` execution codec rather
than Q8P storage compression. The reproducible source patch is committed at
`packages/gen/scripts/drawthings-krea2-i8x.patch`; it exposes the upstream
quantizer as a SwiftPM executable and applies `[.i8x, .ezm7]` to Krea2's
multidimensional non-embedding weights. Rebuild and run it from the same pinned
upstream checkout with:

```bash
git clone https://github.com/drawthingsai/draw-things-community.git /tmp/draw-things-i8x
git -C /tmp/draw-things-i8x checkout ca4978d483bcd017d75e6fd20f79ec4fd1f05c2f
git -C /tmp/draw-things-i8x apply \
  /Users/kk/code/idream/packages/gen/scripts/drawthings-krea2-i8x.patch
swift build --package-path /tmp/draw-things-i8x -c release --product model-quantizer
swift build --package-path /tmp/draw-things-i8x -c release --product draw-things-cli
/tmp/draw-things-i8x/.build/release/model-quantizer \
  --input-file "/Users/kk/Library/Containers/com.liuliu.draw-things/Data/Documents/Models/redcraftkrea2redmix_krea2edition_bf16_f16.ckpt" \
  --model-version krea_2 \
  --output-file "/Users/kk/Library/Containers/com.liuliu.draw-things/Data/Documents/Models/redcraftkrea2redmix_krea2edition_bf16_i8x.ckpt"
```

- iDream model id: `redcraft-krea2-drawthings-i8x`
- Draw Things model: `redcraftkrea2redmix_krea2edition_bf16_i8x.ckpt`
- Size: 12,852,854,784 bytes, 50.0% smaller than F16 and 3.0% smaller than Q8P
- Conversion time: approximately 2 minutes
- Integrity: 581/581 tensors and SQLite `PRAGMA quick_check` returned `ok`
- Codec evidence: 268 main weights have type `8a1e9b00000001`; the corresponding
  Q8P type is `8a1e8b00000001`
- Dependencies: offline `models ensure` returned `Model ready`

The independent Draw Things registration uses the same Qwen text encoder and VAE,
with the I8X checkpoint as both `file` and `clip_encoder`. The pre-registration
backup is:

```text
/Users/kk/Library/Containers/com.liuliu.draw-things/Data/Documents/Models/custom.json.backup-20260722-before-redcraft-krea2-i8x-register
```

The exact `custom.json` entry is:

```json
{
  "upcast_attention": false,
  "version": "krea_2",
  "prefix": "",
  "default_scale": 16,
  "name": "RedCraft KREA2 RedMix 1.1 I8X",
  "autoencoder": "qwen_image_vae_f16.ckpt",
  "modifier": "none",
  "text_encoder": "qwen_3_vl_4b_q8p.ckpt",
  "clip_encoder": "redcraftkrea2redmix_krea2edition_bf16_i8x.ckpt",
  "file": "redcraftkrea2redmix_krea2edition_bf16_i8x.ckpt"
}
```

Controlled A/B used the same prompt, seed 42, dimensions, steps, CFG 1, CLI build,
and one-shot process shape. The 512 row records the second consecutive CLI
invocation, but each invocation was a new process; it benefited only from the OS
file cache, not a persistent in-memory model.

| Size | Steps | I8X total | F16 total | Q8P total | I8X sampling avg |
| --- | ---: | ---: | ---: | ---: | ---: |
| 512x512 | 4 | 17.54 s (second run) | 13.62 s | 13.96 s | 3.24 s |
| 832x1024 | 4 | 37.87 s | 36.35 s | 35.63 s | 7.07 s |

At 832x1024, the decoded I8X/F16 images measured SSIM 0.876789 and PSNR 19.80 dB.
The image is visually valid, but I8X changes the result substantially and was 4.2%
slower than F16 and 6.3% slower than Q8P. At 512x512 it was 28.8% slower than F16.
The real iDream provider seam also generated a valid 832x1024, 2-step, seed-43
image in 22.816 seconds.

Reproduce the 832x1024 I8X sample and the provider-seam sample with:

```bash
/usr/bin/time -p /tmp/draw-things-i8x/.build/release/draw-things-cli generate \
  --model redcraftkrea2redmix_krea2edition_bf16_i8x.ckpt \
  --prompt "adult woman, upper-body portrait, oval face, hazel eyes, long auburn hair, green jacket, soft daylight, photorealistic, high detail" \
  --steps 4 --cfg 1 --width 832 --height 1024 --seed 42 \
  --output "/Users/kk/ComfyUI-Shared/output/drawthings-redcraft-krea2-i8x-ab-seed42-832x1024.png" \
  --no-download-missing --offline --disable-preview

DRAWTHINGS_MODELS_DIR="/Users/kk/Library/Containers/com.liuliu.draw-things/Data/Documents/Models" \
DRAWTHINGS_OFFLINE=true \
DRAWTHINGS_CLI="/tmp/draw-things-i8x/.build/release/draw-things-cli" \
bun run --cwd /Users/kk/code/idream/packages/gen smoke:backend -- \
  --model redcraft-krea2-drawthings-i8x --steps 2 --seed 43 \
  --out "/Users/kk/ComfyUI-Shared/output/idream-drawthings-redcraft-krea2-i8x-seed43.png"
```

Both PNGs are 832x1024. Their SHA-256 digests on the measured host are:

```text
7e9f876ace32ff66c0acd3b0048ad7a6853668a55ac87327e7a887e761815710  drawthings-redcraft-krea2-i8x-ab-seed42-832x1024.png
942b862178b78e3b5e6fa2583efa77024114a4505522d0b0db42b9d3992e932e  idream-drawthings-redcraft-krea2-i8x-seed43.png
```

The installed CLI supports a remote Draw Things server, but a persistent process
can only reduce model-loading overhead; it cannot reverse the slower I8X sampling
kernel measured above. Do not build or route through a persistent I8X service based
on this result. Keep I8X as an isolated reproducibility candidate and retain Q8P as
the best measured Draw Things variant for this host.

## Rollback

Any candidate can be removed from iDream by deleting its workflow descriptor.
The converted Draw Things files can then be removed independently. Neither action
requires changing or reconverting the ComfyUI source checkpoint.
