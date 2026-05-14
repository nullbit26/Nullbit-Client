import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

try:
    import argparse
    import json
    import sys
    from pathlib import Path
    import traceback
    import warnings

    warnings.filterwarnings("ignore")

    def vlog(msg: str) -> None:
        """Диагностика в stderr (видно в логах Node)."""
        print(f"[voice] {msg}", file=sys.stderr, flush=True)

    def fail(message: str) -> int:
        print(f"[voice] {message}", file=sys.stderr, flush=True)
        return 1

    def preview_repr(s: str, max_len: int = 400) -> str:
        if s is None:
            return "None"
        if len(s) <= max_len:
            return repr(s)
        return repr(s[:max_len]) + f"... ({len(s)} chars total)"

    def explain_empty_after_clean(raw: str, cleaned: str) -> str:
        if raw is None or len(str(raw)) == 0:
            return "stdin was empty (nothing read from stdin)"
        t = str(raw or "").encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")
        filtered = "".join(
            ch if (ch.isalnum() or ch.isspace() or ch in ".,!?;:'\"()-") else " "
            for ch in t
        )
        collapsed = " ".join(filtered.split()).strip()
        if not cleaned and not collapsed:
            return (
                f"after punctuation filter + strip: all whitespace; "
                f"raw_len={len(t)} first_codepoints={[hex(ord(c)) for c in t[:24]]}"
            )
        if not cleaned and collapsed:
            codes = [hex(ord(c)) for c in collapsed[:48]]
            return (
                "after strip there are chars but none is alnum() "
                f"(e.g. only punctuation); collapsed={repr(collapsed[:200])} codepoints={codes}"
            )
        return f"unexpected; cleaned={repr(cleaned[:200])}"

    def clean_text(raw: str) -> str:
        text = str(raw or "").encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")
        # Разрешаем RU/EN буквы, цифры и базовую пунктуацию.
        text = "".join(
            ch if (ch.isalnum() or ch.isspace() or ch in ".,!?;:'\"()-")
            else " "
            for ch in text
        )
        text = " ".join(text.split()).strip()
        if not text:
            return ""
        if not any(ch.isalnum() for ch in text):
            return ""
        return text

    # Silero ru: латинские слова/ники часто «молчат» — заменяем на похожие кириллические буквы.
    _LAT_TO_CYR_SINGLE = {
        "a": "а",
        "b": "б",
        "c": "с",
        "d": "д",
        "e": "е",
        "f": "ф",
        "g": "г",
        "h": "х",
        "i": "и",
        "j": "ж",
        "k": "к",
        "l": "л",
        "m": "м",
        "n": "н",
        "o": "о",
        "p": "п",
        "q": "к",
        "r": "р",
        "s": "с",
        "t": "т",
        "u": "у",
        "v": "в",
        "w": "ш",
        "y": "й",
        "z": "з",
    }

    def transliterate_latin_for_russian_tts(text: str) -> str:
        parts = []
        for ch in text:
            lo = ch.lower()
            if lo == "x":
                parts.append("КС" if ch.isupper() else "кс")
                continue
            if "a" <= lo <= "z" and lo in _LAT_TO_CYR_SINGLE:
                cyr = _LAT_TO_CYR_SINGLE[lo]
                if ch.isupper():
                    cyr = cyr.upper()
                parts.append(cyr)
            else:
                parts.append(ch)
        return "".join(parts)

    def pick_output_device(sd, preferred_name: str) -> int:
        devices = sd.query_devices()
        preferred = (preferred_name or "CABLE Input").strip().lower()

        for idx, dev in enumerate(devices):
            name = str(dev.get("name", "")).lower()
            if preferred in name and int(dev.get("max_output_channels", 0)) > 0:
                return idx

        default_pair = sd.default.device
        if default_pair and default_pair[1] is not None:
            return int(default_pair[1])

        for idx, dev in enumerate(devices):
            if int(dev.get("max_output_channels", 0)) > 0:
                return idx
        return -1

    def model_direct_url(model_name: str) -> str:
        if model_name == "v5_ru":
            return "https://models.silero.ai/models/tts/ru/v5_ru.pt"
        return ""

    def model_cache_path(model_name: str) -> Path:
        return Path(".cache") / "torch" / "silero_tts" / f"{model_name}.pt"

    def load_model_from_file(torch, model_path: Path):
        errors = []
        try:
            pkg = torch.package.PackageImporter(str(model_path))
            model = pkg.load_pickle("tts_models", "model")
            return model
        except Exception as exc:
            errors.append(f"PackageImporter: {exc}")

        try:
            model = torch.load(str(model_path), map_location="cpu")
            if hasattr(model, "apply_tts") or hasattr(model, "forward"):
                return model
            errors.append(f"torch.load returned unsupported object type: {type(model)}")
        except Exception as exc:
            errors.append(f"torch.load: {exc}")

        try:
            model = torch.jit.load(str(model_path), map_location="cpu")
            return model
        except Exception as exc:
            errors.append(f"torch.jit.load: {exc}")

        raise RuntimeError(" ; ".join(errors))

    def ensure_model_file(torch, model_name: str) -> Path:
        model_path = model_cache_path(model_name)
        model_path.parent.mkdir(parents=True, exist_ok=True)

        if model_path.exists():
            try:
                load_model_from_file(torch, model_path)
                return model_path
            except Exception:
                try:
                    model_path.unlink()
                except OSError:
                    pass

        url = model_direct_url(model_name)
        if not url:
            raise RuntimeError(f"no direct URL configured for model '{model_name}'")
        vlog("Downloading model...")
        torch.hub.download_url_to_file(url, str(model_path), progress=False)
        load_model_from_file(torch, model_path)
        return model_path

    def load_silero_model_cpu(torch, args):
        torch.set_num_threads(1)
        torch.hub.set_dir(".cache/torch")
        mpath = ensure_model_file(torch, args.model)
        try:
            model = load_model_from_file(torch, mpath)
        except Exception:
            model, _ = torch.hub.load(
                repo_or_dir="snakers4/silero-models",
                model="silero_tts",
                language="ru",
                speaker=args.model,
                trust_repo=True,
                force_reload=False,
            )
        model.to("cpu")
        return model

    def synthesize_numpy(model, args, text: str):
        import numpy as np

        model_sr = getattr(model, "sample_rate", None)
        if not isinstance(model_sr, int) or model_sr <= 0:
            model_sr = getattr(model, "samplerate", None)
        sample_rate = int(model_sr) if isinstance(model_sr, int) and model_sr > 0 else int(args.sample_rate)
        audio = model.apply_tts(text=text, speaker=args.voice, sample_rate=sample_rate)
        if hasattr(audio, "detach"):
            audio = audio.detach().cpu().numpy()
        else:
            audio = np.asarray(audio)
        return audio, sample_rate

    def write_wav_path(out_path_str: str, audio, sample_rate: int) -> None:
        import numpy as np
        import wave

        p = Path(out_path_str)
        p.parent.mkdir(parents=True, exist_ok=True)
        arr = np.asarray(audio)
        vlog(
            "about to write WAV: "
            f"path={p.resolve()} sample_rate={sample_rate} "
            f"audio_shape={getattr(arr, 'shape', None)} dtype={getattr(arr, 'dtype', None)}"
        )
        arr = np.clip(np.asarray(audio, dtype=np.float64), -1.0, 1.0)
        pcm = (arr * 32767.0).astype(np.int16)
        if pcm.ndim > 1:
            pcm = pcm.reshape(-1)
        with wave.open(str(p), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(int(sample_rate))
            wf.writeframes(pcm.tobytes())
        vlog(f"wrote wav sr={sample_rate} samples={pcm.shape[0]}")

    def playback_numpy(audio, sample_rate: int, args) -> None:
        import sounddevice as sd

        try:
            print(sd.query_devices(), flush=True)
        except Exception:
            pass

        out_idx = pick_output_device(sd, args.device_name)
        if out_idx < 0:
            raise RuntimeError("no output device found")
        selected_by = "name"
        forced_id = None
        if str(args.device_id or "").strip():
            try:
                id_candidate = int(str(args.device_id).strip())
                dev = sd.query_devices(id_candidate)
                if int(dev.get("max_output_channels", 0)) > 0:
                    out_idx = id_candidate
                    forced_id = id_candidate
                    selected_by = "id"
            except Exception as id_err:
                print(f"[voice] VOICE_DEVICE_ID invalid/unavailable: {id_err}", flush=True)

        dev_name = str(sd.query_devices(out_idx).get("name", "unknown"))
        if selected_by == "id":
            print(f"\033[1mSELECTED DEVICE: {forced_id}\033[0m", flush=True)
        print(f"\033[1mSELECTED DEVICE: [{out_idx}] {dev_name}\033[0m", flush=True)

        try:
            sd.play(
                audio,
                samplerate=sample_rate,
                device=(forced_id if forced_id is not None else out_idx),
                blocking=True,
            )
            sd.stop()
        except Exception as play_err:
            if selected_by == "id":
                fallback_idx = pick_output_device(sd, "CABLE Input")
                if fallback_idx >= 0 and fallback_idx != out_idx:
                    fb_name = str(sd.query_devices(fallback_idx).get("name", "unknown"))
                    print(f"[voice] retry on CABLE Input fallback: [{fallback_idx}] {fb_name}", flush=True)
                    print(f"\033[1mSELECTED DEVICE: [{fallback_idx}] {fb_name}\033[0m", flush=True)
                    sd.play(audio, samplerate=sample_rate, device=fallback_idx, blocking=True)
                    sd.stop()
                else:
                    raise RuntimeError(
                        f"device busy/unavailable [{out_idx}] {dev_name}: {play_err}"
                    ) from play_err
            else:
                raise RuntimeError(
                    f"device busy/unavailable [{out_idx}] {dev_name}: {play_err}"
                ) from play_err

    def run_server(args) -> int:
        # stdin уже обёрнут в UTF-8 TextIOWrapper в main() — не дублировать:
        # повторный TextIOWrapper(stdin.buffer) на Windows закрывает нижний поток (readline → closed file).
        vlog("server mode: loading Silero (once)...")
        try:
            import torch
        except Exception as exc:
            pyv = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
            return fail(
                "imports failed: "
                f"{exc}. Python={pyv}. "
                "Install deps in same interpreter: pip install torch numpy"
            )

        try:
            model = load_silero_model_cpu(torch, args)
        except Exception as exc:
            details = traceback.format_exc()
            try:
                print(json.dumps({"ready": False, "error": str(exc)[:800]}), flush=True)
            except Exception:
                pass
            return fail(f"silero load failed: {exc}\n{details}")

        print(json.dumps({"ready": True}), flush=True)

        try:
            import sounddevice as sd  # noqa: F401
            sd_available = True
        except Exception:
            sd_available = False

        while True:
            line = sys.stdin.readline()
            if line == "":
                break
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError:
                print(json.dumps({"ok": False, "error": "invalid_json"}), flush=True)
                continue

            wav_path = str(req.get("wav") or "").strip()
            raw_text = req.get("text", "")
            if not isinstance(raw_text, str):
                raw_text = str(raw_text)

            text = clean_text(raw_text)
            text = transliterate_latin_for_russian_tts(text)
            if not text:
                print(json.dumps({"ok": True, "skipped": True}), flush=True)
                continue

            try:
                audio, sample_rate = synthesize_numpy(model, args, text)
            except ValueError as ve:
                vlog(
                    "apply_tts ValueError (silero treats text as empty/invalid): "
                    f"{ve!r} text_len={len(text)} text_preview={preview_repr(text, 300)}"
                )
                print(json.dumps({"ok": True, "skipped": True}), flush=True)
                continue
            except Exception as exc:
                print(json.dumps({"ok": False, "error": str(exc)[:800]}), flush=True)
                continue

            try:
                if wav_path:
                    write_wav_path(wav_path, audio, sample_rate)
                else:
                    if not sd_available:
                        print(
                            json.dumps({"ok": False, "error": "sounddevice not available (install or pass wav path)"}),
                            flush=True,
                        )
                        continue
                    playback_numpy(audio, sample_rate, args)
                print(json.dumps({"ok": True}), flush=True)
            except Exception as exc:
                vlog(traceback.format_exc())
                print(json.dumps({"ok": False, "error": str(exc)[:800]}), flush=True)

        vlog("server stdin EOF, exiting")
        return 0

    def main() -> int:
        # Windows: иначе stdin часто cp1252; Node шлёт UTF-8 — читать байты как utf-8 до любого read().
        if getattr(sys.stdin, "buffer", None) is not None:
            sys.stdin = io.TextIOWrapper(
                sys.stdin.buffer,
                encoding="utf-8",
                errors="replace",
            )

        parser = argparse.ArgumentParser()
        parser.add_argument("--voice", default="aidar")
        parser.add_argument("--model", default="v5_ru")
        parser.add_argument("--sample-rate", type=int, default=48000)
        parser.add_argument("--device-name", default="CABLE Input")
        parser.add_argument("--device-id", default="")
        parser.add_argument(
            "--output-wav",
            dest="output_wav",
            default="",
            help="If set, write 16-bit mono PCM WAV here and skip sounddevice playback.",
        )
        parser.add_argument(
            "--server",
            action="store_true",
            help="Long-lived mode: load model once, then one JSON request per stdin line.",
        )
        args = parser.parse_args()

        vlog(f"argv={sys.argv!r}")
        if args.server:
            return run_server(args)

        vlog(f"stdin encoding={getattr(sys.stdin, 'encoding', None)!r} output_wav={str(args.output_wav or '').strip()!r}")

        raw_stdin = sys.stdin.read()
        vlog(
            f"stdin read: len={len(raw_stdin)} "
            f"bytes_utf8={len(raw_stdin.encode('utf-8', errors='replace'))} "
            f"preview={preview_repr(raw_stdin)}"
        )

        text = clean_text(raw_stdin)
        text = transliterate_latin_for_russian_tts(text)
        if not text:
            vlog(f"skip early: clean_text -> empty. {explain_empty_after_clean(raw_stdin, text)}")
            print("Skipping empty or invalid text", flush=True)
            return 0
        vlog(f"tts text after latin->cyr: len={len(text)} preview={preview_repr(text, 200)}")

        try:
            import torch
        except Exception as exc:
            pyv = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
            return fail(
                "imports failed: "
                f"{exc}. Python={pyv}. "
                "Install deps in same interpreter: pip install torch numpy"
            )

        try:
            model = load_silero_model_cpu(torch, args)
        except Exception as exc:
            details = traceback.format_exc()
            return fail(f"silero load failed: {exc}\n{details}")

        try:
            audio, sample_rate = synthesize_numpy(model, args, text)
        except ValueError as ve:
            vlog(
                "apply_tts raised ValueError (silero treats text as empty/invalid): "
                f"{ve!r} text_len={len(text)} text_preview={preview_repr(text, 300)}"
            )
            print("Skipping empty or invalid text", flush=True)
            return 0
        except Exception as exc:
            details = traceback.format_exc()
            return fail(f"tts failed: {exc}\n{details}")

        out_path = str(args.output_wav or "").strip()
        if out_path:
            try:
                write_wav_path(out_path, audio, sample_rate)
            except Exception as exc:
                details = traceback.format_exc()
                return fail(f"wav write failed: {exc}\n{details}")
            print(f"[voice] wrote wav {out_path} sr={sample_rate}", flush=True)
            print("[voice] ok", flush=True)
            return 0

        try:
            import sounddevice as sd
        except Exception as exc:
            return fail(f"sounddevice import failed (need playback or use --output-wav): {exc}")

        try:
            playback_numpy(audio, sample_rate, args)
        except Exception as exc:
            details = traceback.format_exc()
            return fail(f"playback failed: {exc}\n{details}")

        print("[voice] ok", flush=True)
        return 0

    if __name__ == "__main__":
        raise SystemExit(main())

except Exception:
    import traceback
    traceback.print_exc()
    raise
