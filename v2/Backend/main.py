from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import os
import re
import json
import tempfile
import shutil
import logging
import subprocess
from pathlib import Path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Lyrixsync")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SEPARATED_DIR = Path("separated")
SEPARATED_DIR.mkdir(exist_ok=True)
app.mount("/files", StaticFiles(directory=str(SEPARATED_DIR)), name="files")

LYRICS_DIR = Path("lyrics")
LYRICS_DIR.mkdir(exist_ok=True)

DEMUCS_MODEL = "htdemucs"


def stem_cache_key(filename: str) -> str:
    name = Path(filename).stem
    return re.sub(r"[^\w]", "_", name.lower()).strip("_")


def lyrics_cache_path(cache_key: str) -> Path:
    return LYRICS_DIR / f"{cache_key}.json"


def run_demucs(input_path: str, output_dir: Path, cache_key: str) -> dict:
    stem_dir = output_dir / DEMUCS_MODEL / cache_key
    vocals_path = stem_dir / "vocals.mp3"
    instruments_path = stem_dir / "instruments.mp3"

    if vocals_path.exists() and instruments_path.exists():
        logger.info(f"[demucs] Cache hit for '{cache_key}' — skipping separation")
        return {
            "vocals": str(vocals_path),
            "instruments": str(instruments_path),
            "track_name": cache_key,
        }

    logger.info(f"[demucs] No cache for '{cache_key}' — running separation")

    tmp_out = output_dir / "_tmp_demucs"
    cmd = [
        "python", "-m", "demucs",
        "--two-stems", "vocals",
        "--mp3",
        "-n", DEMUCS_MODEL,
        "-o", str(tmp_out),
        input_path,
    ]

    logger.info(f"Demucs command: {' '.join(cmd)}")

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    for line in proc.stdout:
        line = line.rstrip()
        if line:
            logger.info(f"[demucs] {line}")

    proc.wait()
    logger.info(f"Demucs exit code: {proc.returncode}")

    if proc.returncode != 0:
        raise RuntimeError(f"Demucs failed with exit code {proc.returncode}")

    input_stem = Path(input_path).stem
    raw_dir = tmp_out / DEMUCS_MODEL / input_stem

    stem_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(raw_dir / "vocals.mp3"), str(vocals_path))
    shutil.move(str(raw_dir / "no_vocals.mp3"), str(instruments_path))

    try:
        shutil.rmtree(str(tmp_out))
    except Exception as e:
        logger.warning(f"Could not clean up tmp demucs folder: {e}")

    logger.info(f"Vocals: {vocals_path} (exists: {vocals_path.exists()})")
    logger.info(f"Instruments: {instruments_path} (exists: {instruments_path.exists()})")

    return {
        "vocals": str(vocals_path),
        "instruments": str(instruments_path),
        "track_name": cache_key,
    }


def forced_align(audio_path: str, lyrics_lines: list[str]) -> list[dict]:
    import stable_whisper

    logger.info("[stable-ts] Loading model...")
    model = stable_whisper.load_model("medium")

    full_text = "\n".join(lyrics_lines)

    logger.info(f"[stable-ts] Starting forced alignment on: {audio_path}")
    logger.info(f"[stable-ts] Lyrics lines: {len(lyrics_lines)}")

    result = model.align(audio_path, full_text, language="en")

    logger.info("[stable-ts] Alignment complete")

    word_segments = []
    for segment in result.segments:
        for word in segment.words:
            word_segments.append({
                "word": word.word.strip(),
                "start": round(word.start, 3),
                "end": round(word.end, 3),
            })

    logger.info(f"[stable-ts] Word segments: {len(word_segments)}")
    if word_segments:
        logger.info(f"[stable-ts] First 5: {word_segments[:5]}")
        logger.info(f"[stable-ts] Last 5: {word_segments[-5:]}")

    return word_segments


def stitch_lines(lyrics_lines: list[str], word_segments: list[dict]) -> list[dict]:
    synced_lines = []
    word_index = 0

    for raw_line in lyrics_lines:
        is_ghost = raw_line.strip().startswith("(") and raw_line.strip().endswith(")")
        clean_line = raw_line.strip().strip("()")
        line_words = clean_line.split()
        word_count = len(line_words)

        matched_words = []
        for i in range(word_count):
            if word_index < len(word_segments):
                seg = word_segments[word_index]
                matched_words.append({
                    "word": line_words[i],
                    "start": seg["start"],
                    "end": seg["end"],
                })
                word_index += 1
            else:
                matched_words.append({
                    "word": line_words[i],
                    "start": None,
                    "end": None,
                })

        timestamp = matched_words[0]["start"] if matched_words and matched_words[0]["start"] is not None else None

        synced_lines.append({
            "timestamp": timestamp,
            "line": raw_line.strip(),
            "ghost": is_ghost,
            "words": matched_words,
            "punches": [],
        })

    logger.info(f"[stitch] {len(synced_lines)} lines stitched, {word_index} words consumed")
    matched_count = sum(1 for l in synced_lines if l["timestamp"] is not None)
    logger.info(f"[stitch] Lines with timestamps: {matched_count}/{len(synced_lines)}")

    return synced_lines


def sse_event(data: dict) -> str:
    return f"data: {json.dumps(data)}\n\n"


@app.post("/process")
async def process(
    file: UploadFile = File(...),
    lyrics: str = Form(...),
):
    import asyncio

    logger.info(f"[/process] Received: {file.filename}")
    lyrics_lines = [l for l in lyrics.split("\n") if l.strip()]
    logger.info(f"[/process] Lyrics lines: {len(lyrics_lines)}")

    cache_key = stem_cache_key(file.filename)
    logger.info(f"[/process] Cache key: {cache_key}")

    lyrics_path = lyrics_cache_path(cache_key)
    has_lyrics_cache = lyrics_path.exists()

    suffix = Path(file.filename).suffix
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name

    logger.info(f"[/process] Saved to: {tmp_path}")

    async def generate():
        try:
            loop = asyncio.get_event_loop()

            # Phase 1: Demucs (runs in thread — logs progress, doesn't block SSE)
            yield sse_event({"phase": "separating"})

            stems = await loop.run_in_executor(
                None,
                lambda: run_demucs(tmp_path, SEPARATED_DIR, cache_key)
            )

            vocals_path = stems["vocals"]
            track_name = stems["track_name"]
            base = f"/files/{DEMUCS_MODEL}/{track_name}"
            logger.info(f"[/process] Stems ready. Vocals: {vocals_path}")

            # Stems done — tell frontend to transition to "Syncing..."
            yield sse_event({
                "phase": "aligning",
                "vocals_url": f"{base}/vocals.mp3",
                "no_vocals_url": f"{base}/instruments.mp3",
            })

            # Phase 2: alignment (runs in thread — doesn't block SSE)
            if has_lyrics_cache:
                logger.info(f"[/process] Lyrics cache hit for '{cache_key}' — skipping alignment")
                with open(lyrics_path, "r") as f:
                    synced_lines = json.load(f)
            else:
                logger.info(f"[/process] Starting stable-ts on: {vocals_path}")

                def align_and_stitch():
                    word_segments = forced_align(vocals_path, lyrics_lines)
                    return stitch_lines(lyrics_lines, word_segments)

                synced_lines = await loop.run_in_executor(None, align_and_stitch)

                with open(lyrics_path, "w") as f:
                    json.dump(synced_lines, f)
                logger.info(f"[/process] Lyrics cache saved: {lyrics_path}")

            logger.info(f"[/process] Complete. {len(synced_lines)} lines synced.")
            yield sse_event({
                "phase": "done",
                "vocals_url": f"{base}/vocals.mp3",
                "no_vocals_url": f"{base}/instruments.mp3",
                "synced_lines": synced_lines,
            })

        except Exception as e:
            logger.error(f"[/process] Failed: {e}", exc_info=True)
            yield sse_event({"phase": "error", "message": str(e)})
        finally:
            try:
                os.unlink(tmp_path)
                logger.info(f"[/process] Temp file deleted: {tmp_path}")
            except Exception:
                pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)