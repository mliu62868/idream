"""Contract tests with controlled inference; these are not model-quality evidence."""
import asyncio
import io
import tempfile
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import httpx
from scripts import parakeet_asr_gateway as g


def wav(seconds=1, *, pcm=None):
    frames = round(seconds * 16000)
    if pcm is None:
        # A nonzero, zero-mean tone exercises native admission and codec decode;
        # it is a transport fixture, not model-quality evidence.
        tone = b"\x00\x08" * 16 + b"\x00\xf8" * 16
        pcm = (tone * ((frames + 31) // 32))[:frames * 2]
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(pcm)
    return out.getvalue()


class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        g.API_TOKEN = "test-internal-token"
        g.healthy = g.accepting = True
        g.slot = asyncio.Lock()
        g.states.clear()
        g.rates.clear()
        self.directory = tempfile.TemporaryDirectory(prefix="idream-asr-contract-")
        self.temp = patch.object(g, "TEMP_DIR", Path(self.directory.name))
        self.temp.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=g.app), base_url="http://asr")
        self.mock = patch.object(g, "transcribe", return_value={"text": "Review this draft."})
        self.infer = self.mock.start()

    async def asyncTearDown(self):
        if g.tasks:
            await asyncio.gather(*g.tasks, return_exceptions=True)
        self.mock.stop()
        await self.client.aclose()
        self.temp.stop()
        self.directory.cleanup()

    def headers(self, key="clip-1", user="user-1", conversation="session:one"):
        return {"Authorization": "Bearer test-internal-token", "X-ASR-User-Id": user, "X-ASR-Conversation-Id": conversation, "X-ASR-Request-Id": key, "Content-Type": "audio/wav"}

    async def post(self, body=None, **kwargs):
        return await self.client.post("/v1/transcriptions", content=wav() if body is None else body, headers=self.headers(**kwargs))

    async def test_health_advertises_english_product_support(self):
        result = await self.client.get("/health", headers=self.headers())
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["languages"], ["en"])
        self.assertEqual(result.json()["model"], "moondream/parakeet-redux")
        self.assertEqual(result.json()["modelRevision"], "2bf128600aac4b16946f7ed8372e56117fe5e23b")

    async def test_real_decode_replay_conflict_and_scope(self):
        first = await self.post()
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["audioDurationMs"], 1000)
        self.assertEqual(first.json()["text"], "Review this draft.")
        self.assertEqual((await self.post()).json()["text"], first.json()["text"])
        self.assertEqual(self.infer.call_count, 1)
        self.assertEqual((await self.post(wav(2))).status_code, 409)
        stolen = await self.client.get("/v1/transcriptions/clip-1", headers=self.headers(user="other"))
        self.assertEqual(stolen.status_code, 404)

    async def test_cancel_before_upload_is_tombstone(self):
        cancelled = await self.client.delete("/v1/transcriptions/clip-1", headers=self.headers())
        self.assertEqual(cancelled.json()["status"], "cancelled")
        self.assertEqual((await self.post()).json()["status"], "cancelled")
        self.infer.assert_not_called()

    async def test_actual_stream_limit_without_content_length(self):
        async def chunks():
            for _ in range(9):
                yield bytes(1024 * 1024)
        result = await self.client.post("/v1/transcriptions", headers=self.headers(), content=chunks())
        self.assertEqual(result.status_code, 413)
        self.assertFalse(g.states["clip-1"].active)
        self.infer.assert_not_called()

    async def test_decode_duration_and_invalid_audio(self):
        self.assertEqual((await self.post(wav(60.01))).json()["errorCode"], "audio_too_long")
        self.assertEqual((await self.post(wav(60.01, pcm=bytes(round(60.01 * 16000) * 2)), key="long-zero")).json()["errorCode"], "audio_too_long")
        self.assertEqual((await self.post(b"bad audio", key="bad")).json()["errorCode"], "invalid_audio")
        self.infer.assert_not_called()

    async def test_real_http_zero_pcm_never_reaches_model_but_one_lsb_does(self):
        import socket
        import uvicorn
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        port = listener.getsockname()[1]
        # The test listener never loads the resident runtime or its startup warmup.
        server = uvicorn.Server(uvicorn.Config(g.app, log_level="critical", lifespan="off"))
        task = asyncio.create_task(server.serve(sockets=[listener]))
        self.infer.return_value = {"text": "Thank you."}
        try:
            for _ in range(100):
                if server.started:
                    break
                await asyncio.sleep(.01)
            self.assertTrue(server.started)
            async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", trust_env=False) as client:
                for seconds in (1, 10, 60):
                    with self.subTest(seconds=seconds):
                        key = f"zero-{seconds}"
                        body = wav(seconds, pcm=bytes(seconds * 16000 * 2))
                        headers = self.headers(key=key)
                        result = await client.post("/v1/transcriptions", content=body, headers=headers)
                        self.assertEqual(result.status_code, 200)
                        payload = result.json()
                        self.assertEqual(payload["status"], "failed")
                        self.assertEqual(payload["errorCode"], "no_speech")
                        self.assertNotIn("text", payload)
                        self.infer.assert_not_called()
                        await asyncio.gather(*g.tasks)
                        op = g.states[key]
                        self.assertEqual(op.duration, seconds * 1000)
                        self.assertIsNone(op.text)
                        self.assertFalse(op.active)
                        self.assertFalse(g.slot.locked())
                        self.assertEqual(g.uploads, 0)
                        self.assertEqual(list(g.TEMP_DIR.iterdir()), [])
                        self.assertGreater(op.expires, time.time() + g.TTL - 2)
                        status = await client.get(f"/v1/transcriptions/{key}", headers=headers)
                        self.assertEqual(status.json(), payload)
                        replay = await client.post("/v1/transcriptions", content=body, headers=headers)
                        self.assertEqual(replay.json(), payload)
                        conflict = await client.post("/v1/transcriptions", content=wav(), headers=headers)
                        self.assertEqual(conflict.status_code, 409)
                        self.infer.assert_not_called()
                        op.expires = time.time() - 1
                        self.assertEqual((await client.get(f"/v1/transcriptions/{key}", headers=headers)).status_code, 404)
                # A single PCM16 LSB is eligible even with almost zero RMS.
                pcm = bytes(8000 * 2) + b"\x01\x00" + bytes(7999 * 2)
                result = await client.post("/v1/transcriptions", content=wav(pcm=pcm), headers=self.headers(key="one-lsb"))
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json()["status"], "completed")
                self.assertEqual(result.json()["audioDurationMs"], 1000)
                self.assertEqual(result.json()["text"], "Thank you.")
                self.assertEqual(self.infer.call_count, 1)
                self.infer.assert_called_once_with(pcm)
                await asyncio.gather(*g.tasks)
                self.assertFalse(g.slot.locked())
                self.assertEqual(list(g.TEMP_DIR.iterdir()), [])
        finally:
            server.should_exit = True
            await task
            listener.close()

    async def test_cancel_during_real_zero_decode_preserves_tombstone_and_cleanup(self):
        entered, release = asyncio.Event(), asyncio.Event()
        real_decode = g.decode
        async def paused_decode(path, deadline):
            pcm = await real_decode(path, deadline)
            entered.set()
            await release.wait()
            return pcm
        with patch.object(g, "decode", side_effect=paused_decode):
            pending = asyncio.create_task(self.post(wav(pcm=bytes(16000 * 2))))
            try:
                await asyncio.wait_for(entered.wait(), 3)
                cancelled = await self.client.delete("/v1/transcriptions/clip-1", headers=self.headers())
                self.assertEqual(cancelled.json()["status"], "cancelled")
                self.assertEqual((await pending).json()["status"], "cancelled")
                self.assertTrue(g.slot.locked())
            finally:
                release.set()
                await pending
                await asyncio.gather(*g.tasks)
        self.infer.assert_not_called()
        self.assertEqual(g.states["clip-1"].status, "cancelled")
        self.assertIsNone(g.states["clip-1"].error)
        self.assertIsNone(g.states["clip-1"].text)
        self.assertFalse(g.states["clip-1"].active)
        self.assertFalse(g.slot.locked())
        self.assertEqual(g.uploads, 0)
        self.assertEqual(list(g.TEMP_DIR.iterdir()), [])

    async def test_cancel_native_holds_slot_and_user_gate(self):
        import threading
        started, release = threading.Event(), threading.Event()
        def blocking(_):
            started.set()
            release.wait(3)
            return {"text": "late private result"}
        self.infer.side_effect = blocking
        pending = asyncio.create_task(self.post())
        for _ in range(100):
            if started.is_set():
                break
            await asyncio.sleep(.01)
        self.assertTrue(started.is_set())
        try:
            await self.client.delete("/v1/transcriptions/clip-1", headers=self.headers())
            self.assertEqual((await pending).json()["status"], "cancelled")
            self.assertTrue(g.slot.locked())
            self.assertEqual((await self.post(key="second")).status_code, 429)
        finally:
            release.set()
        await asyncio.gather(*g.tasks)
        self.assertFalse(g.slot.locked())
        self.assertIsNone(g.states["clip-1"].text)

    async def test_timeout_refuses_delivery_and_health(self):
        import threading
        release = threading.Event()
        def blocking(_):
            release.wait(3)
            return {"text": "late result"}
        self.infer.side_effect = blocking
        with patch.object(g, "DEADLINE", .15):
            response = await self.post()
        self.assertEqual(response.json()["errorCode"], "transcription_timeout")
        await asyncio.sleep(.03)
        self.assertTrue(g.slot.locked())
        self.assertFalse(g.healthy)
        release.set()
        await asyncio.gather(*g.tasks)
        self.assertIsNone(g.states["clip-1"].text)

    async def test_rate_and_expiry(self):
        for i in range(10):
            self.assertEqual((await self.post(key=f"clip-{i}")).status_code, 200)
        self.assertEqual((await self.post(key="eleven")).status_code, 429)
        self.assertEqual((await self.post(key="clip-0")).status_code, 200)
        g.states["clip-0"].expires = time.time() - 1
        self.assertEqual((await self.client.get("/v1/transcriptions/clip-0", headers=self.headers(key="clip-0"))).status_code, 404)

    async def test_queue_capacity_and_deadline(self):
        await g.slot.acquire()
        with patch.object(g, "QUEUE_TIMEOUT", .08):
            requests = [asyncio.create_task(self.post(key=f"q-{i}", user=f"u-{i}")) for i in range(5)]
            await asyncio.sleep(.02)
            overflow = await self.post(key="overflow", user="u-overflow")
            self.assertEqual(overflow.status_code, 503)
            for response in await asyncio.gather(*requests):
                self.assertEqual(response.json()["errorCode"], "queue_timeout")
        g.slot.release()
        self.infer.assert_not_called()

    async def test_replay_during_upload_still_checks_hash(self):
        gate = asyncio.Event()
        async def delayed():
            yield wav()[:44]
            await gate.wait()
            yield wav()[44:]
        first = asyncio.create_task(self.client.post("/v1/transcriptions", content=delayed(), headers=self.headers()))
        await asyncio.sleep(.02)
        conflicting = asyncio.create_task(self.post(wav(2)))
        await asyncio.sleep(.02)
        gate.set()
        self.assertEqual((await first).json()["status"], "completed")
        self.assertEqual((await conflicting).status_code, 409)
        self.assertEqual(self.infer.call_count, 1)

    async def test_browser_containers_real_decode(self):
        for format_name, codec in [("webm", "libopus"), ("ogg", "libopus"), ("mp4", "aac")]:
            # Synthetic PCM validates browser container support, not accuracy.
            import subprocess
            encoded = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-c:a", codec, "-f", format_name, *(["-movflags", "frag_keyframe+empty_moov"] if format_name == "mp4" else []), "pipe:1"], input=wav(), capture_output=True, check=True).stdout
            result = await self.post(encoded, key=format_name)
            self.assertEqual(result.json()["status"], "completed", result.text)
            self.assertGreater(result.json()["audioDurationMs"], 900)
            self.assertLess(result.json()["audioDurationMs"], 1100)

    async def test_disk_failure_releases_admission(self):
        with patch.object(g.tempfile, "mkdtemp", side_effect=OSError("disk unavailable")):
            result = await self.post()
        self.assertEqual(result.status_code, 400)
        self.assertEqual(g.uploads, 0)
        self.assertFalse(g.states["clip-1"].active)
        self.assertEqual(g.states["clip-1"].status, "failed")
        self.assertTrue(g.states["clip-1"].uploaded.is_set())
        self.assertEqual((await self.post(key="retry")).json()["status"], "completed")

    async def test_unknown_cancels_cannot_fill_cache(self):
        for i in range(10):
            key=f"cancel-{i}"
            self.assertEqual((await self.client.delete(f"/v1/transcriptions/{key}", headers=self.headers(key=key))).status_code, 200)
        self.assertEqual((await self.client.delete("/v1/transcriptions/overflow", headers=self.headers(key="overflow"))).status_code, 429)
        self.assertEqual(len(g.states), 10)
        # Replay of a real tombstone remains idempotent despite the rate limit.
        self.assertEqual((await self.post(key="cancel-0")).json()["status"], "cancelled")

    async def test_real_http_cancelled_large_replay_drains_body(self):
        import socket
        import urllib.request
        import uvicorn
        listener=socket.socket()
        listener.bind(("127.0.0.1",0))
        listener.listen(128)
        port=listener.getsockname()[1]
        server=uvicorn.Server(uvicorn.Config(g.app,log_level="critical",lifespan="off"))
        task=asyncio.create_task(server.serve(sockets=[listener]))
        try:
            for _ in range(100):
                if server.started:break
                await asyncio.sleep(.01)
            self.assertTrue(server.started)
            await self.client.delete("/v1/transcriptions/clip-1",headers=self.headers())
            def replay():
                opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
                request=urllib.request.Request(f"http://127.0.0.1:{port}/v1/transcriptions",data=wav(60),headers=self.headers(),method="POST")
                import json
                with opener.open(request,timeout=5) as result:return result.status,json.load(result)
            status,payload=await asyncio.to_thread(replay)
            self.assertEqual(status,200)
            self.assertEqual(payload["status"],"cancelled")
            self.infer.assert_not_called()
            self.assertEqual(g.uploads,0)
        finally:
            server.should_exit=True
            await task
            listener.close()

    async def test_auth_required(self):
        result = await self.client.post("/v1/transcriptions", content=wav())
        self.assertEqual(result.status_code, 401)
        self.assertEqual((await self.client.get("/health")).status_code, 401)


if __name__ == "__main__":
    unittest.main()
