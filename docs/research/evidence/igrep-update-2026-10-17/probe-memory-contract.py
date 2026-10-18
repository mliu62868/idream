#!/usr/bin/env python3
"""Probe a published igrep wheel with synthetic memory and all network denied.

Run with the existing igrep Python environment; --wheel selects an extracted
wheel through PYTHONPATH without installing or replacing the current version.
Only macOS sandbox-exec is supported so a missing network fence fails closed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python", required=True, help="Python in the existing igrep environment")
    parser.add_argument("--wheel", type=Path, help="Extracted wheel directory; no installation")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    sandbox = shutil.which("sandbox-exec")
    if not sandbox:
        raise SystemExit("sandbox-exec is required; refusing an unfenced probe")
    results: dict[str, object] = {"network": "sandbox-exec deny network*", "models": "none requested", "checks": []}
    checks: list[dict[str, object]] = results["checks"]  # type: ignore[assignment]
    with tempfile.TemporaryDirectory(prefix="idream-igrep-contract-") as temporary:
        root = Path(temporary)
        environment = os.environ.copy()
        environment.update({"IGREP_NO_CACHE": "1", "IGREP_RERANK_CACHE": "0", "REDIS_URL": "", "IGREP_CACHE_REDIS_DIR": str(root / "no-redis")})
        if args.wheel:
            environment["PYTHONPATH"] = str(args.wheel.resolve())
        prefix = [sandbox, "-p", "(version 1) (allow default) (deny network*)", args.python]

        def run(arguments: list[str], payload: object | str | None = None, code: int = 0) -> object:
            raw = payload if isinstance(payload, str) else json.dumps(payload) if payload is not None else None
            completed = subprocess.run(prefix + ["-m", "igrep", *arguments], input=raw, text=True, capture_output=True, env=environment, cwd=root, timeout=30)
            if completed.returncode != code:
                raise AssertionError(f"{arguments}: expected exit {code}, got {completed.returncode}: {completed.stdout} {completed.stderr}")
            if arguments == ["--version"]:
                return completed.stdout.strip()
            try:
                return json.loads(completed.stdout)
            except json.JSONDecodeError:
                raise AssertionError(f"Expected JSON: {completed.stdout} {completed.stderr}") from None

        def check(name: str, condition: bool, detail: object = None) -> None:
            checks.append({"name": name, "passed": bool(condition), "detail": detail})
            if not condition:
                raise AssertionError(name)

        def api(operation: str, payload: dict[str, object], code: int = 0) -> dict[str, object]:
            return run(["mem-api", operation], payload, code)  # type: ignore[return-value]

        def as_text(value: object) -> str:
            return json.dumps(value, ensure_ascii=False)

        results["version"] = run(["--version"])
        results["python"] = subprocess.check_output([args.python, "--version"], text=True).strip()
        if args.wheel:
            binary = next(args.wheel.glob("igrep.*.so"))
            results["binary_sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
        principal = {"store": str(root / "store"), "tenant": "synthetic-tenant", "user": "alice-character-7"}
        other = {**principal, "user": "bob-character-7"}
        query = {"query": "amber otter", "search_mode": "fast"}
        empty = api("memory-search", {**principal, **query})
        check("empty_search_is_successful_empty_page", empty.get("results") == [] and not empty.get("failed"), empty)
        unknown = api("memory-search", {**principal, **query, "no_cache": True}, 2)
        check("no_cache_payload_field_is_rejected", "no_cache" in as_text(unknown), unknown)
        null = api("memory-search", {**principal, **query, "max_results": None}, 2)
        check("explicit_null_is_rejected", "max_results" in as_text(null), null)
        recorded = api("memory-record", {**principal, "content": "Synthetic test preference: amber otter."})
        own_search = api("memory-search", {**principal, **query})
        other_search = api("memory-search", {**other, **query})
        check("fast_search_retrieves_agent_note_without_network", "amber otter" in str(own_search.get("markdownContext", "")) and bool(own_search.get("results")), own_search)
        check("different_principal_does_not_retrieve_note", other_search.get("results") == [] and "amber otter" not in str(other_search.get("markdownContext", "")), other_search)
        flags = ["--store", principal["store"], "--tenant", principal["tenant"], "--user", principal["user"]]
        first_row = {"role": "user", "content": "Synthetic immutable original: cobalt fox.", "source_seq": 1, "source_at": "2026-10-17T10:00:00Z"}
        first = run(["mem", "ingest", *flags, "--session-id", "immutable-rows", "--rows", "-"], json.dumps(first_row) + "\n")
        changed = run(["mem", "ingest", *flags, "--session-id", "immutable-rows", "--rows", "-"], json.dumps({**first_row, "content": "Synthetic altered duplicate: coral cat."}) + "\n")
        canonical = "\n".join(path.read_text() for path in (root / "store").rglob("*.jsonl") if path.parent.name == "sessions")
        check("same_source_seq_changed_payload_keeps_first", "cobalt fox" in canonical and "coral cat" not in canonical and changed.get("duplicateRows") == 1, {"first": first, "changed": changed})
        transcript = root / "authoritative-transcript.jsonl"
        transcript.write_text(json.dumps({"role": "user", "content": "Synthetic prior branch: mint whale."}) + "\n")
        before = run(["mem", "ingest", *flags, "--session-id", "editable-transcript", "--transcript", str(transcript), "--replace-history"])
        transcript.write_text(json.dumps({"role": "user", "content": "Synthetic current branch: violet owl."}) + "\n")
        after = run(["mem", "ingest", *flags, "--session-id", "editable-transcript", "--transcript", str(transcript), "--replace-history"])
        canonical = "\n".join(path.read_text() for path in (root / "store").rglob("*.jsonl") if path.parent.name == "sessions")
        check("replace_history_removes_old_canonical_turn", "mint whale" not in canonical and "violet owl" in canonical, {"before": before, "after": after})
        cache = subprocess.run(prefix + ["-c", "import json; from igrep.cache_db import get_cache_backend_status; print(json.dumps(get_cache_backend_status()))"], text=True, capture_output=True, env=environment, cwd=root, timeout=30, check=True)
        cache_state = json.loads(cache.stdout)
        check("global_no_cache_disables_shared_backend", cache_state.get("enabled") is False and cache_state.get("source") == "IGREP_NO_CACHE", cache_state)
        purged = run(["mem", "store", "purge", *flags])
        remaining_search = api("memory-search", {**principal, **query})
        check("principal_purge_removes_searchable_note", remaining_search.get("results") == [], {"purge": purged, "search": remaining_search})
        check("principal_purge_does_not_delete_host_transcript", transcript.exists() and "violet owl" in transcript.read_text())
        results["probe_script_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        results["finished_at_utc"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        results["limitations"] = ["No maintain/model calls, relevance-quality evaluation, HTTP auth, concurrency/crash or Redis server deletion test.", "Temporary synthetic memory removed after the run; host transcript preservation is checked before temporary cleanup."]
        serialized = json.dumps(results, ensure_ascii=False, indent=2).replace(str(root.resolve()), "<TEMP>").replace(str(root), "<TEMP>") + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(serialized)
    print(f"{results['version']}: {len(checks)} checks passed; {args.output}")


if __name__ == "__main__":
    main()
