# -*- coding: utf-8 -*-
# 各カードの音声(英語+日本語)を1つのMP3に結合して audio/<id>.mp3 に出力
import asyncio, io, json, os, subprocess
import edge_tts
import imageio_ffmpeg
from pydub import AudioSegment

FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
AudioSegment.converter = FFMPEG   # export 用

EN_VOICE = "en-US-AriaNeural"
JA_VOICE = "ja-JP-NanamiNeural"
RATE = "-8%"
SR = 24000                        # edge-tts は 24kHz mono
OUT_DIR = "audio"
SEM = asyncio.Semaphore(8)

os.makedirs(OUT_DIR, exist_ok=True)

def mp3_to_segment(mp3_bytes):
    # ffprobe を使わず ffmpeg で mp3 -> 生PCM(s16le) にデコード
    p = subprocess.run(
        [FFMPEG, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
         "-f", "s16le", "-ar", str(SR), "-ac", "1", "pipe:1"],
        input=mp3_bytes, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return AudioSegment(data=p.stdout, sample_width=2, frame_rate=SR, channels=1)

async def synth(text, voice):
    async with SEM:
        buf = bytearray()
        for _ in range(3):
            try:
                buf = bytearray()
                c = edge_tts.Communicate(text, voice, rate=RATE)
                async for chunk in c.stream():
                    if chunk["type"] == "audio":
                        buf += chunk["data"]
                if buf:
                    break
            except Exception:
                await asyncio.sleep(1.5)
        return mp3_to_segment(bytes(buf))

def sil(ms):
    return AudioSegment.silent(duration=ms, frame_rate=SR)

async def build_card(card):
    path = os.path.join(OUT_DIR, card["id"] + ".mp3")
    if os.path.exists(path) and os.path.getsize(path) > 500:
        return "skip"
    segs = []
    if card["type"] == "vocab" and card["head"]:
        segs.append((card["head"], EN_VOICE, 500))
    segs.append((card["jp"].replace("〜", "なになに"), JA_VOICE, 450))
    for i, ex in enumerate(card["exs"]):
        segs.append((ex, EN_VOICE, 650 if i < len(card["exs"]) - 1 else 250))

    audios = await asyncio.gather(*[synth(t, v) for (t, v, _g) in segs])
    combined = sil(150)
    for (audio, (_t, _v, gap)) in zip(audios, segs):
        combined += audio + sil(gap)
    combined.export(path, format="mp3", bitrate="48k")
    return "ok"

async def main():
    cards = json.load(open("_audio_manifest.json", encoding="utf-8"))
    done = 0
    for coro in asyncio.as_completed([build_card(c) for c in cards]):
        await coro
        done += 1
        if done % 20 == 0 or done == len(cards):
            print(f"{done}/{len(cards)}", flush=True)
    print("ALL DONE", flush=True)

if __name__ == "__main__":
    asyncio.run(main())
