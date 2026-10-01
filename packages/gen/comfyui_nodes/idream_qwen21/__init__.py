"""Register Qwen 2.1 nodes only on the native image runtime."""

import os

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# INVARIANT: the shared node directory also serves older video installations
# without Qwen 2.1. They must not import these image-only model dependencies.
if os.environ.get("COMFYUI_PROFILE") not in {"video", "video-h3"}:
    from .nodes import (
        IDreamQwen21TextEncode,
        IDreamQwen21VAELoader,
        IDreamQwen21TurboLora,
        IDreamQwen21TurboSigmas,
        NODE_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS,
        correct_qwen21_vae,
        safe_avg_down_forward,
    )
