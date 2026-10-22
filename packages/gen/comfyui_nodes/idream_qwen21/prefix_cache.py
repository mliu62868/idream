"""Lossless, bounded prefix reuse for a resident Qwen 2.1 model."""

import logging
import uuid
import weakref
from types import MethodType

from comfy.patcher_extension import CallbacksMP

logger = logging.getLogger(__name__)


def reuse_qwen_prefix_cache(model):
    keys = ("diffusion_model.reset_prefix_cache", "diffusion_model.select_prefix_cache")
    if any(key in model.object_patches for key in keys):
        raise ValueError("Prefix reuse cannot replace an existing cache method patch")
    prepared = model.clone()
    diffusion = model.get_model_object("diffusion_model")
    # A resident sibling may currently patch this shared module tree. Resolve
    # the source patcher's backups, rather than capturing that sibling's hooks.
    original_reset = model.get_model_object(keys[0])
    original_select = model.get_model_object(keys[1])
    state = {"owner": None, "signature": None, "options": None, "first": True}

    def complete_single_slot(cache):
        return (
            cache is not None
            and cache.dtype == "default"
            and len(cache.slots) == 1
            and cache.filled(len(diffusion.transformer_blocks))
        )

    def reset(self, enabled):
        patcher = self.current_patcher
        if patcher is None:
            # INTENT: cleanup ends sampling, not resident model ownership. Keep
            # only a complete, lossless entry; interrupted/CFG multi-slot runs
            # retain the stock lifetime and cannot accumulate idle cache RAM.
            if complete_single_slot(self.prefix_cache):
                self.prefix_cache_enabled = False
            else:
                original_reset(False)
                state["options"] = None
            return

        signature = (
            patcher.patches_uuid,
            repr(patcher.model_options),
            tuple((key, id(value)) for key, value in patcher.object_patches.items()),
            patcher.force_cast_weights,
            getattr(patcher.model, "manual_cast_dtype", None),
        )
        same_owner = state["owner"] is not None and state["owner"]() is patcher
        if not (
            enabled
            and same_owner
            and state["signature"] == signature
            and complete_single_slot(self.prefix_cache)
        ):
            original_reset(enabled)
            state["options"] = None
        else:
            self.prefix_cache_enabled = True
        state.update(owner=weakref.ref(patcher), signature=signature, first=True)

    def select(self, key, cache_bytes, device, options):
        cache_options = (
            options.get("device", "auto"),
            options.get("dtype", "default"),
            str(device),
        )
        if state["options"] is not None and state["options"] != cache_options:
            original_reset(self.prefix_cache_enabled)
        state["options"] = cache_options

        cache = self.prefix_cache
        first = state["first"]
        state["first"] = False
        if first and cache is not None:
            # INVARIANT: use Comfy's exact tensor key (conditioning, references,
            # slots and target geometry). A different request replaces the idle
            # entry; subsequent CFG branches keep stock within-run behavior.
            if cache.select(key, create=False):
                result = (cache, cache.filled(len(self.transformer_blocks)))
            else:
                cache.free()
                result = original_select(key, cache_bytes, device, options)
        else:
            result = original_select(key, cache_bytes, device, options)
        if first:
            logger.info(
                "iDream Qwen prefix cache: %s (%.1f MiB)",
                "hit" if result[1] else "miss",
                result[0].memory_bytes() / 1024**2 if result[0] is not None else 0,
            )
        return result

    def detach(_patcher, unpatch_all):
        # Comfy also calls detach(False) when reselecting a loaded clone. Its
        # weights stay resident; the next owner/signature check governs reuse.
        # A real unload must release the cache alongside the model weights.
        if unpatch_all:
            original_reset(False)
            state.update(owner=None, signature=None, options=None, first=True)

    prepared.add_object_patch(keys[0], MethodType(reset, diffusion))
    prepared.add_object_patch(keys[1], MethodType(select, diffusion))
    prepared.add_callback_with_key(
        CallbacksMP.ON_DETACH, "idream_qwen_prefix_reuse", detach
    )
    prepared.patches_uuid = uuid.uuid4()
    return prepared
