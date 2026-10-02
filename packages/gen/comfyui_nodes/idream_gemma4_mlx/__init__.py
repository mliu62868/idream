"""Prompt-scoped LTX Gemma4 MLX CLIP loader for native Comfy workflows."""
from .encoder import Gemma4MLXCLIP


class IDreamGemma4MLXCLIPLoader:
    @classmethod
    def INPUT_TYPES(cls):
        import folder_paths
        return {'required': {'clip_name': (folder_paths.get_filename_list('text_encoders'),)}}

    RETURN_TYPES = ('CLIP',)
    FUNCTION = 'load'
    CATEGORY = 'iDream/text'

    @classmethod
    def IS_CHANGED(cls, **_kwargs):
        # The explicit conditioning barrier destroys this owner after all branches.
        return float('nan')

    def load(self, clip_name):
        import folder_paths
        return (Gemma4MLXCLIP(folder_paths.get_full_path_or_raise('text_encoders',clip_name)),)


NODE_CLASS_MAPPINGS = {'IDreamGemma4MLXCLIPLoader': IDreamGemma4MLXCLIPLoader}
