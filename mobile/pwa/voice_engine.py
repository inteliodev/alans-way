#!/usr/bin/env python3
"""Local speech worker for the Intelio phone proxy.

JSON lines on stdin, one JSON line per response on stdout. This process does
not open a socket. Models load from the local cache and the Piper file named
by INTELIO_VOICE_PIPER_MODEL.
"""
import json
import os
import sys
import tempfile
import time
import warnings

warnings.filterwarnings("ignore")

WHISPER = None
PIPER = None


def reply(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def under_tmp(path):
    root = os.path.realpath(tempfile.gettempdir())
    target = os.path.realpath(path)
    if target != root and not target.startswith(root + os.sep):
        raise ValueError("Refusing a path outside the temp directory.")
    return target


def rss_kb():
    try:
        import resource
        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    except Exception:
        return 0


def load_whisper():
    global WHISPER
    if WHISPER is not None:
        return WHISPER
    from faster_whisper import WhisperModel
    name = os.environ.get("INTELIO_VOICE_WHISPER_MODEL", "base")
    compute = os.environ.get("INTELIO_VOICE_WHISPER_COMPUTE", "int8")
    threads = int(os.environ.get("INTELIO_VOICE_THREADS", "2"))
    WHISPER = WhisperModel(name, device="cpu", compute_type=compute, cpu_threads=threads)
    return WHISPER


def load_piper():
    global PIPER
    if PIPER is not None:
        return PIPER
    model = os.environ.get("INTELIO_VOICE_PIPER_MODEL", "")
    if not model:
        raise RuntimeError("INTELIO_VOICE_PIPER_MODEL is not set.")
    try:
        from piper.voice import PiperVoice
    except ImportError:
        from piper import PiperVoice
    PIPER = PiperVoice.load(model)
    return PIPER


def synth_to(text, path):
    voice = load_piper()
    path = under_tmp(path)
    import wave
    with wave.open(path, "wb") as wav_file:
        if hasattr(voice, "synthesize_wav"):
            voice.synthesize_wav(text, wav_file)
            return
        config = getattr(voice, "config", None)
        rate = int(getattr(config, "sample_rate", 22050))
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(rate)
        wrote = False
        for chunk in voice.synthesize(text):
            raw = getattr(chunk, "audio_int16_bytes", None)
            if raw is None and isinstance(chunk, (bytes, bytearray)):
                raw = bytes(chunk)
            if raw:
                wav_file.writeframes(raw)
                wrote = True
        if not wrote:
            raise RuntimeError("Piper returned no audio.")


def transcribe(path):
    path = under_tmp(path)
    model = load_whisper()
    segments, _info = model.transcribe(path, vad_filter=True, language="en")
    return " ".join(segment.text.strip() for segment in segments).strip()


def status():
    whisper = piper = False
    error = ""
    try:
        import faster_whisper  # noqa: F401
        whisper = True
    except Exception as exc:
        error = str(exc)
    try:
        import piper  # noqa: F401
        piper = bool(os.environ.get("INTELIO_VOICE_PIPER_MODEL"))
    except Exception as exc:
        error = str(exc)
    return {"whisper": whisper, "piper": piper, "error": error}


def handle(cmd):
    op = cmd.get("op")
    ident = cmd.get("id")
    if op == "status":
        reply({"id": ident, **status()})
    elif op == "warm":
        started = time.perf_counter()
        load_whisper()
        whisper_s = time.perf_counter()
        load_piper()
        piper_s = time.perf_counter()
        reply({
            "id": ident,
            "whisper_load_s": round(whisper_s - started, 3),
            "piper_load_s": round(piper_s - whisper_s, 3),
            "rss_kb": rss_kb(),
        })
    elif op == "transcribe":
        started = time.perf_counter()
        text = transcribe(cmd["path"])
        reply({
            "id": ident,
            "text": text,
            "seconds": round(time.perf_counter() - started, 3),
            "rss_kb": rss_kb(),
        })
    elif op == "synthesize":
        started = time.perf_counter()
        synth_to(str(cmd.get("text") or "")[:2000], cmd["path"])
        reply({
            "id": ident,
            "ok": True,
            "seconds": round(time.perf_counter() - started, 3),
            "rss_kb": rss_kb(),
        })
    else:
        reply({"id": ident, "error": "Unknown voice op."})


def main():
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        ident = None
        try:
            cmd = json.loads(raw)
            ident = cmd.get("id")
            handle(cmd)
        except Exception as exc:
            reply({"id": ident, "error": str(exc)[:300]})


if __name__ == "__main__":
    main()
