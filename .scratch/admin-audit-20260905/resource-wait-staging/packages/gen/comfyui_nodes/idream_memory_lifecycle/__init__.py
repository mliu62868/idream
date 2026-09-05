"""iDream model-lifecycle nodes for ComfyUI workflows."""

from __future__ import annotations

import gc
import logging

import comfy.memory_management as memory_management
import comfy.model_management as model_management


logger = logging.getLogger(__name__)


class AnyType(str):
    """A ComfyUI wildcard type suitable for dependency-only passthroughs."""

    def __ne__(self, _other: object) -> bool:
        return False


ANY = AnyType("*")
WEIGHT_DTYPES = (
    "default",
    "fp8_e4m3fn",
    "fp8_e4m3fn_fast",
    "fp8_e5m2",
    "fp16",
    "bf16",
    "fp32",
)
COMPUTE_DTYPES = ("default", "fp16", "bf16", "fp32")
CLIP_TYPES = (
    "stable_diffusion",
    "stable_cascade",
    "sd3",
    "stable_audio",
    "mochi",
    "ltxv",
    "pixart",
    "cosmos",
    "lumina2",
    "wan",
    "hidream",
    "chroma",
    "ace",
    "omnigen2",
    "qwen_image",
    "hunyuan_image",
    "flux2",
    "ovis",
    "longcat_image",
    "cogvideox",
    "lens",
    "pixeldit",
    "ideogram4",
    "boogu",
    "krea2",
    "joyimage",
    "mage",
    "minimax",
)


def discard_completed_model_owner(owner: object, render_device: object) -> float:
    """Drop a completed off-device model from its cached owner container."""

    patcher = getattr(owner, "patcher", None)
    model = getattr(owner, "cond_stage_model", None)
    if (
        patcher is None
        or model is None
        or getattr(patcher, "model", None) is not model
        or getattr(patcher, "load_device", render_device) == render_device
    ):
        return 0.0

    size_mb = patcher.model_size() / (1024**2)
    # SPEC: the workflow barrier proves that every conditioning consumer has
    # completed. The executor/cache still retains the CLIP wrapper after model
    # unload, so cache eviction alone cannot release its weights. Invalidate
    # only the declared dead owner; the fresh loader reconstructs it next time.
    owner.cond_stage_model = None
    patcher.model = None
    return size_mb


def release_off_device_models(completed_owner: object | None = None) -> float:
    """Release loaded models whose execution device is not the render device."""

    render_device = model_management.get_torch_device()
    freed_mb = 0.0

    for loaded in list(model_management.current_loaded_models):
        patcher = loaded.model
        if patcher is None or loaded.device == render_device:
            continue

        model = getattr(patcher, "model", None)
        model_name = model.__class__.__name__ if model is not None else "unknown"
        size_mb = loaded.model_memory() / (1024**2)
        try:
            # SPEC: conditioning is materialized before this node executes, so
            # off-device text weights are dead for the remainder of the render.
            loaded.model_unload(None)
        except Exception:
            # INTENT: a memory optimization must not turn a valid paid render
            # into a failed attempt; retain the model and continue instead.
            logger.exception(
                "iDream could not release off-device model %s",
                model_name,
            )
            continue

        try:
            model_management.current_loaded_models.remove(loaded)
        except ValueError:
            pass

        freed_mb += size_mb
        logger.debug(
            "iDream released off-device model %s (%.0f MB)",
            model_name,
            size_mb,
        )

    discarded_owner_mb = 0.0
    if completed_owner is not None:
        try:
            discarded_owner_mb = discard_completed_model_owner(
                completed_owner,
                render_device,
            )
        except Exception:
            logger.exception("iDream could not discard completed model owner")

    # ComfyUI's RAM-pressure cache owns the loader output. Merely detaching a
    # CPU->CPU model leaves that strong reference—and therefore its weights—
    # resident. Active downstream values are separately held by the executor,
    # while dynamic model patchers are protected by RAMPressureCache itself.
    try:
        evicted_cache_bytes = memory_management.extra_ram_release(
            1 << 62,
            free_active=True,
        )
    except Exception:
        logger.exception("iDream could not evict active RAM-cache entries")
        evicted_cache_bytes = 0
    gc.collect()
    try:
        model_management.soft_empty_cache()
    except Exception:
        logger.exception("iDream could not empty the accelerator cache")
    logger.info(
        "iDream detached %.0f MB of off-device models, discarded %.0f MB "
        "from completed owners, and evicted %.0f MB of cached CPU tensors",
        freed_mb,
        discarded_owner_mb,
        evicted_cache_bytes / (1024**2),
    )
    return freed_mb


class IDreamUnloadOffDeviceModels:
    """Pass two dependency values through after releasing off-device models."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "passthrough": (ANY,),
                # INVARIANT: callers wire the last conditioning branch here so
                # unloading cannot race another text-encoder consumer.
                "after": (ANY,),
            },
            "optional": {
                # Image workflows declare the prompt-scoped CLIP owner that is
                # dead once every conditioning branch reaches this barrier.
                "release": (ANY,),
            },
        }

    RETURN_TYPES = (ANY, ANY)
    RETURN_NAMES = ("passthrough", "after")
    FUNCTION = "unload"
    CATEGORY = "iDream/memory"
    DESCRIPTION = (
        "Waits for the declared conditioning dependency, releases loaded models "
        "outside the render device, and returns both inputs unchanged."
    )

    @classmethod
    def IS_CHANGED(cls, **_kwargs):
        # Side effects must run whenever ComfyUI executes the downstream render.
        return float("nan")

    def unload(self, passthrough, after, release=None):
        release_off_device_models(release)
        return (passthrough, after)


class IDreamCheckpointModelVaeLoader:
    """Cache the live MODEL/VAE members without retaining checkpoint CLIP."""

    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths

        return {
            "required": {
                "ckpt_name": (folder_paths.get_filename_list("checkpoints"),),
                "weight_dtype": (WEIGHT_DTYPES,),
                "compute_dtype": (COMPUTE_DTYPES,),
            },
        }

    RETURN_TYPES = ("MODEL", "VAE")
    RETURN_NAMES = ("model", "vae")
    FUNCTION = "load"
    CATEGORY = "iDream/memory"
    DESCRIPTION = (
        "Loads only MODEL and VAE from a checkpoint so a per-prompt CLIP can "
        "be released independently."
    )

    def load(self, ckpt_name, weight_dtype, compute_dtype):
        import comfy.sd
        import folder_paths
        import torch

        dtype_map = {
            "fp8_e4m3fn": torch.float8_e4m3fn,
            "fp8_e5m2": torch.float8_e5m2,
            "fp16": torch.float16,
            "bf16": torch.bfloat16,
            "fp32": torch.float32,
        }
        model_options = {}
        if weight_dtype in dtype_map:
            model_options["dtype"] = dtype_map[weight_dtype]
        if weight_dtype == "fp8_e4m3fn_fast":
            model_options["dtype"] = torch.float8_e4m3fn
            model_options["fp8_optimizations"] = True

        checkpoint_path = folder_paths.get_full_path_or_raise(
            "checkpoints",
            ckpt_name,
        )
        model, _clip, vae, _clip_vision = comfy.sd.load_checkpoint_guess_config(
            checkpoint_path,
            output_vae=True,
            output_clip=False,
            output_clipvision=False,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            output_model=True,
            model_options=model_options,
        )
        if model is None or vae is None:
            raise RuntimeError(f"Checkpoint {ckpt_name} did not contain MODEL and VAE")
        if compute_dtype in dtype_map:
            model.set_model_compute_dtype(dtype_map[compute_dtype])
            model.force_cast_weights = False
        return (model, vae)


class IDreamFreshCheckpointCLIPLoader:
    """Load checkpoint CLIP for one prompt so the barrier can destroy it."""

    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths

        return {
            "required": {
                "ckpt_name": (folder_paths.get_filename_list("checkpoints"),),
            },
        }

    RETURN_TYPES = ("CLIP",)
    FUNCTION = "load"
    CATEGORY = "iDream/memory"
    DESCRIPTION = "Loads a fresh checkpoint CLIP for one conditioning pass."

    @classmethod
    def IS_CHANGED(cls, **_kwargs):
        return float("nan")

    def load(self, ckpt_name):
        import comfy.sd
        import folder_paths

        checkpoint_path = folder_paths.get_full_path_or_raise(
            "checkpoints",
            ckpt_name,
        )
        _model, clip, _vae, _clip_vision = comfy.sd.load_checkpoint_guess_config(
            checkpoint_path,
            output_vae=False,
            output_clip=True,
            output_clipvision=False,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            output_model=False,
        )
        if clip is None:
            raise RuntimeError(f"Checkpoint {ckpt_name} did not contain CLIP")
        return (clip,)


class IDreamFreshCLIPLoader:
    """Load a standalone CLIP for one prompt so the barrier can destroy it."""

    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths

        return {
            "required": {
                "clip_name": (folder_paths.get_filename_list("text_encoders"),),
                "type": (CLIP_TYPES,),
            },
        }

    RETURN_TYPES = ("CLIP",)
    FUNCTION = "load"
    CATEGORY = "iDream/memory"
    DESCRIPTION = "Loads a fresh standalone CLIP for one conditioning pass."

    @classmethod
    def IS_CHANGED(cls, **_kwargs):
        return float("nan")

    def load(self, clip_name, type="stable_diffusion"):
        import comfy.sd
        import folder_paths

        clip_type = getattr(
            comfy.sd.CLIPType,
            type.upper(),
            comfy.sd.CLIPType.STABLE_DIFFUSION,
        )
        clip_path = folder_paths.get_full_path_or_raise(
            "text_encoders",
            clip_name,
        )
        clip = comfy.sd.load_clip(
            ckpt_paths=[clip_path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=clip_type,
        )
        return (clip,)


NODE_CLASS_MAPPINGS = {
    "IDreamUnloadOffDeviceModels": IDreamUnloadOffDeviceModels,
    "IDreamCheckpointModelVaeLoader": IDreamCheckpointModelVaeLoader,
    "IDreamFreshCheckpointCLIPLoader": IDreamFreshCheckpointCLIPLoader,
    "IDreamFreshCLIPLoader": IDreamFreshCLIPLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "IDreamUnloadOffDeviceModels": "iDream Unload Off-Device Models",
    "IDreamCheckpointModelVaeLoader": "iDream Checkpoint MODEL + VAE Loader",
    "IDreamFreshCheckpointCLIPLoader": "iDream Fresh Checkpoint CLIP Loader",
    "IDreamFreshCLIPLoader": "iDream Fresh CLIP Loader",
}
