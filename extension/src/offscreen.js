/*
 * SubtitleCorrector - offscreen document.
 *
 * Neemt een paar seconden de audio van de YouTube-tab op, zet die om naar
 * 16 kHz mono float32 en stuurt hem naar de lokale bridge voor taalherkenning.
 *
 * Waarom offscreen: een MV3 service worker heeft geen getUserMedia/MediaRecorder.
 * Chrome zet het geluid van de tab tijdens een tab-capture uit; daarom spelen we
 * de opgenomen stream (optioneel) terug via de AudioContext, anders hoort de
 * gebruiker een paar seconden niets.
 */
'use strict';

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8791';
const TARGET_RATE = 16000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'sc.offscreen') return false;

  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'record') {
    record(msg).then(sendResponse).catch((e) => {
      sendResponse({ ok: false, reason: 'record-error', detail: String((e && e.message) || e) });
    });
    return true;
  }
  return false;
});

async function bridgeUrl() {
  try {
    const s = await chrome.storage.sync.get({ bridgeUrl: DEFAULT_BRIDGE_URL });
    return String(s.bridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
  } catch (e) {
    return DEFAULT_BRIDGE_URL;
  }
}

function pickMime() {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const c of cands) {
    try {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    } catch (e) { /* ignore */ }
  }
  return '';
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function record(msg) {
  const seconds = Math.max(2, Math.min(10, Number(msg.seconds) || 5));
  const keepAudio = msg.keepAudio !== false;
  const minConfidence = typeof msg.minConfidence === 'number' ? msg.minConfidence : 0.5;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: msg.streamId
        }
      },
      video: false
    });
  } catch (e) {
    return { ok: false, reason: 'capture-failed', detail: String((e && e.message) || e) };
  }

  // Terugspelen zodat de gebruiker blijft horen wat er speelt. Alleen dan is een
  // echte AudioContext + MediaStreamAudioSourceNode nodig; decoderen kan met
  // een offline context (dat scheelt een audio-uitvoer + DSP-werk).
  let ctx = null;
  let source = null;
  let gain = null;
  if (keepAudio) {
    try {
      ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      source = ctx.createMediaStreamSource(stream);
      gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(ctx.destination);
    } catch (e) {
      try { if (ctx) ctx.close(); } catch (e2) { /* ignore */ }
      ctx = null;
      source = null;
      gain = null;
    }
  }

  const mime = pickMime();
  let rec;
  try {
    rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    cleanup();
    return { ok: false, reason: 'recorder-failed', detail: String((e && e.message) || e) };
  }

  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });

  let result = null;
  try {
    rec.start(200);
    await sleep(seconds * 1000);
    try { rec.stop(); } catch (e) { /* ignore */ }
    await stopped;
    result = await analyse(chunks, seconds, minConfidence);
  } catch (e) {
    result = { ok: false, reason: 'analyse-failed', detail: String((e && e.message) || e) };
  } finally {
    cleanup();
  }

  function cleanup() {
    try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
    try { if (source) source.disconnect(); } catch (e) { /* ignore */ }
    try { if (gain) gain.disconnect(); } catch (e) { /* ignore */ }
    try { if (ctx) ctx.close(); } catch (e) { /* ignore */ }
  }

  return result;
}

async function analyse(chunks, seconds, minConfidence) {
  if (!chunks.length) return { ok: false, reason: 'capture-empty' };

  const blob = new Blob(chunks, { type: chunks[0].type || 'audio/webm' });
  const arr = await blob.arrayBuffer();
  if (!arr.byteLength) return { ok: false, reason: 'capture-empty' };

  let decoded;
  try {
    const decodeCtx = new OfflineAudioContext(1, 1, TARGET_RATE);
    decoded = await decodeCtx.decodeAudioData(arr.slice(0));
  } catch (e) {
    return { ok: false, reason: 'decode-failed', detail: String((e && e.message) || e) };
  }

  // Mono + 16 kHz (Whisper-vereiste) via OfflineAudioContext.
  const length = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(1, length, TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  // Stilte-gate: zonder geluid is er niets te herkennen.
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  if (rms < 0.0008) {
    return { ok: false, reason: 'silence', rms: Number(rms.toFixed(5)), peak: Number(peak.toFixed(4)), seconds: seconds };
  }

  const url = (await bridgeUrl()) + '/detect?rate=16000&format=f32';
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-SC-Min-Confidence': String(minConfidence),
        'X-SC-Max-Seconds': String(seconds)
      },
      body: samples
    });
  } catch (e) {
    return { ok: false, reason: 'bridge-offline', detail: String((e && e.message) || e), rms: Number(rms.toFixed(5)) };
  }

  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  if (!res.ok || !json) {
    return { ok: false, reason: 'bridge-error', status: res.status, rms: Number(rms.toFixed(5)) };
  }

  return {
    ok: true,
    language: json.language || null,
    confidence: typeof json.confidence === 'number' ? json.confidence : null,
    inScope: json.in_scope !== false,
    backend: json.backend || null,
    model: json.model || null,
    transcript: json.transcript || null,
    duration: json.duration || null,
    rms: Number(rms.toFixed(5)),
    peak: Number(peak.toFixed(4))
  };
}
