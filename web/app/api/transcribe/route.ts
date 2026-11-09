import { settings } from "@/lib/agent/config";
import { jsonError, rateLimited } from "@/lib/agent/http";

// POST /api/transcribe (multipart: audio=<wav>) → {text}. The browser detects end of speech (VAD) and uploads one
// utterance; Groq Whisper transcribes it. Keeps the provider key on the server.
export const maxDuration = 30;
const MAX_BYTES = 3 * 1024 * 1024; // ~90 s of 16 kHz mono WAV, far beyond one utterance

export async function POST(req: Request) {
  const limited = rateLimited(req, "transcribe");
  if (limited) return limited;
  const s = settings();
  if (!s.sttApiKey) return jsonError(503, "Speech recognition isn't configured (STT_API_KEY).");
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "Expected multipart form data with an 'audio' file.");
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) return jsonError(400, "Missing audio.");
  if (audio.size > MAX_BYTES) return jsonError(413, "Audio clip too long.");

  const upstream = new FormData();
  upstream.append("file", audio, "utterance.wav");
  upstream.append("model", s.sttModel);
  upstream.append("language", "en");
  upstream.append("response_format", "json");
  upstream.append("temperature", "0");
  const t0 = performance.now();
  const res = await fetch(`${s.sttBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.sttApiKey}` },
    body: upstream,
  });
  if (res.status === 429) return jsonError(429, "Speech recognition is busy (free quota). Try again in a moment, or use chat.");
  if (!res.ok) {
    console.error("transcription failed", res.status, (await res.text()).slice(0, 300));
    return jsonError(502, "Speech recognition failed.");
  }
  const data = (await res.json()) as { text?: string };
  return Response.json({ text: (data.text ?? "").trim(), ms: Math.round(performance.now() - t0) });
}
