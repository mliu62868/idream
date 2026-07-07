#!/usr/bin/env python3
# SPEC: Convert a ComfyUI fp8 safetensors checkpoint to plain bf16 so it runs
#       natively on Apple Silicon (MPS), which lacks Float8_e4m3fn support.
# HANDLES BOTH fp8 packagings:
#   - scaled fp8 (comfy_kitchen): <k>.weight (F8) + <k>.weight_scale (F32 scalar)
#       + <k>.comfy_quant (U8 tag)  ->  dequant = weight.float() * scale
#   - plain fp8 (e.g. Qwen-Rapid-AIO): weights stored directly in F8, no scale
#       ->  dequant = weight.to(bf16)   (widening cast, exact for fp8 values)
# INVARIANTS:
#   - a "<k>_scale" key is a quant SIDECAR only if "<k>" exists AND is fp8;
#     otherwise it is a real weight (e.g. text-encoder `logit_scale`) and is KEPT.
#   - output contains zero fp8 tensors; non-fp8 tensors pass through unchanged.
# USAGE: dequant_fp8_to_bf16.py <src.safetensors> <dst.safetensors>
import sys
import json
import struct
import torch
from safetensors import safe_open
from safetensors.torch import save_file

src, dst = sys.argv[1], sys.argv[2]

# read dtypes from the safetensors header (robust, no full load)
with open(src, "rb") as fh:
    n = struct.unpack("<Q", fh.read(8))[0]
    header = json.loads(fh.read(n))
header.pop("__metadata__", None)
fp8_weight_keys = {k for k, meta in header.items() if "F8" in meta["dtype"]}

with safe_open(src, framework="pt", device="cpu") as f:
    keys = list(f.keys())
    out: dict[str, torch.Tensor] = {}

    def is_sidecar_scale(k: str) -> bool:
        if not k.endswith("_scale"):
            return False
        base = k[: -len("_scale")]
        return base in fp8_weight_keys

    converted = plain = kept = dropped = 0
    for k in keys:
        if k.endswith(".comfy_quant") or is_sidecar_scale(k):
            dropped += 1
            continue
        v = f.get_tensor(k)
        if v.dtype == torch.float8_e4m3fn:
            scale_key = k + "_scale"
            if scale_key in keys:
                scale = f.get_tensor(scale_key)
                out[k] = (v.float() * scale.float()).to(torch.bfloat16).contiguous()
                converted += 1
            else:
                out[k] = v.to(torch.bfloat16).contiguous()
                plain += 1
        else:
            out[k] = v.contiguous()
            kept += 1

bad = [k for k, t in out.items() if t.dtype == torch.float8_e4m3fn]
assert not bad, f"fp8 leaked: {bad[:3]}"

save_file(out, dst, metadata={"format": "pt", "converted_from": "fp8_e4m3fn"})
print(f"OK: scaled-dequant={converted} plain-cast={plain} kept={kept} "
      f"dropped-sidecars={dropped} total-out={len(out)} -> {dst}")
