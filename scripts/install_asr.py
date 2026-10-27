"""Explicit online install/prewarm step; gateway restarts remain offline."""
import hashlib
import json
from pathlib import Path
from huggingface_hub import snapshot_download
from scripts.asr_gateway import MODEL_ID, MODEL_REVISION, MODEL_FILES, SDK_VERSION

if __name__ == "__main__":
    snapshot = Path(snapshot_download(MODEL_ID, revision=MODEL_REVISION, allow_patterns=list(MODEL_FILES)))
    checksums = {}
    for name, expected in MODEL_FILES.items():
        digest = hashlib.sha256()
        with (snapshot / name).open("rb") as file:
            while chunk := file.read(1024 * 1024):
                digest.update(chunk)
        checksums[name] = digest.hexdigest()
        if checksums[name] != expected:
            raise RuntimeError("ASR model files differ from the pinned checksums")
    print(json.dumps({"model": MODEL_ID, "revision": MODEL_REVISION, "runtimeVersion": SDK_VERSION, "checksums": checksums}, indent=2))
