"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { RotateCcw, RotateCw } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = "idle" | "uploading" | "syncing" | "annotating" | "done" | "error";

type TranslateLanguage = "french" | "english" | "spanish" | "german" | "dutch" | "polish";

const LANGUAGE_LABELS: Record<TranslateLanguage, string> = {
  french: "French",
  english: "English",
  spanish: "Spanish",
  german: "German",
  dutch: "Dutch",
  polish: "Polish",
};

export interface SyncedWord {
  word: string;
  start: number | null;
}

export interface SyncedLine {
  timestamp: number | null;
  line: string;
  ghost: boolean;
  words: SyncedWord[] | null;
  punches: [];
}

// ---------------------------------------------------------------------------
// Metadata helpers — iTunes Search API
// ---------------------------------------------------------------------------

interface ItunesMetadata {
  title: string;
  artist: string;
  album: string;
  artworkURL: string | null;
}

function parseFilename(filename: string): string {
  const base = filename.replace(/\.[^/.]+$/, "").trim();
  return base.replace(/^\d+[\s.\-]+/, "").trim();
}

async function fetchItunesMetadata(filename: string): Promise<ItunesMetadata | null> {
  const term = parseFilename(filename);
  if (!term) return null;
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term, media: "music", entity: "song", limit: "5" })}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json() as {
    resultCount: number;
    results: Array<{ trackName: string; artistName: string; collectionName: string; artworkUrl100?: string }>;
  };
  if (!data.resultCount || data.results.length === 0) return null;
  const best = data.results[0]!;
  const artworkURL = best.artworkUrl100 ? best.artworkUrl100.replace("100x100bb", "3000x3000bb") : null;
  return { title: best.trackName, artist: best.artistName, album: best.collectionName, artworkURL };
}

// ---------------------------------------------------------------------------
// Lyrics helper — lrclib.net
// ---------------------------------------------------------------------------

async function fetchLrclibLyrics(title: string, artist: string): Promise<string | null> {
  const url = `https://lrclib.net/api/get?${new URLSearchParams({ track_name: title, artist_name: artist })}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json() as { plainLyrics?: string | null; instrumental?: boolean };
  if (data.instrumental) return null;
  return data.plainLyrics ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLyrics(raw: string): SyncedLine[] {
  return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => ({
    timestamp: null, line, ghost: /^\(.*\)$/.test(line), words: null, punches: [],
  }));
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res((r.result as string).split(",")[1]!);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function getActiveIndex(lines: SyncedLine[], time: number) {
  let active = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.timestamp !== null && lines[i]!.timestamp! <= time) active = i;
  }
  return active;
}

function letterOpacity(w: SyncedWord, t: number, li: number, lc: number, nextWordStart: number | null): number {
  if (w.start === null) return 0;
  const sweepEnd = nextWordStart ?? w.start + 0.35;
  const fullDur = Math.max(sweepEnd - w.start, 0.05);
  const letterStart = w.start + (li / Math.max(lc, 1)) * fullDur;
  const letterDur = fullDur / Math.max(lc, 1);
  const progress = (t - letterStart) / letterDur;
  return Math.max(0, Math.min(1, progress));
}

function letterGlowPulse(w: SyncedWord, t: number, li: number, lc: number, nextWordStart: number | null): number {
  if (w.start === null) return 0;
  const sweepEnd = nextWordStart ?? w.start + 0.35;
  const fullDur = Math.max(sweepEnd - w.start, 0.05);
  const letterStart = w.start + (li / Math.max(lc, 1)) * fullDur;
  const letterDur = fullDur / Math.max(lc, 1);
  const progress = (t - letterStart) / letterDur;
  const x = progress - 1;
  return Math.exp(-(x * x) / (2 * 0.55 * 0.55));
}

async function gemini(audiob64: string, mime: string, prompt: string) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.NEXT_PUBLIC_GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mime, data: audiob64 } }, { text: prompt }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 65536 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  if (data?.candidates?.[0]?.finishReason === "MAX_TOKENS") throw new Error("Response too long — try a shorter song.");
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return JSON.parse(text.replace(/```json|```/gi, "").trim());
}

async function geminiText(prompt: string) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.NEXT_PUBLIC_GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 16384 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return JSON.parse(text.replace(/```json|```/gi, "").trim());
}

async function syncLines(audiob64: string, mime: string, lines: SyncedLine[]): Promise<SyncedLine[]> {
  const payload = lines.map((l, i) => ({ lineIndex: i, line: l.line, ghost: l.ghost }));

  console.log("🎵 [SYNC] Sending lines to Gemini for timestamp sync:");
  console.log(`   Total lines: ${payload.length}`);
  console.table(payload.map(l => ({ lineIndex: l.lineIndex, ghost: l.ghost, line: l.line })));

  const result = await gemini(audiob64, mime, `You are a lyric sync assistant. Listen to the audio and find exactly when each vocal line begins.\n\nReturn a timestamp (seconds, 2 decimal places) for every line including ghost lines. Timestamps must be ascending.\n\nRespond ONLY with raw JSON, no markdown:\n[{ "lineIndex": 0, "timestamp": 11.44 }]\n\nLines:\n${JSON.stringify(payload, null, 2)}`) as Array<{ lineIndex: number; timestamp: number }>;

  console.log("✅ [SYNC] Raw result from Gemini (synced timestamps):");
  console.log(JSON.stringify(result, null, 2));
  console.log(`   Lines returned: ${result.length} / ${lines.length}`);

  const synced = lines.map((l, i) => {
    const match = result.find((r) => r.lineIndex === i);
    return match ? { ...l, timestamp: match.timestamp } : l;
  });

  const missing = synced.filter(l => l.timestamp === null);
  if (missing.length > 0) {
    console.warn(`⚠️ [SYNC] ${missing.length} lines have no timestamp:`, missing.map(l => l.line));
  }

  console.log("📋 [SYNC] Final synced lines:");
  console.table(synced.map((l, i) => ({ index: i, timestamp: l.timestamp, ghost: l.ghost, line: l.line })));

  return synced;
}

async function annotateWords(audiob64: string, mime: string, lines: SyncedLine[]): Promise<SyncedLine[]> {
  // Only send non-ghost lines. We do NOT echo words back — Gemini returns only
  // an array of start times per line (lean output), and we zip them against the
  // words we already have. This roughly halves the output token count vs the
  // previous approach, preventing silent mid-array truncation.
  const payload = lines
    .map((l, i) => ({
      lineIndex: i,
      timestamp: l.timestamp,
      wordCount: l.line.split(/\s+/).filter(Boolean).length,
      line: l.line,
    }))
    .filter((_, i) => !lines[i]!.ghost);

  console.log("🔤 [ANNOTATE] Sending lean payload to Gemini (starts-only, no word echo):");
  console.log(`   Non-ghost lines: ${payload.length}`);
  console.table(payload.map(l => ({ lineIndex: l.lineIndex, timestamp: l.timestamp, wordCount: l.wordCount, line: l.line })));

  // Gemini returns ONLY the start times as a flat array per line — no word strings.
  // e.g. [{ "lineIndex": 0, "starts": [3.3, 3.55, 3.7, 3.8, 4.25] }]
  const result = await gemini(
    audiob64,
    mime,
    `You are a lyric word timing assistant. Listen to the audio and find exactly when each word begins.\n\nFor each line I give you, return ONLY an array of start times (seconds, 2 decimal places) — one number per word, in order. Do NOT repeat the words back.\n\nRules:\n- One start time per word, in the same order as the words in the line\n- Timestamps within a line must be ascending\n- The number of start times must exactly match the wordCount for that line\n- Ghost lines are excluded — they are not in this list\n\nRespond ONLY with raw JSON, no markdown:\n[{ "lineIndex": 0, "starts": [3.3, 3.55, 3.7] }]\n\nLines:\n${JSON.stringify(payload, null, 2)}`
  ) as Array<{ lineIndex: number; starts: number[] }>;

  console.log("✅ [ANNOTATE] Raw result from Gemini (starts-only):");
  console.log(JSON.stringify(result, null, 2));
  console.log(`   Lines with data returned: ${result.length} / ${payload.length}`);

  // Check for missing lines
  const returnedIndexes = new Set(result.map(r => r.lineIndex));
  const missingAnnotations = payload.filter(p => !returnedIndexes.has(p.lineIndex));
  if (missingAnnotations.length > 0) {
    console.warn(`⚠️ [ANNOTATE] Missing annotations for line indexes:`, missingAnnotations.map(l => l.lineIndex));
    missingAnnotations.forEach(l => console.warn(`   Line ${l.lineIndex} (ts: ${l.timestamp}): "${l.line}"`));
  }

  // Zip start times back against the original words
  const annotated = lines.map((line, i) => {
    if (line.ghost) return line;
    const match = result.find(r => r.lineIndex === i);
    if (!match) return line;
    const words = line.line.split(/\s+/).filter(Boolean);
    if (match.starts.length !== words.length) {
      console.warn(`⚠️ [ANNOTATE] Line ${i} word count mismatch: expected ${words.length}, got ${match.starts.length} starts — "${line.line}"`);
    }
    return {
      ...line,
      words: words.map((word, wi) => ({
        word,
        start: match.starts[wi] ?? null,
      })) as SyncedWord[],
    };
  });

  console.log("📋 [ANNOTATE] Final annotated lines summary:");
  annotated.forEach((l, i) => {
    if (!l.ghost) {
      console.log(`   Line ${i} (ts: ${l.timestamp}) "${l.line}" → ${l.words?.length ?? 0} words annotated`);
      if (l.words && l.words.length > 0) {
        const first = l.words[0];
        const last = l.words[l.words.length - 1];
        console.log(`      first: "${first?.word}" @ ${first?.start}s  last: "${last?.word}" @ ${last?.start}s`);
      }
    }
  });

  return annotated;
}

async function translateLyrics(lines: SyncedLine[], language: TranslateLanguage): Promise<string[]> {
  const payload = lines.map((l, i) => ({ lineIndex: i, line: l.line }));
  const result = await geminiText(
    `You are a song lyrics translator. Translate each line of the following lyrics into ${LANGUAGE_LABELS[language]}.\n\nPreserve the line count exactly — one translated line per input line, in the same order. Keep the poetic and emotional feel of the original as much as possible. For ghost lines (background/parenthetical), translate them as-is without the parentheses.\n\nRespond ONLY with raw JSON, no markdown:\n[{ "lineIndex": 0, "translated": "Bonjour le monde" }]\n\nLines:\n${JSON.stringify(payload, null, 2)}`
  ) as Array<{ lineIndex: number; translated: string }>;
  return lines.map((_, i) => {
    const match = result.find((r) => r.lineIndex === i);
    return match?.translated ?? "";
  });
}

// ---------------------------------------------------------------------------
// WavyText
// ---------------------------------------------------------------------------

const GLOBAL_CSS = `
@keyframes lx-bounce {
  0%, 100% { transform: translateY(0px); opacity: 0.4; }
  40% { transform: translateY(-5px); opacity: 1; }
  60% { transform: translateY(-5px); opacity: 1; }
}
@keyframes lxpulse {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.8); }
  40% { opacity: 0.6; transform: scale(1); }
}
@keyframes lx-fade-in {
  from { opacity: 0; transform: translateY(6px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0px) scale(1); }
}
`;

const LETTER_DUR = 0.08;
const LETTER_GAP = 0;
const LOOP_PAUSE = 0.3;

function WavyText({ text, color = "rgba(255,255,255,0.5)" }: { text: string; color?: string }) {
  const chars = text.split("");
  const nonSpaceCount = chars.filter((c) => c !== " ").length;
  const cycleDuration = nonSpaceCount * (LETTER_DUR + LETTER_GAP) + LOOP_PAUSE;

  let letterIndex = 0;
  return (
    <>
      <style>{GLOBAL_CSS}</style>
      <span className="inline-flex items-end gap-0 font-mono tracking-[0.08em] text-[13px]" style={{ color }}>
        {chars.map((ch, i) => {
          if (ch === " ") {
            return <span key={i} style={{ display: "inline-block", width: "0.35em" }} />;
          }
          const myDelay = letterIndex * (LETTER_DUR + LETTER_GAP);
          letterIndex++;
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                animation: `lx-bounce ${cycleDuration}s ease-in-out ${myDelay}s infinite`,
                opacity: 0.4,
              }}
            >
              {ch}
            </span>
          );
        })}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------
// AnimatedWord
// ---------------------------------------------------------------------------

function AnimatedWord({ word, currentTime, nextWordStart }: { word: SyncedWord; currentTime: number; nextWordStart: number | null }) {
  const letters = word.word.split("");
  const lc = letters.length;

  const pulses = letters.map((_, li) =>
    word.start !== null ? letterGlowPulse(word, currentTime, li, lc, nextWordStart) : 0
  );

  return (
    <span className="inline-block mr-[0.25em]">
      {letters.map((letter, li) => {
        const opacity = word.start !== null ? letterOpacity(word, currentTime, li, lc, nextWordStart) : 0;
        const v = Math.round(160 + (255 - 160) * opacity);

        let ripple = 0;
        for (let ni = 0; ni < lc; ni++) {
          const d = Math.abs(li - ni);
          const falloff = Math.exp(-(d * d) / 0.72);
          ripple += (pulses[ni] ?? 0) * falloff;
        }
        ripple = Math.min(ripple, 1);

        const scale = 1 + 0.15 * ripple;
        const glowOpacity = ripple * 0.20;
        const glowBlur = 4 + ripple * 8;
        const textShadow = ripple > 0.02
          ? `0 0 ${glowBlur}px rgba(255,255,255,${glowOpacity})`
          : "none";

        return (
          <span
            key={li}
            style={{
              color: `rgb(${v},${v},${v})`,
              transform: `scale(${scale})`,
              textShadow,
              display: "inline-block",
              transition: "color 0.04s linear",
            }}
            className="leading-none align-middle"
          >
            {letter}
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// LanguageSelector — custom floating pill UI
// ---------------------------------------------------------------------------

function LanguageSelector({
  selectedLanguage,
  translating,
  onSelect,
  onClear,
}: {
  selectedLanguage: TranslateLanguage | "";
  translating: boolean;
  onSelect: (lang: TranslateLanguage | "") => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const label = selectedLanguage ? LANGUAGE_LABELS[selectedLanguage] : "translate";

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      {/* Spinner dots when translating */}
      {translating && (
        <div className="flex gap-[3px] items-center">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-[3px] h-[3px] rounded-full bg-white/30"
              style={{ animation: "lxpulse 1.2s ease-in-out infinite", animationDelay: `${i * 0.2}s` }}
            />
          ))}
        </div>
      )}

      {/* Trigger pill */}
      <button
        onClick={() => { if (!translating) setOpen((o) => !o); }}
        disabled={translating}
        className="flex items-center gap-[5px] px-[10px] py-[5px] rounded-full border transition-all duration-150 cursor-pointer"
        style={{
          background: selectedLanguage ? "rgba(255,255,255,0.08)" : "transparent",
          borderColor: selectedLanguage ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.1)",
          opacity: translating ? 0.4 : 1,
        }}
      >
        {/* Globe icon */}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span
          className="text-[11px] font-mono tracking-[0.07em]"
          style={{ color: selectedLanguage ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.25)" }}
        >
          {label}
        </span>
        {/* Chevron */}
        {!selectedLanguage && (
          <svg
            width="8" height="8" viewBox="0 0 24 24" fill="none"
            stroke="rgba(255,255,255,0.2)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s ease" }}
          >
            <polyline points="6,9 12,15 18,9" />
          </svg>
        )}
      </button>

      {/* Clear button */}
      {selectedLanguage && !translating && (
        <button
          onClick={onClear}
          className="w-[18px] h-[18px] rounded-full border border-white/[0.1] flex items-center justify-center cursor-pointer transition-all duration-150 hover:border-white/25 hover:bg-white/[0.06]"
        >
          <svg width="7" height="7" viewBox="0 0 10 10" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.8" strokeLinecap="round">
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      )}

      {/* Dropdown */}
      {open && (
        <div
          className="absolute bottom-full right-0 mb-[8px] rounded-[10px] overflow-hidden border border-white/[0.08]"
          style={{
            background: "rgba(18,18,20,0.96)",
            backdropFilter: "blur(20px)",
            boxShadow: "0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
            minWidth: "130px",
            animation: "lx-fade-in 0.15s ease-out forwards",
          }}
        >
          {(Object.entries(LANGUAGE_LABELS) as [TranslateLanguage, string][]).map(([val, lbl], idx) => {
            const isActive = val === selectedLanguage;
            return (
              <button
                key={val}
                onClick={() => { onSelect(val); setOpen(false); }}
                className="w-full text-left px-[13px] py-[8px] flex items-center justify-between gap-3 cursor-pointer transition-colors duration-100"
                style={{
                  background: isActive ? "rgba(255,255,255,0.06)" : "transparent",
                  borderBottom: idx < Object.keys(LANGUAGE_LABELS).length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                }}
                onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
              >
                <span
                  className="text-[12px] font-mono tracking-[0.05em]"
                  style={{ color: isActive ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.45)" }}
                >
                  {lbl}
                </span>
                {isActive && (
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20,6 9,17 4,12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function HomePage() {
  const audioInputRef = useRef<HTMLInputElement>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const lyricsContainerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const backIconRef = useRef<HTMLSpanElement>(null);
  const fwdIconRef = useRef<HTMLSpanElement>(null);

  // Scrubber refs — driven imperatively to avoid RAF/state race
  const progressBarRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const currentTimeDisplayRef = useRef<HTMLSpanElement>(null);

  // Audio / cover
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioURL, setAudioURL] = useState<string | null>(null);
  const [coverURL, setCoverURL] = useState<string | null>(null);
  const [trackTitle, setTrackTitle] = useState<string>("");
  const [trackArtist, setTrackArtist] = useState<string>("");

  // Lyrics
  const [rawLyrics, setRawLyrics] = useState("");
  const [savedLyrics, setSavedLyrics] = useState<SyncedLine[]>([]);
  const [lyricsSaved, setLyricsSaved] = useState(false);

  // Phase / errors
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [metaFetching, setMetaFetching] = useState(false);

  // Playback
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Translation
  const [selectedLanguage, setSelectedLanguage] = useState<TranslateLanguage | "">("");
  const [translatedLines, setTranslatedLines] = useState<string[] | null>(null);
  const [translating, setTranslating] = useState(false);

  const isProcessing = phase === "uploading" || phase === "syncing" || phase === "annotating";
  const activeLineIndex = lyricsSaved ? getActiveIndex(savedLyrics, currentTime) : -1;

  const wavyLabel: string | null =
    metaFetching ? "Searching for lyrics..." :
    phase === "uploading" ? "Listening..." :
    phase === "syncing" ? "Syncing lyrics..." :
    phase === "annotating" ? "Annotating lyrics..." :
    null;

  // ---------------------------------------------------------------------------
  // Reset everything
  // ---------------------------------------------------------------------------

  const resetAll = useCallback(() => {
    if (audioURL) URL.revokeObjectURL(audioURL);
    setAudioFile(null);
    setAudioURL(null);
    setCoverURL(null);
    setTrackTitle("");
    setTrackArtist("");
    setRawLyrics("");
    setSavedLyrics([]);
    setLyricsSaved(false);
    setPhase("idle");
    setErrorMsg(null);
    setMetaFetching(false);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setSelectedLanguage("");
    setTranslatedLines(null);
    setTranslating(false);
    if (progressBarRef.current) progressBarRef.current.style.width = "0%";
    if (thumbRef.current) thumbRef.current.style.left = "0%";
    if (currentTimeDisplayRef.current) currentTimeDisplayRef.current.textContent = "0:00";
  }, [audioURL]);

  // ---------------------------------------------------------------------------
  // Seek icon animation
  // ---------------------------------------------------------------------------

  const animateSeekIcon = (ref: React.RefObject<HTMLSpanElement>, deg: number) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = "transform 0.12s ease-out";
    el.style.transform = `rotate(${deg}deg)`;
    setTimeout(() => {
      el.style.transition = "transform 0.18s ease-in-out";
      el.style.transform = "rotate(0deg)";
    }, 120);
  };

  // ---------------------------------------------------------------------------
  // Auto-scroll active line
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!lyricsSaved || activeLineIndex < 0) return;
    const container = lyricsContainerRef.current;
    const lineEl = lineRefs.current[activeLineIndex];
    if (!container || !lineEl) return;
    const lineCenter = lineEl.offsetTop + lineEl.offsetHeight / 2;
    container.scrollTo({ top: lineCenter - container.clientHeight / 2, behavior: "smooth" });
  }, [activeLineIndex, lyricsSaved]);

  // ---------------------------------------------------------------------------
  // Audio events
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onMeta = () => setDuration(a.duration);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("loadedmetadata", onMeta);
    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("loadedmetadata", onMeta);
    };
  }, [audioURL]);

  // ---------------------------------------------------------------------------
  // RAF loop
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let rafId: number;
    const tick = () => {
      const a = audioRef.current;
      if (a && a.duration) {
        const t = a.currentTime;
        const pct = (t / a.duration) * 100;
        if (progressBarRef.current) progressBarRef.current.style.width = `${pct}%`;
        if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
        if (currentTimeDisplayRef.current) currentTimeDisplayRef.current.textContent = formatTime(t);
        setCurrentTime(t);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  // ---------------------------------------------------------------------------
  // Playback controls
  // ---------------------------------------------------------------------------

  const togglePlay = useCallback(() => {
    if (!audioFile) { audioInputRef.current?.click(); return; }
    const a = audioRef.current;
    if (!a) return;
    a.paused ? void a.play() : a.pause();
  }, [audioFile]);

  const seek = useCallback((delta: number, deg?: number, ref?: React.RefObject<HTMLSpanElement>) => {
    const a = audioRef.current;
    if (!a || !audioFile) return;
    a.currentTime = Math.max(0, Math.min(a.duration || 0, a.currentTime + delta));
    if (a.duration) {
      const pct = (a.currentTime / a.duration) * 100;
      if (progressBarRef.current) progressBarRef.current.style.width = `${pct}%`;
      if (thumbRef.current) thumbRef.current.style.left = `${pct}%`;
      if (currentTimeDisplayRef.current) currentTimeDisplayRef.current.textContent = formatTime(a.currentTime);
    }
    setCurrentTime(a.currentTime);
    if (ref && deg !== undefined) animateSeekIcon(ref, deg);
  }, [audioFile]);

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === "Space") { e.preventDefault(); togglePlay(); }
      if (e.code === "ArrowLeft") { e.preventDefault(); seek(-5, -30, backIconRef); }
      if (e.code === "ArrowRight") { e.preventDefault(); seek(5, 30, fwdIconRef); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seek]);

  // ---------------------------------------------------------------------------
  // Translation
  // ---------------------------------------------------------------------------

  const handleLanguageChange = async (lang: TranslateLanguage | "") => {
    setSelectedLanguage(lang);
    if (!lang) { setTranslatedLines(null); return; }
    const linesToTranslate = lyricsSaved ? savedLyrics : parseLyrics(rawLyrics);
    if (linesToTranslate.length === 0) return;
    setTranslating(true);
    try {
      const translated = await translateLyrics(linesToTranslate, lang);
      setTranslatedLines(translated);
    } catch {
      setTranslatedLines(null);
    } finally {
      setTranslating(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Audio upload
  // ---------------------------------------------------------------------------

  const handleAudioUpload = async (file: File) => {
    const url = URL.createObjectURL(file);
    const fallbackTitle = file.name.replace(/\.[^/.]+$/, "");
    setAudioFile(file);
    setAudioURL(url);
    setTrackTitle(fallbackTitle);
    setTrackArtist("");
    setCurrentTime(0);

    setMetaFetching(true);
    try {
      const meta = await fetchItunesMetadata(file.name);
      if (!meta) return;
      const title = meta.title.charAt(0).toUpperCase() + meta.title.slice(1);
      setTrackTitle(title);
      setTrackArtist(meta.artist);
      const lyricsPromise = fetchLrclibLyrics(meta.title, meta.artist);
      if (meta.artworkURL) setCoverURL(meta.artworkURL);
      const lyrics = await lyricsPromise;
      if (lyrics) setRawLyrics((prev) => prev.trim() ? prev : lyrics);
    } catch {
      // silent fallback
    } finally {
      setMetaFetching(false);
    }
  };

  const handleCoverUpload = (file: File) => {
    setCoverURL(URL.createObjectURL(file));
  };

  // ---------------------------------------------------------------------------
  // Seek bar click
  // ---------------------------------------------------------------------------

  const handleSeekBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !a.duration || !audioFile) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    a.currentTime = pct * a.duration;
    const pctStr = `${pct * 100}%`;
    if (progressBarRef.current) progressBarRef.current.style.width = pctStr;
    if (thumbRef.current) thumbRef.current.style.left = pctStr;
    if (currentTimeDisplayRef.current) currentTimeDisplayRef.current.textContent = formatTime(a.currentTime);
    setCurrentTime(a.currentTime);
  };

  // ---------------------------------------------------------------------------
  // Lyric sync
  // ---------------------------------------------------------------------------

  const handleSave = async () => {
    if (!audioFile || !rawLyrics.trim()) return;
    const parsed = parseLyrics(rawLyrics);
    setErrorMsg(null);

    console.log("🚀 [START] Starting lyric sync pipeline");
    console.log(`   Audio file: ${audioFile.name} (${(audioFile.size / 1024 / 1024).toFixed(2)} MB, type: ${audioFile.type})`);
    console.log(`   Total parsed lines: ${parsed.length}`);
    console.table(parsed.map((l, i) => ({ index: i, ghost: l.ghost, line: l.line })));

    try {
      setPhase("uploading");
      const audiob64 = await fileToBase64(audioFile);
      console.log(`📦 [UPLOAD] Audio encoded to base64, length: ${audiob64.length} chars`);

      const mime = audioFile.type || "audio/mpeg";
      console.log(`   MIME type: ${mime}`);

      setPhase("syncing");
      const synced = await syncLines(audiob64, mime, parsed);

      setPhase("annotating");
      const annotated = await annotateWords(audiob64, mime, synced);

      console.log("🎉 [DONE] Pipeline complete. Final annotated lyrics:");
      console.log(JSON.stringify(annotated, null, 2));

      setSavedLyrics(annotated);
      lineRefs.current = new Array(annotated.length).fill(null);
      if (selectedLanguage) {
        setTranslating(true);
        try {
          const translated = await translateLyrics(annotated, selectedLanguage);
          setTranslatedLines(translated);
        } catch {
          setTranslatedLines(null);
        } finally {
          setTranslating(false);
        }
      }
      setLyricsSaved(true);
      setPhase("done");
    } catch (err) {
      console.error("❌ [ERROR] Sync pipeline failed:", err);
      setErrorMsg(err instanceof Error ? err.message : "Something went wrong");
      setPhase("error");
    }
  };

  // ---------------------------------------------------------------------------
  // Google lyrics URL
  // ---------------------------------------------------------------------------

  const googleLyricsURL = (): string => {
    const q = trackTitle && trackArtist
      ? `${trackTitle} by ${trackArtist} lyrics`
      : trackTitle ? `${trackTitle} lyrics` : "lyrics";
    return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  };

  // ---------------------------------------------------------------------------
  // Render saved line
  // ---------------------------------------------------------------------------

  const renderSavedLine = (line: SyncedLine, index: number) => {
    const isActive = index === activeLineIndex;
    const isPast = index < activeLineIndex;
    const isGhost = line.ghost;
    const translatedText = translatedLines?.[index] ?? null;

    let opacity: number;
    if (isActive) opacity = 1;
    else if (Math.abs(index - activeLineIndex) === 1) opacity = 0.35;
    else if (isPast) opacity = 0.18;
    else opacity = 0.25;

    return (
      <div
        key={index}
        ref={(el) => { lineRefs.current[index] = el; }}
        className="py-[10px] transition-all duration-400 ease-in-out"
        style={{ opacity, transform: isActive ? "scale(1)" : "scale(0.97)", transformOrigin: "left center" }}
      >
        {isGhost && (
          <p className="m-0 italic text-white leading-[1.5] tracking-[0.01em]" style={{ fontSize: isActive ? "28px" : "20px", fontWeight: isActive ? 700 : 400 }}>
            {line.line.replace(/[()]/g, "")}
          </p>
        )}
        {!isGhost && (
          <p className="m-0 leading-[1.5] tracking-[-0.01em]" style={{ fontSize: isActive ? "28px" : "24px", fontWeight: isActive ? 700 : 600, color: isActive ? "transparent" : "#ffffff" }}>
            {isActive && line.words && line.words.length > 0 ? (
              <span style={{ fontSize: isActive ? "28px" : "24px", fontWeight: isActive ? 700 : 600 }}>
                {line.words.map((word, wi) => (
                  <AnimatedWord key={wi} word={word} currentTime={currentTime} nextWordStart={line.words?.[wi + 1]?.start ?? null} />
                ))}
              </span>
            ) : line.line}
          </p>
        )}
        {translatedText && (
          <p
            className="m-0 leading-[1.4] tracking-[-0.005em]"
            style={{
              fontSize: isActive ? "22px" : "18px",
              fontWeight: 400,
              color: "rgba(255,255,255,0.60)",
              marginTop: "3px",
              fontStyle: isGhost ? "italic" : "normal",
            }}
          >
            {translatedText}
          </p>
        )}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // JSX
  // ---------------------------------------------------------------------------

  return (
    <main className="h-screen font-sans flex overflow-hidden relative bg-[#0a0a0a]">
      <style>{GLOBAL_CSS}</style>
      {audioURL && <audio ref={audioRef} src={audioURL} preload="metadata" />}

      {/* Blurred cover background */}
      {coverURL && (
        <div className="absolute inset-0 z-0 overflow-hidden">
          <img src={coverURL} alt="" className="w-full h-full object-cover scale-[1.15]" style={{ filter: "blur(80px) saturate(1.4) brightness(0.35)" }} />
          <div className="absolute inset-0 bg-gradient-to-br from-black/55 to-black/30" />
        </div>
      )}

      <div className="relative z-10 flex w-full h-full overflow-hidden">

        {/* ── Left panel ─────────────────────────────────────────────────────── */}
        <div className="w-[400px] shrink-0 flex flex-col p-9 pt-9 pb-7 gap-[18px] bg-transparent">

          {/* Cover art */}
          {!audioFile ? (
            <div className="w-full aspect-square rounded-xl bg-white/[0.03] shrink-0" />
          ) : coverURL ? (
            <div
              onClick={() => coverInputRef.current?.click()}
              className="w-full aspect-square rounded-xl overflow-hidden cursor-pointer relative shrink-0"
              style={{ boxShadow: "0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)" }}
            >
              <img src={coverURL} alt="cover" className="w-full h-full object-cover block" />
              <div
                className="absolute inset-0 flex items-center justify-center transition-all duration-200 hover:bg-black/45"
                onMouseEnter={(e) => { (e.currentTarget.querySelector("span") as HTMLSpanElement).style.opacity = "1"; }}
                onMouseLeave={(e) => { (e.currentTarget.querySelector("span") as HTMLSpanElement).style.opacity = "0"; }}
              >
                <span className="text-white text-[10px] font-mono tracking-[0.12em] pointer-events-none transition-opacity duration-200" style={{ opacity: 0 }}>CHANGE</span>
              </div>
            </div>
          ) : (
            <div
              onClick={() => coverInputRef.current?.click()}
              className="w-full aspect-square rounded-xl overflow-hidden cursor-pointer relative bg-white/[0.04] shrink-0"
            >
              <div className="w-full h-full flex flex-col items-center justify-center gap-[10px] border border-dashed border-white/[0.08] rounded-xl">
                {metaFetching ? (
                  <div className="flex gap-[5px] items-center">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="w-[4px] h-[4px] rounded-full bg-white/20"
                        style={{ animation: "lxpulse 1.2s ease-in-out infinite", animationDelay: `${i * 0.2}s` }} />
                    ))}
                  </div>
                ) : (
                  <>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1.5">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21,15 16,10 5,21" />
                    </svg>
                    <span className="text-white/[0.12] text-[10px] font-mono tracking-[0.1em]">ADD COVER</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Track info + change song button */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col gap-[3px] min-w-0">
              {metaFetching && !trackTitle ? (
                <span className="text-white/20 text-[10px] font-mono tracking-[0.08em]">looking up…</span>
              ) : (
                <>
                  <p className="m-0 text-[15px] font-semibold tracking-[-0.02em] leading-[1.2] text-white truncate" style={{ opacity: trackTitle ? 1 : 0.15 }}>
                    {trackTitle || "untitled"}
                  </p>
                  {trackArtist && (
                    <p className="m-0 text-[12px] font-normal leading-[1.3] tracking-[-0.01em] truncate" style={{ color: "rgba(255,255,255,0.38)" }}>
                      {trackArtist}
                    </p>
                  )}
                </>
              )}
            </div>

            {audioFile && (
              <button
                onClick={() => { resetAll(); setTimeout(() => audioInputRef.current?.click(), 50); }}
                className="shrink-0 w-[22px] h-[22px] rounded-full border border-white/[0.12] flex items-center justify-center transition-all duration-150 hover:border-white/30 hover:bg-white/[0.06] mt-[1px] cursor-pointer"
                title="Change song"
              >
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="4.5" y1="1" x2="4.5" y2="8" />
                  <line x1="1" y1="4.5" x2="8" y2="4.5" />
                </svg>
              </button>
            )}
          </div>

          {/* Seek bar */}
          <div className="flex flex-col gap-[7px]">
            <div
              onClick={handleSeekBarClick}
              className="h-[3px] bg-white/[0.08] rounded-[2px] relative"
              style={{ cursor: audioFile ? "pointer" : "default" }}
            >
              <div
                ref={progressBarRef}
                className="absolute left-0 top-0 bottom-0 rounded-[2px]"
                style={{ width: "0%", background: audioFile ? "#fff" : "rgba(255,255,255,0.08)", transition: "none" }}
              />
              {audioFile && (
                <div
                  ref={thumbRef}
                  className="absolute top-1/2 w-[10px] h-[10px] rounded-full bg-white -translate-y-1/2 -translate-x-1/2 shadow-[0_0_0_2px_rgba(255,255,255,0.2)]"
                  style={{ left: "0%", transition: "none" }}
                />
              )}
            </div>
            <div className="flex justify-between">
              <span ref={currentTimeDisplayRef} className="text-white/40 text-[11px] font-mono">0:00</span>
              <span className="text-white/20 text-[11px] font-mono">{formatTime(duration)}</span>
            </div>
          </div>

          {/* Playback controls */}
          <div className="flex items-center justify-center gap-6">
            {/* Back 5s — RotateCcw from lucide */}
            <button
              onClick={() => seek(-5, -30, backIconRef)}
              className="bg-none border-none cursor-pointer p-1 flex items-center justify-center"
            >
              <span ref={backIconRef} className="inline-flex">
                <RotateCcw
                  size={18}
                  strokeWidth={1.5}
                  color={audioFile ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.12)"}
                />
              </span>
            </button>

            {/* Play / Pause */}
            <button
              onClick={togglePlay}
              className="w-[46px] h-[46px] rounded-full flex items-center justify-center shrink-0 transition-all duration-[250ms] active:scale-[0.93] cursor-pointer"
              style={{
                background: audioFile ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.06)",
                border: audioFile ? "none" : "1px dashed rgba(255,255,255,0.12)",
                boxShadow: audioFile ? "0 4px 20px rgba(255,255,255,0.15)" : "none",
              }}
            >
              {!audioFile ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" strokeLinecap="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              ) : playing ? (
                <svg width="10" height="12" viewBox="0 0 10 12" fill="#000">
                  <rect x="0" y="0" width="3" height="12" rx="1" /><rect x="7" y="0" width="3" height="12" rx="1" />
                </svg>
              ) : (
                <svg width="10" height="12" viewBox="0 0 10 12" fill="#000">
                  <polygon points="1,0 10,6 1,12" />
                </svg>
              )}
            </button>

            {/* Forward 5s — RotateCw from lucide */}
            <button
              onClick={() => seek(5, 30, fwdIconRef)}
              className="bg-none border-none cursor-pointer p-1 flex items-center justify-center"
            >
              <span ref={fwdIconRef} className="inline-flex">
                <RotateCw
                  size={18}
                  strokeWidth={1.5}
                  color={audioFile ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.12)"}
                />
              </span>
            </button>
          </div>

          <div className="flex-1" />
          {errorMsg && <p className="m-0 text-[#e05555] text-[10px] font-mono">{errorMsg.slice(0, 90)}</p>}
          {!audioFile && rawLyrics.trim() && !errorMsg && !isProcessing && (
            <p className="m-0 text-white/15 text-[10px] font-mono">add a song first</p>
          )}
        </div>

        {/* ── Right panel ────────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {!lyricsSaved ? (
            <div className="flex-1 flex flex-col px-[52px] pt-11 pb-7">
              <textarea
                value={rawLyrics}
                onChange={(e) => setRawLyrics(e.target.value)}
                placeholder={"Type lyrics here...\nOne line per lyric line\n(wrap background vocals in parentheses)"}
                className="flex-1 bg-transparent border-none outline-none resize-none text-[26px] font-bold leading-[1.6] tracking-[-0.02em] p-0 scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
                style={{ color: rawLyrics ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.12)", caretColor: "rgba(255,255,255,0.6)" }}
              />

              {/* Bottom toolbar */}
              <div className="flex items-center justify-between pt-5 border-t border-white/[0.06] shrink-0">
                <a
                  href={googleLyricsURL()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-[6px] no-underline transition-opacity duration-150 hover:opacity-70"
                  style={{ opacity: trackTitle || rawLyrics.trim() ? 0.45 : 0.15, pointerEvents: trackTitle || rawLyrics.trim() ? "auto" : "none" }}
                  tabIndex={trackTitle || rawLyrics.trim() ? 0 : -1}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15,3 21,3 21,9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                  <span className="text-[11px] font-mono tracking-[0.08em] text-white/90">get lyrics</span>
                </a>

                <button
                  onClick={() => void handleSave()}
                  disabled={!!(!(rawLyrics.trim().length > 0 && !!audioFile && !isProcessing && !metaFetching))}
                  className="bg-none border-none p-0 transition-colors duration-200"
                  style={{ cursor: rawLyrics.trim() && audioFile && !isProcessing && !metaFetching ? "pointer" : "default" }}
                >
                  {wavyLabel ? (
                    <WavyText text={wavyLabel} />
                  ) : (
                    <span
                      className="text-[13px] font-mono tracking-[0.08em]"
                      style={{ color: rawLyrics.trim() && audioFile ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.15)" }}
                    >
                      {phase === "done" ? "re-sync" : phase === "error" ? "retry" : "save lyrics"}
                      {rawLyrics.trim() && audioFile && phase !== "done" && " →"}
                    </span>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="absolute top-0 left-0 right-0 h-20 z-20 pointer-events-none" />
              <div className="absolute bottom-0 left-0 right-0 h-20 z-20 pointer-events-none" />
              <div ref={lyricsContainerRef} className="flex-1 overflow-y-auto px-[52px] py-20 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="h-[30vh]" />
                {savedLyrics.map((line, i) => renderSavedLine(line, i))}
                <div className="h-[30vh]" />
              </div>

              {/* Language selector */}
              <div className="absolute bottom-7 right-8 z-30">
                <LanguageSelector
                  selectedLanguage={selectedLanguage}
                  translating={translating}
                  onSelect={(lang) => void handleLanguageChange(lang)}
                  onClear={() => { setSelectedLanguage(""); setTranslatedLines(null); }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <input ref={audioInputRef} type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleAudioUpload(f); e.target.value = ""; }} />
      <input ref={coverInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleCoverUpload(f); }} />
    </main>
  );
}