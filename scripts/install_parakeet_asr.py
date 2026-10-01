"""Explicit online install/prewarm step; gateway restarts remain offline."""
import hashlib
import json
from pathlib import Path
from huggingface_hub import snapshot_download
from scripts.parakeet_asr_gateway import MODEL_ID, MODEL_REVISION, MODEL_SHA256, SDK_VERSION

if __name__ == "__main__":
    snapshot = Path(snapshot_download(MODEL_ID, revision=MODEL_REVISION, allow_patterns=["config.json", "model.safetensors", "ternary.json", "tokenizer.json"]))
    checksums = {}
    for name in ("config.json", "model.safetensors", "ternary.json", "tokenizer.json"):
        digest = hashlib.sha256()
        with (snapshot / name).open("rb") as file:
            while chunk := file.read(1024 * 1024):
                digest.update(chunk)
        checksums[name] = digest.hexdigest()
    if checksums["model.safetensors"] != MODEL_SHA256:
        raise RuntimeError("ASR weights differ from the pinned checksum")
    print(json.dumps({"model": MODEL_ID, "revision": MODEL_REVISION, "runtimeVersion": SDK_VERSION, "checksums": checksums}, indent=2))
