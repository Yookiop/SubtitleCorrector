/*
 * SubtitleCorrector - service worker.
 *
 * Taken:
 *   - badge op het icoon zetten (taal van de laatste correctie)
 *   - de lokale bridge pollen (health) voor de popup
 *   - op verzoek de tab-audio opnemen via een offscreen document en de
 *     samples naar de bridge sturen voor taalherkenning (EN/NL)
 *
 * De opname gebeurt in een offscreen document omdat een service worker geen
 * getUserMedia/MediaRecorder heeft. Reden 'USER_MEDIA' + 'AUDIO_PLAYBACK'.
 */
'use strict';

const OFFSCREEN_PATH = 'src/offscreen.html';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8791';

let creatingOffscreen = null;
let healthCache = { at: 0, data: null };
let lastTrackedTab = null;

/* ------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------ */
function paintBadge(text, tabId) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: '#0b3a4a' });
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#7ef0ff' });
  } catch (e) { /* ignore */ }

  if (text) {
    lastTrackedTab = tabId != null ? tabId : lastTrackedTab;
    try { chrome.action.setBadgeText(tabId != null ? { text: text, tabId: tabId } : { text: text }); } catch (e) { /* ignore */ }
    return;
  }
  try {
    if (lastTrackedTab != null) chrome.action.setBadgeText({ text: '', tabId: lastTrackedTab });
    lastTrackedTab = null;
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * Offscreen document
 * ------------------------------------------------------------------ */
async function hasOffscreen() {
  try {
    if (!chrome.runtime.getContexts) return false;
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts && contexts.length > 0;
  } catch (e) {
    return false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Kort (een paar seconden) de audio van de YouTube-tab opnemen om de audiotaal (EN/NL) te herkennen.'
  });
  try {
    await creatingOffscreen;
  } catch (e) {
    // Race: een ander request maakte hem net aan.
    if (!(await hasOffscreen())) throw e;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch (e) { /* ignore */ }
}

function sendToOffscreen(msg) {
  return new Promise((resolve, reject) => {
    const payload = Object.assign({ target: 'sc.offscreen' }, msg);
    const timer = setTimeout(() => reject(new Error('offscreen-timeout')), 25000);
    try {
      chrome.runtime.sendMessage(payload, (res) => {
        void chrome.runtime.lastError;
        clearTimeout(timer);
        if (res === undefined) reject(new Error('offscreen-no-response'));
        else resolve(res);
      });
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Bridge health
 * ------------------------------------------------------------------ */
async function getBridgeUrl() {
  try {
    const s = await chrome.storage.sync.get({ bridgeUrl: DEFAULT_BRIDGE_URL });
    return String(s.bridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
  } catch (e) {
    return DEFAULT_BRIDGE_URL;
  }
}

async function bridgeHealth(force) {
  const now = Date.now();
  if (!force && healthCache.data && now - healthCache.at < 5000) return healthCache.data;

  const url = await getBridgeUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(url + '/health', { signal: ctrl.signal, cache: 'no-store' });
    const json = await res.json();
    healthCache = {
      at: now,
      data: {
        ok: !!json.ok,
        ready: !!json.ready,
        backend: json.backend || null,
        model: json.model || null,
        languages: json.languages || null,
        url: url,
        loading: !!json.loading,
        error: json.error || null
      }
    };
  } catch (e) {
    healthCache = { at: now, data: { ok: false, ready: false, url: url, error: String(e.message || e) } };
  } finally {
    clearTimeout(timer);
  }
  return healthCache.data;
}

/* ------------------------------------------------------------------ *
 * Audio-detectie
 * ------------------------------------------------------------------ */
function clampSeconds(v) {
  const n = Number(v);
  if (!isFinite(n)) return 5;
  return Math.max(2, Math.min(10, Math.round(n)));
}

async function detectAudio(tab, msg) {
  const tabId = tab && tab.id;
  if (tabId == null) return { ok: false, reason: 'no-tab' };

  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, reason: 'offscreen-failed', detail: String(e.message || e) };
  }

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    await closeOffscreen();
    return { ok: false, reason: 'tab-capture-denied', detail: String(e.message || e) };
  }

  try {
    const res = await sendToOffscreen({
      type: 'record',
      streamId: streamId,
      seconds: clampSeconds(msg.seconds),
      keepAudio: msg.keepAudio !== false,
      minConfidence: typeof msg.minConfidence === 'number' ? msg.minConfidence : 0.5
    });
    return res || { ok: false, reason: 'no-result' };
  } catch (e) {
    return { ok: false, reason: 'record-failed', detail: String(e.message || e) };
  } finally {
    // Document sluiten zodra we klaar zijn (volgende keer opnieuw aanmaken).
    setTimeout(() => { closeOffscreen(); }, 1500);
  }
}

/* ------------------------------------------------------------------ *
 * Berichten
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.target === 'sc.offscreen') return false; // niet voor ons

  switch (msg.type) {
    case 'setBadge':
      paintBadge(msg.text || '', sender && sender.tab ? sender.tab.id : null);
      sendResponse({ ok: true });
      return true;

    case 'bridgeHealth':
      bridgeHealth(!!msg.force).then(sendResponse);
      return true;

    case 'detectAudio':
      detectAudio(sender && sender.tab, msg).then(sendResponse);
      return true;

    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === lastTrackedTab) lastTrackedTab = null;
});
