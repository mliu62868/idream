#!/usr/bin/env python3
"""Segment one frozen image with the pinned, local Comfy SAM3.1 checkpoint.

Gen owns the accelerator lease and child-process deadline. This program never
downloads models, talks to a Comfy server, or changes another process's models.
stdout is one JSON result; library diagnostics go to stderr. Exit codes:
0 = approved mask, 2 = invalid input/dependency, 3 = refused target/region,
1 = execution or output failure. Failed masks are diagnostic only.
"""

from __future__ import annotations

import argparse
import base64
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import resource
import sys
import threading
import time


MODEL_SHA256 = "9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03"
SCORE_THRESHOLD = 0.5
MASK_NMS_IOU = 0.5
MIN_INSTANCE_MASK_IOU = 0.8
MAX_MASK_FRACTION = 0.65
MAX_SOURCE_BYTES = 32 * 1024 * 1024
MAX_SOURCE_PIXELS = 4 * 1024 * 1024


class SegmentError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = 2):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise SegmentError("invalid_arguments", message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_new(path: Path, data: bytes) -> None:
    """Publish a complete artifact without replacing a previous attempt."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.partial")
    try:
        with temporary.open("xb") as output:
            os.chmod(temporary, 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_target(target: str) -> str:
    target = target.strip()
    # Comfy's SAM3 wrapper treats commas and :N as a multi-concept program.
    # Product cardinality comes only from --selection, never from that syntax.
    if not target or len(target) > 160 or any(ord(c) < 32 or c in ",:" for c in target):
        raise SegmentError("invalid_target", "Target must be one short concept without commas, colons or control characters.")
    return target


def region_failure(candidate_count: int, mask_pixels: int, total_pixels: int, selection: str) -> tuple[str, str] | None:
    if candidate_count == 0 or mask_pixels == 0:
        return "target_not_found", "No nonempty target mask met the joint score threshold."
    if selection == "one" and candidate_count != 1:
        return "target_ambiguous", "More than one target instance met the joint score threshold."
    if mask_pixels / total_pixels > MAX_MASK_FRACTION:
        return "mask_too_large", "The target mask exceeds the allowed fraction for a local edit."
    return None


def joint_scores(raw_scores: object, presence: object) -> object:
    import torch

    if raw_scores.ndim != 2 or raw_scores.shape[0] != 1 or presence.shape != (1, 1):
        raise SegmentError("invalid_prediction", "Unexpected SAM3 score or presence shapes.", 1)
    if not all(torch.isfinite(value).all().item() for value in (raw_scores, presence)):
        raise SegmentError("invalid_prediction", "SAM3 returned non-finite scores or presence.", 1)
    # The native Comfy node discards presence. Meta's processor uses this joint
    # score so high query similarity alone cannot assert that a target exists.
    return raw_scores.float().sigmoid() * presence.float().sigmoid()


def group_instance_masks(candidates: list[dict], packed_masks: dict[int, object]) -> list[dict]:
    """Overlap components keep region refusal independent of score ordering."""
    import numpy as np

    population = np.array([value.bit_count() for value in range(256)], dtype=np.uint8)
    active = {candidate["index"]: candidate for candidate in candidates if candidate["maskPixels"] > 0}
    indices = sorted(active)
    neighbors = {index: set() for index in indices}
    pairs = {}
    for position, first in enumerate(indices):
        for second in indices[position + 1:]:
            intersection = int(population[np.bitwise_and(packed_masks[first], packed_masks[second])].sum())
            areas = [active[first]["maskPixels"], active[second]["maskPixels"]]
            union = sum(areas) - intersection
            overlap = intersection / union
            pairs[first, second] = {"indices": [first, second], "iou": overlap, "maskPixels": areas,
                                    "intersectionPixels": intersection, "unionPixels": union,
                                    "disputedPixels": union - intersection}
            if overlap >= MASK_NMS_IOU:
                neighbors[first].add(second)
                neighbors[second].add(first)
    for candidate in candidates:
        candidate.update(decision="empty" if candidate["maskPixels"] == 0 else "kept",
                         suppressedBy=None, suppressionIoU=None)
    visited = set()
    groups = []
    for seed in indices:
        if seed in visited:
            continue
        members = set()
        pending = [seed]
        while pending:
            index = pending.pop()
            if index in members:
                continue
            members.add(index)
            pending.extend(neighbors[index] - members)
        visited.update(members)
        member_indices = sorted(members)
        representative = min(members, key=lambda index: (-active[index]["score"], index))
        comparisons = [pairs[first, second] for position, first in enumerate(member_indices)
                       for second in member_indices[position + 1:]]
        worst_pair = min(comparisons, key=lambda pair: (pair["iou"], pair["indices"]), default=None)
        # All pairs are checked; one deterministic worst witness plus counts
        # bounds JSON size even if every model query lands in one component.
        groups.append({"representativeIndex": representative, "memberIndices": member_indices,
                       "representativeMaskPixels": active[representative]["maskPixels"],
                       "pairCount": len(comparisons), "worstPair": worst_pair,
                       "disagreementPairCount": sum(pair["iou"] < MIN_INSTANCE_MASK_IOU for pair in comparisons)})
        # Preserve who connected each duplicate into the component. Every link
        # meets the grouping threshold, even when endpoints farther apart do not.
        linked = {representative}
        pending = [representative]
        while pending:
            parent = pending.pop()
            for index in sorted(neighbors[parent] - linked):
                linked.add(index)
                pending.append(index)
                pair = pairs[tuple(sorted((parent, index)))]
                active[index].update(decision="suppressed", suppressedBy=parent, suppressionIoU=pair["iou"])
    return sorted(groups, key=lambda group: (-active[group["representativeIndex"]]["score"], group["representativeIndex"]))


def fuse_instance_masks(groups: list[dict], packed_masks: dict[int, object], total_pixels: int) -> object:
    """Refuse disagreement before fusion; agreement cannot certify correctness."""
    import numpy as np

    if any(group["disagreementPairCount"] > 0 for group in groups):
        raise SegmentError("target_region_uncertain", "Candidate masks disagree about the target region; the local edit was refused.", 3)
    union = np.zeros((total_pixels + 7) // 8, dtype=np.uint8)
    population = np.array([value.bit_count() for value in range(256)], dtype=np.uint8)
    for group in groups:
        merged = np.zeros_like(union)
        for index in group["memberIndices"]:
            merged |= packed_masks[index]
        merged_pixels = int(population[merged].sum())
        group.update(mergedMaskPixels=merged_pixels, addedMaskPixels=merged_pixels - group["representativeMaskPixels"])
        union |= merged
    return union


def watch_parent(parent_pid: int, lease_fd: int) -> None:
    if parent_pid <= 1 or parent_pid == os.getpid() or os.getppid() != parent_pid:
        raise SegmentError("invalid_parent", "Segmentation must be owned by its current parent process.")
    if lease_fd < 3:
        raise SegmentError("invalid_lease", "The inherited accelerator lease must use a separate file descriptor.")
    try:
        os.fstat(lease_fd)
        os.set_inheritable(lease_fd, False)
    except OSError as error:
        raise SegmentError("invalid_lease", "The inherited accelerator lease is not open.") from error

    def check_parent() -> None:
        while True:
            if os.getppid() != parent_pid:
                # Do not run model cleanup after the owner disappears. The OS
                # closes this process's inherited lease with all other handles.
                os._exit(1)
            time.sleep(1)

    # Never LOCK_UN the inherited descriptor: parent and child share the same
    # open file description, so unlocking here would release the parent's lease.
    threading.Thread(target=check_parent, name="segmentation-parent", daemon=True).start()


def read_source(source: Path | bytes, evidence: dict, *, png_only: bool = False) -> object:
    import numpy as np
    from PIL import Image, ImageOps

    if isinstance(source, Path):
        if not source.is_file() or source.stat().st_size > MAX_SOURCE_BYTES:
            raise SegmentError("invalid_source", "Source must be a local image no larger than 32 MiB.")
        source_bytes = source.read_bytes()
    else:
        source_bytes = source
    if not source_bytes or len(source_bytes) > MAX_SOURCE_BYTES:
        raise SegmentError("invalid_source", "Source must be a nonempty image no larger than 32 MiB.")
    evidence["sourceSha256"] = hashlib.sha256(source_bytes).hexdigest()
    with Image.open(io.BytesIO(source_bytes)) as image:
        if png_only and image.format != "PNG":
            raise SegmentError("invalid_source", "Stdio source must be a PNG image.")
        if getattr(image, "n_frames", 1) != 1 or image.width * image.height > MAX_SOURCE_PIXELS:
            raise SegmentError("invalid_source", "Source must be one frame of at most 4 megapixels.")
        rgb = np.array(ImageOps.exif_transpose(image).convert("RGB"), dtype=np.uint8)
    height, width = rgb.shape[:2]
    evidence.update(width=width, height=height, totalPixels=width * height,
                    sourceRgbSha256=hashlib.sha256(rgb.tobytes()).hexdigest())
    return rgb


def segment(args: argparse.Namespace, evidence: dict) -> None:
    stages = evidence["stagesMs"]
    started = time.perf_counter()
    source = sys.stdin.buffer.read(MAX_SOURCE_BYTES + 1) if args.stdio else args.source
    rgb = read_source(source, evidence, png_only=args.stdio)
    stages["sourceMs"] = round((time.perf_counter() - started) * 1000, 3)

    if args.checkpoint.suffix != ".safetensors" or not args.checkpoint.is_file():
        raise SegmentError("checkpoint_missing", "A local SAM3.1 safetensors checkpoint is required.")
    def checkpoint_identity() -> tuple[int, int, int, int, int]:
        metadata = args.checkpoint.stat()
        return metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns

    checkpoint_stat = checkpoint_identity()
    started = time.perf_counter()
    evidence["modelSha256"] = sha256_file(args.checkpoint)
    stages["modelHashMs"] = round((time.perf_counter() - started) * 1000, 3)
    if evidence["modelSha256"] != MODEL_SHA256:
        raise SegmentError("checkpoint_mismatch", "Checkpoint SHA256 does not match the pinned SAM3.1 model.")
    sources = ["comfy/sd.py", "comfy/ldm/sam3/detector.py", "comfy/text_encoders/sam3_clip.py"]
    if not all((args.comfy_root / item).is_file() for item in sources):
        raise SegmentError("comfy_missing", "Comfy root is missing the required native SAM3 implementation.")
    evidence["comfySourceSha256"] = {item: sha256_file(args.comfy_root / item) for item in sources}
    sys.path.insert(0, str(args.comfy_root))

    import numpy as np
    from PIL import Image
    import torch
    import torch.nn.functional as functional
    import comfy.sd
    import comfy.utils
    import comfy.model_management as management

    device = management.get_torch_device()
    evidence["runtime"] = {"python": sys.version.split()[0], "torch": torch.__version__, "device": str(device)}
    memory = evidence["memory"] = {}

    def synchronize() -> None:
        if device.type == "mps":
            torch.mps.synchronize()
        elif device.type == "cuda":
            torch.cuda.synchronize(device)

    def sample_memory(stage: str) -> None:
        snapshot = {}
        if device.type == "mps":
            snapshot["allocatedBytes"] = torch.mps.current_allocated_memory()
            snapshot["driverAllocatedBytes"] = torch.mps.driver_allocated_memory()
        elif device.type == "cuda":
            snapshot["allocatedBytes"] = torch.cuda.memory_allocated(device)
            snapshot["reservedBytes"] = torch.cuda.memory_reserved(device)
        memory[stage] = snapshot

    started = time.perf_counter()
    loaded = comfy.sd.load_checkpoint_guess_config(
        str(args.checkpoint), output_vae=False, output_clip=True,
        output_clipvision=False, disable_dynamic=True,
    )
    model, clip = loaded[0], loaded[1]
    if model is None or clip is None or model.model.diffusion_model.__class__.__name__ != "SAM3Model":
        raise SegmentError("invalid_model", "Checkpoint did not load a SAM3 model and its text encoder.")
    if checkpoint_identity() != checkpoint_stat:
        raise SegmentError("checkpoint_changed", "Checkpoint changed while it was being loaded.")
    synchronize()
    stages["loadMs"] = round((time.perf_counter() - started) * 1000, 3)
    sample_memory("afterLoad")

    with torch.inference_mode():
        started = time.perf_counter()
        tokens = clip.tokenize(args.target)
        if set(tokens) != {"sam3_clip"} or len(tokens["sam3_clip"]) != 1:
            raise SegmentError("target_too_long", "Target must fit one SAM3 text-encoder context.")
        conditioning = clip.encode_from_tokens_scheduled(tokens)
        if len(conditioning) != 1 or "sam3_multi_cond" in conditioning[0][1]:
            raise SegmentError("invalid_conditioning", "Expected exactly one SAM3 target concept.")
        synchronize()
        stages["textEncodeMs"] = round((time.perf_counter() - started) * 1000, 3)

        management.load_model_gpu(model)
        sam = model.model.diffusion_model
        sam.eval()
        dtype = model.model.get_dtype()
        text = conditioning[0][0].to(device=device, dtype=dtype)
        attention = conditioning[0][1].get("attention_mask")
        if attention is None:
            raise SegmentError("invalid_conditioning", "SAM3 conditioning is missing its attention mask.")
        attention = attention.to(device)
        image = torch.from_numpy(rgb.copy()).unsqueeze(0).float().div_(255.0)
        frame = comfy.utils.common_upscale(image.movedim(-1, 1), 1008, 1008, "bilinear", crop="disabled")
        frame = frame.to(device=device, dtype=dtype)
        synchronize()
        sample_memory("beforeInference")
        started = time.perf_counter()
        # Keep native mask resolution here: allocating Q full-size source masks
        # would turn source dimensions into an unnecessary GPU memory multiplier.
        result = sam(frame, text_embeddings=text, text_mask=attention)
        synchronize()
        stages["inferenceMs"] = round((time.perf_counter() - started) * 1000, 3)
        sample_memory("afterInference")

        started = time.perf_counter()
        raw_scores = result["scores"].float().cpu()
        presence = result.get("presence")
        boxes = result["boxes"].float().cpu()
        masks = result["masks"]
        if presence is None:
            raise SegmentError("invalid_prediction", "SAM3 returned no presence score.", 1)
        presence = presence.float().cpu()
        if (raw_scores.ndim != 2 or raw_scores.shape[0] != 1 or presence.shape != (1, 1)
                or boxes.shape != (*raw_scores.shape, 4) or masks.ndim != 4
                or tuple(masks.shape[:2]) != tuple(raw_scores.shape)):
            raise SegmentError("invalid_prediction", "Unexpected SAM3 prediction shapes.", 1)
        if not torch.isfinite(boxes).all().item():
            raise SegmentError("invalid_prediction", "SAM3 returned non-finite predictions.", 1)
        probabilities = joint_scores(raw_scores, presence)
        indices = torch.nonzero(probabilities[0] >= SCORE_THRESHOLD, as_tuple=False).flatten().tolist()
        evidence["prediction"] = {
            "queryCount": raw_scores.shape[1], "presence": presence.sigmoid().item(),
            "presenceLogit": presence.item(), "maximumScore": probabilities.max().item(),
            "nativeMaskWidth": masks.shape[3], "nativeMaskHeight": masks.shape[2],
        }
        width, height = evidence["width"], evidence["height"]
        packed_masks = {}
        # Each proposal is processed separately on CPU. Even an all-instance
        # request never materializes [Q,H,W] at full source resolution.
        for index in indices:
            logits = masks[0, index].detach().float().cpu()
            if not torch.isfinite(logits).all().item():
                raise SegmentError("invalid_prediction", "SAM3 returned non-finite mask logits.", 1)
            resized = functional.interpolate(logits[None, None], size=(height, width), mode="bilinear", align_corners=False)
            binary = (resized[0, 0] > 0).numpy()
            x1, y1, x2, y2 = boxes[0, index].tolist()
            pixels = int(binary.sum())
            evidence["candidates"].append({
                "index": index, "score": probabilities[0, index].item(),
                "rawScore": raw_scores[0, index].sigmoid().item(),
                "presence": presence.sigmoid().item(),
                "box": [x1 * width, y1 * height, (x2 - x1) * width, (y2 - y1) * height],
                "maskPixels": pixels,
            })
            packed_masks[index] = np.packbits(binary)
        groups = group_instance_masks(evidence["candidates"], packed_masks)
        retained = [group["representativeIndex"] for group in groups]
        evidence.update(rawCandidateCount=len(indices), independentInstanceCount=len(retained),
                        retainedCandidateIndices=retained, instanceGroups=groups)
        # Packing keeps the worst-case 200 source-sized proposals to 100 MiB at
        # the 4 MP limit, instead of retaining 800 MiB of boolean source masks.
        packed_union = fuse_instance_masks(groups, packed_masks, width * height)
        union = np.unpackbits(packed_union, count=width * height).reshape(height, width)
        evidence["maskPixels"] = int(union.sum())
        image_buffer = io.BytesIO()
        Image.fromarray(union.astype(np.uint8) * 255).save(image_buffer, format="PNG")
        mask_bytes = image_buffer.getvalue()
        if args.stdio:
            evidence["maskPngBase64"] = base64.b64encode(mask_bytes).decode("ascii")
        else:
            write_new(args.mask_output, mask_bytes)
        evidence["maskSha256"] = hashlib.sha256(mask_bytes).hexdigest()
        evidence["maskPixelSha256"] = hashlib.sha256((union.astype(np.uint8) * 255).tobytes()).hexdigest()
        stages["postprocessMs"] = round((time.perf_counter() - started) * 1000, 3)
        sample_memory("afterPostprocess")
        failure = region_failure(len(retained), evidence["maskPixels"], evidence["totalPixels"], args.selection)
        if failure:
            raise SegmentError(*failure, exit_code=3)


def main(argv: list[str] | None = None) -> int:
    started = time.perf_counter()
    evidence = {"version": 1, "status": "failed", "candidates": [], "stagesMs": {},
                "scoreThreshold": SCORE_THRESHOLD, "maskNmsIouThreshold": MASK_NMS_IOU,
                "maskGroupingPolicy": "overlap-connected-components",
                "instanceMaskAgreementThreshold": MIN_INSTANCE_MASK_IOU,
                "instanceMaskAgreementPolicy": "conservative-rejection-only",
                "maskCorrectnessCertified": False,
                "maskMergePolicy": "instance-proposal-union",
                "maxMaskFraction": MAX_MASK_FRACTION,
                "scriptSha256": sha256_file(Path(__file__))}
    args = None
    exit_code = 0
    evidence_path_valid = False
    try:
        parser = Parser(description=__doc__)
        for name in ("comfy-root", "checkpoint"):
            parser.add_argument(f"--{name}", type=Path, required=True)
        for name in ("source", "mask-output", "evidence-output"):
            parser.add_argument(f"--{name}", type=Path)
        parser.add_argument("--stdio", action="store_true")
        parser.add_argument("--lease-fd", type=int)
        parser.add_argument("--parent-pid", type=int)
        parser.add_argument("--target", required=True)
        parser.add_argument("--selection", choices=("one", "all"), required=True)
        args = parser.parse_args(argv)
        for name in ("comfy_root", "checkpoint", "source", "mask_output", "evidence_output"):
            value = getattr(args, name)
            if value is not None:
                setattr(args, name, value.resolve())
        file_paths = [args.source, args.mask_output, args.evidence_output]
        if args.stdio:
            if any(path is not None for path in file_paths):
                raise SegmentError("invalid_arguments", "Stdio mode cannot use source or output file paths.")
            if args.lease_fd is None or args.parent_pid is None:
                raise SegmentError("invalid_arguments", "Stdio mode requires the inherited lease and parent PID.")
        else:
            if any(path is None for path in file_paths):
                raise SegmentError("invalid_arguments", "File mode requires source, mask-output and evidence-output.")
            paths = [*file_paths, args.checkpoint]
            if len(set(paths)) != len(paths) or args.mask_output.exists() or args.evidence_output.exists():
                raise SegmentError("output_conflict", "Use distinct source, checkpoint and new output paths.")
            evidence_path_valid = True
        if (args.lease_fd is None) != (args.parent_pid is None):
            raise SegmentError("invalid_arguments", "Pass the inherited lease and parent PID together.")
        if args.lease_fd is not None:
            watch_parent(args.parent_pid, args.lease_fd)
        args.target = validate_target(args.target)
        evidence.update(target=args.target, selection=args.selection)
        with redirect_stdout(sys.stderr):
            segment(args, evidence)
        evidence["status"] = "ok"
    except SegmentError as error:
        exit_code = error.exit_code
        evidence.update(code=error.code, message=str(error))
    except Exception as error:
        exit_code = 1
        evidence.update(code="segmentation_failed", message=f"{type(error).__name__}: {error}")
    evidence["elapsedMs"] = round((time.perf_counter() - started) * 1000, 3)
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    evidence["peakRssBytes"] = rss if sys.platform == "darwin" else rss * 1024
    result = json.dumps(evidence, ensure_ascii=False, allow_nan=False, sort_keys=True) + "\n"
    if args is not None and evidence_path_valid:
        try:
            write_new(args.evidence_output, result.encode())
        except Exception as error:
            exit_code = 1
            evidence.update(status="failed", code="evidence_write_failed", message=f"{type(error).__name__}: {error}")
            result = json.dumps(evidence, ensure_ascii=False, allow_nan=False, sort_keys=True) + "\n"
    sys.stdout.write(result)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
