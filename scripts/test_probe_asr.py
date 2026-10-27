"""Regression-gate contracts with real WAV decode and controlled inference.

These fixtures test assertions and evidence preservation, not ASR model quality.
No model is loaded and no frozen evaluation corpus is required.
"""
import contextlib
import hashlib
import io
import json
import os
import runpy
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts import asr_gateway as gateway


probe = runpy.run_path(str(Path(__file__).with_name("probe-asr.py")))
regress = probe["regress"]
FULL_REFERENCE = "Hello. I placed a blue notebook beside a red cup. Please tell me where the notebook is in one short sentence."
SHORT_REFERENCE = "Hello. I placed a blue notebook beside a red cup."


class ProbeRegressionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="idream-asr-probe-contract-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.sequence = 0
        self.pcm = (b"\x00\x08" * 16 + b"\x00\xf8" * 16) * 50
        self.audio = self.root / "controlled-tone.wav"
        with wave.open(str(self.audio), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            output.writeframes(self.pcm)
        self.audio_sha = hashlib.sha256(self.audio.read_bytes()).hexdigest()
        saved_path = sys.path[:]
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), saved_path))
        for name, replacement in [
            ("runtime", None),
            ("load_runtime", None),
            ("transcribe", None),
        ]:
            patcher = patch.object(gateway, name, replacement) if name == "runtime" else patch.object(gateway, name)
            mocked = patcher.start()
            self.addCleanup(patcher.stop)
            if name == "load_runtime":
                self.load = mocked
                self.load.return_value = contextlib.nullcontext(object())
            elif name == "transcribe":
                self.infer = mocked
        revision = patch("subprocess.check_output", return_value="controlled-test-source-revision\n")
        revision.start()
        self.addCleanup(revision.stop)

    def records(self, references, *, critical=False):
        records = [
            {"id": f"sample-{index}", "path": str(self.audio), "sha256": self.audio_sha, "reference": reference}
            for index, reference in enumerate(references)
        ]
        if critical:
            for record in records:
                record.update(critical_tokens=["cup"], forbidden_tokens=["cop"])
        return records

    def arguments(self, records, output=None):
        self.sequence += 1
        manifest = self.root / f"manifest-{self.sequence}.json"
        manifest.write_text(json.dumps(records))
        return SimpleNamespace(
            manifest=str(manifest),
            output=str(output or self.root / f"result-{self.sequence}.json"),
            max_wer=0.1,
        )

    def invoke(self, args, *, exit_code=0):
        with contextlib.redirect_stdout(io.StringIO()):
            if exit_code:
                with self.assertRaises(SystemExit) as raised:
                    regress(args)
                self.assertEqual(raised.exception.code, exit_code)
            else:
                regress(args)
        return json.loads(Path(args.output).read_text())

    def assert_incomplete(self, report, rows):
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(len(report["rows"]), rows)
        self.assertNotIn("passed", report)
        self.assertIn("manifestSha256", report)
        self.assertEqual(report["sourceRevision"], "controlled-test-source-revision")

    def test_each_original_critical_failure_fails_below_aggregate_wer_limit(self):
        references = [FULL_REFERENCE, FULL_REFERENCE, SHORT_REFERENCE]
        records = self.records(references, critical=True)
        for failed_index in range(3):
            with self.subTest(failed_index=failed_index):
                hypotheses = references[:]
                hypotheses[failed_index] = hypotheses[failed_index].replace("cup", "cop")
                self.infer.side_effect = [{"text": text} for text in hypotheses]
                report = self.invoke(self.arguments(records), exit_code=1)
                self.assertEqual(report["status"], "complete")
                self.assertFalse(report["passed"])
                self.assertLess(report["wer"], 0.1)
                self.assertEqual([row["criticalPassed"] for row in report["rows"]], [index != failed_index for index in range(3)])

    def test_empty_transcript_fails_even_when_aggregate_wer_is_low(self):
        references = ["hello there", " ".join(["long"] * 20)]
        self.infer.side_effect = [{"text": ""}, {"text": references[1]}]
        report = self.invoke(self.arguments(self.records(references)), exit_code=1)
        self.assertLess(report["wer"], 0.1)
        self.assertEqual(report["rows"][0]["error"], "no_speech")
        self.assertFalse(report["passed"])

    def test_empty_reference_with_speech_fails(self):
        self.infer.return_value = {"text": "unexpected words"}
        report = self.invoke(self.arguments(self.records([""])), exit_code=1)
        self.assertEqual(report["rows"][0]["error"], "unexpected_speech")
        self.assertFalse(report["passed"])

    def test_overlong_transcript_fails(self):
        self.infer.return_value = {"text": "x" * (gateway.MAX_TEXT + 1)}
        report = self.invoke(self.arguments(self.records(["one word"])), exit_code=1)
        self.assertEqual(report["rows"][0]["error"], "transcript_too_long")
        self.assertFalse(report["passed"])

    def test_runtime_load_failure_preserves_incomplete_metadata(self):
        self.load.side_effect = RuntimeError("controlled startup failure")
        args = self.arguments(self.records(["one word"]))
        with self.assertRaisesRegex(RuntimeError, "controlled startup failure"):
            self.invoke(args)
        self.assert_incomplete(json.loads(Path(args.output).read_text()), 0)
        self.infer.assert_not_called()

    def test_interruption_after_first_row_preserves_that_row(self):
        real_decode = gateway.decode
        decoded = 0

        async def interrupted_decode(path, deadline):
            nonlocal decoded
            decoded += 1
            if decoded == 2:
                raise SystemExit(77)
            return await real_decode(path, deadline)

        self.infer.return_value = {"text": "one word"}
        args = self.arguments(self.records(["one word", "another word"]))
        with patch.object(gateway, "decode", side_effect=interrupted_decode):
            report = self.invoke(args, exit_code=77)
        self.assert_incomplete(report, 1)
        self.assertEqual(report["rows"][0]["transcript"], "one word")
        self.infer.assert_called_once_with(self.pcm)

    def test_complete_run_records_audio_identity_and_passes(self):
        references = [FULL_REFERENCE, FULL_REFERENCE, SHORT_REFERENCE]
        self.infer.side_effect = [{"text": text} for text in references]
        args = self.arguments(self.records(references, critical=True))
        report = self.invoke(args)
        self.assertEqual(report["status"], "complete")
        self.assertTrue(report["passed"])
        self.assertEqual(report["wer"], 0)
        self.assertEqual(len(report["rows"]), 3)
        self.assertEqual(report["manifestSha256"], hashlib.sha256(Path(args.manifest).read_bytes()).hexdigest())
        for row in report["rows"]:
            self.assertEqual(row["inputSha256"], self.audio_sha)
            self.assertEqual(row["pcmSha256"], hashlib.sha256(self.pcm).hexdigest())
        self.assertEqual(self.infer.call_count, 3)
        for call in self.infer.call_args_list:
            self.assertEqual(call.args, (self.pcm,))
            self.assertEqual(call.kwargs, {})

    def test_bad_checksum_and_ids_fail_before_loading_model(self):
        for problem in ("checksum", "duplicate_id", "invalid_id"):
            with self.subTest(problem=problem):
                records = self.records(["one word", "another word"])
                if problem == "checksum":
                    records[0]["sha256"] = "0" * 64
                elif problem == "duplicate_id":
                    records[1]["id"] = records[0]["id"]
                else:
                    records[0]["id"] = None
                args = self.arguments(records)
                with self.assertRaises(ValueError):
                    self.invoke(args)
                self.assertFalse(Path(args.output).exists())
        self.load.assert_not_called()
        self.infer.assert_not_called()

    def test_existing_output_is_never_overwritten(self):
        output = self.root / "existing.json"
        previous = b'{"status":"complete","passed":false,"rows":[]}\n'
        output.write_bytes(previous)
        args = self.arguments(self.records(["one word"]), output)
        with self.assertRaises(FileExistsError):
            self.invoke(args)
        self.assertEqual(output.read_bytes(), previous)
        self.load.assert_not_called()
        self.infer.assert_not_called()

    def test_qualification_run_rejects_old_output_without_relabeling_evidence(self):
        records = self.records(["one word"])
        records[0]["language"] = "en"
        (self.root / "manifest.json").write_text(json.dumps(records))
        output = self.root / "historical.jsonl"
        evidence = b'{"model":"previous-model","transcript":"old evidence"}\n'
        metadata = b'{"model":"previous-model","revision":"previous-revision"}\n'
        output.write_bytes(evidence)
        sidecar = output.with_suffix(".runtime.json")
        sidecar.write_bytes(metadata)
        shared_runtime = self.root / "runtime.json"
        shared_runtime.write_bytes(metadata)
        run = probe["run"]
        with patch.dict(run.__globals__, {"ROOT": self.root}), patch.dict(os.environ):
            with self.assertRaises(FileExistsError):
                run(SimpleNamespace(languages="en", output=output.name))
        self.assertEqual(output.read_bytes(), evidence)
        self.assertEqual(sidecar.read_bytes(), metadata)
        self.assertEqual(shared_runtime.read_bytes(), metadata)
        self.load.assert_not_called()
        self.infer.assert_not_called()

    def test_forbidden_word_fails_even_when_critical_word_is_present(self):
        self.infer.return_value = {"text": FULL_REFERENCE + " cop"}
        report = self.invoke(self.arguments(self.records([FULL_REFERENCE], critical=True)), exit_code=1)
        self.assertLess(report["wer"], 0.1)
        self.assertFalse(report["rows"][0]["criticalPassed"])
        self.assertFalse(report["passed"])


if __name__ == "__main__":
    unittest.main()
