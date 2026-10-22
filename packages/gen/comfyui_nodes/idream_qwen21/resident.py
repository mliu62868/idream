"""Graph-scoped BF16 materialization of emulated INT8 Qwen weights on MPS."""
import copy
import logging
import time
import uuid

import torch
from comfy.quant_ops import QuantizedTensor
from comfy.patcher_extension import CallbacksMP


def resident_int8_model(model, device):
    # INVARIANT: freezing a representation must not bypass pending adapters or
    # hooks that can change a weight during sampling.
    if model.patches or model.hook_patches:
        raise ValueError("Resident INT8 weights require a model without weight patches")
    prepared = model.clone()
    # Sibling patchers share a module tree. Its current representation may
    # already be BF16, so account from that tree rather than a cached INT8 size.
    size = sum(tensor.nbytes for tensor in model.model.state_dict().values())
    count = 0
    sources = []
    started = time.perf_counter()
    for name, module in model.get_model_object("diffusion_model").named_modules():
        if getattr(module, "weight", None) is None:
            continue
        key = f"diffusion_model.{name}"
        # Read the source patcher's object backup when a resident sibling is
        # active; reading module.weight directly would see its BF16 replacement.
        source = model.get_model_object(key)
        weight = source.weight
        if not isinstance(weight, QuantizedTensor):
            continue
        if getattr(source, "quant_format", None) != "int8_tensorwise" or not getattr(source, "_full_precision_mm", False):
            raise ValueError("Resident weights require emulated INT8 Linear modules")
        if any(existing == key or existing.startswith(f"{key}.") or key.startswith(f"{existing}.") for existing in prepared.object_patches):
            raise ValueError("Resident weights cannot replace an existing object patch")
        if any(source.children()):
            raise ValueError("Resident weights require leaf Linear modules")
        before = sum(tensor.nbytes for tensor in module.state_dict().values())
        # Use the exact existing dequantizer, including ConvRot inverse rotation,
        # on the execution device. Materialize one layer at a time to bound FP32
        # temporaries; disk weights and the shared loader remain unchanged.
        replacement = copy.copy(source)
        replacement._parameters = source._parameters.copy()
        replacement._buffers = source._buffers.copy()
        replacement._modules = source._modules.copy()
        replacement.weight_function = list(source.weight_function)
        replacement.bias_function = list(source.bias_function)
        replacement.weight = torch.nn.Parameter(weight.to(device=device).dequantize().to(torch.bfloat16), requires_grad=False)
        # Cache the module, not a Parameter: quantized Linear._apply replaces
        # Parameters on .to(), so cached Parameter patches would retain MPS
        # allocations after managed offload. All clones share this module.
        prepared.add_object_patch(key, replacement)
        sources.append(source)
        after = sum(tensor.nbytes for tensor in replacement.state_dict().values())
        size += after - before
        count += 1
    if not count:
        raise ValueError("No emulated INT8 weights to materialize")
    prepared.size = size
    # A representation change must reload the managed model; otherwise an
    # already-loaded clone can retain the old INT8 loaded-memory accounting.
    prepared.patches_uuid = uuid.uuid4()
    def offload_sources(patcher, _unpatch_all):
        # Originals may have been loaded before this node ran. They are outside
        # the active module tree while patched, so managed .to(cpu) misses them.
        for source in sources:
            source.to(patcher.offload_device)
    prepared.add_callback_with_key(CallbacksMP.ON_DETACH, "idream_resident_int8", offload_sources)
    if device.type == "mps":
        torch.mps.synchronize()
    logging.info("iDream resident INT8: %d BF16 weights, %.1f MiB model, %.3fs materialization", count, size / 1024**2, time.perf_counter() - started)
    return prepared


class IDreamQwen21ResidentWeights:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "prepare"
    CATEGORY = "iDream/Qwen 2.1"
    DESCRIPTION = "Materializes emulated INT8 Qwen weights once as BF16; requires additional unified memory."

    def prepare(self, model):
        import comfy.model_management
        from comfy.ldm.qwen_image21.model import QwenImage21Transformer2DModel
        device = comfy.model_management.get_torch_device()
        if device.type != "mps" or not isinstance(model.get_model_object("diffusion_model"), QwenImage21Transformer2DModel):
            raise ValueError("Resident Qwen weights require the Qwen 2.1 MPS runtime")
        # The original quantized loader remains cached alongside the new weights.
        if comfy.model_management.get_free_memory(device) < 3 * model.model_size():
            raise ValueError("Insufficient unified memory for resident BF16 Qwen weights")
        from .prefix_cache import reuse_qwen_prefix_cache
        return (reuse_qwen_prefix_cache(resident_int8_model(model, device)),)
