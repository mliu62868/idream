#!/usr/bin/env python3
# SPEC: Convert a ComfyUI fp8 safetensors checkpoint to plain bf16 so it runs
#       without per-forward FP8 decode on Apple Silicon MPS.
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
import argparse
import json
import os
import struct
from pathlib import Path

import torch
from safetensors import safe_open
from safetensors.torch import save_file


def read_header(path: Path) -> dict[str, dict[str, object]]:
    """Read tensor metadata without mapping the multi-gigabyte payload."""
    with path.open("rb") as fh:
        header_size = struct.unpack("<Q", fh.read(8))[0]
        header = json.loads(fh.read(header_size))
    header.pop("__metadata__", None)
    return header


def fp8_keys(header: dict[str, dict[str, object]]) -> set[str]:
    return {key for key, meta in header.items() if "F8" in str(meta["dtype"])}


def quant_sidecar_keys(
    header: dict[str, dict[str, object]],
    quantized_keys: set[str],
) -> set[str]:
    sidecars = {
        key
        for key in header
        if key.endswith(".comfy_quant")
    }
    sidecars.update(
        key
        for key in header
        if key.endswith("_scale") and key[: -len("_scale")] in quantized_keys
    )
    return sidecars


def validate_output(
    source_header: dict[str, dict[str, object]],
    output_path: Path,
) -> dict[str, int]:
    output_header = read_header(output_path)
    source_fp8 = fp8_keys(source_header)
    source_sidecars = quant_sidecar_keys(source_header, source_fp8)
    leaked_fp8 = fp8_keys(output_header)
    leaked_sidecars = set(output_header).intersection(source_sidecars)
    expected_count = len(source_header) - len(source_sidecars)
    if leaked_fp8:
        raise RuntimeError(f"FP8 tensors leaked into output: {sorted(leaked_fp8)[:3]}")
    if leaked_sidecars:
        raise RuntimeError(
            f"quantization sidecars leaked into output: {sorted(leaked_sidecars)[:3]}"
        )
    if len(output_header) != expected_count:
        raise RuntimeError(
            f"output tensor count {len(output_header)} != expected {expected_count}"
        )
    non_bf16_converted = [
        key
        for key in source_fp8
        if output_header.get(key, {}).get("dtype") != "BF16"
    ]
    if non_bf16_converted:
        raise RuntimeError(
            f"converted tensors are not BF16: {sorted(non_bf16_converted)[:3]}"
        )
    return {
        "source_fp8": len(source_fp8),
        "dropped_sidecars": len(source_sidecars),
        "output_tensors": len(output_header),
    }


def convert_file(source: Path, destination: Path) -> dict[str, int]:
    source = source.resolve()
    destination = destination.resolve()
    if source == destination:
        raise ValueError("source and destination must be different files")
    if destination.exists():
        raise FileExistsError(f"refusing to overwrite existing output: {destination}")
    if not source.is_file():
        raise FileNotFoundError(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(f".{destination.name}.partial-{os.getpid()}")
    if partial.exists():
        raise FileExistsError(f"stale partial output exists: {partial}")

    source_header = read_header(source)
    source_fp8 = fp8_keys(source_header)
    if not source_fp8:
        raise ValueError(f"source contains no FP8 tensors: {source}")
    sidecars = quant_sidecar_keys(source_header, source_fp8)

    scaled = plain = kept = 0
    try:
        with safe_open(source, framework="pt", device="cpu") as tensors:
            keys = list(tensors.keys())
            key_set = set(keys)
            output: dict[str, torch.Tensor] = {}
            for key in keys:
                if key in sidecars:
                    continue
                value = tensors.get_tensor(key)
                if value.dtype == torch.float8_e4m3fn:
                    scale_key = key + "_scale"
                    if scale_key in key_set:
                        scale = tensors.get_tensor(scale_key)
                        value = value.float() * scale.float()
                        scaled += 1
                    else:
                        plain += 1
                    output[key] = value.to(torch.bfloat16).contiguous()
                else:
                    output[key] = value.contiguous()
                    kept += 1

        save_file(
            output,
            partial,
            metadata={
                "format": "pt",
                "converted_from": "fp8_e4m3fn",
                "source_filename": source.name,
            },
        )
        validation = validate_output(source_header, partial)
        os.replace(partial, destination)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise

    return {
        "scaled_dequantized": scaled,
        "plain_cast": plain,
        "kept": kept,
        **validation,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    result = convert_file(args.source, args.destination)
    print(f"OK: {json.dumps(result, sort_keys=True)} -> {args.destination}")


if __name__ == "__main__":
    main()
