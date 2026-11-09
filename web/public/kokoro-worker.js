// Pearl's voice, in the visitor's browser: Kokoro-82M via kokoro-js (transformers.js + ONNX Runtime Web).
// Runs in a module Web Worker so synthesis never blocks the page. The model (~90 MB, q8) downloads once from the
// Hugging Face Hub and is cached by the browser. Loaded from jsDelivr at a pinned version (kept out of the Next bundle).
//
// Messages in:  {type: "load"} · {type: "speak", id, text, voice}
// Messages out: {type: "ready", device} · {type: "audio", id, samples: Float32Array, rate} · {type: "error", id?, message}

const KOKORO_URL = "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm";
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let ttsPromise = null;

async function load() {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const { KokoroTTS } = await import(KOKORO_URL);
      let device = "wasm";
      try {
        if (self.navigator && self.navigator.gpu && (await self.navigator.gpu.requestAdapter())) device = "webgpu";
      } catch {
        device = "wasm";
      }
      // WebGPU wants full precision; on CPU (wasm) the 8-bit model is the fast one.
      const tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: device === "webgpu" ? "fp32" : "q8", device });
      return { tts, device };
    })();
    ttsPromise.catch(() => {
      ttsPromise = null; // allow a retry
    });
  }
  return ttsPromise;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === "load") {
      const { device } = await load();
      self.postMessage({ type: "ready", device });
    } else if (msg.type === "speak") {
      const { tts } = await load();
      const audio = await tts.generate(msg.text, { voice: msg.voice || "af_heart" });
      const samples = audio.audio;
      self.postMessage({ type: "audio", id: msg.id, samples, rate: audio.sampling_rate }, [samples.buffer]);
    }
  } catch (e) {
    self.postMessage({ type: "error", id: msg.id, message: String((e && e.message) || e) });
  }
};
