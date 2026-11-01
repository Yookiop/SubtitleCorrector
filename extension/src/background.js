/*
 * SubtitleCorrector - service worker.
 *
 * Taken:
 *   - badge op het icoon zetten (taal van de laatste correctie)
 *   - de lokale bridge pollen (health) voor de popup
 *   - op verzoek de tab-audio opnemen via een offscreen document en de
 *     samples naar de bridge sturen voor taalherkenning (EN/NL)
 *   - een video die je uit een playlist in een nieuw tabblad opent, zonder
 *     playlist-parameters laden (optie openVideosOutsidePlaylist)
 *
 * De opname gebeurt in een offscreen document omdat een service worker geen
 * getUserMedia/MediaRecorder heeft. Reden 'USER_MEDIA' + 'AUDIO_PLAYBACK'.
 */
'use strict';

// De pure logica (taalnormalisatie, caption-planning, URL-opruiming) staat in
// lang-utils.js. De service worker laadt hem met importScripts; de
// Firefox-variant zet hem als eerste in background.scripts (zie
// manifest.firefox.json), want daar bestaat importScripts niet.
if (typeof importScripts === 'function' && !globalThis.SCLang) {
  importScripts('/src/shared/lang-utils.js');
}
const L = globalThis.SCLang || null;

// Firefox levert `browser` (promise-gebaseerd) én een `chrome`-namespace die
// alleen callbacks kent; Chrome levert alleen `chrome` (met promises). Deze
// background gebruikt promises, dus pak `browser` als die er is — dan werkt
// hetzelfde bestand op beide browsers (manifest.firefox.json gebruikt
// background.scripts, want Firefox heeft geen service workers voor extensies).
const ext = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser : chrome;

// Chrome-only: een offscreen document en tabCapture bestaan in Firefox niet,
// dus daar kan de audio-analyse (Whisper-bridge) niet draaien. De rest van de
// extensie (ondertitels kiezen + Caption Boost) werkt daar gewoon.
const canCaptureAudio = !!(ext.offscreen && ext.tabCapture);

const OFFSCREEN_PATH = 'src/offscreen.html';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8791';

let creatingOffscreen = null;
let healthCache = { at: 0, data: null };
let lastTrackedTab = null;

/* ------------------------------------------------------------------ *
 * Per-tab kill switch (het CC-knopje in de speler)
 *
 * Houdt per tab bij of de gebruiker de ondertiteling van dat tabblad
 * volledig uit heeft gezet. Zo'n tabblad mag geen audio meer naar de
 * bridge sturen. De status staat in storage.session: een herlaadbeurt van
 * het tabblad onthoudt hem, het afsluiten van de browser niet.
 * ------------------------------------------------------------------ */
const disabledTabs = new Set();
const disabledReady = ext.storage.session
  .get({ scTabDisabled: {} })
  .then((s) => {
    const map = (s && s.scTabDisabled) || {};
    Object.keys(map).forEach((k) => { if (map[k]) disabledTabs.add(Number(k)); });
  })
  .catch(() => {});

function persistDisabledTabs() {
  try {
    const map = {};
    disabledTabs.forEach((id) => { map[id] = true; });
    ext.storage.session.set({ scTabDisabled: map }).catch(() => {});
  } catch (e) { /* ignore */ }
}

async function isTabDisabled(tabId) {
  if (tabId == null) return false;
  try { await disabledReady; } catch (e) { /* ignore */ }
  return disabledTabs.has(tabId);
}

async function setTabDisabled(tabId, off) {
  if (tabId == null) return;
  try { await disabledReady; } catch (e) { /* ignore */ }
  if (off) disabledTabs.add(tabId);
  else disabledTabs.delete(tabId);
  persistDisabledTabs();
}

/* ------------------------------------------------------------------ *
 * Video's buiten de playlist openen (optie openVideosOutsidePlaylist)
 *
 * YouTube's playlist-parameters (&list=, &index=, &pp=) zetten een video in
 * playlist-modus, en dat is het trage geval. Open je zo'n video met
 * ctrl+klik / middelste muisklik in een nieuw tabblad, dan haalt deze
 * listener de parameters er meteen weer af: het tabblad speelt alleen de
 * video, zonder playlist.
 *
 * Alleen gloednieuwe tabbladen. Klik je binnen hetzelfde tabblad van de
 * playlist door naar een video, dan blijft de playlist staan — anders zou
 * je vaste playlist-tabblad zijn playlist kwijtraken.
 * ------------------------------------------------------------------ */
const NEW_TAB_WINDOW_MS = 8000;
const freshTabs = new Map(); // tabId -> { at, armed }  (armed = eerste URL van dit tabblad nog niet gezien)

let outsidePlaylistOn = false;
const outsidePlaylistReady = ext.storage.sync
  .get({ openVideosOutsidePlaylist: false })
  .then((s) => { outsidePlaylistOn = !!(s && s.openVideosOutsidePlaylist); })
  .catch(() => {});

try {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes || !changes.openVideosOutsidePlaylist) return;
    outsidePlaylistOn = !!changes.openVideosOutsidePlaylist.newValue;
  });
} catch (e) { /* ignore */ }

function pruneFreshTabs(now) {
  freshTabs.forEach((info, id) => {
    if (now - info.at > NEW_TAB_WINDOW_MS) freshTabs.delete(id);
  });
}

async function openOutsidePlaylist(tabId, rawUrl) {
  if (!L || typeof L.urlWithoutPlaylist !== 'function') return false;
  const target = L.urlWithoutPlaylist(rawUrl);
  if (!target) return false;
  await outsidePlaylistReady;
  if (!outsidePlaylistOn) return false;
  if (!freshTabs.has(tabId)) return false;
  // Eén keer per tabblad: de opgeschoonde URL bevat geen playlist-parameters
  // meer, dus een redirect-lus kan hier niet ontstaan.
  freshTabs.delete(tabId);
  try {
    await ext.tabs.update(tabId, { url: target });
    return true;
  } catch (e) {
    return false;
  }
}

ext.tabs.onCreated.addListener((tab) => {
  if (!tab || tab.id == null) return;
  const now = Date.now();
  pruneFreshTabs(now);
  // Chrome geeft de bestemming van een ctrl+klik mee als pendingUrl. Zonder
  // URL (Firefox, sommige lege tabbladen) is het tabblad "armed": de eerste
  // navigatie die binnenkomt mag dan nog opgeschoond worden.
  const url = tab.pendingUrl || tab.url || '';
  freshTabs.set(tab.id, { at: now, armed: !url });
  if (url) openOutsidePlaylist(tab.id, url);
});

ext.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo || !changeInfo.url) return;
  const info = freshTabs.get(tabId);
  if (!info || !info.armed) return;
  info.armed = false;
  openOutsidePlaylist(tabId, changeInfo.url);
});

/* ------------------------------------------------------------------ *
 * Badge
 * ------------------------------------------------------------------ */
function paintBadge(text, tabId) {
  try {
    ext.action.setBadgeBackgroundColor({ color: '#0b3a4a' });
    if (ext.action.setBadgeTextColor) ext.action.setBadgeTextColor({ color: '#7ef0ff' });
  } catch (e) { /* ignore */ }

  if (text) {
    lastTrackedTab = tabId != null ? tabId : lastTrackedTab;
    try { ext.action.setBadgeText(tabId != null ? { text: text, tabId: tabId } : { text: text }); } catch (e) { /* ignore */ }
    return;
  }
  try {
    if (lastTrackedTab != null) ext.action.setBadgeText({ text: '', tabId: lastTrackedTab });
    lastTrackedTab = null;
  } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * Offscreen document
 * ------------------------------------------------------------------ */
async function hasOffscreen() {
  try {
    if (!ext.runtime.getContexts) return false;
    const contexts = await ext.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts && contexts.length > 0;
  } catch (e) {
    return false;
  }
}

async function ensureOffscreen() {
  if (!canCaptureAudio) throw new Error('offscreen niet ondersteund in deze browser');
  if (await hasOffscreen()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = ext.offscreen.createDocument({
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
    if (await hasOffscreen()) await ext.offscreen.closeDocument();
  } catch (e) { /* ignore */ }
}

function sendToOffscreen(msg) {
  return new Promise((resolve, reject) => {
    const payload = Object.assign({ target: 'sc.offscreen' }, msg);
    const timer = setTimeout(() => reject(new Error('offscreen-timeout')), 25000);
    try {
      ext.runtime.sendMessage(payload, (res) => {
        void ext.runtime.lastError;
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
    const s = await ext.storage.sync.get({ bridgeUrl: DEFAULT_BRIDGE_URL });
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
  // `capture: false` = deze browser kan geen tab-audio opnemen (Firefox); de
  // popup toont dat dan als "niet ondersteund" in plaats van "offline".
  return Object.assign({ capture: canCaptureAudio }, healthCache.data);
}

/* ------------------------------------------------------------------ *
 * Audio-detectie
 * ------------------------------------------------------------------ */
function clampSeconds(v) {
  const n = Number(v);
  if (!isFinite(n)) return 5;
  return Math.max(2, Math.min(10, Math.round(n)));
}

let capturing = false;

async function detectAudio(tab, msg) {
  const tabId = tab && tab.id;
  if (tabId == null) return { ok: false, reason: 'no-tab' };
  // Firefox: geen offscreen document en geen tabCapture -> geen audio-analyse.
  if (!canCaptureAudio) return { ok: false, reason: 'capture-unsupported' };
  // Kill switch: dit tabblad heeft de ondertiteling bewust uit staan.
  if (await isTabDisabled(tabId)) return { ok: false, reason: 'subtitles-off' };
  if (capturing) return { ok: false, reason: 'capture-busy' };

  // Niet opnemen als de bridge offline is of het model nog laadt: dat kost
  // alleen CPU/GPU zonder resultaat (belangrijk in playlists).
  const health = await bridgeHealth(false);
  if (!health || !health.ok || !health.ready) {
    return { ok: false, reason: health && health.ok ? 'bridge-loading' : 'bridge-offline' };
  }

  capturing = true;
  try {
    return await captureAndDetect(tabId, msg);
  } finally {
    capturing = false;
  }
}

async function captureAndDetect(tabId, msg) {
  try {
    await ensureOffscreen();
  } catch (e) {
    return { ok: false, reason: 'offscreen-failed', detail: String(e.message || e) };
  }

  let streamId;
  try {
    streamId = await ext.tabCapture.getMediaStreamId({ targetTabId: tabId });
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
ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

    case 'getTabState': {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      isTabDisabled(tabId).then((off) => sendResponse({ ok: true, subtitlesOff: off }));
      return true;
    }

    case 'setTabDisabled':
      setTabDisabled(sender && sender.tab ? sender.tab.id : null, !!msg.off).then(() => sendResponse({ ok: true }));
      return true;

    default:
      return false;
  }
});

ext.tabs.onRemoved.addListener((tabId) => {
  if (tabId === lastTrackedTab) lastTrackedTab = null;
  freshTabs.delete(tabId);
  if (disabledTabs.has(tabId)) {
    disabledTabs.delete(tabId);
    persistDisabledTabs();
  }
});
