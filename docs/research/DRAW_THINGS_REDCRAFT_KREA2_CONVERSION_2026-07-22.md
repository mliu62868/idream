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

## Rollback

The candidate can be removed from iDream by deleting its workflow descriptor.
The converted Draw Things files can then be removed independently. Neither action
requires changing or reconverting the ComfyUI source checkpoint.
